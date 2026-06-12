import { test, expect } from "@playwright/test";
import {
  apiPost,
  apiPut,
  getAdminCreds,
  loginApiSession,
  type ApiSession,
} from "../helpers/auth";
import {
  assignEmployee,
  createAppointment,
  createCustomer,
  createEmployee,
  deactivateEmployee,
} from "../helpers/test-data";

// Task #1247 — Smoke-Pfad „Buchungs-Hard-Block: Selbstzahler vs. §45b".
//
// Der §45b-Entlastungsbetrag ist eine gesetzliche Pflegekassenleistung
// (SGB XI). Ein Selbstzahler hat darauf KEINEN Anspruch — er kann seine
// Termine niemals aus §45b finanzieren. Bisher war dieser Hard-Block nur
// über Unit-/Architektur-/Storage-Tests abgedeckt, nicht end-to-end gegen
// den live laufenden Server.
//
// Dieser Smoke-Test legt einen echten Selbstzahler-Kunden samt Termin an und
// weist nach, dass jeder §45b-Finanzierungs-Intent end-to-end mit 409
// `BUDGET_NOT_AVAILABLE_FOR_SELBSTZAHLER` geblockt wird:
//   1. §45b-Topf aktivieren (PUT type-settings, enabled=true)
//   2. §45b-Startwert/Restguthaben buchen (POST initial-budget)
// Anschließend wird bestätigt, dass §45b für den Kunden weiterhin deaktiviert
// bleibt (keine Zeile persistiert).
//
// Die Selbstzahler-Eligibility-Ablehnung ist FLAG-UNABHÄNGIG (greift ohne
// `BUDGET_HARD_HOLDS`), daher läuft der Test stabil gegen den vom Orchestrator
// flag-bereinigten Ephemeral-Test-Server. Verifikation ausschließlich über die
// JSON-API (kein DB-Zugriff im e2e).

const STATUTORY_45B = "entlastungsbetrag_45b";

const creds = getAdminCreds();
test.skip(!creds, "TEST_USER_EMAIL/TEST_USER_PASSWORD nicht gesetzt — Smoke-Suite übersprungen.");

let session: ApiSession;

test.beforeAll(async () => {
  session = await loginApiSession(creds!);
});

test.afterAll(async () => {
  if (session) await session.api.dispose();
});

interface TypeSettingRow {
  budgetType: string;
  enabled: boolean;
}

function enabledOf(rows: TypeSettingRow[], budgetType: string): boolean {
  const row = rows.find((r) => r.budgetType === budgetType);
  if (!row) throw new Error(`type-setting ${budgetType} fehlt in der Response`);
  return row.enabled;
}

test.describe("@smoke Buchungs-Hard-Block — Selbstzahler vs. §45b", () => {
  test("Selbstzahler-Termin kann nicht aus §45b finanziert werden (409, flag-unabhängig)", async () => {
    // EIN berechneter Anker (Monatsgrenzen-Falle): der §45b-Block ist
    // datums-unabhängig, daher reicht ein einziger Anker für den Startwert.
    const anchor = new Date();
    const anchorYmd = `${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2, "0")}-01`;

    // 1) Echter Selbstzahler-Kunde + Termin (acceptsPrivatePayment, damit der
    //    Termin regulär gegen den privaten Topf bucht und überhaupt anlegbar ist).
    const customer = await createCustomer(session, {
      billingType: "selbstzahler",
      acceptsPrivatePayment: true,
    });

    const employee = await createEmployee(session);
    await assignEmployee(session, customer.id, employee.id);
    const appointment = await createAppointment(session, {
      customerId: customer.id,
      employeeId: employee.id,
    });
    expect(appointment.id, "Termin wurde nicht angelegt").toBeGreaterThan(0);

    try {
      // 2) §45b-Topf aktivieren → Hard-Block (409).
      const enableRes = await apiPut<{ code?: string }>(
        session,
        `/api/budget/${customer.id}/type-settings`,
        {
          settings: [
            {
              budgetType: STATUTORY_45B,
              enabled: true,
              priority: 1,
              monthlyLimitCents: null,
              yearlyLimitCents: null,
            },
          ],
        },
      );
      expect(
        enableRes.status,
        `§45b-Aktivierung muss 409 liefern, war ${enableRes.status} (${JSON.stringify(enableRes.data)})`,
      ).toBe(409);
      expect(enableRes.data?.code).toBe("BUDGET_NOT_AVAILABLE_FOR_SELBSTZAHLER");

      // 3) §45b-Startwert/Restguthaben buchen → derselbe Hard-Block (409).
      const initialRes = await apiPost<{ code?: string }>(
        session,
        `/api/budget/${customer.id}/initial-budget`,
        {
          budgetType: STATUTORY_45B,
          currentMonthAmountCents: 5000,
          carryoverAmountCents: 0,
          budgetStartDate: anchorYmd,
        },
      );
      expect(
        initialRes.status,
        `§45b-Startwert muss 409 liefern, war ${initialRes.status} (${JSON.stringify(initialRes.data)})`,
      ).toBe(409);
      expect(initialRes.data?.code).toBe("BUDGET_NOT_AVAILABLE_FOR_SELBSTZAHLER");

      // 4) End-to-end-Beweis: §45b bleibt für den Selbstzahler deaktiviert —
      //    kein Topf, gegen den die Buchung des Termins routen könnte.
      const tsRes = await session.api.get(`/api/budget/${customer.id}/type-settings`);
      expect(tsRes.ok(), `type-settings GET fehlgeschlagen: ${tsRes.status()}`).toBeTruthy();
      const settings = (await tsRes.json()) as TypeSettingRow[];
      expect(enabledOf(settings, STATUTORY_45B)).toBe(false);
    } finally {
      await deactivateEmployee(session, employee.id);
    }
  });
});
