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
import { writeFile } from "node:fs/promises";
import { pushSchema } from "drizzle-kit/api";
import * as schema from "@shared/schema";
import { db } from "../server/lib/db";
import { dbHostOf, currentDatabaseName } from "../server/scripts/lib/prod-write-gate";
import { findeDestruktiveAnweisungen } from "./lib/destructive-schema-statements";
import {
  bewerteNachbedingung,
  klassifiziereAnweisung,
} from "./lib/push-statement-classifier";
import BENIGNER_CHURN from "./lib/benign-push-churn.json" with { type: "json" };
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

async function anstehendeAnweisungen(): Promise<string[]> {
  const trocken = await pushSchema(
    schema as Parameters<typeof pushSchema>[0],
    db as unknown as Parameters<typeof pushSchema>[1],
  );
  return trocken.statementsToExecute;
}

/**
 * Nachbedingung NACH dem Push (B1). `drizzle-kit push` beendet sich bei einem
 * DDL-Fehler mit exit 0 — gemessen an 0.31.10 mit einer Rolle ohne `CREATE`:
 * „permission denied for schema public", 0 Tabellen angelegt, EXITCODE=0.
 * Der Erfolg wird deshalb daran gemessen, was DANACH noch aussteht.
 */
async function nachbedingung(): Promise<void> {
  const anstehend = await anstehendeAnweisungen();
  const urteil = bewerteNachbedingung(anstehend, BENIGNER_CHURN);

  if (urteil.blockaden.length === 0) {
    console.log(
      `[schema-gate] Nachbedingung erfüllt: ${urteil.geduldet.length} bekannte ` +
        `Churn-Anweisung(en) offen, nichts Strukturelles.`,
    );
    return;
  }

  const strukturell = urteil.blockaden.filter((b) => b.grund !== "nicht im Fingerprint");
  const drift = urteil.blockaden.filter((b) => b.grund === "nicht im Fingerprint");

  abbruch(
    `RELEASE ABGEBROCHEN — der Schema-Push ist NICHT vollständig durchgelaufen.\n\n` +
      urteil.blockaden.map((b) => `  [${b.grund}] ${b.sql}`).join("\n") +
      `\n\n` +
      (strukturell.length > 0
        ? `${strukturell.length} Anweisung(en) verändern das Schema und stehen nach dem\n` +
          `Push IMMER NOCH an. \`drizzle-kit push\` meldet einen DDL-Fehlschlag mit\n` +
          `exit 0 — deshalb wird hier die Wirkung geprüft, nicht der Rückgabewert.\n` +
          `Im Log von Schritt 1 steht der eigentliche Fehler (Rechte, Constraint\n` +
          `gegen Altdaten, Lock-Timeout).\n\n`
        : "") +
      (drift.length > 0
        ? `${drift.length} Anweisung(en) sehen kosmetisch aus, stehen aber nicht im\n` +
          `Fingerprint (scripts/lib/benign-push-churn.json). Das ist Drift: prüfen,\n` +
          `ob sie wirklich harmlos sind, dann den Fingerprint neu erzeugen mit\n` +
          `  npx tsx scripts/release-schema-gate.ts --fingerprint\n\n`
        : "") +
      `Der Deploy bricht ab; die laufende Version bleibt unberührt.`,
  );
}

async function drop_gate(): Promise<void> {
  const statements = await anstehendeAnweisungen();
  const drops = findeDestruktiveAnweisungen(statements);
  if (drops.length === 0) {
    console.log(
      `[schema-gate] ${statements.length} Anweisung(en) anstehend, ` +
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

/** Erzeugt den Fingerprint neu — read-only, schreibt nur die JSON-Datei. */
async function fingerprintSchreiben(): Promise<void> {
  const anstehend = await anstehendeAnweisungen();
  const fremd = anstehend.filter((s) => klassifiziereAnweisung(s) !== "kosmetisch");
  if (fremd.length > 0) {
    abbruch(
      `FINGERPRINT NICHT GESCHRIEBEN — ${fremd.length} der anstehenden Anweisungen\n` +
        `sind nicht kosmetisch:\n\n` +
        fremd.map((s) => `  ${s}`).join("\n") +
        `\n\nEin Fingerprint darf nur den harmlosen Bodensatz festhalten. Solange\n` +
        `Strukturelles aussteht, ist das Schema schlicht nicht aktuell — erst\n` +
        `pushen, dann den Fingerprint erzeugen.`,
    );
  }
  const ziel = new URL("./lib/benign-push-churn.json", import.meta.url);
  await writeFile(ziel, `${JSON.stringify(anstehend, null, 2)}\n`, "utf8");
  console.log(`[schema-gate] Fingerprint geschrieben: ${anstehend.length} Anweisung(en).`);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    abbruch("[schema-gate] FEHLER: DATABASE_URL ist nicht gesetzt.");
  }

  const host = dbHostOf(process.env.DATABASE_URL) ?? "(Host unbekannt)";
  const datenbank = await currentDatabaseName();
  console.log(`[schema-gate] Ziel: ${host}/${datenbank}`);

  const modus = process.argv[2] ?? "--drop-gate";
  switch (modus) {
    case "--drop-gate":
      return drop_gate();
    case "--nachbedingung":
      return nachbedingung();
    case "--fingerprint":
      return fingerprintSchreiben();
    default:
      abbruch(
        `[schema-gate] FEHLER: unbekannter Modus "${modus}". ` +
          `Erlaubt: --drop-gate (Standard), --nachbedingung, --fingerprint.`,
      );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    // Auch ein unerwarteter Fehler bricht den Release ab. Ein Riegel, der bei
    // eigenem Versagen durchwinkt, ist keiner.
    abbruch(`[schema-gate] FEHLER: ${err instanceof Error ? err.message : String(err)}`);
  });
