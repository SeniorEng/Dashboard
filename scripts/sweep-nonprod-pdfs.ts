// ---------------------------------------------------------------------------
// Standalone-CLI: verwaiste NICHT-PRODUKTIONS-PDF-Artefakte im Object-Storage
// aufräumen (Task #1806)
//
// Rechnungs-/Leistungsnachweis-PDFs teilen sich EINEN Bucket. Prod schreibt in
// `invoices/…` (GoBD-aufbewahrt, UNANTASTBAR); Nicht-Prod-/Test-Läufe isolieren
// unter `_nonprod/…`. Dort gab es bislang keine Retention → der Bucket wächst
// monoton. Dieses CLI löscht die ausreichend ALTEN `_nonprod/`-Objekte.
//
// Dieselbe Sweep-Logik (`runNonprodPdfSweep`) läuft auch automatisch beim Start
// des Ephemeral-Orchestrators (`scripts/with-ephemeral-db.ts`) und im Sammel-
// Unblock `scripts/sweep-test-dbs.ts` (`npm run test:unblock`). Dieses CLI ist
// der gezielte manuelle Aufruf.
//
// SICHERHEIT:
//   - läuft NIEMALS in Production (harter NODE_ENV-Guard).
//   - Dry-Run per Default; echtes Löschen NUR mit `--apply`.
//   - jeder zu löschende Key MUSS unter `_nonprod/` liegen (Guard wirft sonst).
//   - Altersgrenze (Default 24h, via `--retention-ms=`) schützt frische
//     Artefakte eines parallel laufenden Schwester-Laufs.
//
// Aufruf:
//   tsx scripts/sweep-nonprod-pdfs.ts                 # dry-run (nur anzeigen)
//   tsx scripts/sweep-nonprod-pdfs.ts --apply         # wirklich löschen
//   tsx scripts/sweep-nonprod-pdfs.ts --retention-ms=0 --apply   # alle _nonprod-PDFs
// ---------------------------------------------------------------------------
import {
  DEFAULT_PDF_RETENTION_MS,
  runNonprodPdfSweep,
} from "./lib/object-storage-pdf-sweep.ts";

function fail(msg: string): never {
  console.error(`[pdf-sweep] ${msg}`);
  process.exit(1);
}

if (process.env.NODE_ENV === "production") {
  fail("Verweigert: läuft niemals in Production.");
}

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const retentionArg = argv.find((a) => a.startsWith("--retention-ms="));
let retentionMs = DEFAULT_PDF_RETENTION_MS;
if (retentionArg) {
  const parsed = Number(retentionArg.split("=")[1]);
  if (!Number.isFinite(parsed) || parsed < 0) fail(`Ungültiges --retention-ms: ${retentionArg}`);
  retentionMs = parsed;
}

const result = await runNonprodPdfSweep({
  retentionMs,
  dryRun: !apply,
  log: (m) => console.log(m),
});

if (result === null) {
  console.log("[pdf-sweep] Nichts zu tun (Object-Storage nicht konfiguriert).");
  process.exit(0);
}

console.log(
  `[pdf-sweep] Fertig. ${apply ? "" : "(dry-run) "}` +
    `Gescannt: ${result.scanned}, ` +
    `${apply ? "gelöscht" : "würde löschen"}: ${result.deleted.length}, ` +
    `übersprungen (zu jung/unbekannt): ${result.skipped}, ` +
    `fehlgeschlagen: ${result.failed.length}.`,
);

process.exit(result.failed.length > 0 ? 1 : 0);
