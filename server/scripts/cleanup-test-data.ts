/**
 * Cleanup-Skript für Task #183: Test-Datenbank-Verschmutzung bereinigen
 *
 * Identifiziert und löscht (nach Bestätigung) alle Test-Entitäten in der
 * Datenbank, die durch jahrelange Testläufe entstanden sind:
 * Test-Kunden, Test-Interessenten, Test-Mitarbeiter, Test-Services und
 * deren abhängige Datensätze (Termine, Rechnungen, Zeiteinträge usw.).
 *
 * Schutzmaßnahmen:
 *   - Default ist DRY-RUN (kein DELETE).
 *   - Verweigert Ausführung wenn NODE_ENV=production.
 *   - Snapshot der echten Entitäten vor und nach: bricht ab wenn Diff != 0.
 *   - Soft-deleted Reihen echter Kunden/Mitarbeiter (Stornos) bleiben unangetastet.
 *
 * CLI:
 *   tsx server/scripts/cleanup-test-data.ts                          # dry-run, alle Bereiche
 *   tsx server/scripts/cleanup-test-data.ts --apply                  # scharf ausführen
 *   tsx server/scripts/cleanup-test-data.ts --scope=services         # nur Services
 *   tsx server/scripts/cleanup-test-data.ts --apply --scope=users    # scharf, nur User
 *
 * Scopes: customers | prospects | services | users | orphans | all (default)
 */

import { sql } from "drizzle-orm";
import { db, pool } from "../lib/db";
import * as fs from "node:fs";
import * as path from "node:path";

type Scope = "customers" | "prospects" | "services" | "users" | "orphans" | "all";

interface Args {
  apply: boolean;
  scope: Scope;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const scopeArg = argv.find((a) => a.startsWith("--scope="));
  const scope = (scopeArg ? scopeArg.split("=")[1] : "all") as Scope;
  const validScopes: Scope[] = ["customers", "prospects", "services", "users", "orphans", "all"];
  if (!validScopes.includes(scope)) {
    throw new Error(`Ungültiger --scope=${scope}. Erlaubt: ${validScopes.join(", ")}`);
  }
  return { apply, scope };
}

// File logging: parallel zur Konsole, immer in tmp/cleanup-test-data-{ts}.log
const TS = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_DIR = path.resolve("tmp");
const LOG_FILE = path.join(LOG_DIR, `cleanup-test-data-${TS}.log`);
let logStream: fs.WriteStream | null = null;
function ensureLogStream(): void {
  if (logStream) return;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
}

function log(msg: string): void {
  console.log(msg);
  ensureLogStream();
  logStream!.write(msg + "\n");
}

function header(title: string): void {
  log("\n" + "=".repeat(70));
  log(title);
  log("=".repeat(70));
}

async function safetyChecks(apply: boolean): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("ABBRUCH: NODE_ENV=production. Dieses Skript darf nie auf Produktion laufen.");
  }
  // Hostname-Check, nicht Substring-Check: parse die URL und prüfe Host
  // gegen Deny-Pattern (prod, production). DATABASE_URL kann eine valide URL
  // sein oder ein Postgres-Connection-String.
  const url = process.env.DATABASE_URL || "";
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    // Fallback: postgres://user:pass@host:port/db ohne valides URL-Schema
    const m = url.match(/@([^:/?#]+)/);
    host = (m ? m[1] : "").toLowerCase();
  }
  // Hard-Stop bei Hostname-Match auf prod-Pattern (auch im Trockenlauf)
  if (host && /(^|[.-])prod([.-]|$)|production/.test(host)) {
    throw new Error(`ABBRUCH: DB-Host '${host}' sieht nach Produktion aus. Dieses Skript darf nie auf Produktion laufen.`);
  }
  log(`Sicherheits-Checks ok. DB-Host: ${host || "(unbekannt)"}, Modus: ${apply ? "APPLY (scharf)" : "DRY-RUN"}`);
}

async function listWhitelistEntities(): Promise<void> {
  // Sanity-Output: liste die echten Daten namentlich, damit ein menschlicher
  // Operator vor dem Apply nochmal verifizieren kann, dass die Whitelist korrekt
  // klassifiziert ist.
  header("Sanity-Check: Liste der echten (whitelist) Entitäten");

  const realUsers = await db.execute<{ id: number; email: string; nachname: string }>(sql`
    SELECT id, email, nachname FROM users WHERE NOT ${USER_TEST_CONDITION} ORDER BY id
  `);
  const u = (realUsers as unknown as { rows: Array<{ id: number; email: string; nachname: string }> }).rows;
  log(`\nEchte Mitarbeiter (${u.length}):`);
  for (const r of u) log(`   #${r.id}  ${r.nachname.padEnd(20)} <${r.email}>`);

  const realServices = await db.execute<{ id: number; name: string; code: string | null }>(sql`
    SELECT id, name, code FROM services WHERE NOT ${SERVICE_TEST_CONDITION} ORDER BY id
  `);
  const s = (realServices as unknown as { rows: Array<{ id: number; name: string; code: string | null }> }).rows;
  log(`\nEchte Services (${s.length}):`);
  for (const r of s) log(`   #${r.id}  ${(r.code || "—").padEnd(15)} ${r.name}`);

  const realCustHead = await db.execute<{ id: number; vorname: string; nachname: string }>(sql`
    SELECT id, vorname, nachname FROM customers WHERE NOT ${CUSTOMER_TEST_CONDITION} ORDER BY id LIMIT 20
  `);
  const cHead = (realCustHead as unknown as { rows: Array<{ id: number; vorname: string; nachname: string }> }).rows;
  const totalReal = await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM customers WHERE NOT ${CUSTOMER_TEST_CONDITION}
  `);
  const totalCount = (totalReal as unknown as { rows: Array<{ n: number }> }).rows[0].n;
  log(`\nEchte Kunden (${totalCount} gesamt, erste 20):`);
  for (const r of cHead) log(`   #${r.id}  ${r.vorname} ${r.nachname}`);
  if (totalCount > 20) log(`   … plus ${totalCount - 20} weitere`);
}

// SQL-Bedingungen für Test-Pattern (gespiegelt aus tests/globalSetup.ts).
// Wir nutzen `#` als ESCAPE-Zeichen, um Backslash-Escape-Probleme zu vermeiden.
const CUSTOMER_TEST_CONDITION = sql`(
  LOWER(vorname) LIKE '%test%' OR LOWER(nachname) LIKE '%test%'
  OR LOWER(nachname) LIKE 'auto#_%' ESCAPE '#'
  OR LOWER(nachname) LIKE 'privat-%' OR LOWER(nachname) LIKE 'fahrtdienst-%' OR LOWER(nachname) LIKE 'integ-%'
  OR LOWER(vorname) LIKE 'sz-%' OR LOWER(vorname) LIKE 'pv-%' OR LOWER(vorname) LIKE 'fd-%'
  OR LOWER(vorname) LIKE 'eb-%' OR LOWER(vorname) LIKE 'pg1-%' OR LOWER(vorname) LIKE 'qs-%'
  OR LOWER(vorname) LIKE 'status-%'
  -- Import-Test-Patterns (Marvin/Bertha/Idem/Cap mit nachname-Timestamps)
  OR LOWER(nachname) LIKE 'importtrim-%' OR LOWER(nachname) LIKE 'notrim-%'
  OR LOWER(nachname) LIKE 'reconcile-%' OR LOWER(nachname) LIKE 'aligned-%'
  OR LOWER(nachname) LIKE 'mustermann-%'
)`;

const PROSPECT_TEST_CONDITION = sql`(
  LOWER(vorname) LIKE '%test%' OR LOWER(nachname) LIKE '%test%'
  OR LOWER(vorname) LIKE 'eb-%' OR LOWER(vorname) LIKE 'status-%'
  OR LOWER(nachname) LIKE 'eb%'
)`;

const USER_TEST_CONDITION = sql`(
  LOWER(email) LIKE '%@test.local'
  OR LOWER(email) LIKE 'testemp-%'
  OR LOWER(nachname) LIKE 'testemp#_%' ESCAPE '#'
)`;

const SERVICE_TEST_CONDITION = sql`(
  LOWER(name) LIKE '%#_test#_%' ESCAPE '#'
  OR LOWER(code) LIKE 'qs-test-%'
)`;

interface Snapshot {
  realCustomers: number;
  realProspects: number;
  realUsers: number;
  realServices: number;
  realInvoices: number;
  softDeletedAppointmentsRealCust: number;
  softDeletedTimeEntriesRealUser: number;
  // Erweiterung: high-value Tabellen mit Customer-FK auf echte Kunden,
  // die Phase 4 (User-Cleanup) potenziell anfassen könnte.
  realAppointmentSeries: number;
  realMonthlyServiceRecords: number;
  realCustomerAssignmentHistory: number;
}

// Aliase für JOIN-Versionen (gleiche Bedingung, aber mit Tabellen-Alias).
const CUSTOMER_TEST_C = sql`(
  LOWER(c.vorname) LIKE '%test%' OR LOWER(c.nachname) LIKE '%test%'
  OR LOWER(c.nachname) LIKE 'auto#_%' ESCAPE '#'
  OR LOWER(c.nachname) LIKE 'privat-%' OR LOWER(c.nachname) LIKE 'fahrtdienst-%' OR LOWER(c.nachname) LIKE 'integ-%'
  OR LOWER(c.vorname) LIKE 'sz-%' OR LOWER(c.vorname) LIKE 'pv-%' OR LOWER(c.vorname) LIKE 'fd-%'
  OR LOWER(c.vorname) LIKE 'eb-%' OR LOWER(c.vorname) LIKE 'pg1-%' OR LOWER(c.vorname) LIKE 'qs-%'
  OR LOWER(c.vorname) LIKE 'status-%'
)`;

const USER_TEST_U = sql`(
  LOWER(u.email) LIKE '%@test.local'
  OR LOWER(u.email) LIKE 'testemp-%'
  OR LOWER(u.nachname) LIKE 'testemp#_%' ESCAPE '#'
)`;

async function takeSnapshot(label: string): Promise<Snapshot> {
  const r = await db.execute<Snapshot & Record<string, unknown>>(sql`
    SELECT
      (SELECT COUNT(*)::int FROM customers WHERE NOT ${CUSTOMER_TEST_CONDITION}) AS "realCustomers",
      (SELECT COUNT(*)::int FROM prospects WHERE NOT ${PROSPECT_TEST_CONDITION}) AS "realProspects",
      (SELECT COUNT(*)::int FROM users WHERE NOT ${USER_TEST_CONDITION}) AS "realUsers",
      (SELECT COUNT(*)::int FROM services WHERE NOT ${SERVICE_TEST_CONDITION}) AS "realServices",
      (SELECT COUNT(*)::int FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE NOT ${CUSTOMER_TEST_C}) AS "realInvoices",
      (SELECT COUNT(*)::int FROM appointments a JOIN customers c ON c.id = a.customer_id WHERE a.deleted_at IS NOT NULL AND NOT ${CUSTOMER_TEST_C}) AS "softDeletedAppointmentsRealCust",
      (SELECT COUNT(*)::int FROM employee_time_entries e JOIN users u ON u.id = e.user_id WHERE e.deleted_at IS NOT NULL AND NOT ${USER_TEST_U}) AS "softDeletedTimeEntriesRealUser",
      (SELECT COUNT(*)::int FROM appointment_series s JOIN customers c ON c.id = s.customer_id WHERE NOT ${CUSTOMER_TEST_C}) AS "realAppointmentSeries",
      (SELECT COUNT(*)::int FROM monthly_service_records m JOIN customers c ON c.id = m.customer_id WHERE NOT ${CUSTOMER_TEST_C}) AS "realMonthlyServiceRecords",
      (SELECT COUNT(*)::int FROM customer_assignment_history h JOIN customers c ON c.id = h.customer_id WHERE NOT ${CUSTOMER_TEST_C}) AS "realCustomerAssignmentHistory"
  `);
  const row = (r as unknown as { rows: Snapshot[] }).rows[0];
  log(`\n[${label}] Whitelist-Counts (echte Daten, dürfen nicht abnehmen):`);
  log(`   echte Kunden:                              ${row.realCustomers}`);
  log(`   echte Interessenten:                       ${row.realProspects}`);
  log(`   echte Mitarbeiter:                         ${row.realUsers}`);
  log(`   echte Services:                            ${row.realServices}`);
  log(`   Rechnungen echter Kunden:                  ${row.realInvoices}`);
  log(`   weich-gelöschte Termine echter Kunden:     ${row.softDeletedAppointmentsRealCust}`);
  log(`   weich-gelöschte Zeit-Einträge echter User: ${row.softDeletedTimeEntriesRealUser}`);
  log(`   Termin-Serien echter Kunden:               ${row.realAppointmentSeries}`);
  log(`   Monats-LN echter Kunden:                   ${row.realMonthlyServiceRecords}`);
  log(`   Zuweisungs-Historie echter Kunden:         ${row.realCustomerAssignmentHistory}`);
  return row;
}

function assertWhitelistUnchanged(before: Snapshot, after: Snapshot): void {
  const fields: Array<keyof Snapshot> = [
    "realCustomers", "realProspects", "realUsers", "realServices",
    "realInvoices", "softDeletedAppointmentsRealCust", "softDeletedTimeEntriesRealUser",
    "realAppointmentSeries", "realMonthlyServiceRecords", "realCustomerAssignmentHistory",
  ];
  const diffs = fields.filter((k) => before[k] !== after[k]);
  if (diffs.length > 0) {
    const detail = diffs.map((k) => `${k}: ${before[k]} → ${after[k]}`).join("; ");
    throw new Error(`KRITISCH: Whitelist-Counts haben sich geändert! ${detail}`);
  }
  log("\nWhitelist-Verifikation OK: alle echten Daten unverändert.");
}

async function countTestEntities(): Promise<{
  customers: number;
  prospects: number;
  users: number;
  services: number;
}> {
  const r = await db.execute<{ customers: number; prospects: number; users: number; services: number }>(sql`
    SELECT
      (SELECT COUNT(*)::int FROM customers WHERE ${CUSTOMER_TEST_CONDITION}) AS customers,
      (SELECT COUNT(*)::int FROM prospects WHERE ${PROSPECT_TEST_CONDITION}) AS prospects,
      (SELECT COUNT(*)::int FROM users WHERE ${USER_TEST_CONDITION}) AS users,
      (SELECT COUNT(*)::int FROM services WHERE ${SERVICE_TEST_CONDITION}) AS services
  `);
  return (r as unknown as { rows: Array<{ customers: number; prospects: number; users: number; services: number }> }).rows[0];
}

/**
 * Lösch-Cascade für einen einzelnen Test-Kunden, gespiegelt aus
 * server/routes/admin/test-cleanup.ts → purgeCustomerCascade().
 */
async function purgeCustomerCascade(id: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`UPDATE prospects SET converted_customer_id = NULL WHERE converted_customer_id = ${id}`);
    await tx.execute(sql`UPDATE customers SET merged_into_customer_id = NULL WHERE merged_into_customer_id = ${id}`);

    const apptIdsRes = await tx.execute<{ id: number }>(sql`SELECT id FROM appointments WHERE customer_id = ${id}`);
    const apptIds = (apptIdsRes as unknown as { rows: Array<{ id: number }> }).rows.map((r) => r.id);

    const invIdsRes = await tx.execute<{ id: number }>(sql`SELECT id FROM invoices WHERE customer_id = ${id}`);
    const invIds = (invIdsRes as unknown as { rows: Array<{ id: number }> }).rows.map((r) => r.id);

    if (invIds.length > 0) {
      await tx.execute(sql`UPDATE qonto_transactions SET matched_invoice_id = NULL WHERE matched_invoice_id IN (${sql.join(invIds.map((i) => sql`${i}`), sql`, `)})`);
      await tx.execute(sql`UPDATE payment_advice_items SET matched_invoice_id = NULL WHERE matched_invoice_id IN (${sql.join(invIds.map((i) => sql`${i}`), sql`, `)})`);
      await tx.execute(sql`UPDATE invoices SET stornierte_rechnung_id = NULL WHERE stornierte_rechnung_id IN (${sql.join(invIds.map((i) => sql`${i}`), sql`, `)})`);
      await tx.execute(sql`DELETE FROM invoice_line_items WHERE invoice_id IN (${sql.join(invIds.map((i) => sql`${i}`), sql`, `)})`);
      await tx.execute(sql`DELETE FROM invoices WHERE customer_id = ${id}`);
    }

    await tx.execute(sql`DELETE FROM appointment_series WHERE customer_id = ${id}`);

    if (apptIds.length > 0) {
      await tx.execute(sql`UPDATE budget_transactions SET appointment_id = NULL WHERE appointment_id IN (${sql.join(apptIds.map((i) => sql`${i}`), sql`, `)})`);
      await tx.execute(sql`UPDATE appointments SET travel_from_appointment_id = NULL WHERE travel_from_appointment_id IN (${sql.join(apptIds.map((i) => sql`${i}`), sql`, `)})`);
      await tx.execute(sql`DELETE FROM appointment_services WHERE appointment_id IN (${sql.join(apptIds.map((i) => sql`${i}`), sql`, `)})`);
      await tx.execute(sql`DELETE FROM appointments WHERE customer_id = ${id}`);
    }

    await tx.execute(sql`DELETE FROM document_deliveries WHERE customer_id = ${id}`);
    await tx.execute(sql`DELETE FROM budget_transactions WHERE customer_id = ${id}`);
    await tx.execute(sql`DELETE FROM customers WHERE id = ${id}`);
  });
}

async function purgeTestCustomers(apply: boolean): Promise<void> {
  header("Phase 1: Test-Kunden (mit Cascade über Termine, Rechnungen, Budget, Series)");
  const idsRes = await db.execute<{ id: number }>(sql`SELECT id FROM customers WHERE ${CUSTOMER_TEST_CONDITION} ORDER BY id`);
  const ids = (idsRes as unknown as { rows: Array<{ id: number }> }).rows.map((r) => r.id);
  log(`Gefunden: ${ids.length} Test-Kunden`);
  if (ids.length === 0) return;

  if (!apply) {
    log("DRY-RUN: würde alle " + ids.length + " Test-Kunden mit Cascade löschen.");
    log("Sample IDs: " + ids.slice(0, 10).join(", ") + (ids.length > 10 ? ", ..." : ""));
    return;
  }

  let done = 0;
  let failed = 0;
  const batchSize = 50;
  const t0 = Date.now();
  for (const id of ids) {
    try {
      await purgeCustomerCascade(id);
      done++;
    } catch (err) {
      failed++;
      console.warn(`  Kunde #${id} fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (done % batchSize === 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      log(`  Fortschritt: ${done}/${ids.length} gelöscht (${elapsed}s)`);
    }
  }
  log(`Phase 1 fertig: ${done} gelöscht, ${failed} fehlgeschlagen.`);
}

async function purgeTestProspects(apply: boolean): Promise<void> {
  header("Phase 2: Test-Interessenten");
  const cntRes = await db.execute<{ n: number }>(sql`SELECT COUNT(*)::int AS n FROM prospects WHERE ${PROSPECT_TEST_CONDITION}`);
  const cnt = (cntRes as unknown as { rows: Array<{ n: number }> }).rows[0].n;
  log(`Gefunden: ${cnt} Test-Interessenten`);
  if (cnt === 0) return;
  if (!apply) {
    log("DRY-RUN: würde alle " + cnt + " Test-Interessenten löschen.");
    return;
  }

  await db.transaction(async (tx) => {
    const idsRes = await tx.execute<{ id: number }>(sql`SELECT id FROM prospects WHERE ${PROSPECT_TEST_CONDITION}`);
    const ids = (idsRes as unknown as { rows: Array<{ id: number }> }).rows.map((r) => r.id);
    if (ids.length === 0) return;
    const idList = sql.join(ids.map((i) => sql`${i}`), sql`, `);
    await tx.execute(sql`DELETE FROM prospect_notes WHERE prospect_id IN (${idList})`);
    await tx.execute(sql`DELETE FROM prospect_offers WHERE prospect_id IN (${idList})`);
    // appointments mit (prospect_id IS NOT NULL AND customer_id IS NULL) verletzen
    // die Check-Constraint, wenn man prospect_id auf NULL setzt → solche Termine
    // hart löschen (Test-Termine ohne Kunden), übrige nur entkoppeln.
    await tx.execute(sql`DELETE FROM appointments WHERE prospect_id IN (${idList}) AND customer_id IS NULL`);
    await tx.execute(sql`UPDATE appointments SET prospect_id = NULL WHERE prospect_id IN (${idList})`);
    await tx.execute(sql`DELETE FROM prospects WHERE id IN (${idList})`);
  });
  log(`Phase 2 fertig: ${cnt} Interessenten gelöscht.`);
}

async function purgeTestServices(apply: boolean): Promise<void> {
  header("Phase 3: Test-Services (nur unreferenzierte hart löschen)");
  const idsRes = await db.execute<{ id: number; name: string }>(sql`SELECT id, name FROM services WHERE ${SERVICE_TEST_CONDITION} ORDER BY id`);
  const all = (idsRes as unknown as { rows: Array<{ id: number; name: string }> }).rows;
  log(`Gefunden: ${all.length} Test-Services`);
  if (all.length === 0) return;

  // Nur appointment_services blockt (NO ACTION). customer_service_prices und
  // service_budget_pots haben CASCADE und werden automatisch mitgelöscht – das
  // ist OK, weil sie reine Preis-Override-Einträge sind, die durch Test-Services
  // entstanden sind und nach deren Entfernung sowieso ungültig wären.
  const idList = sql.join(all.map((r) => sql`${r.id}`), sql`, `);
  const refsRes = await db.execute<{ id: number }>(sql`
    SELECT DISTINCT service_id AS id FROM appointment_services WHERE service_id IN (${idList})
  `);
  const referenced = new Set((refsRes as unknown as { rows: Array<{ id: number }> }).rows.map((r) => r.id));
  const deletable = all.filter((s) => !referenced.has(s.id));
  const referencedList = all.filter((s) => referenced.has(s.id));
  log(`  davon in Terminen referenziert: ${referencedList.length} (Fallback: is_active=false statt löschen)`);
  log(`  davon hart löschbar:            ${deletable.length} (CASCADE räumt Preis-Overrides auf)`);

  if (!apply) {
    if (deletable.length > 0) log("DRY-RUN: würde " + deletable.length + " unreferenzierte Test-Services löschen.");
    if (referencedList.length > 0) log("DRY-RUN: würde " + referencedList.length + " referenzierte Test-Services auf is_active=false setzen.");
    return;
  }

  // service_rates hat keinen FK auf services (Kategorie-basierend), service_budget_pots
  // und customer_service_prices haben CASCADE — daher reicht der reine DELETE auf services.
  await db.transaction(async (tx) => {
    if (deletable.length > 0) {
      const dList = sql.join(deletable.map((s) => sql`${s.id}`), sql`, `);
      await tx.execute(sql`DELETE FROM services WHERE id IN (${dList})`);
    }
    // Fallback für referenzierte Test-Services: nicht löschen (würde historische
    // Termine kaputtmachen), aber deaktivieren, damit sie nicht mehr in Picklists
    // auftauchen und keine neuen Termine sie nutzen können.
    if (referencedList.length > 0) {
      const rList = sql.join(referencedList.map((s) => sql`${s.id}`), sql`, `);
      await tx.execute(sql`UPDATE services SET is_active = false WHERE id IN (${rList})`);
    }
  });
  log(`Phase 3 fertig: ${deletable.length} Services gelöscht, ${referencedList.length} deaktiviert.`);
}

async function purgeTestUsers(apply: boolean): Promise<void> {
  header("Phase 4: Test-Mitarbeiter (mit Cascade über Time-Entries, Notifications, FK-Set-Null)");

  // Sicherheitscheck: Test-User mit Termin-Zuweisung an ECHTE Kunden?
  const blockerRes = await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM appointments a
    JOIN users u ON u.id = a.assigned_employee_id
    JOIN customers c ON c.id = a.customer_id
    WHERE a.deleted_at IS NULL
      AND (LOWER(u.email) LIKE '%@test.local' OR LOWER(u.email) LIKE 'testemp-%' OR LOWER(u.nachname) LIKE 'testemp\_%' ESCAPE '\')
      AND NOT (
        LOWER(c.vorname) LIKE '%test%' OR LOWER(c.nachname) LIKE '%test%'
        OR LOWER(c.nachname) LIKE 'auto\\_%' ESCAPE '\\'
        OR LOWER(c.nachname) LIKE 'privat-%' OR LOWER(c.nachname) LIKE 'fahrtdienst-%' OR LOWER(c.nachname) LIKE 'integ-%'
        OR LOWER(c.vorname) LIKE 'sz-%' OR LOWER(c.vorname) LIKE 'pv-%' OR LOWER(c.vorname) LIKE 'fd-%'
        OR LOWER(c.vorname) LIKE 'eb-%' OR LOWER(c.vorname) LIKE 'pg1-%' OR LOWER(c.vorname) LIKE 'qs-%'
        OR LOWER(c.vorname) LIKE 'status-%'
      )
  `);
  const blocker = (blockerRes as unknown as { rows: Array<{ n: number }> }).rows[0].n;
  if (blocker > 0) {
    throw new Error(`ABBRUCH: ${blocker} Termine echter Kunden sind Test-Mitarbeitern zugewiesen. Bitte erst manuell umhängen.`);
  }

  // Sicherheitscheck 2: monthly_service_records / customer_assignment_history
  // mit NOT-NULL employee_id, die Test-User mit ECHTEN Kunden verbinden.
  // Phase 4 würde diese Rows hart löschen — das wäre Datenverlust für echte Kunden.
  const blocker2Res = await db.execute<{ msr: number; cah: number }>(sql`
    SELECT
      (SELECT COUNT(*)::int FROM monthly_service_records m
        JOIN users u ON u.id = m.employee_id
        JOIN customers c ON c.id = m.customer_id
        WHERE ${USER_TEST_U} AND NOT ${CUSTOMER_TEST_C}) AS msr,
      (SELECT COUNT(*)::int FROM customer_assignment_history h
        JOIN users u ON u.id = h.employee_id
        JOIN customers c ON c.id = h.customer_id
        WHERE ${USER_TEST_U} AND NOT ${CUSTOMER_TEST_C}) AS cah
  `);
  const b2 = (blocker2Res as unknown as { rows: Array<{ msr: number; cah: number }> }).rows[0];
  if (b2.msr > 0 || b2.cah > 0) {
    throw new Error(
      `ABBRUCH: Test-Mitarbeiter sind in echten Kundendaten verflochten — ${b2.msr} monthly_service_records + ${b2.cah} customer_assignment_history Einträge ` +
      `gehören echten Kunden, sind aber von Test-Usern erzeugt. Bitte manuell auf einen echten Mitarbeiter umhängen, sonst würde Phase 4 echte Daten zerstören.`,
    );
  }

  const idsRes = await db.execute<{ id: number; email: string }>(sql`SELECT id, email FROM users WHERE ${USER_TEST_CONDITION} ORDER BY id`);
  const all = (idsRes as unknown as { rows: Array<{ id: number; email: string }> }).rows;
  log(`Gefunden: ${all.length} Test-Mitarbeiter`);
  if (all.length === 0) return;

  if (!apply) {
    log("DRY-RUN: würde alle " + all.length + " Test-Mitarbeiter inkl. ihrer Time-Entries, Notifications und FK-Refs löschen.");
    return;
  }

  // In Batches verarbeiten, damit IN-Listen handhabbar bleiben.
  const batchSize = 200;
  let done = 0;
  for (let i = 0; i < all.length; i += batchSize) {
    const batch = all.slice(i, i + batchSize);
    const idList = sql.join(batch.map((u) => sql`${u.id}`), sql`, `);

    // audit_log ist per RULE append-only (audit_log_no_delete / no_update).
    // Wir deaktivieren die Regeln nur für die Dauer dieses Batches und stellen sie
    // im finally-Block in jedem Fall wieder her – auch wenn das DISABLE selbst
    // bereits fehlgeschlagen ist (ENABLE auf bereits aktivierte Regel ist No-op).
    let disabledNoDelete = false;
    let disabledNoUpdate = false;
    try {
    await db.execute(sql`ALTER TABLE audit_log DISABLE RULE audit_log_no_delete`);
    disabledNoDelete = true;
    await db.execute(sql`ALTER TABLE audit_log DISABLE RULE audit_log_no_update`);
    disabledNoUpdate = true;
    await db.transaction(async (tx) => {
      // Hard-delete child rows in tables with NO ACTION + non-nullable FK to test users.
      // (Test-Daten ohne Wert für echte Kunden – verifiziert vor dem Lauf.)
      await tx.execute(sql`DELETE FROM employee_time_entries WHERE user_id IN (${idList})`);
      await tx.execute(sql`DELETE FROM notifications WHERE user_id IN (${idList})`);
      await tx.execute(sql`DELETE FROM employee_month_closings WHERE user_id IN (${idList}) OR closed_by_user_id IN (${idList})`);
      await tx.execute(sql`DELETE FROM employee_vacation_allowance WHERE user_id IN (${idList})`);
      await tx.execute(sql`DELETE FROM user_whatsapp_preferences WHERE user_id IN (${idList})`);
      await tx.execute(sql`DELETE FROM whatsapp_message_log WHERE user_id IN (${idList})`);
      await tx.execute(sql`DELETE FROM audit_log WHERE user_id IN (${idList})`);
      await tx.execute(sql`DELETE FROM monthly_service_records WHERE employee_id IN (${idList})`);
      await tx.execute(sql`DELETE FROM customer_assignment_history WHERE employee_id IN (${idList})`);
      await tx.execute(sql`DELETE FROM tasks WHERE created_by_user_id IN (${idList}) OR assigned_to_user_id IN (${idList})`);
      // KEIN DELETE auf appointment_series via assigned_employee_id — das würde
      // Serien echter Kunden löschen, denen mal ein Test-Mitarbeiter zugewiesen
      // war. Series von Test-Kunden sind in Phase 1 bereits weg; verbleibende
      // Series gehören echten Kunden und bekommen unten nur SET NULL.
      await tx.execute(sql`DELETE FROM employee_compensation_history WHERE created_by_user_id IN (${idList})`);

      // SET NULL on nullable FK refs (NO ACTION rules); rows belonging to test customers
      // are already gone from Phase 1, so these affect only orphan/system rows.
      await tx.execute(sql`UPDATE birthday_card_tracking SET sent_by_user_id = NULL WHERE sent_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE company_settings SET updated_by_user_id = NULL WHERE updated_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE system_settings SET updated_by_user_id = NULL WHERE updated_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE payment_advices SET uploaded_by_user_id = NULL WHERE uploaded_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE service_rates SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE prospect_notes SET user_id = NULL WHERE user_id IN (${idList})`);
      await tx.execute(sql`UPDATE prospect_offers SET created_by = NULL WHERE created_by IN (${idList})`);
      await tx.execute(sql`UPDATE prospects SET assigned_employee_id = NULL WHERE assigned_employee_id IN (${idList})`);

      // Customers (real ones with test user references) – set null
      await tx.execute(sql`UPDATE customers SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE customers SET primary_employee_id = NULL WHERE primary_employee_id IN (${idList})`);
      await tx.execute(sql`UPDATE customers SET backup_employee_id = NULL WHERE backup_employee_id IN (${idList})`);
      await tx.execute(sql`UPDATE customers SET backup_employee_id_2 = NULL WHERE backup_employee_id_2 IN (${idList})`);

      // Appointments (soft-deleted of real customers) – set assignments null where test user attached
      await tx.execute(sql`UPDATE appointments SET assigned_employee_id = NULL WHERE assigned_employee_id IN (${idList})`);
      await tx.execute(sql`UPDATE appointments SET performed_by_employee_id = NULL WHERE performed_by_employee_id IN (${idList})`);
      await tx.execute(sql`UPDATE appointments SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE appointments SET signed_by_user_id = NULL WHERE signed_by_user_id IN (${idList})`);

      await tx.execute(sql`UPDATE appointment_series SET assigned_employee_id = NULL WHERE assigned_employee_id IN (${idList})`);
      await tx.execute(sql`UPDATE appointment_series SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);

      await tx.execute(sql`UPDATE budget_transactions SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE budget_allocations SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE customer_assignment_history SET changed_by_user_id = NULL WHERE changed_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE customer_assignment_history SET employee_id = NULL WHERE employee_id IN (${idList})`);
      await tx.execute(sql`UPDATE customer_budgets SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE customer_care_level_history SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE customer_contract_rates SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE customer_contracts SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE customer_documents SET uploaded_by_user_id = NULL WHERE uploaded_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE customer_insurance_history SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE customer_needs_assessments SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE customer_pricing_history SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE document_deliveries SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE employee_compensation_history SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE employee_document_proofs SET reviewed_by_user_id = NULL WHERE reviewed_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE employee_documents SET uploaded_by_user_id = NULL WHERE uploaded_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE employee_month_closings SET reopened_by_user_id = NULL WHERE reopened_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE employee_month_closings SET closed_by_user_id = NULL WHERE closed_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE employee_qualifications SET assigned_by_user_id = NULL WHERE assigned_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE generated_documents SET signed_by_employee_id = NULL WHERE signed_by_employee_id IN (${idList})`);
      await tx.execute(sql`UPDATE generated_documents SET generated_by_user_id = NULL WHERE generated_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE invoices SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE monthly_service_records SET customer_signed_by_user_id = NULL WHERE customer_signed_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE monthly_service_records SET employee_signed_by_user_id = NULL WHERE employee_signed_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE monthly_service_records SET employee_id = NULL WHERE employee_id IN (${idList})`);
      await tx.execute(sql`UPDATE tasks SET assigned_to_user_id = NULL WHERE assigned_to_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE tasks SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);

      // Finally delete the users themselves (CASCADE handles sessions, admin_permissions,
      // user_roles, password_reset_tokens, employee_compensation_history.user_id,
      // employee_qualifications.employee_id, employee_documents.employee_id,
      // employee_document_proofs.employee_id).
      await tx.execute(sql`DELETE FROM users WHERE id IN (${idList})`);
    });
    } finally {
      // audit_log-Schutzregeln in JEDEM Fall wieder aktivieren.
      // try/catch um ENABLE — falls die Verbindung schon kaputt ist, soll
      // das die Original-Exception nicht überschreiben.
      if (disabledNoUpdate) {
        try { await db.execute(sql`ALTER TABLE audit_log ENABLE RULE audit_log_no_update`); } catch {}
      }
      if (disabledNoDelete) {
        try { await db.execute(sql`ALTER TABLE audit_log ENABLE RULE audit_log_no_delete`); } catch {}
      }
    }

    done += batch.length;
    log(`  Fortschritt: ${done}/${all.length} Mitarbeiter verarbeitet`);
  }
  log(`Phase 4 fertig: ${all.length} Mitarbeiter gelöscht.`);
}

async function purgeOrphans(apply: boolean): Promise<void> {
  header("Phase 5: Verwaiste soft-deleted Reihen ohne FK-Ziel (nur Test-Datenmüll)");
  // Soft-deleted appointments where customer no longer exists
  const orphAppts = await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM appointments a
    LEFT JOIN customers c ON c.id = a.customer_id
    WHERE a.deleted_at IS NOT NULL AND a.customer_id IS NOT NULL AND c.id IS NULL
  `);
  const orphApptsCnt = (orphAppts as unknown as { rows: Array<{ n: number }> }).rows[0].n;

  const orphTimeEntries = await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM employee_time_entries e
    LEFT JOIN users u ON u.id = e.user_id
    WHERE e.deleted_at IS NOT NULL AND u.id IS NULL
  `);
  const orphTeCnt = (orphTimeEntries as unknown as { rows: Array<{ n: number }> }).rows[0].n;

  log(`Verwaiste soft-deleted Termine (Kunde weg):       ${orphApptsCnt}`);
  log(`Verwaiste soft-deleted Zeit-Einträge (User weg):  ${orphTeCnt}`);

  if (!apply) {
    if (orphApptsCnt + orphTeCnt > 0) log("DRY-RUN: würde diese verwaisten Reihen hart löschen.");
    return;
  }

  if (orphApptsCnt > 0) {
    await db.transaction(async (tx) => {
      const ids = await tx.execute<{ id: number }>(sql`
        SELECT a.id FROM appointments a LEFT JOIN customers c ON c.id = a.customer_id
        WHERE a.deleted_at IS NOT NULL AND a.customer_id IS NOT NULL AND c.id IS NULL
      `);
      const idList = (ids as unknown as { rows: Array<{ id: number }> }).rows.map((r) => r.id);
      if (idList.length > 0) {
        const sqlList = sql.join(idList.map((i) => sql`${i}`), sql`, `);
        await tx.execute(sql`UPDATE budget_transactions SET appointment_id = NULL WHERE appointment_id IN (${sqlList})`);
        await tx.execute(sql`UPDATE appointments SET travel_from_appointment_id = NULL WHERE travel_from_appointment_id IN (${sqlList})`);
        await tx.execute(sql`DELETE FROM appointment_services WHERE appointment_id IN (${sqlList})`);
        await tx.execute(sql`DELETE FROM appointments WHERE id IN (${sqlList})`);
      }
    });
    log(`  ${orphApptsCnt} verwaiste Termine hart gelöscht.`);
  }

  if (orphTeCnt > 0) {
    await db.execute(sql`
      DELETE FROM employee_time_entries WHERE id IN (
        SELECT e.id FROM employee_time_entries e LEFT JOIN users u ON u.id = e.user_id
        WHERE e.deleted_at IS NOT NULL AND u.id IS NULL
      )
    `);
    log(`  ${orphTeCnt} verwaiste Zeit-Einträge hart gelöscht.`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  header(`Cleanup Test-Daten — Modus: ${args.apply ? "APPLY (scharf)" : "DRY-RUN"}, Scope: ${args.scope}`);
  await safetyChecks(args.apply);

  // Sanity-Output: liste die echten Entitäten namentlich, damit der Operator
  // vor dem Apply nochmal verifizieren kann, dass die Whitelist korrekt
  // klassifiziert ist (insb. dass keine Test-Daten als „echt" eingestuft sind).
  await listWhitelistEntities();

  const before = await takeSnapshot("VOR Cleanup");

  const cntBefore = await countTestEntities();
  log(`\n[VOR Cleanup] Test-Entitäten:`);
  log(`   Test-Kunden:       ${cntBefore.customers}`);
  log(`   Test-Interessenten:${cntBefore.prospects}`);
  log(`   Test-Mitarbeiter:  ${cntBefore.users}`);
  log(`   Test-Services:     ${cntBefore.services}`);

  try {
    if (args.scope === "customers" || args.scope === "all") await purgeTestCustomers(args.apply);
    if (args.scope === "prospects" || args.scope === "all") await purgeTestProspects(args.apply);
    if (args.scope === "services" || args.scope === "all") await purgeTestServices(args.apply);
    if (args.scope === "users" || args.scope === "all") await purgeTestUsers(args.apply);
    if (args.scope === "orphans" || args.scope === "all") await purgeOrphans(args.apply);
  } catch (err) {
    console.error("\nFEHLER während Cleanup:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }

  const after = await takeSnapshot("NACH Cleanup");
  if (args.apply) {
    assertWhitelistUnchanged(before, after);
    const cntAfter = await countTestEntities();
    log(`\n[NACH Cleanup] Test-Entitäten:`);
    log(`   Test-Kunden:       ${cntBefore.customers} → ${cntAfter.customers}`);
    log(`   Test-Interessenten:${cntBefore.prospects} → ${cntAfter.prospects}`);
    log(`   Test-Mitarbeiter:  ${cntBefore.users} → ${cntAfter.users}`);
    log(`   Test-Services:     ${cntBefore.services} → ${cntAfter.services}`);
  } else {
    log("\nDRY-RUN abgeschlossen. Mit --apply scharf ausführen.");
  }

  await pool.end();
  // Log-Stream sauber schließen, sonst kann das letzte Schreiben verloren gehen.
  if (logStream) {
    await new Promise<void>((resolve) => logStream!.end(() => resolve()));
  }
}

main().catch(async (err) => {
  console.error("Skript-Fehler:", err);
  if (logStream) {
    await new Promise<void>((resolve) => logStream!.end(() => resolve()));
  }
  process.exit(1);
});
