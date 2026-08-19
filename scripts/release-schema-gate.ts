/**
 * Release-Step, Schritt 0d: **technischer Riegel gegen einen destruktiven
 * Schema-Push (Schritt 0d).**
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
 * ── Freigabe: `docs/schema-change-manifest.json`, an den schemaHash gebunden ──
 * ERSETZT `PUBLISH_ACK_DROPS` auf diesem Pfad. Eine Env-Variable müsste auf der
 * Plattform gesetzt werden und bliebe dann gesetzt — derselbe Schlüssel
 * genehmigte still jeden künftigen Deploy. Eine Freigabe, die nicht abläuft,
 * ist keine. Der Manifest-Eintrag trägt den Schema-Stand, für den er gilt, und
 * entwertet sich selbst, sobald die Änderung angewendet ist (Muster aus
 * docs/pre-publish-backup-runbook.md §8.6).
 *
 * Freigabepflichtig ist nicht nur `DROP COLUMN`/`DROP TABLE`, sondern auch
 * `SET NOT NULL`, `UNIQUE`, `CHECK` und verengende Typänderungen: sie brechen
 * den alten Code, der im Deploy-Fenster noch bedient, genauso.
 *
 * ── Die DATABASE_URL wird NIE ausgegeben ────────────────────────────────
 * Gemeldet werden Host und `current_database()` aus der offenen Verbindung.
 */
import { readFile, writeFile } from "node:fs/promises";
import { pushSchema } from "drizzle-kit/api";
import * as schema from "@shared/schema";
import { db } from "../server/lib/db";
import { dbHostOf, currentDatabaseName } from "../server/scripts/lib/prod-write-gate";
import { findeFreigabepflichtige } from "./lib/destructive-schema-statements";
import {
  berechneSchemaHash,
  freigabeMeldung,
  pruefeFreigaben,
  type Manifest,
} from "./lib/schema-change-manifest";
import {
  bewerteNachbedingung,
  klassifiziereAnweisung,
} from "./lib/push-statement-classifier";
import BENIGNER_CHURN from "./lib/benign-push-churn.json" with { type: "json" };
import { sql } from "drizzle-orm";

function abbruch(nachricht: string): never {
  console.error(`\n${nachricht}\n`);
  process.exit(1);
}

/**
 * Schema-Schnappschuss in der Form von `script/schema-replica-diff.mjs`
 * (Tabelle → Spalten), aber über `server/lib/db` gelesen.
 *
 * Bewusst NICHT über dessen `fetchSchemaSnapshot`: das oeffnet eine eigene
 * `pg`-Verbindung und leitet SSL aus dem Connection-String ab — gegen einen
 * Postgres ohne TLS (Coolify-intern, lokale Wegwerf-DBs) scheitert es mit
 * "The server does not support SSL connections". Gemessen, nicht vermutet.
 * Ausserdem waere es eine DRITTE Verbindung neben den zwei, deren Identitaet
 * Schritt 0a gerade beweist. Die Form bleibt dieselbe, damit Freigabe und
 * Operator-Preflight denselben Begriff benutzen.
 */
async function schemaSchnappschuss(): Promise<Record<string, string[]>> {
  const ergebnis = (await db.execute(sql`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
  `)) as unknown;
  const rows = (Array.isArray(ergebnis)
    ? ergebnis
    : ((ergebnis as { rows?: unknown[] }).rows ?? [])) as {
    table_name: string;
    column_name: string;
  }[];
  const schnappschuss: Record<string, string[]> = {};
  for (const zeile of rows) {
    (schnappschuss[zeile.table_name] ??= []).push(zeile.column_name);
  }
  return schnappschuss;
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
  const pflichtige = findeFreigabepflichtige(statements);
  if (pflichtige.length === 0) {
    console.log(
      `[schema-gate] ${statements.length} Anweisung(en) anstehend, ` +
        `keine davon ist freigabepflichtig.`,
    );
    return;
  }

  // Der Hash laeuft ueber den LIVE-Stand der Zieldatenbank. Sobald eine
  // freigegebene Aenderung angewendet ist, passt der Eintrag nicht mehr —
  // die Freigabe entwertet sich von selbst, ohne dass jemand aufraeumt.
  const schemaHash = berechneSchemaHash(await schemaSchnappschuss());
  const manifest = JSON.parse(
    await readFile(new URL("../docs/schema-change-manifest.json", import.meta.url), "utf8"),
  ) as Manifest;

  const urteil = pruefeFreigaben(
    pflichtige.map((p) => p.key),
    manifest,
    schemaHash,
  );

  for (const f of urteil.angenommen) {
    console.log(
      `[schema-gate] freigegeben: ${f.aenderung} (Backup ${f.backupId}, ${f.begruendung})`,
    );
  }
  if (urteil.abgelehnt.length > 0) {
    abbruch(freigabeMeldung(urteil, schemaHash));
  }
  console.log(
    `[schema-gate] Alle ${urteil.angenommen.length} freigabepflichtigen Aenderungen ` +
      `sind fuer Schema ${schemaHash} einzeln freigegeben.`,
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
