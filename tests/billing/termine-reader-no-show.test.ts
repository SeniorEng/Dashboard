/**
 * Task #1593 — No-Show-Termine dürfen nie still aus der Abrechnungs-Termine-Liste
 * verschwinden.
 *
 * „Kunde nicht angetroffen" (customer_no_show) ist ein terminaler Side-Zustand,
 * der in der „Termine End-to-End"-Liste (`readBillingTermine`,
 * server/storage/billing/termine-reader.ts) als eigene, filterbare Stufe
 * `kunde_nicht_angetroffen` erscheinen MUSS — damit das Büro entgangene Termine
 * analysieren kann. Vor Task #1473 waren No-Shows aus dieser Liste
 * ausgeschlossen; ohne einen Pin könnte eine spätere Änderung am Reader sie
 * wieder still fallen lassen.
 *
 * Die subtile Regel, die hier festgenagelt wird (Priorität aus der Pipeline-SSoT
 * `assignAppointmentStage`, shared/domain/billing-pipeline.ts): ein No-Show wird
 * IMMER unter `kunde_nicht_angetroffen` gezeigt — auch dann, wenn er eine
 * (Ausfallgebühr-)Rechnung trägt. Der Side-Zustand hat Vorrang vor „bereits
 * abgerechnet", der Termin darf also nie in eine Rechnungs-Stufe abwandern.
 *
 * Gegenprobe: ein stornierter und ein normal abgeschlossener Termin dürfen NICHT
 * als No-Show auftauchen (schützt die Reihenfolge/Priorität).
 *
 * Läuft gegen eine echte (Ephemeral-)DB über den Test-Orchestrator; die Termine
 * werden direkt per DB-Insert geseedet und der Reader wird direkt aufgerufen.
 * Assertions filtern auf den frisch angelegten Test-Mitarbeiter, damit
 * Fremd-/Parallel-Testdaten in derselben Worker-DB die Aussage nicht verfälschen.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { readBillingTermine } from "../../server/storage/billing/termine-reader";
import type { BillingTermineAppointment } from "@shared/api/billing-termine";
import {
  cleanupCustomer,
  createTestCustomer,
  createTestEmployee,
  getAuthCookie,
  uniqueId,
} from "../test-utils";

// Isolierter historischer Monat (vollständig in der Vergangenheit), damit die
// Termine als abgeschlossene/terminale Zustände plausibel sind.
const YEAR = 2022;
const MONTH = 5;

let employeeId: number;
let customerId: number;
let invSeq = 0;
const uniq = uniqueId();

async function insertAppointment(
  day: number,
  status: string,
): Promise<number> {
  const date = `${YEAR}-${String(MONTH).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const r = await db.execute(sql`
    INSERT INTO appointments (
      customer_id, appointment_type, date, scheduled_start, duration_promised,
      status, assigned_employee_id, performed_by_employee_id
    )
    VALUES (
      ${customerId}, 'kundentermin', ${date}::date, '09:00', 60,
      ${status}, ${employeeId}, ${employeeId}
    )
    RETURNING id
  `);
  return Number((r.rows[0] as { id: number }).id);
}

// Erzeugt eine aktive (nicht-stornierte) Rechnung mit einem Line-Item auf dem
// Termin — spiegelt eine No-Show-Ausfallgebühr wider.
async function insertFeeInvoice(appointmentId: number): Promise<number> {
  const number = `T1593-${uniq}-${invSeq++}`;
  const r = await db.execute(sql`
    INSERT INTO invoices (
      invoice_number, customer_id, billing_type, invoice_type,
      billing_month, billing_year, recipient_name, status
    )
    VALUES (
      ${number}, ${customerId}, 'selbstzahler', 'rechnung',
      ${MONTH}, ${YEAR}, 'Testempfänger', 'entwurf'
    )
    RETURNING id
  `);
  const invoiceId = Number((r.rows[0] as { id: number }).id);
  await db.execute(sql`
    INSERT INTO invoice_line_items (
      invoice_id, appointment_id, appointment_date, service_description,
      duration_minutes, unit_price_cents, total_cents
    )
    VALUES (
      ${invoiceId}, ${appointmentId},
      ${`${YEAR}-${String(MONTH).padStart(2, "0")}-15`}::date, 'Ausfallgebühr',
      0, 2000, 2000
    )
  `);
  return invoiceId;
}

async function readMyAppointments(): Promise<BillingTermineAppointment[]> {
  const res = await readBillingTermine(YEAR, MONTH, { employeeId });
  const group = res.employees.find((g) => g.employeeId === employeeId);
  return group?.appointments ?? [];
}

beforeAll(async () => {
  await getAuthCookie();
  const emp = await createTestEmployee({ nachnamePrefix: "t1593" });
  employeeId = emp.id;
  const c = await createTestCustomer();
  customerId = c.id as number;
});

afterAll(async () => {
  await cleanupCustomer(customerId);
});

describe("Task #1593 – No-Shows verschwinden nie aus der Termine-Liste", () => {
  it("ein No-Show OHNE Rechnung landet in Stufe kunde_nicht_angetroffen", async () => {
    const apptId = await insertAppointment(3, "customer_no_show");

    const appts = await readMyAppointments();
    const found = appts.find((a) => a.appointmentId === apptId);
    expect(found, "No-Show-Termin muss in der Liste erscheinen").toBeDefined();
    expect(found!.stage).toBe("kunde_nicht_angetroffen");
    expect(found!.invoiceId).toBeUndefined();
  });

  it("ein No-Show MIT (Ausfallgebühr-)Rechnung bleibt in kunde_nicht_angetroffen und wandert nicht in eine Rechnungs-Stufe", async () => {
    const apptId = await insertAppointment(4, "customer_no_show");
    await insertFeeInvoice(apptId);

    const appts = await readMyAppointments();
    const found = appts.find((a) => a.appointmentId === apptId);
    expect(found, "berechneter No-Show-Termin muss in der Liste erscheinen").toBeDefined();
    // Side-Zustand hat Vorrang vor „abgerechnet" — nie eine Rechnungs-Stufe.
    expect(found!.stage).toBe("kunde_nicht_angetroffen");
  });

  it("ein stornierter und ein abgeschlossener Termin erscheinen NICHT als No-Show (Prioritäts-Reihenfolge)", async () => {
    const cancelledId = await insertAppointment(5, "cancelled");
    const completedId = await insertAppointment(6, "completed");

    const appts = await readMyAppointments();

    // Stornierte Termine sind gar nicht Teil der Liste.
    expect(appts.find((a) => a.appointmentId === cancelledId)).toBeUndefined();

    // Der abgeschlossene Termin ist Teil der Liste, aber nicht als No-Show.
    const completed = appts.find((a) => a.appointmentId === completedId);
    expect(completed, "abgeschlossener Termin muss in der Liste erscheinen").toBeDefined();
    expect(completed!.stage).not.toBe("kunde_nicht_angetroffen");

    // Kein Termin, der kein No-Show ist, trägt fälschlich die No-Show-Stufe.
    const noShowStages = appts.filter((a) => a.stage === "kunde_nicht_angetroffen");
    expect(noShowStages.every((a) => a.appointmentId !== cancelledId && a.appointmentId !== completedId)).toBe(true);
  });
});
