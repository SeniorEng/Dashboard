/**
 * Integrationstest für `GET /api/appointments/coverage-check` ("Kunden ohne
 * Termin") — der Endpunkt hatte bis hierhin KEINEN Test.
 *
 * Er schließt die Lücke, die der Equality-Test
 * (`tests/equality/coverage-responsibility-ssot.test.ts`) per Konstruktion offen
 * lässt: dort werden zwei JS-Funktionen gegeneinander geprüft und die SQL-Seite
 * nur über Byte-Gleichheit des kompilierten Statements hergeleitet. Hier läuft
 * die Where-Bedingung `responsibilityCondition()` einmal wirklich gegen Postgres
 * und die Rollen-Ableitung `responsibilityRole()` wirklich gegen deren Ergebnis.
 *
 * Abgedeckt:
 *  - jede Rolle der Kette (primary / backup1 / backup2) wird ausgewählt und
 *    korrekt beschriftet,
 *  - ein Kunde, für den der Mitarbeiter NICHT zuständig ist, fällt raus,
 *  - `hvCount` + `vertretungCount` stimmen und summieren sich auf die Liste,
 *  - Vertretungs-Zeilen tragen den Namen der hauptverantwortlichen Kraft.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CoverageCheckResponse } from "@shared/api";
import {
  apiGet,
  apiPatch,
  createTestCustomer,
  createTestEmployee,
  cleanupCustomer,
  getAuthCookie,
} from "../test-utils";

let subjectEmployeeId: number;
let hvEmployeeId: number;
let hvEmployeeName: string;

/** Kunde mit dem Testmitarbeiter als Hauptverantwortlichem. */
let customerPrimaryId: number;
/** Kunde mit dem Testmitarbeiter als 1. Vertretung (HV = Superadmin). */
let customerBackup1Id: number;
/** Kunde mit dem Testmitarbeiter als 2. Vertretung (HV = Superadmin). */
let customerBackup2Id: number;
/** Kunde OHNE Bezug zum Testmitarbeiter — darf nicht auftauchen. */
let customerForeignId: number;

async function assign(
  customerId: number,
  chain: { primaryEmployeeId: number | null; backupEmployeeId: number | null; backupEmployeeId2: number | null },
): Promise<void> {
  const res = await apiPatch<unknown>(`/api/admin/customers/${customerId}/assign`, chain);
  if (res.status !== 200) {
    throw new Error(`assign fehlgeschlagen: ${res.status} ${JSON.stringify(res.data)}`);
  }
}

beforeAll(async () => {
  const auth = await getAuthCookie();
  hvEmployeeId = auth.user.id;
  hvEmployeeName = auth.user.displayName;

  const subject = await createTestEmployee({ nachnamePrefix: "CoverageSubject" });
  subjectEmployeeId = subject.id;

  // Frische Kunden ohne jeden Termin — damit sind sie per Definition
  // "unabgedeckt" in beiden Monatsfenstern des Endpunkts.
  const [a, b, c, d] = await Promise.all([
    createTestCustomer(),
    createTestCustomer(),
    createTestCustomer(),
    createTestCustomer(),
  ]);
  customerPrimaryId = a.id;
  customerBackup1Id = b.id;
  customerBackup2Id = c.id;
  customerForeignId = d.id;

  await assign(customerPrimaryId, {
    primaryEmployeeId: subjectEmployeeId, backupEmployeeId: null, backupEmployeeId2: null,
  });
  await assign(customerBackup1Id, {
    primaryEmployeeId: hvEmployeeId, backupEmployeeId: subjectEmployeeId, backupEmployeeId2: null,
  });
  await assign(customerBackup2Id, {
    primaryEmployeeId: hvEmployeeId, backupEmployeeId: null, backupEmployeeId2: subjectEmployeeId,
  });
  await assign(customerForeignId, {
    primaryEmployeeId: hvEmployeeId, backupEmployeeId: null, backupEmployeeId2: null,
  });
});

afterAll(async () => {
  await Promise.all([
    cleanupCustomer(customerPrimaryId),
    cleanupCustomer(customerBackup1Id),
    cleanupCustomer(customerBackup2Id),
    cleanupCustomer(customerForeignId),
  ]);
});

describe("GET /api/appointments/coverage-check — Rollen-Auswahl und Zähler-Split", () => {
  async function fetchCoverage(): Promise<CoverageCheckResponse> {
    const res = await apiGet<CoverageCheckResponse>(
      `/api/appointments/coverage-check?employeeId=${subjectEmployeeId}`,
    );
    expect(res.status).toBe(200);
    return res.data;
  }

  it("wählt alle drei Rollen der Kette aus und beschriftet sie korrekt", async () => {
    const data = await fetchCoverage();
    const byId = new Map(data.currentMonth.uncoveredCustomers.map((c) => [c.id, c]));

    expect(byId.get(customerPrimaryId)?.role).toBe("primary");
    expect(byId.get(customerBackup1Id)?.role).toBe("backup1");
    expect(byId.get(customerBackup2Id)?.role).toBe("backup2");
  });

  it("lässt einen Kunden aus, für den der Mitarbeiter nicht zuständig ist", async () => {
    const data = await fetchCoverage();
    const ids = data.currentMonth.uncoveredCustomers.map((c) => c.id);
    expect(ids).not.toContain(customerForeignId);
  });

  it("Vertretungs-Zeilen tragen den Namen der hauptverantwortlichen Kraft, HV-Zeilen nicht", async () => {
    const data = await fetchCoverage();
    const byId = new Map(data.currentMonth.uncoveredCustomers.map((c) => [c.id, c]));

    expect(byId.get(customerBackup1Id)?.primaryEmployeeName).toBe(hvEmployeeName);
    expect(byId.get(customerBackup2Id)?.primaryEmployeeName).toBe(hvEmployeeName);
    expect(byId.get(customerPrimaryId)?.primaryEmployeeName).toBeUndefined();
  });

  it("Zähler-Split zählt die eigenen Kunden und summiert sich auf die Liste", async () => {
    const data = await fetchCoverage();

    for (const month of [data.currentMonth, data.nextMonth]) {
      // Andere Testdaten können demselben Mitarbeiter nicht zugeordnet sein (er
      // ist frisch angelegt) — die Zahlen sind daher exakt, nicht nur "mindestens".
      expect(month.uncoveredCustomers).toHaveLength(3);
      expect(month.hvCount).toBe(1);
      expect(month.vertretungCount).toBe(2);
      expect(month.hvCount + month.vertretungCount).toBe(month.uncoveredCustomers.length);
    }
  });
});
