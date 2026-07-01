/**
 * Task #1559 — Absicherung des 6-KPI-Boards und der Tabellen-Aggregation der
 * „Mitarbeiterabrechnung & Stundenkonto" (Task #1555).
 *
 * Der Übersichts-Endpoint `GET /api/admin/mitarbeiterabrechnung` verdichtet die
 * pro-Mitarbeiter-Zeilen (SSoT `payroll-hours` + Stundenkonto `payroll-accounts`)
 * zu den Management-Kennzahlen auf dem Hauptschirm:
 *   (1) erfasste Stunden        = Σ (erfasst.hw + erfasst.ab + erfasst.feiertage)
 *   (2) abrechenbare Stunden    = Σ (Hauswirtschaft + Alltagsbegleitung)
 *   (3) Produktivquote          = abrechenbar / erfasst · 100 (+ Gemeinkosten-h)
 *   (4) Wachstum vs. Vormonat   = deltaPct(current, previous)
 *   (5) Stundenkonto-Saldo      = Σ sichtbarer Salden (HW+AB+Feiertage)
 *   (6) offene Termine          = dokumentiert, aber nicht unterschrieben
 * plus dem „sichtbare Zeile"-Filter (Aktivität ODER materielles Stundenkonto).
 *
 * Diese Verdichtung war bisher ungetestet — eine Regression würde falsche
 * Management-Zahlen zeigen, ohne dass ein Test fehlschlägt. Wir seeden EINEN
 * Mitarbeiter mit exakt bekannten dokumentierten Stunden/km in einem festen
 * historischen Monat (+ Vormonat für die Delta-Kennzahl) und prüfen jede KPI.
 * Zusätzlich beweist ein reiner Übertrags-Mitarbeiter (keine Aktivität, aber ein
 * Go-Live-Anfangsbestand), dass der Sichtbarkeitsfilter ihn NICHT verwirft.
 *
 * Der historische Monat 2021-11 wird von keinem anderen Test genutzt; die
 * Aggregation filtert strikt auf `is_active`-Mitarbeiter, unsere Zeilen sind
 * brandneu — daher keine Kollision mit Fremddaten in einer frischen Wegwerf-DB.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../server/lib/db";
import {
  apiGet,
  apiPut,
  createTestCustomer,
  cleanupCustomer,
  createTestEmployee,
  deactivateTestEmployee,
  assignEmployeeToCustomer,
  createAndDocumentAppointment,
} from "./test-utils";

const TARGET_YEAR = 2021;
const TARGET_MONTH = 11;
const PREV_YEAR = 2021;
const PREV_MONTH = 10;

// Zielmonat (November 2021) — zwei dokumentierte Termine für Mitarbeiter A:
//  - signiert:   120 HW-Minuten (2,0 h) + 10 Anfahrts-km
//  - unsigniert:  90 HW-Minuten (1,5 h) + 0 km  → zählt als offener Termin
// Vormonat (Oktober 2021) — ein signierter Termin: 60 HW-Minuten (1,0 h).
const SIGNED_DATE = `${TARGET_YEAR}-11-12`; // Freitag
const UNSIGNED_DATE = `${TARGET_YEAR}-11-19`; // Freitag
const PREV_DATE = `${PREV_YEAR}-10-15`; // Freitag

const SIGNED_MIN = 120;
const UNSIGNED_MIN = 90;
const PREV_MIN = 60;
const SIGNED_KM = 10;

// Erwartete abgeleitete Werte für Mitarbeiter A im Zielmonat.
const EXP_HW_HOURS = (SIGNED_MIN + UNSIGNED_MIN) / 60; // 3,5
const EXP_KM = SIGNED_KM; // 10
const EXP_UNSIGNED_HOURS = UNSIGNED_MIN / 60; // 1,5
const PREV_HW_HOURS = PREV_MIN / 60; // 1,0

// Go-Live-Anfangsbestand für den reinen Übertrags-Mitarbeiter B.
const B_ANFANGSBESTAND_HW = 5;

interface ErfasstBlock {
  hw: number;
  ab: number;
  feiertage: number;
  kilometer: number;
}
interface TableRow {
  employeeId: number;
  erfasst: ErfasstBlock;
  stundenkontoSaldo: number;
  unsignedAppointmentCount: number;
  unsignedMinutes: number;
}
interface KpiValue {
  current: number;
  previous: number;
  deltaPct: number | null;
}
interface OverviewResponse {
  year: number;
  month: number;
  kpis: {
    erfassteStunden: KpiValue;
    abrechenbareStunden: KpiValue;
    produktivquote: { current: number | null; gemeinkostenStunden: number };
    wachstum: { produktivDeltaPct: number | null; gemeinkostenDeltaPct: number | null };
    stundenkontoSaldo: number;
    offeneTermine: { hours: number; count: number };
    activeEmployees: number;
  };
  rows: TableRow[];
}

async function getSeededHauswirtschaftServiceId(): Promise<number> {
  const res = await db.execute(
    sql`SELECT id FROM services WHERE code = 'hauswirtschaft' LIMIT 1`,
  );
  const row = res.rows?.[0] as { id: number } | undefined;
  if (!row) throw new Error("Basis-Leistung 'hauswirtschaft' fehlt in der Test-DB");
  return Number(row.id);
}

/** Legt einen dokumentierten Termin an und normalisiert ihn per SQL auf exakte
 * Rohwerte (Datum, Status, Unterschrift, performed_by, km, Anfahrtsminuten). */
async function seedDocumentedAppointment(opts: {
  customerId: number;
  serviceId: number;
  employeeId: number;
  date: string;
  minutes: number;
  travelKm: number;
  signed: boolean;
}): Promise<void> {
  const { appointmentId } = await createAndDocumentAppointment(opts.customerId, opts.serviceId, {
    assignedEmployeeId: opts.employeeId,
    durationMinutes: opts.minutes,
  });
  await db.execute(sql`
    UPDATE appointments
    SET date = ${opts.date},
        status = 'completed',
        signature_data = ${opts.signed ? "data:image/png;base64,KPI_SIGNED" : null},
        performed_by_employee_id = ${opts.employeeId},
        assigned_employee_id = ${opts.employeeId},
        travel_minutes = 0,
        travel_kilometers = ${opts.travelKm},
        customer_kilometers = 0
    WHERE id = ${appointmentId}
  `);
  await db.execute(sql`
    UPDATE appointment_services
    SET actual_duration_minutes = ${opts.minutes}
    WHERE appointment_id = ${appointmentId}
  `);
}

const r2 = (n: number) => Math.round(n * 100) / 100;

describe("Task #1559: Mitarbeiterabrechnung KPI-Board-Aggregation", () => {
  let customerId: number;
  let employeeAId: number; // Aktivität (Stunden/km/offener Termin)
  let employeeBId: number; // reiner Übertrag (Go-Live-Anfangsbestand)

  beforeAll(async () => {
    const customer = await createTestCustomer();
    customerId = customer.id as number;
    const serviceId = await getSeededHauswirtschaftServiceId();

    const empA = await createTestEmployee({ nachnamePrefix: "TestKpiA" });
    employeeAId = empA.id;
    const empB = await createTestEmployee({ nachnamePrefix: "TestKpiB" });
    employeeBId = empB.id;
    await assignEmployeeToCustomer(customerId, employeeAId);

    // Mitarbeiter A: zwei Zielmonats-Termine (signiert + unsigniert) + Vormonat.
    await seedDocumentedAppointment({
      customerId, serviceId, employeeId: employeeAId,
      date: SIGNED_DATE, minutes: SIGNED_MIN, travelKm: SIGNED_KM, signed: true,
    });
    await seedDocumentedAppointment({
      customerId, serviceId, employeeId: employeeAId,
      date: UNSIGNED_DATE, minutes: UNSIGNED_MIN, travelKm: 0, signed: false,
    });
    await seedDocumentedAppointment({
      customerId, serviceId, employeeId: employeeAId,
      date: PREV_DATE, minutes: PREV_MIN, travelKm: 0, signed: true,
    });

    // Mitarbeiter B: keine Aktivität, aber ein Go-Live-Anfangsbestand (5 h HW,
    // Bezahlt 0) ⇒ materielles Stundenkonto (Saldo 5) ⇒ MUSS sichtbar bleiben.
    const put = await apiPut(`/api/admin/mitarbeiterabrechnung/account`, {
      userId: employeeBId,
      year: TARGET_YEAR,
      month: TARGET_MONTH,
      category: "hw",
      anfangsbestand: B_ANFANGSBESTAND_HW,
      bezahlt: 0,
      openingBalanceType: "go_live",
    });
    expect(put.status).toBe(200);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM employee_hours_accounts WHERE user_id = ${employeeBId}`);
    await cleanupCustomer(customerId);
    await deactivateTestEmployee(employeeAId);
    await deactivateTestEmployee(employeeBId);
  });

  async function getOverview(): Promise<OverviewResponse> {
    const res = await apiGet<OverviewResponse>(
      `/api/admin/mitarbeiterabrechnung?year=${TARGET_YEAR}&month=${TARGET_MONTH}`,
    );
    expect(res.status).toBe(200);
    return res.data;
  }

  it("leitet die pro-Mitarbeiter-Zeile aus den dokumentierten Rohdaten ab", async () => {
    const data = await getOverview();
    const rowA = data.rows.find((r) => r.employeeId === employeeAId);
    expect(rowA, "Aktivitäts-Mitarbeiter A muss sichtbar sein").toBeDefined();

    // Erfasst wird aus den dokumentierten Terminen abgeleitet (signiert + unsigniert).
    expect(rowA!.erfasst.hw).toBe(EXP_HW_HOURS); // 3,5
    expect(rowA!.erfasst.ab).toBe(0);
    expect(rowA!.erfasst.feiertage).toBe(0); // sozialversicherungspflichtig, keine Monatsstunden
    expect(rowA!.erfasst.kilometer).toBeCloseTo(EXP_KM, 3); // 10

    // Nur der unsignierte Termin zählt als „offen".
    expect(rowA!.unsignedAppointmentCount).toBe(1);
    expect(rowA!.unsignedMinutes).toBe(UNSIGNED_MIN); // 90
    // A hat kein manuelles Stundenkonto ⇒ Bezahlt defaultet auf Erfasst ⇒ Saldo 0.
    expect(rowA!.stundenkontoSaldo).toBe(0);
  });

  it("hält den reinen Übertrags-Mitarbeiter (kein Aktivität, materielles Konto) sichtbar", async () => {
    const data = await getOverview();
    const rowB = data.rows.find((r) => r.employeeId === employeeBId);
    expect(rowB, "Übertrags-Mitarbeiter B muss trotz fehlender Aktivität sichtbar sein").toBeDefined();

    // Keine Aktivität → alle Erfasst-Werte 0.
    expect(rowB!.erfasst.hw).toBe(0);
    expect(rowB!.erfasst.ab).toBe(0);
    expect(rowB!.erfasst.kilometer).toBe(0);
    expect(rowB!.unsignedAppointmentCount).toBe(0);
    // Saldo = Anfangsbestand (5) + Erfasst (0) − Bezahlt (0) = 5.
    expect(rowB!.stundenkontoSaldo).toBe(B_ANFANGSBESTAND_HW);
  });

  it("verdichtet die 6 KPIs korrekt (erfasst/abrechenbar/Quote/Saldo/offene Termine)", async () => {
    const data = await getOverview();
    const k = data.kpis;

    // (1) Erfasste Stunden = Σ (hw + ab + feiertage) über sichtbare Zeilen.
    //     A = 3,5 ; B = 0 ⇒ 3,5.
    expect(k.erfassteStunden.current).toBe(EXP_HW_HOURS);
    // (2) Abrechenbare Stunden = Σ (Hauswirtschaft + Alltagsbegleitung) = 3,5.
    expect(k.abrechenbareStunden.current).toBe(EXP_HW_HOURS);
    // (3) Produktivquote = 3,5 / 3,5 · 100 = 100 ; Gemeinkosten = 0.
    expect(k.produktivquote.current).toBe(100);
    expect(k.produktivquote.gemeinkostenStunden).toBe(0);
    // (5) Stundenkonto-Saldo = Σ sichtbarer Salden = 0 (A) + 5 (B) = 5.
    expect(k.stundenkontoSaldo).toBe(B_ANFANGSBESTAND_HW);
    // (6) Offene Termine: genau der eine unsignierte Termin (1,5 h).
    expect(k.offeneTermine.count).toBe(1);
    expect(k.offeneTermine.hours).toBe(EXP_UNSIGNED_HOURS);
    // Kontext: genau A und B sind sichtbar.
    expect(k.activeEmployees).toBe(2);

    // Selbstkonsistenz: die Headline-KPIs MÜSSEN exakt der Summe der zurück-
    // gelieferten Tabellenzeilen entsprechen (Drift-Guard Anzeige vs. Board).
    const sumHw = r2(
      data.rows.reduce((s, r) => s + r.erfasst.hw + r.erfasst.ab + r.erfasst.feiertage, 0),
    );
    const sumSaldo = r2(data.rows.reduce((s, r) => s + r.stundenkontoSaldo, 0));
    const sumUnsignedCount = data.rows.reduce((s, r) => s + r.unsignedAppointmentCount, 0);
    expect(k.erfassteStunden.current).toBe(sumHw);
    expect(k.stundenkontoSaldo).toBe(sumSaldo);
    expect(k.offeneTermine.count).toBe(sumUnsignedCount);
  });

  it("berechnet Wachstum/Delta gegen den Vormonat", async () => {
    const data = await getOverview();
    const k = data.kpis;

    // Vormonat (Oktober): nur A mit 1,0 h ⇒ previous = 1,0.
    expect(k.erfassteStunden.previous).toBe(PREV_HW_HOURS);
    expect(k.abrechenbareStunden.previous).toBe(PREV_HW_HOURS);

    // deltaPct = (3,5 − 1,0) / 1,0 · 100 = 250,0.
    const expectedDelta = r2(((EXP_HW_HOURS - PREV_HW_HOURS) / PREV_HW_HOURS) * 100);
    expect(k.erfassteStunden.deltaPct).toBe(expectedDelta);
    expect(k.abrechenbareStunden.deltaPct).toBe(expectedDelta);
    // Wachstum-Kachel spiegelt die produktive Delta-Kennzahl.
    expect(k.wachstum.produktivDeltaPct).toBe(expectedDelta);
  });
});
