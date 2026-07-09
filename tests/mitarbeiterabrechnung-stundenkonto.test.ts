/**
 * Task #1557 — Absicherung der Stundenkonto-Saldo-Mathematik und der
 * Editier-Sperre nach dem Monatsabschluss für den Screen
 * „Mitarbeiterabrechnung & Stundenkonto" (Task #1555).
 *
 * SSoT der Berechnung liegt in `server/storage/time-tracking/payroll-accounts.ts`
 * (`computeAccountsForMonth`, `upsertHoursAccount`); die Route
 * `server/routes/admin/mitarbeiterabrechnung.ts` ist nur ein dünner Wrapper.
 * Nur die Frontend-Anzeige der Unsigniert-Warnung war bisher (Unit-)getestet —
 * die Geld-nahe Saldo-Logik und der Sperr-/Audit-Pfad hatten keinen
 * Integrationstest.
 *
 * Saldo je Kategorie (HW/AB/Feiertage/Kilometer):
 *   Saldo = Anfangsbestand + Erfasst − Bezahlt
 *   - Erfasst: abgeleitet aus dokumentierten Terminen (nie persistiert)
 *   - Bezahlt: manuell; NULL ⇒ default = Erfasst (Saldo bleibt 0)
 *   - Anfangsbestand: nur als Go-Live-Eröffnungssaldo editierbar; Übertrag
 *     ('carryover') ist abgeleitet/gesperrt
 *
 * Editier-Sperre: nach dem 8.-des-Monats-Auto-Abschluss
 * (`employee_month_closings` ohne `reopened_at`) ist jede Bearbeitung gesperrt.
 * Jede erfolgreiche Bearbeitung schreibt einen Audit-Eintrag.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../server/lib/db";
import {
  apiGet,
  apiPut,
  getAuthCookie,
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

// Fester historischer Monat — die Aggregation filtert strikt auf unsere
// brandneue performed_by_employee_id, daher keine Kollision mit Fremddaten.
const TARGET_YEAR = 2023;
const TARGET_MONTH = 9;
const TARGET_DATE = `${TARGET_YEAR}-0${TARGET_MONTH}-12`;

// Roh-Werte, die die abgeleiteten Erfasst-Zahlen eindeutig bestimmen.
const HW_MINUTES = 120; // ⇒ erfasst.hw = 2.0 h
const TRAVEL_KM = 10; // ⇒ erfasst.kilometer = 10

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

const r2 = (n: number) => Math.round(n * 100) / 100;

describe("Task #1557: Stundenkonto-Saldo + Monatsabschluss-Sperre", () => {
  let customerId: number;
  let employeeId: number;

  async function getCells(): Promise<Record<string, AccountCell>> {
    const res = await apiGet<DrilldownResponse>(
      `/api/admin/mitarbeiterabrechnung/employee/${employeeId}?year=${TARGET_YEAR}&month=${TARGET_MONTH}`,
    );
    expect(res.status).toBe(200);
    const byCat: Record<string, AccountCell> = {};
    for (const c of res.data.accountCells) byCat[c.category] = c;
    return byCat;
  }

  /** Die Saldo-Invariante MUSS für jede Kategorie exakt aus den vom Server
   * gelieferten Bausteinen folgen: Saldo = Anfangsbestand + Erfasst − Bezahlt. */
  function assertSaldoIdentity(cells: Record<string, AccountCell>): void {
    for (const cat of ["hw", "ab", "feiertage", "kilometer"]) {
      const c = cells[cat];
      expect(c, `Kontozelle '${cat}' muss existieren`).toBeDefined();
      expect(c.saldo).toBe(r2(c.anfangsbestand + c.erfasst - c.bezahlt));
    }
  }

  async function countAudit(): Promise<number> {
    const res = await db.execute(sql`
      SELECT COUNT(*)::int AS c FROM audit_log
      WHERE action = 'hours_account_updated'
        AND entity_type = 'hours_account'
        AND (metadata->>'employeeUserId')::int = ${employeeId}
    `);
    return Number((res.rows?.[0] as { c: number }).c);
  }

  beforeAll(async () => {
    const customer = await createTestCustomer();
    customerId = customer.id as number;
    const serviceId = await getSeededHauswirtschaftServiceId();
    const employee = await createTestEmployee({ nachnamePrefix: "TestStk" });
    employeeId = employee.id;
    await assignEmployeeToCustomer(customerId, employeeId);

    // Ein dokumentierter (completed) Termin im Zielmonat mit exakten Rohwerten:
    // 120 HW-Minuten, keine Anfahrtsminuten, 10 Anfahrts-km, 0 Kunden-km.
    const { appointmentId } = await createAndDocumentAppointment(customerId, serviceId, {
      assignedEmployeeId: employeeId,
      durationMinutes: HW_MINUTES,
    });
    await db.execute(sql`
      UPDATE appointments
      SET date = ${TARGET_DATE},
          status = 'completed',
          signature_data = 'data:image/png;base64,STK_SIGNED',
          performed_by_employee_id = ${employeeId},
          assigned_employee_id = ${employeeId},
          travel_minutes = 0,
          travel_kilometers = ${TRAVEL_KM},
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

  it("leitet Erfasst korrekt ab und defaultet Bezahlt auf Erfasst (Saldo 0)", async () => {
    const cells = await getCells();

    // Erfasst wird aus dem dokumentierten Termin abgeleitet.
    expect(cells.hw.erfasst).toBe(HW_MINUTES / 60); // 2.0
    expect(cells.kilometer.erfasst).toBeCloseTo(TRAVEL_KM, 3); // 10

    // Ohne gepflegtes „Bezahlt" gilt der Default = Erfasst ⇒ Saldo bleibt 0.
    // Würde Bezahlt fälschlich auf 0 defaulten, wäre der Saldo = Erfasst (>0).
    expect(cells.kilometer.bezahltIsDefault).toBe(true);
    expect(cells.kilometer.bezahlt).toBeCloseTo(TRAVEL_KM, 3);
    expect(cells.kilometer.saldo).toBe(0);
    expect(cells.hw.bezahltIsDefault).toBe(true);
    expect(cells.hw.bezahlt).toBe(HW_MINUTES / 60);
    expect(cells.hw.saldo).toBe(0);

    assertSaldoIdentity(cells);
  });

  it("berechnet den Saldo = Anfangsbestand + Erfasst − Bezahlt (Go-Live-Anfangsbestand)", async () => {
    // Go-Live-Anfangsbestand 5 h + Bezahlt 1 h auf HW.
    const put = await apiPut(`/api/admin/mitarbeiterabrechnung/account`, {
      userId: employeeId,
      year: TARGET_YEAR,
      month: TARGET_MONTH,
      category: "hw",
      anfangsbestand: 5,
      bezahlt: 1,
      openingBalanceType: "go_live",
    });
    expect(put.status).toBe(200);

    const cells = await getCells();
    expect(cells.hw.anfangsbestand).toBe(5);
    expect(cells.hw.anfangsbestandType).toBe("go_live");
    expect(cells.hw.erfasst).toBe(HW_MINUTES / 60); // 2.0
    expect(cells.hw.bezahlt).toBe(1);
    expect(cells.hw.bezahltIsDefault).toBe(false);
    // Saldo = 5 + 2 − 1 = 6
    expect(cells.hw.saldo).toBe(6);

    assertSaldoIdentity(cells);
  });

  it("schreibt bei jeder erfolgreichen Bearbeitung einen Audit-Eintrag", async () => {
    const before = await countAudit();

    const put = await apiPut(`/api/admin/mitarbeiterabrechnung/account`, {
      userId: employeeId,
      year: TARGET_YEAR,
      month: TARGET_MONTH,
      category: "kilometer",
      bezahlt: 4,
    });
    expect(put.status).toBe(200);

    const after = await countAudit();
    expect(after).toBe(before + 1);

    const entry = await db.execute(sql`
      SELECT metadata FROM audit_log
      WHERE action = 'hours_account_updated'
        AND entity_type = 'hours_account'
        AND (metadata->>'employeeUserId')::int = ${employeeId}
      ORDER BY id DESC LIMIT 1
    `);
    const meta = (entry.rows[0] as { metadata: Record<string, any> }).metadata;
    expect(meta.category).toBe("kilometer");
    expect(meta.year).toBe(TARGET_YEAR);
    expect(meta.month).toBe(TARGET_MONTH);
    expect(meta.next.bezahlt).toBe(4);

    // Saldo folgt dem manuell gesetzten Bezahlt: 0 + 10 − 4 = 6.
    const cells = await getCells();
    expect(cells.kilometer.saldo).toBe(6);
    assertSaldoIdentity(cells);
  });

  it("lehnt einen Anfangsbestand ab, der nicht als Go-Live gesetzt wird", async () => {
    const put = await apiPut(`/api/admin/mitarbeiterabrechnung/account`, {
      userId: employeeId,
      year: TARGET_YEAR,
      month: TARGET_MONTH,
      category: "ab",
      anfangsbestand: 3, // ohne openingBalanceType: 'go_live'
    });
    expect(put.status).toBe(400);
    expect((put.data as { error: string }).error).toBe("OPENING_BALANCE_LOCKED");
  });

  it("haelt Bezahlt nach dem Monatsabschluss editierbar, sperrt aber den Anfangsbestand", async () => {
    // Task #1733 — Feld-granulare Sperre: der Lohnlauf läuft NACH dem
    // Auto-Abschluss, daher muss „Bezahlt" weiter erfassbar bleiben, während
    // der Anfangsbestand (Übertrag/Go-Live) gesperrt bleibt.
    // Auto-Abschluss simulieren: Periodensperre schreiben (kein reopened_at).
    const auth = await getAuthCookie();
    await db.execute(sql`
      INSERT INTO employee_month_closings (user_id, year, month, closed_by_user_id)
      VALUES (${employeeId}, ${TARGET_YEAR}, ${TARGET_MONTH}, ${auth.user.id})
      ON CONFLICT (user_id, year, month) DO UPDATE SET reopened_at = NULL
    `);

    const before = await countAudit();

    // „Bezahlt" bleibt auf einem abgeschlossenen Monat erfassbar (200) …
    const putBezahlt = await apiPut(`/api/admin/mitarbeiterabrechnung/account`, {
      userId: employeeId,
      year: TARGET_YEAR,
      month: TARGET_MONTH,
      category: "hw",
      bezahlt: 99,
    });
    expect(putBezahlt.status).toBe(200);

    // … und wird wie bisher auditiert.
    const after = await countAudit();
    expect(after).toBe(before + 1);

    // Der neue Bezahlt-Wert schlägt im Saldo durch: 5 + 2 − 99 = -92.
    const detail = await apiGet<DrilldownResponse>(
      `/api/admin/mitarbeiterabrechnung/employee/${employeeId}?year=${TARGET_YEAR}&month=${TARGET_MONTH}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.data.isClosed).toBe(true);
    const cells: Record<string, AccountCell> = {};
    for (const c of detail.data.accountCells) cells[c.category] = c;
    expect(cells.hw.bezahlt).toBe(99);
    expect(cells.hw.anfangsbestand).toBe(5);
    expect(cells.hw.saldo).toBe(r2(5 + HW_MINUTES / 60 - 99));
    assertSaldoIdentity(cells);
  });

  it("sperrt den Anfangsbestand auf einem abgeschlossenen Monat (403)", async () => {
    // Der abschließende Monat wurde im vorigen Test gesperrt und bleibt es.
    const before = await countAudit();

    const putOpening = await apiPut(`/api/admin/mitarbeiterabrechnung/account`, {
      userId: employeeId,
      year: TARGET_YEAR,
      month: TARGET_MONTH,
      category: "hw",
      anfangsbestand: 42,
      openingBalanceType: "go_live",
    });
    expect(putOpening.status).toBe(403);
    expect((putOpening.data as { error: string }).error).toBe("MONTH_CLOSED");

    // Kein Schreibvorgang ⇒ kein zusätzlicher Audit-Eintrag, Anfangsbestand unverändert.
    const after = await countAudit();
    expect(after).toBe(before);

    const detail = await apiGet<DrilldownResponse>(
      `/api/admin/mitarbeiterabrechnung/employee/${employeeId}?year=${TARGET_YEAR}&month=${TARGET_MONTH}`,
    );
    expect(detail.status).toBe(200);
    const cells: Record<string, AccountCell> = {};
    for (const c of detail.data.accountCells) cells[c.category] = c;
    expect(cells.hw.anfangsbestand).toBe(5);
  });
});

/**
 * Task #1555-Regression — Route-Smoke auf die BASIS-Übersichtsroute.
 *
 * Symptom: Das Frontend rief `GET /api/admin/mitarbeiterabrechnung?year&month`
 * auf und bekam 404 ⇒ KPI-Board, Aggregat-Tabelle und Stundenkonto blieben
 * für alle Monate leer. Die bestehenden Tests (#1551–#1554, #1557) trafen
 * entweder die Aggregationsfunktion direkt oder nur die Unterrouten
 * `/employee/:id` bzw. `/account` — die BASIS-Route war HTTP-seitig ungetestet,
 * daher rutschte ein Pfad-/Methoden-/Registrierungs-Mismatch stumm durch.
 *
 * Dieser Test feuert exakt denselben GET-Pfad wie das Frontend und schlägt
 * fehl, sobald die Route nicht (mehr) unter diesem Pfad registriert ist.
 */
const SMOKE_YEAR = 2022;
const SMOKE_MONTH = 11;
const SMOKE_DATE = `${SMOKE_YEAR}-${SMOKE_MONTH}-14`; // Montag, kein Wochenende
const SMOKE_HW_MINUTES = 90; // ⇒ erfasst.hw = 1.5 h
const SMOKE_TRAVEL_KM = 7;

interface OverviewRow {
  employeeId: number;
  vorname: string;
  nachname: string;
  erfasst: { hw: number; ab: number; feiertage: number; kilometer: number };
  unsignedAppointmentCount: number;
}

interface OverviewResponse {
  year: number;
  month: number;
  kpis: {
    erfassteStunden: { current: number; previous: number; deltaPct: number | null };
    abrechenbareStunden: { current: number; previous: number; deltaPct: number | null };
    produktivquote: { current: number; gemeinkostenStunden: number };
    wachstum: { produktivDeltaPct: number | null; gemeinkostenDeltaPct: number | null };
    stundenkontoSaldo: number;
    offeneTermine: { hours: number; count: number };
  };
  rows: OverviewRow[];
}

describe("Task #1555-Regression: GET /mitarbeiterabrechnung (Route-Smoke)", () => {
  let customerId: number;
  let employeeId: number;

  async function getOverview() {
    return apiGet<OverviewResponse>(
      `/api/admin/mitarbeiterabrechnung?year=${SMOKE_YEAR}&month=${SMOKE_MONTH}`,
    );
  }

  beforeAll(async () => {
    const customer = await createTestCustomer();
    customerId = customer.id as number;
    const serviceId = await getSeededHauswirtschaftServiceId();
    const employee = await createTestEmployee({ nachnamePrefix: "TestSmoke" });
    employeeId = employee.id;
    await assignEmployeeToCustomer(customerId, employeeId);

    const { appointmentId } = await createAndDocumentAppointment(customerId, serviceId, {
      assignedEmployeeId: employeeId,
      durationMinutes: SMOKE_HW_MINUTES,
    });
    await db.execute(sql`
      UPDATE appointments
      SET date = ${SMOKE_DATE},
          status = 'completed',
          signature_data = 'data:image/png;base64,SMOKE_SIGNED',
          performed_by_employee_id = ${employeeId},
          assigned_employee_id = ${employeeId},
          travel_minutes = 0,
          travel_kilometers = ${SMOKE_TRAVEL_KM},
          customer_kilometers = 0
      WHERE id = ${appointmentId}
    `);
    await db.execute(sql`
      UPDATE appointment_services
      SET actual_duration_minutes = ${SMOKE_HW_MINUTES}
      WHERE appointment_id = ${appointmentId}
    `);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM employee_hours_accounts WHERE user_id = ${employeeId}`);
    await db.execute(sql`DELETE FROM employee_month_closings WHERE user_id = ${employeeId}`);
    await cleanupCustomer(customerId);
    await deactivateTestEmployee(employeeId);
  });

  it("antwortet mit 200 (nicht 404) auf denselben GET-Pfad wie das Frontend", async () => {
    const res = await getOverview();
    expect(res.status).toBe(200);
    expect(res.data.year).toBe(SMOKE_YEAR);
    expect(res.data.month).toBe(SMOKE_MONTH);
  });

  it("liefert das erwartete KPI-Board- und Tabellen-Shape", async () => {
    const res = await getOverview();
    expect(res.status).toBe(200);
    const { kpis, rows } = res.data;
    // Alle sechs KPI-Gruppen des Boards müssen vorhanden und numerisch sein,
    // sonst rendern die KpiCards NaN/leer.
    expect(typeof kpis.erfassteStunden.current).toBe("number");
    expect(typeof kpis.abrechenbareStunden.current).toBe("number");
    expect(typeof kpis.produktivquote.current).toBe("number");
    expect(kpis.wachstum).toBeDefined();
    expect(typeof kpis.stundenkontoSaldo).toBe("number");
    expect(typeof kpis.offeneTermine.hours).toBe("number");
    expect(typeof kpis.offeneTermine.count).toBe("number");
    expect(Array.isArray(rows)).toBe(true);
  });

  it("verdrahtet die Aggregation mit der Route: der dokumentierte Termin erscheint in der Zeile", async () => {
    const res = await getOverview();
    expect(res.status).toBe(200);
    const mine = res.data.rows.find((r) => r.employeeId === employeeId);
    expect(mine, "Mitarbeiter mit dokumentiertem Termin muss eine Zeile haben").toBeDefined();
    expect(mine!.erfasst.hw).toBeCloseTo(SMOKE_HW_MINUTES / 60, 2); // 1.5
    expect(mine!.erfasst.kilometer).toBeCloseTo(SMOKE_TRAVEL_KM, 3);
    // Termin ist dokumentiert UND unterschrieben ⇒ keine offene Unterschrift.
    expect(mine!.unsignedAppointmentCount).toBe(0);
  });
});
