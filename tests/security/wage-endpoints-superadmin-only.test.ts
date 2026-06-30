import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiGetAs,
  createTestEmployee,
  deactivateTestEmployee,
  loginAs,
} from "../test-utils";

/**
 * Task #1512 — Lohn-/Auszahlungs-/Personalkosten-Daten PRO MITARBEITER sind
 * ausnahmslos Superadmin-only.
 *
 * Der User-Beschluss zu #1512 verschiebt die tatsächlichen Pro-Mitarbeiter-
 * Vergütungszahlen (Lexware-Brutto/Auszahlung, Profitabilität/Wirtschaftlich-
 * keit je Mitarbeiter) hinter die `requireWageDataAccess`-Schranke
 * (= `requireSuperAdmin`). Dieser Test PINNT die Garantie serverseitig, damit
 * ein späteres Refactor die sensiblen Lohndaten nicht unbemerkt wieder für
 * normale Admins öffnet.
 *
 * Kontrakt pro Endpunkt:
 *   - Normaler Admin (isAdmin=true, isSuperAdmin=false) → 403 FORBIDDEN.
 *   - Superadmin (Default-Test-User) → 200.
 *
 * Bewusst NICHT hier (aggregierte, nicht-personenbezogene Geschäfts-KPIs
 * bleiben Admin-sichtbar): `/api/statistics/v2/revenue`, `/api/billing/pipeline`.
 */

interface ErrorResponse {
  error?: string;
  message?: string;
}

const createdEmployeeIds: number[] = [];
let normalAdminAuth: Awaited<ReturnType<typeof loginAs>>;

const now = new Date();
const year = now.getFullYear();
const month = now.getMonth() + 1;

// Jede lohn-tragende Route mit gültigen Query-Parametern für den 200er-Pfad.
const WAGE_ENDPOINTS: { name: string; path: string }[] = [
  { name: "GET /api/admin/hours-overview (Lexware-Auszahlung je Mitarbeiter)", path: `/api/admin/hours-overview?year=${year}&month=${month}` },
  // Sprung-Ziel der Lexware-Stundenübersicht — Teil derselben Superadmin-only
  // Lohn-Oberfläche; employeeId muss eine Zahl sein (der geseedete Superadmin id=1).
  { name: "GET /api/admin/hours-overview/unsigned-appointments (Lexware-Detailliste)", path: `/api/admin/hours-overview/unsigned-appointments?year=${year}&month=${month}&employeeId=1` },
  { name: "GET /api/statistics/v2/performance (Profitabilität je Mitarbeiter)", path: `/api/statistics/v2/performance?year=${year}&month=${month}` },
  { name: "GET /api/billing/economics (Personalkosten/Marge je Mitarbeiter)", path: `/api/billing/economics?year=${year}&month=${month}` },
];

beforeAll(async () => {
  const normalAdmin = await createTestEmployee({ isAdmin: true, nachnamePrefix: "WageEndpointAdmin" });
  createdEmployeeIds.push(normalAdmin.id);
  normalAdminAuth = await loginAs(normalAdmin.email, normalAdmin.password);
});

afterAll(async () => {
  for (const id of createdEmployeeIds) await deactivateTestEmployee(id);
});

describe("Lohn-tragende Endpunkte sind Superadmin-only (Task #1512)", () => {
  describe("Normaler Admin → 403 FORBIDDEN", () => {
    for (const { name, path } of WAGE_ENDPOINTS) {
      it(`${name} → 403`, async () => {
        const res = await apiGetAs<ErrorResponse>(normalAdminAuth, path);
        expect(res.status).toBe(403);
        expect(res.data.error).toBe("FORBIDDEN");
      });
    }
  });

  describe("Superadmin → 200", () => {
    for (const { name, path } of WAGE_ENDPOINTS) {
      it(`${name} → 200`, async () => {
        const res = await apiGet(path);
        expect(res.status).toBe(200);
      });
    }
  });
});
