/**
 * Task #1424 — Per-Row-Löschung einer EINZELNEN unbenutzten Pflegekasse.
 *
 * Prüft die Storage-SSoT `deleteInsuranceProviderIfUnused`:
 *   - eine UNBENUTZTE Kasse wird gelöscht (`status: "deleted"`),
 *   - eine REFERENZIERTE Kasse bleibt unangetastet (`status: "in_use"`),
 *   - eine nicht existierende ID liefert `status: "not_found"`.
 *
 * Bewusst gegen die Storage-Funktion (nicht die HTTP-Route) getestet, damit der
 * transaktionale Race-Schutz und die geteilte SSoT `isUnusedInsuranceProvider()`
 * direkt abgesichert sind.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { customers, insuranceProviders, customerInsuranceHistory } from "@shared/schema";
import { uniqueId } from "../test-utils";
import { deleteInsuranceProviderIfUnused } from "../../server/storage/customer-mgmt/insurance";

const TAG = `t1424-${uniqueId()}`;

let referencedProviderId: number;
let unusedProviderId: number;
let customerId: number;

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

  const [cust] = await db
    .insert(customers)
    .values({
      name: `T1424-Kunde-${TAG}`,
      address: "Teststraße 1, 10115 Berlin",
      vorname: "T1424",
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
      .where(inArray(insuranceProviders.id, [referencedProviderId, unusedProviderId]));
  } catch {}
});

describe("Task #1424 — deleteInsuranceProviderIfUnused", () => {
  it("lehnt eine referenzierte Kasse mit status 'in_use' ab", async () => {
    const result = await deleteInsuranceProviderIfUnused(referencedProviderId);
    expect(result.status).toBe("in_use");

    const stillThere = await db
      .select({ id: insuranceProviders.id })
      .from(insuranceProviders)
      .where(eq(insuranceProviders.id, referencedProviderId));
    expect(stillThere).toHaveLength(1);
  });

  it("liefert 'not_found' für eine nicht existierende ID", async () => {
    const result = await deleteInsuranceProviderIfUnused(987654321);
    expect(result.status).toBe("not_found");
  });

  it("löscht eine unbenutzte Kasse und gibt den gelöschten Datensatz zurück", async () => {
    const result = await deleteInsuranceProviderIfUnused(unusedProviderId);
    expect(result.status).toBe("deleted");
    if (result.status === "deleted") {
      expect(result.provider.id).toBe(unusedProviderId);
      expect(result.provider.name).toBe(`Unbenutzt-${TAG}`);
    }

    const gone = await db
      .select({ id: insuranceProviders.id })
      .from(insuranceProviders)
      .where(eq(insuranceProviders.id, unusedProviderId));
    expect(gone).toHaveLength(0);
  });
});
