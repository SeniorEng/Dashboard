import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiPostAs,
  loginAs,
  createTestEmployee,
  deactivateTestEmployee,
  uniqueId,
  runCleanup,
} from "../test-utils";

let employeeAuth: Awaited<ReturnType<typeof loginAs>>;
let employeeId: number | null = null;

beforeAll(async () => {
  const emp = await createTestEmployee({ isAdmin: false, nachnamePrefix: "RouteRemoved" });
  employeeId = emp.id;
  employeeAuth = await loginAs(emp.email, emp.password);
});

afterAll(async () => {
  await runCleanup();
  await deactivateTestEmployee(employeeId);
});

describe("N13: POST /api/customers ist entfernt", () => {
  it("legt für authentifizierten Non-Admin keinen Kunden mehr an (kein 201, keine Customer-ID)", async () => {
    const payload = {
      vorname: "RegressionGuard",
      nachname: "Removed-" + uniqueId(),
      geburtsdatum: "1940-01-15",
      strasse: "Teststraße",
      nr: "1",
      plz: "10115",
      stadt: "Berlin",
      pflegegrad: 3,
      pflegegradSeit: "2024-01-01",
    };

    const res = await apiPostAs<any>(employeeAuth, "/api/customers", payload);

    // Wäre die Route wieder eingeführt, käme 201 mit dem neu angelegten
    // Customer-Objekt zurück (siehe vorherige Implementierung).
    expect(
      res.status,
      `Erwartet kein 201 (Route entfernt). Status=${res.status}, body=${JSON.stringify(res.data)}`,
    ).not.toBe(201);

    expect(
      res.data?.id,
      `Antwort darf keinen neu angelegten Kunden enthalten. body=${JSON.stringify(res.data)}`,
    ).toBeUndefined();

    expect(
      res.data?.vorname,
      `Antwort darf keinen Customer-Vornamen enthalten. body=${JSON.stringify(res.data)}`,
    ).toBeUndefined();
  });
});
