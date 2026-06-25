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
  isProductionEnv,
  runTestDataCleanup,
  findTestCustomerIds,
  findTestUserIds,
  PROSPECT_TEST_FILTER,
} from "../services/test-data-cleanup";
import { prospects } from "@shared/schema";

// Prod-Pattern auf dem Hostnamen — zeichengleich zu den Shell-Guards in
// scripts/reseed-dev-db.sh und scripts/backup-dev-db.sh.
export const PROD_HOST_PATTERN = /(^|[.-])prod([.-]|$)|production/;

export function dbHostOf(url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    // Fallback: postgres://user:pass@host:port/db ohne valides URL-Schema.
    const m = url.match(/@([^:/?#]+)/);
    host = (m ? m[1] : "").toLowerCase();
  }
  return host;
}

export function assertDevDatabase(): void {
  if (isProductionEnv()) {
    throw new Error("ABBRUCH: NODE_ENV=production. db:sweep-dev läuft nur gegen die Dev-DB.");
  }
  const url = process.env.DATABASE_URL || "";
  if (!url) {
    throw new Error("ABBRUCH: DATABASE_URL ist nicht gesetzt.");
  }
  const devHost = dbHostOf(url);
  // Fail-closed: ohne ermittelbaren Host können die Prod-Guards nicht greifen.
  if (!devHost) {
    throw new Error("ABBRUCH: DB-Host konnte aus DATABASE_URL nicht extrahiert werden (fail-closed).");
  }
  if (PROD_HOST_PATTERN.test(devHost)) {
    throw new Error(`ABBRUCH: DB-Host '${devHost}' sieht nach Produktion aus. Verweigert.`);
  }
  const prodUrl = process.env.PROD_DATABASE_URL || "";
  if (prodUrl) {
    const prodHost = dbHostOf(prodUrl);
    if (prodHost && devHost === prodHost) {
      throw new Error(`ABBRUCH: DATABASE_URL-Host == PROD_DATABASE_URL-Host ('${devHost}'). Verweigert.`);
    }
  }
  console.log(`Sicherheits-Checks ok. Dev-DB-Host: ${devHost}`);
}

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
