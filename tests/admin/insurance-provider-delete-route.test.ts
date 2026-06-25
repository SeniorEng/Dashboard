/**
 * Task #1425 — API-Level-Absicherung der Route
 *   DELETE /api/admin/insurance-providers/:id
 *
 * Die Storage-SSoT `deleteInsuranceProviderIfUnused` ist bereits separat
 * getestet (`insurance-provider-delete.test.ts`). Hier sichern wir die HTTP-
 * Route selbst ab, damit eine spätere Änderung nicht versehentlich
 *   - Nicht-Superadmins löschen lässt (Authorization),
 *   - den In-Use-Schutz (409) aushebelt,
 *   - oder das Audit-Logging vergisst.
 *
 * Geprüft wird:
 *   - ein normaler Admin wird abgewiesen (403 FORBIDDEN),
 *   - ein Mitarbeiter wird abgewiesen (403 FORBIDDEN),
 *   - eine noch zugewiesene Kasse liefert 409 (in use),
 *   - eine nicht existierende ID liefert 404,
 *   - eine unbenutzte Kasse wird gelöscht (200) und schreibt einen
 *     `insurance_provider_deleted`-Audit-Eintrag.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { customers, insuranceProviders, customerInsuranceHistory } from "@shared/schema";
import {
  apiDelete,
  apiDeleteAs,
  createTestEmployee,
  deactivateTestEmployee,
  loginAs,
  resetAuthCache,
  uniqueId,
} from "../test-utils";

const TAG = `t1425-${uniqueId()}`;

let referencedProviderId: number;
let unusedProviderId: number;
let authGuardProviderId: number;
let customerId: number;
const createdEmployeeIds: number[] = [];

interface DeleteResponse {
  deleted?: boolean;
  error?: string;
  message?: string;
}

async function providerExists(id: number): Promise<boolean> {
  const rows = await db
    .select({ id: insuranceProviders.id })
    .from(insuranceProviders)
    .where(eq(insuranceProviders.id, id));
  return rows.length > 0;
}

async function countDeletionAudit(providerId: number): Promise<number> {
  const res = await db.execute(sql`
    SELECT COUNT(*)::int AS count FROM audit_log
    WHERE action = 'insurance_provider_deleted'
      AND entity_type = 'insurance_provider'
      AND entity_id = ${providerId}
  `);
  return (res.rows[0] as { count: number }).count;
}

beforeAll(async () => {
  const [ref] = await db
    .insert(insuranceProviders)
    .values({ name: `Referenziert-${TAG}`, isPrivate: false } as any)
    .returning({ id: insuranceProviders.id });
  referencedProviderId = ref.id;

  const [unused] = await db
    .insert(insuranceProviders)
    .values({ name: `Unbenutzt-${TAG}`, isPrivate: true } as any)
    .returning({ id: insuranceProviders.id });
  unusedProviderId = unused.id;

  const [guard] = await db
    .insert(insuranceProviders)
    .values({ name: `AuthGuard-${TAG}`, isPrivate: true } as any)
    .returning({ id: insuranceProviders.id });
  authGuardProviderId = guard.id;

  const [cust] = await db
    .insert(customers)
    .values({
      name: `T1425-Kunde-${TAG}`,
      address: "Teststraße 1, 10115 Berlin",
      vorname: "T1425",
      nachname: `Kunde-${TAG}`,
      billingType: "selbstzahler",
    } as any)
    .returning({ id: customers.id });
  customerId = cust.id;

  // Verknüpft die REFERENZIERTE Kasse mit dem Kunden → "benutzt".
  await db.insert(customerInsuranceHistory).values({
    customerId,
    insuranceProviderId: referencedProviderId,
    versichertennummer: `VN-${TAG}`,
    validFrom: "2024-01-01",
  } as any);
});

afterAll(async () => {
  try {
    await db.delete(customers).where(eq(customers.id, customerId));
  } catch {}
  try {
    await db
      .delete(insuranceProviders)
      .where(
        inArray(insuranceProviders.id, [
          referencedProviderId,
          unusedProviderId,
          authGuardProviderId,
        ]),
      );
  } catch {}
  for (const id of createdEmployeeIds) await deactivateTestEmployee(id);
  resetAuthCache();
});

describe("Task #1425 — DELETE /api/admin/insurance-providers/:id", () => {
  it("weist einen normalen Admin ab (403) und lässt die Kasse unangetastet", async () => {
    const admin = await createTestEmployee({ isAdmin: true, nachnamePrefix: "T1425Admin" });
    createdEmployeeIds.push(admin.id);
    const adminAuth = await loginAs(admin.email, admin.password);

    const res = await apiDeleteAs(adminAuth, `/api/admin/insurance-providers/${authGuardProviderId}`);
    expect(res.status).toBe(403);
    expect((res.data as DeleteResponse).error).toBe("FORBIDDEN");

    expect(await providerExists(authGuardProviderId)).toBe(true);
  });

  it("weist einen Mitarbeiter ab (403) und lässt die Kasse unangetastet", async () => {
    const employee = await createTestEmployee({ isAdmin: false, nachnamePrefix: "T1425Emp" });
    createdEmployeeIds.push(employee.id);
    const employeeAuth = await loginAs(employee.email, employee.password);

    const res = await apiDeleteAs(employeeAuth, `/api/admin/insurance-providers/${authGuardProviderId}`);
    expect(res.status).toBe(403);
    expect((res.data as DeleteResponse).error).toBe("FORBIDDEN");

    expect(await providerExists(authGuardProviderId)).toBe(true);
  });

  it("liefert 409 für eine noch zugewiesene Kasse (in use)", async () => {
    const res = await apiDelete(`/api/admin/insurance-providers/${referencedProviderId}`);
    expect(res.status).toBe(409);
    expect((res.data as DeleteResponse).error).toBe("CONFLICT");

    expect(await providerExists(referencedProviderId)).toBe(true);
  });

  it("liefert 404 für eine nicht existierende ID", async () => {
    const res = await apiDelete(`/api/admin/insurance-providers/987654321`);
    expect(res.status).toBe(404);
    expect((res.data as DeleteResponse).error).toBe("NOT_FOUND");
  });

  it("löscht eine unbenutzte Kasse (200) und schreibt einen Audit-Eintrag", async () => {
    const auditBefore = await countDeletionAudit(unusedProviderId);

    const res = await apiDelete(`/api/admin/insurance-providers/${unusedProviderId}`);
    expect(res.status).toBe(200);
    expect((res.data as DeleteResponse).deleted).toBe(true);

    expect(await providerExists(unusedProviderId)).toBe(false);

    const auditAfter = await countDeletionAudit(unusedProviderId);
    expect(auditAfter).toBe(auditBefore + 1);

    const entry = await db.execute(sql`
      SELECT metadata FROM audit_log
      WHERE action = 'insurance_provider_deleted'
        AND entity_type = 'insurance_provider'
        AND entity_id = ${unusedProviderId}
      ORDER BY id DESC LIMIT 1
    `);
    const meta = (entry.rows[0] as { metadata: Record<string, unknown> }).metadata;
    expect(meta.name).toBe(`Unbenutzt-${TAG}`);
    expect(meta.isPrivate).toBe(true);
  });
});
