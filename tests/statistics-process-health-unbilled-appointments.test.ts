/**
 * Task #1530 — "Noch abzurechnen" (records-without-invoice) muss termin-genau sein.
 *
 * Der Prozess-Gesundheits-Safety-Net listet abgeschlossene (kunden-unterschriebene)
 * Leistungsnachweise, deren Termine noch auf keiner aktiven Rechnung stehen. Früher
 * war die Prüfung period-grob: sobald für Kunde+Jahr+Monat IRGENDEINE aktive Rechnung
 * existierte, verschwand JEDER Nachweis dieses Zeitraums aus der Liste — auch wenn ein
 * Geschwister-Nachweis bzw. der Rest nach einer Teil-Abrechnung nie abgerechnet wurde.
 *
 * Jetzt termin-genau (gleiche SSoT-Regel wie die Abrechnungs-Engine,
 * `getAlreadyInvoicedAppointmentIds`): ein Nachweis bleibt sichtbar, solange er noch
 * mindestens einen Termin hat, der auf KEINER aktiven (nicht `storniert`, keine
 * `stornorechnung`) Rechnung als Line-Item steht.
 *
 * Diese Tests seeden gezielt einen isolierten historischen Zeitraum (2021-03) direkt
 * per DB-Insert und prüfen die exportierte SSoT-Leseschicht `listRecordsWithoutInvoice`
 * sowie den KPI-Zähler in `getProcessHealthSummary`. Assertions filtern auf die eigens
 * angelegten Kunden, damit Fremddaten/Parallelität die Aussage nicht verfälschen.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../server/lib/db";
import { getAuthCookie, createTestCustomer, createTestEmployee, cleanupCustomer } from "./test-utils";
import {
  listRecordsWithoutInvoice,
  getProcessHealthSummary,
} from "../server/storage/statistics/process-health";
import { resolvePeriod } from "../server/storage/statistics/common";

const YEAR = 2021;
const MONTH = 3;
const PERIOD = resolvePeriod({ year: YEAR, month: MONTH });

let employeeId: number;
const customerIds: number[] = [];
const uniq = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
let invSeq = 0;

async function insertAppointment(customerId: number, day: number): Promise<number> {
  const date = `${YEAR}-${String(MONTH).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const r = await db.execute(sql`
    INSERT INTO appointments (customer_id, appointment_type, date, scheduled_start, duration_promised, status)
    VALUES (${customerId}, 'kundentermin', ${date}::date, '09:00', 60, 'completed')
    RETURNING id
  `);
  return Number((r.rows[0] as { id: number }).id);
}

async function insertCompletedRecord(customerId: number, appointmentIds: number[]): Promise<number> {
  const r = await db.execute(sql`
    INSERT INTO monthly_service_records (customer_id, employee_id, year, month, record_type, status)
    VALUES (${customerId}, ${employeeId}, ${YEAR}, ${MONTH}, 'monthly', 'completed')
    RETURNING id
  `);
  const recordId = Number((r.rows[0] as { id: number }).id);
  for (const apptId of appointmentIds) {
    await db.execute(sql`
      INSERT INTO service_record_appointments (service_record_id, appointment_id)
      VALUES (${recordId}, ${apptId})
    `);
  }
  return recordId;
}

async function insertInvoiceWithLines(
  customerId: number,
  appointmentIds: number[],
  opts: { status?: string; invoiceType?: string } = {},
): Promise<number> {
  const status = opts.status ?? "entwurf";
  const invoiceType = opts.invoiceType ?? "rechnung";
  const number = `T1530-${uniq}-${invSeq++}`;
  const r = await db.execute(sql`
    INSERT INTO invoices (invoice_number, customer_id, billing_type, invoice_type, billing_month, billing_year, recipient_name, status)
    VALUES (${number}, ${customerId}, 'selbstzahler', ${invoiceType}, ${MONTH}, ${YEAR}, 'Testempfänger', ${status})
    RETURNING id
  `);
  const invoiceId = Number((r.rows[0] as { id: number }).id);
  for (const apptId of appointmentIds) {
    await db.execute(sql`
      INSERT INTO invoice_line_items (invoice_id, appointment_id, appointment_date, service_description, duration_minutes, unit_price_cents, total_cents)
      VALUES (${invoiceId}, ${apptId}, ${`${YEAR}-${String(MONTH).padStart(2, "0")}-15`}::date, 'Testleistung', 60, 3500, 3500)
    `);
  }
  return invoiceId;
}

async function isRecordListed(recordId: number): Promise<boolean> {
  const rows = await listRecordsWithoutInvoice(PERIOD);
  return rows.some((r) => r.serviceRecordId === recordId);
}

async function countListedForRecord(recordId: number): Promise<number> {
  const rows = await listRecordsWithoutInvoice(PERIOD);
  return rows.filter((r) => r.serviceRecordId === recordId).length;
}

beforeAll(async () => {
  await getAuthCookie();
  const emp = await createTestEmployee({ nachnamePrefix: "t1530" });
  employeeId = emp.id;
});

afterAll(async () => {
  for (const id of customerIds) {
    await cleanupCustomer(id);
  }
});

describe("Task #1530 – records-without-invoice ist termin-genau", () => {
  it("zeigt einen Nachweis, dessen Termin nicht abgerechnet ist, OBWOHL für den Monat schon eine Geschwister-Rechnung existiert", async () => {
    const c = await createTestCustomer();
    customerIds.push(c.id);
    const a1 = await insertAppointment(c.id, 3);
    const a2 = await insertAppointment(c.id, 10);
    // Ein Nachweis über beide Termine; Rechnung deckt NUR a1 ab → a2 bleibt offen.
    const record = await insertCompletedRecord(c.id, [a1, a2]);
    await insertInvoiceWithLines(c.id, [a1]);

    // Termin-genau: Nachweis bleibt sichtbar (a2 unberechnet). Period-grob hätte ihn versteckt.
    expect(await isRecordListed(record)).toBe(true);
    // Kein Doppelzählen: trotz zweier offener/teiloffener Termine genau EIN Listeneintrag.
    expect(await countListedForRecord(record)).toBe(1);
  });

  it("versteckt einen Nachweis, dessen sämtliche Termine abgerechnet sind", async () => {
    const c = await createTestCustomer();
    customerIds.push(c.id);
    const a1 = await insertAppointment(c.id, 4);
    const a2 = await insertAppointment(c.id, 11);
    const record = await insertCompletedRecord(c.id, [a1, a2]);
    await insertInvoiceWithLines(c.id, [a1, a2]);

    expect(await isRecordListed(record)).toBe(false);
  });

  it("ein zweiter unterschriebener Nachweis taucht auf, der bereits abgerechnete bleibt verborgen (Geschwister-Nachweise)", async () => {
    const c = await createTestCustomer();
    customerIds.push(c.id);
    const a1 = await insertAppointment(c.id, 5);
    const a2 = await insertAppointment(c.id, 12);
    const billed = await insertCompletedRecord(c.id, [a1]);
    const unbilled = await insertCompletedRecord(c.id, [a2]);
    // Rechnung deckt nur a1 (=billed-Nachweis) → erzeugt eine Geschwister-Rechnung für den Monat.
    await insertInvoiceWithLines(c.id, [a1]);

    expect(await isRecordListed(billed)).toBe(false);
    expect(await isRecordListed(unbilled)).toBe(true);
  });

  it("eine stornierte Rechnung gibt ihre Termine wieder frei", async () => {
    const c = await createTestCustomer();
    customerIds.push(c.id);
    const a1 = await insertAppointment(c.id, 6);
    const record = await insertCompletedRecord(c.id, [a1]);
    await insertInvoiceWithLines(c.id, [a1], { status: "storniert" });

    expect(await isRecordListed(record)).toBe(true);
  });

  it("eine Stornorechnung (invoice_type) zählt nicht als aktive Abrechnung", async () => {
    const c = await createTestCustomer();
    customerIds.push(c.id);
    const a1 = await insertAppointment(c.id, 7);
    const record = await insertCompletedRecord(c.id, [a1]);
    await insertInvoiceWithLines(c.id, [a1], { invoiceType: "stornorechnung" });

    expect(await isRecordListed(record)).toBe(true);
  });

  it("der KPI-Zähler bewegt sich, wenn der letzte offene Termin abgerechnet wird (Konsistenz Liste ⇄ Zähler)", async () => {
    const c = await createTestCustomer();
    customerIds.push(c.id);
    const a1 = await insertAppointment(c.id, 8);
    const record = await insertCompletedRecord(c.id, [a1]);

    const before = (await getProcessHealthSummary(PERIOD)).recordsWithoutInvoice.current;
    expect(await isRecordListed(record)).toBe(true);

    // Aktive Rechnung über a1 → Nachweis ist vollständig abgerechnet.
    await insertInvoiceWithLines(c.id, [a1]);
    const after = (await getProcessHealthSummary(PERIOD)).recordsWithoutInvoice.current;

    expect(await isRecordListed(record)).toBe(false);
    expect(after).toBe(before - 1);
  });
});
