import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../server/lib/db";
import { getAuthCookie, createTestCustomer, cleanupCustomer } from "./test-utils";
import { readBillingEconomics } from "../server/storage/billing/economics-reader";
import { getRevenueStats } from "../server/storage/statistics/revenue";
import { getMonthlyCategoryErfasst } from "../server/storage/time-tracking/payroll-hours";
import { resolvePeriod } from "../server/storage/statistics/common";

/**
 * Task #1754 — Anti-Drift: der Wirtschaftlichkeits-Reader (`readBillingEconomics`)
 * MUSS mit den SSoT für Lohn-Stunden und Umsatz im Gleichschritt bleiben.
 *
 * Der billing-scoped Economics-Reader aggregiert Stunden UND Erlös je
 * Mitarbeiter neu (eigene SQL-Queries). Wenn diese Aggregation jemals von der
 * Lohn-Aufschlüsselung (`getMonthlyCategoryErfasst`, „Mitarbeiterabrechnung")
 * oder vom Umsatz-Reader (`getRevenueStats`, „Umsatz-Dashboard") abweicht,
 * zeigt der Wirtschaftliche Überblick andere Zahlen als die beiden Reader, die
 * dieselbe fachliche Frage („wie viele Stunden je Kategorie?" / „wie viel
 * dokumentierter Umsatz?") bereits verbindlich beantworten.
 *
 * Diese Suite bucht einen isolierten Monat mit
 *   - einem GEMISCHTEN Termin (Hauswirtschaft + Alltagsbegleitung in EINEM
 *     Termin) — fängt einen Rückfall auf `DISTINCT ON (a.id)` ab (würde eine der
 *     beiden Kategorien verschlucken),
 *   - einem reinen Hauswirtschafts-Termin (mehrere Termine im Monat),
 *   - dokumentierter Ist-Dauer `actual_duration_minutes` ≠
 *     `duration_promised` (fängt einen Rückfall auf die versprochene Dauer ab),
 *   - nicht-abrechenbaren Zeiterfassungs-km (dürfen NIE in Stunden oder Umsatz
 *     durchsickern, nur in die km-/Kostenseite).
 *
 * und prüft für denselben Mitarbeiter/Zeitraum:
 *   1. Economics-Kategorie-Stunden === Payroll `erfasst.hw` / `erfasst.ab`
 *   2. Economics-Umsatz === Revenue-Stats `byEmployee.documented`
 *
 * Isolation über ein eigenes, weit entferntes Jahr (kein anderer Test bucht dort
 * für den Seed-Superadmin), damit die employee-/monatsgefilterten Reader nur die
 * Fixture-Daten sehen. Alle Beträge sind Integer-Cents.
 */
describe("Task #1754 — Economics-Reader darf nicht von Payroll-/Umsatz-SSoT driften", () => {
  const YEAR = 2043;
  const MONTH = 6;
  const APPT_DATE = `${YEAR}-0${MONTH}-15`;

  // Ist-Dauern je Leistung (bewusst ≠ geplant und ≠ duration_promised).
  const HW1_ACTUAL = 50; // gemischter Termin: Hauswirtschaft
  const AB1_ACTUAL = 40; // gemischter Termin: Alltagsbegleitung
  const HW2_ACTUAL = 45; // reiner Hauswirtschafts-Termin
  const EXPECTED_HW_MINUTES = HW1_ACTUAL + HW2_ACTUAL; // 95
  const EXPECTED_AB_MINUTES = AB1_ACTUAL; // 40
  const TIME_ENTRY_KM = 15; // nicht-abrechenbare Zeiterfassungs-km

  let userId: number;
  let customerId: number;
  let hwServiceId = 0;
  let abServiceId = 0;
  let timeEntryId = 0;

  const r2 = (n: number) => Math.round(n * 100) / 100;

  const insertAppointment = async (durationPromised: number): Promise<number> => {
    return db.execute(sql`
      INSERT INTO appointments (
        customer_id, created_by_user_id, assigned_employee_id, performed_by_employee_id,
        appointment_type, date, scheduled_start, scheduled_end, duration_promised,
        status, actual_start, actual_end, travel_origin_type, travel_kilometers,
        travel_minutes, customer_kilometers, signed_at, signed_by_user_id
      ) VALUES (
        ${customerId}, ${userId}, ${userId}, ${userId},
        'Kundentermin', ${APPT_DATE}, '09:00', '10:00', ${durationPromised},
        'completed', '09:00', '10:00', 'home', 0,
        0, 0, NOW(), ${userId}
      )
      RETURNING id
    `).then((r) => (r.rows as Array<{ id: number }>)[0].id);
  };

  const insertService = async (
    apptId: number,
    serviceId: number,
    planned: number,
    actual: number,
  ) => {
    await db.execute(sql`
      INSERT INTO appointment_services
        (appointment_id, service_id, planned_duration_minutes, actual_duration_minutes, details)
      VALUES (${apptId}, ${serviceId}, ${planned}, ${actual}, 'T1754 fixture')
    `);
  };

  beforeAll(async () => {
    const auth = await getAuthCookie();
    userId = auth.user.id; // Seed-Superadmin ⇒ Lohn-Rolle 'admin'.

    const customer = await createTestCustomer({ vorname: "T1754", nachname: `Drift_${Date.now()}` });
    customerId = customer.id as number;

    // Reale Katalog-Leistungen (alle drei Reader filtern nach Code bzw.
    // `lohnart_kategorie`).
    const svc = await db.execute(sql`
      SELECT code, id FROM services WHERE code IN ('hauswirtschaft','alltagsbegleitung')
    `).then((r) => r.rows as Array<{ code: string; id: number }>);
    hwServiceId = svc.find((s) => s.code === "hauswirtschaft")!.id;
    abServiceId = svc.find((s) => s.code === "alltagsbegleitung")!.id;

    // 1) GEMISCHTER Termin (HW + AB) — fängt DISTINCT-ON-Kollaps ab. Ist-Dauer je
    //    Leistung ≠ geplant, duration_promised (123) ≠ Summe der Leistungs-Minuten.
    const mixedApptId = await insertAppointment(123);
    await insertService(mixedApptId, hwServiceId, 60, HW1_ACTUAL);
    await insertService(mixedApptId, abServiceId, 30, AB1_ACTUAL);

    // 2) Reiner Hauswirtschafts-Termin (mehrere Termine im Monat).
    const hwApptId = await insertAppointment(90);
    await insertService(hwApptId, hwServiceId, 60, HW2_ACTUAL);

    // 3) Nicht-abrechenbare Zeiterfassung mit km, aber OHNE Dauer — die km dürfen
    //    NIE in Stunden/Umsatz durchsickern (duration_minutes=0 ⇒ keine bezahlte
    //    Sonstiges-Zeit, die die HW-Stunden verfälschen würde).
    timeEntryId = await db.execute(sql`
      INSERT INTO employee_time_entries
        (user_id, entry_type, entry_date, duration_minutes, kilometers, is_full_day)
      VALUES (${userId}, 'vertrieb', ${APPT_DATE}, 0, ${TIME_ENTRY_KM}, false)
      RETURNING id
    `).then((r) => (r.rows as Array<{ id: number }>)[0].id);
  });

  afterAll(async () => {
    await cleanupCustomer(customerId); // entfernt Termine + Leistungen (FK-Cascade)
    if (timeEntryId) await db.execute(sql`DELETE FROM employee_time_entries WHERE id = ${timeEntryId}`);
  });

  it("Economics-Kategorie-Stunden === Payroll erfasst.hw / erfasst.ab", async () => {
    const billing = await readBillingEconomics(YEAR, MONTH, { employeeId: userId });
    const empRow = billing.byEmployee.find((r) => r.employeeId === userId);
    expect(empRow).toBeDefined();

    const hwRow = empRow!.services.find((s) => s.key === "hauswirtschaft");
    const abRow = empRow!.services.find((s) => s.key === "alltagsbegleitung");
    expect(hwRow).toBeDefined();
    expect(abRow).toBeDefined();

    // Der gemischte Termin trägt seine HW- UND AB-Minuten jeweils der richtigen
    // Kategorie bei (kein DISTINCT-ON-Kollaps), auf Ist-Dauer (nicht
    // duration_promised).
    expect(hwRow!.quantity).toBe(EXPECTED_HW_MINUTES);
    expect(abRow!.quantity).toBe(EXPECTED_AB_MINUTES);

    const { byEmployeeMonth } = await getMonthlyCategoryErfasst(YEAR, MONTH);
    const erfasst = byEmployeeMonth[userId]?.[MONTH];
    expect(erfasst).toBeDefined();

    // Economics-Minuten/60 (auf 2 NK) === die von der Lohn-SSoT gemeldeten
    // Kategorie-Stunden. Driftet der Reader (andere Minuten-Basis, Kollaps,
    // duration_promised), bricht diese Gleichung.
    expect(r2(hwRow!.quantity / 60)).toBe(erfasst.hw);
    expect(r2(abRow!.quantity / 60)).toBe(erfasst.ab);

    // Nicht-abrechenbare Zeiterfassungs-km liegen auf der km-Seite (nicht in den
    // Stunden) — bei Economics UND Payroll deckungsgleich.
    expect(empRow!.km).toBe(TIME_ENTRY_KM);
    expect(erfasst.kilometer).toBe(TIME_ENTRY_KM);
  });

  it("Economics-Umsatz === Revenue-Stats byEmployee.documented (gleicher Mitarbeiter/Zeitraum)", async () => {
    const billing = await readBillingEconomics(YEAR, MONTH, { employeeId: userId });
    const empRow = billing.byEmployee.find((r) => r.employeeId === userId);
    expect(empRow).toBeDefined();

    const revenueStats = await getRevenueStats(resolvePeriod({ year: YEAR, month: MONTH }));
    const revEmp = revenueStats.byEmployee.find((r) => r.id === userId);
    expect(revEmp).toBeDefined();

    // Der dokumentierte Erlös des Umsatz-Readers (HW+AB-Stundenleistungen, gleiche
    // Preis-SSoT + Pro-Leistung-Rundung) muss exakt dem Economics-Erlös
    // entsprechen. Nicht-abrechenbare Zeiterfassungs-km erzeugen KEINEN Erlös,
    // sickern also nicht ein.
    expect(empRow!.revenueCents).toBe(revEmp!.documented);
    expect(empRow!.revenueCents).toBeGreaterThan(0);
  });
});
