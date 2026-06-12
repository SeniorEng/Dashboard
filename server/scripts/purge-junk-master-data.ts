// ---------------------------------------------------------------------------
// BUG-18 (Task #1230) — CLI für den Junk-Stammdaten-Purge.
//
//   npm run purge:junk-master-data            → read-only Dry-Run + Report
//   npm run purge:junk-master-data -- --apply → destruktiver Lauf, ABER nur,
//                                                wenn JUNK_PURGE_PROD_APPROVED
//                                                gesetzt ist (Alriks Freigabe).
//
// Der Report wird IMMER (auch beim Apply, vor der Mutation) nach
// `docs/bug-18-junk-purge-dry-run-<env>-<ts>.md` geschrieben und archiviert.
// ---------------------------------------------------------------------------
import * as fs from "node:fs";
import * as path from "node:path";
import { pool } from "../lib/db";
import {
  collectJunkPurgeReport,
  formatJunkPurgeReport,
  applyJunkPurgeMigration,
} from "../startup/purge-junk-master-data";

function isApproved(): boolean {
  const v = (process.env.JUNK_PURGE_PROD_APPROVED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const report = await collectJunkPurgeReport();
  const md = formatJunkPurgeReport(report);

  const env = (process.env.NODE_ENV ?? "unset").replace(/[^a-z0-9]+/gi, "");
  const ts = report.generatedAt.replace(/[:.]/g, "-");
  const outDir = path.resolve(process.cwd(), "docs");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `bug-18-junk-purge-dry-run-${env}-${ts}.md`);
  fs.writeFileSync(outFile, md, "utf8");

  const s = report.services;
  const d = report.documentTypes;
  console.log(`[junk-purge] Dry-Run-Report → ${outFile}`);
  console.log(
    `[junk-purge] services: löschen=${s.deletable.length}, deaktivieren=${s.deactivatable.length}; ` +
      `document_types: löschen=${d.deletable.length}, deaktivieren=${d.deactivatable.length}.`,
  );

  if (!apply) {
    console.log("[junk-purge] Dry-Run (kein --apply) — KEINE Mutation durchgeführt.");
    return;
  }

  if (!isApproved()) {
    console.error(
      "[junk-purge] --apply angefordert, aber JUNK_PURGE_PROD_APPROVED ist NICHT gesetzt. " +
        "Destruktiver Lauf abgebrochen — nur Dry-Run-Report erzeugt.",
    );
    process.exitCode = 2;
    return;
  }

  console.log("[junk-purge] Freigabe erkannt — destruktiver Lauf startet …");
  const result = await applyJunkPurgeMigration();
  console.log(
    `[junk-purge] ${result.outcome}: services del=${result.servicesDeleted}/deact=${result.servicesDeactivated}, ` +
      `doc-types del=${result.documentTypesDeleted}/deact=${result.documentTypesDeactivated}.`,
  );
}

main()
  .catch((err) => {
    console.error("[junk-purge] Fehler:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
