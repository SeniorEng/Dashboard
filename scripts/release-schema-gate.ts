/**
 * Release-Step, Schritt 0d: **technischer Riegel gegen einen destruktiven
 * Schema-Push.**
 *
 * `scripts/migrate.sh` läuft im Hook mit `--force`, und `--force` genehmigt
 * Datenverlust-Anweisungen automatisch. Dieser Schritt läuft VOR dem Push, im
 * Trockenlauf, und bricht ab, wenn ein `DROP COLUMN`/`DROP TABLE` anstünde, das
 * nicht ausdrücklich freigegeben ist.
 *
 * ── Was das ERSETZT ─────────────────────────────────────────────────────
 * Bis hierhin war der einzige Schutz auf dem automatischen Deploy-Pfad die
 * Review-Regel in CLAUDE.md („vor --force den Schema-Diff prüfen"). Der
 * Build-Check `script/check-pre-publish-backup.mjs` liest DATEIEN in
 * `migrations/` und ist bei `push` per Konstruktion blind; der blockierende
 * `script/preflight-publish.mjs` ist ein Operator-Schritt, den im Deploy
 * niemand aufruft. Dieser Schritt ersetzt die Menschen-Regel durch ein Gate.
 *
 * ── Trockenlauf ─────────────────────────────────────────────────────────
 * `pushSchema()` aus `drizzle-kit/api` liefert `statementsToExecute`, ohne sie
 * anzuwenden (empirisch verifiziert: die Testspalte stand nach dem Aufruf noch).
 * Die CLI kann das nicht — `push` hat kein `--dry-run`, und `--strict` würde im
 * Hook auf eine Rückfrage warten.
 *
 * ── Freigabe ────────────────────────────────────────────────────────────
 * Über `PUBLISH_ACK_DROPS` — dieselbe Variable und dasselbe Schlüsselformat
 * (`column:<tabelle>.<spalte>`, `table:<tabelle>`) wie der Operator-Preflight.
 * Bewusst kein zweiter Begriff für dieselbe Frage. Ein Sammel-OK gibt es nicht:
 * jeder Drop muss einzeln dastehen.
 *
 * ── Die DATABASE_URL wird NIE ausgegeben ────────────────────────────────
 * Gemeldet werden Host und `current_database()` aus der offenen Verbindung.
 */
import { pushSchema } from "drizzle-kit/api";
import * as schema from "@shared/schema";
import { db } from "../server/lib/db";
import { dbHostOf, currentDatabaseName } from "../server/scripts/lib/prod-write-gate";
import { findeDestruktiveAnweisungen } from "./lib/destructive-schema-statements";
// Die Ack-/Beschreibungs-Helfer sind bereits die SSoT des Operator-Preflights.
import {
  describeDrop,
  dropKey,
  parseAckList,
  partitionAcknowledgedDrops,
} from "../script/schema-replica-diff.mjs";

function abbruch(nachricht: string): never {
  console.error(`\n${nachricht}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    abbruch("[schema-gate] FEHLER: DATABASE_URL ist nicht gesetzt.");
  }

  const host = dbHostOf(process.env.DATABASE_URL) ?? "(Host unbekannt)";
  const datenbank = await currentDatabaseName();
  console.log(`[schema-gate] Ziel: ${host}/${datenbank}`);

  const trocken = await pushSchema(
    schema as Parameters<typeof pushSchema>[0],
    db as unknown as Parameters<typeof pushSchema>[1],
  );

  const drops = findeDestruktiveAnweisungen(trocken.statementsToExecute);
  if (drops.length === 0) {
    console.log(
      `[schema-gate] ${trocken.statementsToExecute.length} Anweisung(en) anstehend, ` +
        `keine davon droppt Spalten oder Tabellen.`,
    );
    return;
  }

  const { acknowledged, unacknowledged } = partitionAcknowledgedDrops(
    drops,
    parseAckList(process.env.PUBLISH_ACK_DROPS),
  );

  for (const drop of acknowledged) {
    console.log(`[schema-gate] freigegeben: ${describeDrop(drop)}`);
  }
  if (unacknowledged.length === 0) {
    console.log(
      `[schema-gate] Alle ${acknowledged.length} destruktiven Änderungen sind einzeln freigegeben.`,
    );
    return;
  }

  abbruch(
    `RELEASE ABGEBROCHEN — der Schema-Push würde ${unacknowledged.length} nicht\n` +
      `freigegebene, datenvernichtende Änderung(en) anwenden.\n\n` +
      unacknowledged.map((d) => `  ${describeDrop(d)}   →   ${dropKey(d)}`).join("\n") +
      `\n\n\`migrate.sh\` läuft im Release-Hook mit --force; --force genehmigt genau\n` +
      `solche Anweisungen automatisch. Deshalb dieser Riegel davor.\n\n` +
      `Wenn der Drop gewollt ist: Backup nach docs/pre-publish-backup-runbook.md\n` +
      `ziehen und jeden Schlüssel einzeln freigeben —\n\n` +
      `  PUBLISH_ACK_DROPS="${unacknowledged.map(dropKey).join(",")}"\n\n` +
      `Ein Sammel-OK gibt es bewusst nicht: so kann kein Drop mitrutschen.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    // Auch ein unerwarteter Fehler bricht den Release ab. Ein Riegel, der bei
    // eigenem Versagen durchwinkt, ist keiner.
    abbruch(`[schema-gate] FEHLER: ${err instanceof Error ? err.message : String(err)}`);
  });
