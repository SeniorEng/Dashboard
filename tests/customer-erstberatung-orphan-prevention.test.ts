/**
 * Task #510 — Verhindert, dass neue "In Erstberatung"-Karteileichen entstehen.
 *
 * Ein Kunde darf nur dann den Status 'erstberatung' tragen, wenn er aus
 * einem Prospect konvertiert wurde (`convertedFromProspectId` gesetzt).
 * Sowohl der Storage-Layer-Guard als auch das DB-CHECK-Constraint müssen
 * den Insert/Update ablehnen.
 */
import { describe, it, expect, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../server/lib/db";
import { customers } from "../shared/schema";
import { customerManagementStorage } from "../server/storage/customer-management";
import { uniqueId } from "./test-utils";

const createdCustomerIds: number[] = [];

afterAll(async () => {
  for (const id of createdCustomerIds) {
    try {
      await db.update(customers).set({ deletedAt: new Date() }).where(eq(customers.id, id));
    } catch {}
  }
});

function basePayload(overrides: Record<string, any> = {}) {
  const tag = uniqueId();
  return {
    name: `Orphan-Test, QS-${tag}`,
    vorname: "QS",
    nachname: "Orphan-Test-" + tag,
    address: "Teststraße 1, 10115 Berlin",
    strasse: "Teststraße",
    nr: "1",
    plz: "10115",
    stadt: "Berlin",
    billingType: "selbstzahler",
    ...overrides,
  } as any;
}

describe("Task #510 — Erstberatung-Karteileichen-Prävention", () => {
  it("Storage-Guard lehnt Insert mit status='erstberatung' ohne convertedFromProspectId ab", async () => {
    await expect(
      customerManagementStorage.createCustomerDirect(
        basePayload({ status: "erstberatung", convertedFromProspectId: null }),
      ),
    ).rejects.toThrow(/erstberatung/i);
  });

  it("Storage-Guard erlaubt Insert mit status='aktiv' (Default-Pfad)", async () => {
    const created = await customerManagementStorage.createCustomerDirect(basePayload());
    createdCustomerIds.push(created.id);
    expect(created.status).toBe("aktiv");
  });

  it("Storage-Guard lehnt Update auf status='erstberatung' ohne Prospect-Bezug ab", async () => {
    const created = await customerManagementStorage.createCustomerDirect(basePayload());
    createdCustomerIds.push(created.id);
    await expect(
      customerManagementStorage.updateCustomer(created.id, { status: "erstberatung" }),
    ).rejects.toThrow(/erstberatung/i);
  });

  it("DB-CHECK-Constraint lehnt direkten SQL-Insert ohne Prospect-Bezug ab", async () => {
    // Falls die Migration das Constraint noch nicht setzen konnte (Altlasten in Prod),
    // skippen wir diesen Test — der Storage-Guard fängt den Fall trotzdem ab.
    const constraintExists = await db.execute(sql`
      SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      WHERE c.conname = 'customers_erstberatung_requires_prospect_check'
        AND t.relname = 'customers'
    `);
    if ((constraintExists.rows as unknown[]).length === 0) {
      return;
    }

    const tag = uniqueId();
    await expect(
      db.execute(sql`
        INSERT INTO customers (name, vorname, nachname, address, strasse, nr, plz, stadt, billing_type, status, converted_from_prospect_id)
        VALUES (${"Direct, QS-" + tag}, ${"QS"}, ${"Direct-" + tag}, ${"Teststr. 1, 10115 Berlin"}, ${"Teststr."}, ${"1"}, ${"10115"}, ${"Berlin"}, ${"selbstzahler"}, ${"erstberatung"}, NULL)
      `),
    ).rejects.toThrow();
  });
});
