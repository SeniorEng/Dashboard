/**
 * Task #1558 — Absicherung der Stundenkonto-ÜBERTRAGSKETTE für den Screen
 * „Mitarbeiterabrechnung & Stundenkonto" (Task #1555).
 *
 * Der Single-Month-Saldo und der Sperr-/Audit-Pfad sind bereits durch
 * `tests/mitarbeiterabrechnung-stundenkonto.test.ts` (Task #1557) abgedeckt.
 * NICHT abgedeckt war die Übertragskette selbst: die SSoT
 * `server/storage/time-tracking/payroll-accounts.ts` (`computeAccountsForMonth`)
 * leitet den Anfangsbestand jedes Monats aus dem Saldo des Vormonats ab
 * (Januar-Anker = gespeicherter Wert oder 0). Ein stiller Bruch dieser Kette
 * würde den laufenden „Auszahl-Rückstand" jedes Mitarbeiters falsch fortführen,
 * OHNE dass irgendwo ein Fehler auffällt.
 *
 * Geprüfte Invarianten:
 *   1. Der Saldo eines Monats wird als 'carryover'-Anfangsbestand in den
 *      Folgemonat übertragen (anfangsbestand[N+1] === saldo[N]).
 *   2. Ein gespeicherter Go-Live-Anfangsbestand überschreibt den abgeleiteten
 *      Übertrag NUR für diesen einen Monat; die Kette läuft danach ab dem neuen
 *      Saldo weiter.
 *   3. Ohne gespeicherten Januar-Anker rollt der Saldo NICHT über die
 *      Jahresgrenze (Dezember → Januar) — bewusste Vereinfachung.
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
const YEAR = 2023;
const NEXT_YEAR = 2024;

// Aktivitäts-Monat: ein dokumentierter Termin + manuell gepflegtes „Bezahlt".
const MONTH_ACTIVITY = 9; // September
const ACTIVITY_DATE = `${YEAR}-09-12`;
// Reiner Übertrags-Monat (keine Aktivität): erbt den September-Saldo.
const MONTH_CARRYOVER = 10; // Oktober
// Go-Live-Override-Monat.
const MONTH_GOLIVE = 11; // November
// Folgemonat nach Go-Live: erbt den (überschriebenen) November-Saldo.
const MONTH_AFTER_GOLIVE = 12; // Dezember

// Rohwerte, die die abgeleiteten Erfasst-Zahlen eindeutig bestimmen.
const HW_MINUTES = 180; // ⇒ erfasst.hw = 3.0 h
const BEZAHLT_ACTIVITY = 1; // ⇒ Saldo September = 0 + 3 − 1 = 2 h
const EXPECTED_SALDO_ACTIVITY = 2;
const GOLIVE_ANFANGSBESTAND = 10; // ⇒ Saldo November = 10 + 0 − 0 = 10 h

interface AccountCell {
  category: "hw" | "ab" | "feiertage" | "kilometer";
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
  isClosed: boolean;
  accountCells: AccountCell[];
}

describe("Task #1558: Stundenkonto-Übertragskette (Anfangsbestand-Carryover)", () => {
  let customerId: number;
  let employeeId: number;

  async function getCells(year: number, month: number): Promise<Record<string, AccountCell>> {
    const res = await apiGet<DrilldownResponse>(
      `/api/admin/mitarbeiterabrechnung/employee/${employeeId}?year=${year}&month=${month}`,
    );
    expect(res.status).toBe(200);
    const byCat: Record<string, AccountCell> = {};
    for (const c of res.data.accountCells) byCat[c.category] = c;
    return byCat;
  }

  beforeAll(async () => {
    const customer = await createTestCustomer();
    customerId = customer.id as number;
    const serviceId = await getSeededHauswirtschaftServiceId();
    const employee = await createTestEmployee({ nachnamePrefix: "TestStkCarry" });
    employeeId = employee.id;
    await assignEmployeeToCustomer(customerId, employeeId);

    // Ein dokumentierter (completed) Termin im Aktivitäts-Monat mit exakten
    // Rohwerten: 180 HW-Minuten, keine Anfahrt, keine km ⇒ nur die hw-Kategorie
    // trägt Erfasst (3.0 h), alle anderen Kategorien bleiben 0.
    const { appointmentId } = await createAndDocumentAppointment(customerId, serviceId, {
      assignedEmployeeId: employeeId,
      durationMinutes: HW_MINUTES,
    });
    await db.execute(sql`
      UPDATE appointments
      SET date = ${ACTIVITY_DATE},
          status = 'completed',
          signature_data = 'data:image/png;base64,STK_CARRY_SIGNED',
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
  });

  afterAll(async () => {
    await db.execute(sql`
      DELETE FROM employee_hours_accounts WHERE user_id = ${employeeId}
    `);
    await db.execute(sql`
      DELETE FROM employee_month_closings WHERE user_id = ${employeeId}
    `);
    await cleanupCustomer(customerId);
    await deactivateTestEmployee(employeeId);
  });

  it("überträgt den Vormonats-Saldo als 'carryover'-Anfangsbestand in den Folgemonat", async () => {
    // Manuell gepflegtes „Bezahlt" (< Erfasst) erzeugt im September einen
    // echten Saldo: 0 + 3 − 1 = 2 h.
    const put = await apiPut(`/api/admin/mitarbeiterabrechnung/account`, {
      userId: employeeId,
      year: YEAR,
      month: MONTH_ACTIVITY,
      category: "hw",
      bezahlt: BEZAHLT_ACTIVITY,
    });
    expect(put.status).toBe(200);

    // September: Saldo = 2 h, Anfangsbestand selbst noch abgeleitet (0).
    const sep = await getCells(YEAR, MONTH_ACTIVITY);
    expect(sep.hw.erfasst).toBe(HW_MINUTES / 60); // 3.0
    expect(sep.hw.bezahlt).toBe(BEZAHLT_ACTIVITY);
    expect(sep.hw.bezahltIsDefault).toBe(false);
    expect(sep.hw.anfangsbestandType).toBe("carryover");
    expect(sep.hw.anfangsbestand).toBe(0);
    expect(sep.hw.saldo).toBe(EXPECTED_SALDO_ACTIVITY);

    // Oktober (keine eigene Aktivität): Anfangsbestand MUSS der abgeleitete
    // Übertrag des September-Saldos sein.
    const oct = await getCells(YEAR, MONTH_CARRYOVER);
    expect(oct.hw.anfangsbestandType).toBe("carryover");
    expect(oct.hw.anfangsbestand).toBe(sep.hw.saldo); // 2
    expect(oct.hw.erfasst).toBe(0);
    expect(oct.hw.bezahltIsDefault).toBe(true);
    expect(oct.hw.bezahlt).toBe(0);
    // Saldo läuft unverändert weiter: 2 + 0 − 0 = 2.
    expect(oct.hw.saldo).toBe(EXPECTED_SALDO_ACTIVITY);
  });

  it("überschreibt mit gespeichertem Go-Live-Anfangsbestand den Übertrag NUR für diesen Monat", async () => {
    // Vorzustand: Ohne Go-Live würde der November den Oktober-Saldo (2 h) erben.
    const novBefore = await getCells(YEAR, MONTH_GOLIVE);
    expect(novBefore.hw.anfangsbestandType).toBe("carryover");
    expect(novBefore.hw.anfangsbestand).toBe(EXPECTED_SALDO_ACTIVITY); // 2

    // Go-Live-Eröffnungssaldo für November setzen (10 h). Das ist der EINZIGE
    // Weg, einen Anfangsbestand manuell zu setzen (Übertrag ist gesperrt).
    const put = await apiPut(`/api/admin/mitarbeiterabrechnung/account`, {
      userId: employeeId,
      year: YEAR,
      month: MONTH_GOLIVE,
      category: "hw",
      anfangsbestand: GOLIVE_ANFANGSBESTAND,
      openingBalanceType: "go_live",
    });
    expect(put.status).toBe(200);

    // November: Der Go-Live-Wert überschreibt den abgeleiteten Übertrag (2 → 10).
    const nov = await getCells(YEAR, MONTH_GOLIVE);
    expect(nov.hw.anfangsbestandType).toBe("go_live");
    expect(nov.hw.anfangsbestand).toBe(GOLIVE_ANFANGSBESTAND); // 10, nicht 2
    expect(nov.hw.erfasst).toBe(0);
    expect(nov.hw.saldo).toBe(GOLIVE_ANFANGSBESTAND); // 10 + 0 − 0

    // „Nur für diesen Monat": Der Oktober bleibt unberührt (2 h) — der Go-Live
    // wirkt nicht rückwärts.
    const oct = await getCells(YEAR, MONTH_CARRYOVER);
    expect(oct.hw.anfangsbestandType).toBe("carryover");
    expect(oct.hw.anfangsbestand).toBe(EXPECTED_SALDO_ACTIVITY); // 2

    // Dezember: Die Kette läuft ab dem NEUEN November-Saldo (10 h) weiter —
    // wieder als abgeleiteter 'carryover', nicht als go_live.
    const dec = await getCells(YEAR, MONTH_AFTER_GOLIVE);
    expect(dec.hw.anfangsbestandType).toBe("carryover");
    expect(dec.hw.anfangsbestand).toBe(GOLIVE_ANFANGSBESTAND); // 10, ererbt vom November-Saldo
    expect(dec.hw.saldo).toBe(GOLIVE_ANFANGSBESTAND);
  });

  it("überträgt ohne gespeicherten Januar-Anker NICHT über die Jahresgrenze (Dez → Jan)", async () => {
    // Dezember 2023 trägt einen Saldo von 10 h.
    const dec = await getCells(YEAR, MONTH_AFTER_GOLIVE);
    expect(dec.hw.saldo).toBe(GOLIVE_ANFANGSBESTAND);

    // Januar 2024 startet die Kette bei m=1 neu: ohne gespeicherten Anker ist
    // der Anfangsbestand 0 (bewusste Cross-Year-Vereinfachung), NICHT der
    // Dezember-Saldo.
    const jan = await getCells(NEXT_YEAR, 1);
    expect(jan.hw.anfangsbestandType).toBe("carryover");
    expect(jan.hw.anfangsbestand).toBe(0); // NICHT 10
    expect(jan.hw.saldo).toBe(0);
  });
});
