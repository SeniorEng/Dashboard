/**
 * Task #1563 — Übersichts-Aggregat und Drill-down MÜSSEN denselben
 * Stundenkonto-Saldo (Anfangsbestand/Saldo) für denselben Mitarbeiter/Monat
 * zeigen.
 *
 * Beide Routen im selben Screen lesen die Kontozellen aus GENAU EINER SSoT
 * (`computeAccountsForMonth` in `server/storage/time-tracking/payroll-accounts.ts`):
 *   - GET /api/admin/mitarbeiterabrechnung            (Übersicht: eine Zeile je MA)
 *   - GET /api/admin/mitarbeiterabrechnung/employee/:id (Drill-down: Kontozellen)
 *
 * Die Übersicht exponiert bewusst nur den Saldo je Kategorie (`row.saldo` +
 * `row.stundenkontoSaldo`/`row.kilometerSaldo`), NICHT den Anfangsbestand — die
 * Tabelle zeigt den laufenden Auszahl-Rückstand, nicht dessen Herkunft. Der
 * Drill-down zeigt zusätzlich `anfangsbestand`/`anfangsbestandType`.
 *
 * Weil beide Pfade dieselbe Funktion aufrufen, KANN der Saldo nicht driften.
 * Dieser Test verankert genau das gegen künftige Regressionen (z.B. wenn ein
 * Pfad auf eine zweite, parallele Berechnung umgestellt würde — die vom Projekt
 * bekämpfte „zwei Berechnungen für eine Frage"-Drift):
 *
 *   1. Aktivitäts-Monat: `overview.saldo[cat]` === `drilldown[cat].saldo` für
 *      JEDE Kategorie; und die aggregierten Kacheln
 *      (`stundenkontoSaldo`/`kilometerSaldo`) folgen exakt der Kontozellen-Summe.
 *   2. Reiner Übertrags-Monat (keine eigene Aktivität, Erfasst=Bezahlt=0):
 *      Dort gilt Saldo === Anfangsbestand. Der von der Übersicht gezeigte Saldo
 *      ist damit BYTE-genau der übertragene Anfangsbestand des Drill-downs —
 *      die stärkste Aussage über die Anfangsbestand-Konsistenz, die die
 *      (saldo-only) Übersichts-Form zulässt.
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

async function getSeededHauswirtschaftServiceId(): Promise<number> {
  const res = await db.execute(
    sql`SELECT id FROM services WHERE code = 'hauswirtschaft' LIMIT 1`,
  );
  const row = res.rows?.[0] as { id: number } | undefined;
  if (!row) throw new Error("Basis-Leistung 'hauswirtschaft' fehlt in der Test-DB");
  return Number(row.id);
}

// Fester historischer Jahrgang — die Aggregation filtert strikt auf unsere
// brandneue performed_by_employee_id, daher keine Kollision mit Fremddaten.
const YEAR = 2021;
const MONTH_ACTIVITY = 5; // Mai: dokumentierter Termin + gepflegtes „Bezahlt"
const ACTIVITY_DATE = `${YEAR}-05-12`;
const MONTH_CARRYOVER = 6; // Juni: reiner Übertrags-Monat (keine Aktivität)

const HW_MINUTES = 180; // ⇒ erfasst.hw = 3.0 h
const BEZAHLT_ACTIVITY = 1; // ⇒ Saldo Mai = 0 + 3 − 1 = 2 h
const EXPECTED_SALDO = 2;

const CATEGORIES = ["hw", "ab", "feiertage", "kilometer"] as const;
type Category = (typeof CATEGORIES)[number];

interface AccountCell {
  category: Category;
  anfangsbestand: number;
  anfangsbestandType: "go_live" | "carryover";
  erfasst: number;
  bezahlt: number;
  bezahltIsDefault: boolean;
  saldo: number;
}

interface DrilldownResponse {
  year: number;
  month: number;
  employeeId: number;
  accountCells: AccountCell[];
}

interface OverviewRow {
  employeeId: number;
  saldo: { hw: number; ab: number; feiertage: number; kilometer: number };
  stundenkontoSaldo: number;
  kilometerSaldo: number;
}

interface OverviewResponse {
  year: number;
  month: number;
  rows: OverviewRow[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

describe("Task #1563: Übersicht ≡ Drill-down (Stundenkonto-Saldo/Anfangsbestand)", () => {
  let customerId: number;
  let employeeId: number;

  async function getDrilldownCells(month: number): Promise<Record<Category, AccountCell>> {
    const res = await apiGet<DrilldownResponse>(
      `/api/admin/mitarbeiterabrechnung/employee/${employeeId}?year=${YEAR}&month=${month}`,
    );
    expect(res.status).toBe(200);
    const byCat = {} as Record<Category, AccountCell>;
    for (const c of res.data.accountCells) byCat[c.category] = c;
    return byCat;
  }

  async function getOverviewRow(month: number): Promise<OverviewRow> {
    const res = await apiGet<OverviewResponse>(
      `/api/admin/mitarbeiterabrechnung?year=${YEAR}&month=${month}`,
    );
    expect(res.status).toBe(200);
    const row = res.data.rows.find((r) => r.employeeId === employeeId);
    expect(row, `Mitarbeiter ${employeeId} muss eine Übersichts-Zeile haben (Monat ${month})`).toBeDefined();
    return row!;
  }

  beforeAll(async () => {
    const customer = await createTestCustomer();
    customerId = customer.id as number;
    const serviceId = await getSeededHauswirtschaftServiceId();
    const employee = await createTestEmployee({ nachnamePrefix: "TestParity" });
    employeeId = employee.id;
    await assignEmployeeToCustomer(customerId, employeeId);

    // Ein dokumentierter (completed) Termin im Aktivitäts-Monat mit exakten
    // Rohwerten: 180 HW-Minuten, keine Anfahrt, keine km ⇒ nur die hw-Kategorie
    // trägt Erfasst (3.0 h).
    const { appointmentId } = await createAndDocumentAppointment(customerId, serviceId, {
      assignedEmployeeId: employeeId,
      durationMinutes: HW_MINUTES,
    });
    await db.execute(sql`
      UPDATE appointments
      SET date = ${ACTIVITY_DATE},
          status = 'completed',
          signature_data = 'data:image/png;base64,PARITY_SIGNED',
          performed_by_employee_id = ${employeeId},
          assigned_employee_id = ${employeeId},
          travel_minutes = 0,
          travel_kilometers = 0,
          customer_kilometers = 0
      WHERE id = ${appointmentId}
    `);
    await db.execute(sql`
      UPDATE appointment_services
      SET actual_duration_minutes = ${HW_MINUTES}
      WHERE appointment_id = ${appointmentId}
    `);

    // Manuell gepflegtes „Bezahlt" (< Erfasst) erzeugt im Mai einen echten
    // Saldo: 0 + 3 − 1 = 2 h, der sich in den Juni überträgt.
    const put = await apiPut(`/api/admin/mitarbeiterabrechnung/account`, {
      userId: employeeId,
      year: YEAR,
      month: MONTH_ACTIVITY,
      category: "hw",
      bezahlt: BEZAHLT_ACTIVITY,
    });
    expect(put.status).toBe(200);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM employee_hours_accounts WHERE user_id = ${employeeId}`);
    await db.execute(sql`DELETE FROM employee_month_closings WHERE user_id = ${employeeId}`);
    await cleanupCustomer(customerId);
    await deactivateTestEmployee(employeeId);
  });

  it("zeigt im Aktivitäts-Monat pro Kategorie denselben Saldo (Übersicht ≡ Drill-down)", async () => {
    const cells = await getDrilldownCells(MONTH_ACTIVITY);
    const overview = await getOverviewRow(MONTH_ACTIVITY);

    // Kontroll-Anker: der Saldo IST der erwartete Wert (2 h auf hw).
    expect(cells.hw.saldo).toBe(EXPECTED_SALDO);

    // Kern-Invariante: Saldo je Kategorie ist in BEIDEN Pfaden identisch.
    for (const cat of CATEGORIES) {
      expect(
        overview.saldo[cat],
        `Saldo '${cat}' muss in Übersicht und Drill-down gleich sein`,
      ).toBe(cells[cat].saldo);
    }

    // Die aggregierten Kacheln der Übersicht folgen exakt der Kontozellen-Summe
    // des Drill-downs (hw+ab+feiertage; Kilometer separat).
    const expectedStundenkonto = r2(cells.hw.saldo + cells.ab.saldo + cells.feiertage.saldo);
    expect(overview.stundenkontoSaldo).toBe(expectedStundenkonto);
    expect(overview.kilometerSaldo).toBe(cells.kilometer.saldo);
  });

  it("zeigt im reinen Übertrags-Monat den übertragenen Anfangsbestand identisch (Übersicht-Saldo ≡ Drill-down-Anfangsbestand)", async () => {
    const cells = await getDrilldownCells(MONTH_CARRYOVER);
    const overview = await getOverviewRow(MONTH_CARRYOVER);

    // Ohne eigene Aktivität ist der Juni ein reiner Übertrags-Monat:
    // Anfangsbestand = übertragener Mai-Saldo (2), Erfasst = Bezahlt = 0.
    expect(cells.hw.anfangsbestandType).toBe("carryover");
    expect(cells.hw.anfangsbestand).toBe(EXPECTED_SALDO);
    expect(cells.hw.erfasst).toBe(0);
    expect(cells.hw.bezahlt).toBe(0);
    // ⇒ In diesem Monat gilt Saldo === Anfangsbestand.
    expect(cells.hw.saldo).toBe(cells.hw.anfangsbestand);

    // Damit ist der von der Übersicht gezeigte Saldo BYTE-genau der
    // übertragene Anfangsbestand des Drill-downs — beide Pfade sind konsistent.
    expect(overview.saldo.hw).toBe(cells.hw.saldo);
    expect(overview.saldo.hw).toBe(cells.hw.anfangsbestand);

    // Und wieder: Saldo-Parität über ALLE Kategorien.
    for (const cat of CATEGORIES) {
      expect(overview.saldo[cat]).toBe(cells[cat].saldo);
    }
    const expectedStundenkonto = r2(cells.hw.saldo + cells.ab.saldo + cells.feiertage.saldo);
    expect(overview.stundenkontoSaldo).toBe(expectedStundenkonto);
    expect(overview.kilometerSaldo).toBe(cells.kilometer.saldo);
  });
});
