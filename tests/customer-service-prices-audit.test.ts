import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { apiPost, apiPatch, apiDelete, uniqueId, createTestCustomer, cleanupCustomer } from "./test-utils";
import { db } from "../server/lib/db";
import { sql } from "drizzle-orm";

/**
 * Task #836: Jede Anlage/Änderung/Löschung eines Kundenpreises MUSS einen
 * Audit-Eintrag erzeugen — auch dann, wenn kein abgerechneter Monat betroffen
 * ist (rein zukünftige Preise ohne Rechnungsbezug). Vor #836 wurde nur bei
 * Rechnungs-Impact (oder beim Ersetzen einer Zeile) auditiert, sodass eine
 * forensische Lücke in den Preis-Stammdaten entstand.
 */
describe("Kundenpreis-Audit ohne Rechnungsbezug (Task #836)", () => {
  let svcId = 0;
  let custId = 0;
  const createdPriceIds: number[] = [];

  async function countAudit(action: string): Promise<number> {
    const res = await db.execute(sql`
      SELECT COUNT(*)::int AS count FROM audit_log
      WHERE action = ${action}
        AND entity_type = 'customer'
        AND entity_id = ${custId}
    `);
    return (res.rows[0] as { count: number }).count;
  }

  function futureDate(monthsAhead: number, day: number): string {
    const d = new Date();
    d.setMonth(d.getMonth() + monthsAhead);
    d.setDate(day);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  beforeAll(async () => {
    const svcRes = await apiPost<any>("/api/services", {
      name: "QS-Audit-NoInvoice_" + uniqueId(),
      unitType: "hours",
      defaultPriceCents: 5000,
      vatRate: 19,
    });
    expect(svcRes.status).toBe(201);
    svcId = svcRes.data.id;

    const cust = await createTestCustomer();
    custId = cust.id;
  });

  afterAll(async () => {
    try {
      for (const pid of createdPriceIds) {
        await db.execute(sql`UPDATE customer_service_prices SET deleted_at = NOW() WHERE id = ${pid}`);
      }
    } catch {}
    try {
      if (svcId) {
        await db.execute(sql`UPDATE services SET is_active = false WHERE id = ${svcId}`);
      }
    } catch {}
    await cleanupCustomer(custId);
  });

  it("POST eines reinen Zukunftspreises schreibt einen customer_price_created Audit-Eintrag", async () => {
    const before = await countAudit("customer_price_created");

    const validFrom = futureDate(6, 12);
    const res = await apiPost<any>(`/api/customers/${custId}/service-prices`, {
      serviceId: svcId,
      priceCents: 4321,
      validFrom,
    });
    expect(res.status).toBe(200);
    expect(res.data.id).toBeGreaterThan(0);
    createdPriceIds.push(res.data.id);

    const after = await countAudit("customer_price_created");
    expect(after).toBe(before + 1);

    const entry = await db.execute(sql`
      SELECT metadata FROM audit_log
      WHERE action = 'customer_price_created'
        AND entity_type = 'customer'
        AND entity_id = ${custId}
      ORDER BY id DESC LIMIT 1
    `);
    const meta = (entry.rows[0] as { metadata: Record<string, unknown> }).metadata;
    expect(meta.serviceId).toBe(svcId);
    expect(meta.priceCents).toBe(4321);
    expect(meta.validFrom).toBe(validFrom);
    // Kein Rechnungsbezug → keine affectedInvoices im Kontext
    expect(meta.affectedInvoices).toBeUndefined();
  });

  it("PATCH eines Zukunftspreises ohne Rechnungsbezug schreibt einen customer_price_updated Audit-Eintrag", async () => {
    expect(createdPriceIds.length).toBeGreaterThan(0);
    const priceId = createdPriceIds[0];
    const before = await countAudit("customer_price_updated");

    const res = await apiPatch<any>(`/api/customers/${custId}/service-prices/${priceId}`, {
      priceCents: 4567,
    });
    expect(res.status).toBe(200);
    expect(res.data.priceCents).toBe(4567);

    const after = await countAudit("customer_price_updated");
    expect(after).toBe(before + 1);

    const entry = await db.execute(sql`
      SELECT metadata FROM audit_log
      WHERE action = 'customer_price_updated'
        AND entity_type = 'customer'
        AND entity_id = ${custId}
      ORDER BY id DESC LIMIT 1
    `);
    const meta = (entry.rows[0] as { metadata: Record<string, unknown> }).metadata;
    expect(meta.priceId).toBe(priceId);
    expect((meta.before as any).priceCents).toBe(4321);
    expect((meta.after as any).priceCents).toBe(4567);
    expect(meta.changedFields).toContain("priceCents");
    expect(meta.affectedInvoices).toBeUndefined();
  });

  it("DELETE eines Zukunftspreises ohne Rechnungsbezug schreibt einen customer_price_deleted Audit-Eintrag", async () => {
    expect(createdPriceIds.length).toBeGreaterThan(0);
    const priceId = createdPriceIds[0];
    const before = await countAudit("customer_price_deleted");

    const res = await apiDelete(`/api/customers/${custId}/service-prices/${priceId}`);
    expect(res.status).toBe(200);

    const after = await countAudit("customer_price_deleted");
    expect(after).toBe(before + 1);

    const entry = await db.execute(sql`
      SELECT metadata FROM audit_log
      WHERE action = 'customer_price_deleted'
        AND entity_type = 'customer'
        AND entity_id = ${custId}
      ORDER BY id DESC LIMIT 1
    `);
    const meta = (entry.rows[0] as { metadata: Record<string, unknown> }).metadata;
    expect(meta.priceId).toBe(priceId);
    expect(meta.futureOnly).toBe(true);
    expect(meta.affectedInvoices).toBeUndefined();

    // Preis ist soft-gelöscht; nicht erneut im afterAll antasten.
    createdPriceIds.shift();
  });
});
