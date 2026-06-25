/**
 * Periodischer Dev-DB-Test-Daten-Sweep (Task #1430)
 *
 * Räumt den auf der langlebigen DEV-DB angesammelten Test-Pattern-Backlog
 * (Kunden/Interessenten/User) wieder ab, damit der in Task #1427 einmalig
 * entfernte Rückstau (3281 Test-Kunden) nicht erneut anwächst. Gedacht für eine
 * Scheduled Deployment (z.B. wöchentlich) ODER den manuellen Aufruf
 * `npm run db:sweep-dev -- --apply`.
 *
 * Ersetzungs-Regel: Dieses Skript ERSETZT den wiederkehrenden manuellen Lauf
 * von `npm run cleanup:test-data -- --apply` für den Kunden-/Interessenten-/
 * User-Backlog. Es fügt KEINE neue Lösch-Logik hinzu, sondern ist ein dünner,
 * gescopter CLI-Wrapper um den bereits existierenden SSoT-Runner
 * `runTestDataCleanup()` (server/services/test-data-cleanup.ts), der den
 * set-based Bulk-Purge nutzt (anders als der langsame per-Kunde-Cascade in
 * cleanup-test-data.ts).
 *
 * Schutzmaßnahmen (gespiegelt aus scripts/reseed-dev-db.sh / backup-dev-db.sh):
 *   - Abbruch bei NODE_ENV=production (zusätzlich ist runTestDataCleanup() dort
 *     bereits ein No-op).
 *   - Abbruch, wenn der DB-Host nach Produktion aussieht (Regex auf Hostname).
 *   - Fail-closed: Abbruch, wenn der Host nicht ermittelbar ist.
 *   - Abbruch, wenn DATABASE_URL-Host == PROD_DATABASE_URL-Host.
 *   - Default ist DRY-RUN (zählt nur). Erst `--apply` löscht.
 *   - Der ZZ-Test-Whitelist-Schutz (CUSTOMER_PRESERVE_VORNAME_PREFIX) steckt im
 *     CUSTOMER_TEST_FILTER und bleibt damit automatisch erhalten.
 *
 * CLI:
 *   tsx server/scripts/sweep-dev-test-data.ts            # dry-run (zählt nur)
 *   tsx server/scripts/sweep-dev-test-data.ts --apply    # scharf ausführen
 *   npm run db:sweep-dev                                 # dry-run
 *   npm run db:sweep-dev -- --apply                      # scharf
 */

import { fileURLToPath } from "node:url";
import { db, pool } from "../lib/db";
import {
  runTestDataCleanup,
  findTestCustomerIds,
  findTestUserIds,
  PROSPECT_TEST_FILTER,
} from "../services/test-data-cleanup";
import { prospects } from "@shared/schema";

// Prod-Schutz-Guards liegen DB-frei in `../lib/dev-db-guard` (Ersetzungs-Regel:
// von hier herausgelöst, damit ein IMMER laufendes CI-Gate sie ohne DB-Import
// abdecken kann). Re-export für Rückwärtskompatibilität der Importeure.
export {
  PROD_HOST_PATTERN,
  dbHostOf,
  assertDevDatabase,
} from "../lib/dev-db-guard";
import { assertDevDatabase } from "../lib/dev-db-guard";

async function countProspects(): Promise<number> {
  const rows = await db.select({ id: prospects.id }).from(prospects).where(PROSPECT_TEST_FILTER);
  return rows.length;
}

export async function runSweep(apply: boolean): Promise<void> {
  assertDevDatabase();
  console.log(`Modus: ${apply ? "APPLY (scharf)" : "DRY-RUN (zählt nur)"}`);

  if (!apply) {
    const [custIds, userIds, prospectCount] = await Promise.all([
      findTestCustomerIds(),
      findTestUserIds(),
      countProspects(),
    ]);
    console.log("\nDRY-RUN — würde folgende Test-Pattern-Datensätze entfernen:");
    console.log(`   Test-Kunden:        ${custIds.length}`);
    console.log(`   Test-Interessenten: ${prospectCount}`);
    console.log(`   Test-User:          ${userIds.length}`);
    console.log("\nMit `--apply` ausführen, um den Bulk-Purge scharf zu schalten.");
    return;
  }

  const t0 = Date.now();
  const summary = await runTestDataCleanup();
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (summary.skipped) {
    console.log(`Sweep übersprungen (Grund: ${summary.reason ?? "unbekannt"}).`);
    return;
  }

  console.log(`\nSweep fertig in ${elapsed}s:`);
  console.log(`   Kunden gelöscht:        ${summary.customersDeleted} (fehlgeschlagen: ${summary.customersFailed})`);
  console.log(`   Interessenten gelöscht: ${summary.prospectsDeleted}`);
  console.log(`   User gelöscht:          ${summary.usersDeleted} (abgelehnt: ${summary.usersRejected})`);
  if (summary.usersBlocked) {
    console.warn("   WARNUNG: Mindestens ein User-Batch wurde geblockt (Verflechtung mit echten Kunden).");
  }
}

async function main(): Promise<void> {
  const apply = process.argv.slice(2).includes("--apply");
  await runSweep(apply);
}

// Nur als CLI ausführen — ein versehentlicher Import darf main() nicht triggern
// (Schutz vor unguarded top-level Skript-Ausführung beim Boot).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
    .then(async () => {
      await pool.end();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      await pool.end();
      process.exit(1);
    });
}
