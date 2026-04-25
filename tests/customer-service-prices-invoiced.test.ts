import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { apiGet, apiPost, apiDelete, uniqueId } from "./test-utils";
import { db } from "../server/lib/db";
import { sql } from "drizzle-orm";

let createdServiceId: number = 0;
let createdCustomerId: number = 0;
let createdInvoiceId: number = 0;
let createdPriceIds: number[] = [];

describe("Schutz gegen versehentliches Verlängern abgelaufener Kundenpreise (Task #191)", () => {
  beforeAll(async () => {
    const serviceName = "QS-Pricing-Guard_" + uniqueId();
    const svcRes = await apiPost<any>("/api/services", {
      name: serviceName,
      unitType: "hours",
      defaultPriceCents: 5000,
      vatRate: 19,
    });
    expect(svcRes.status).toBe(201);
    createdServiceId = svcRes.data.id;

    const customers = await apiGet<any[]>("/api/customers");
    expect(customers.status).toBe(200);
    expect(customers.data.length).toBeGreaterThan(0);
    createdCustomerId = customers.data[0].id;

    const today = new Date();
    const billingMonth = today.getMonth() + 1;
    const billingYear = today.getFullYear();
    const invoiceNumber = "QS-INV-" + uniqueId();
    const insertRes = await db.execute(sql`
      INSERT INTO invoices (
        invoice_number, customer_id, billing_type, invoice_type,
        billing_month, billing_year, recipient_name,
        net_amount_cents, vat_amount_cents, gross_amount_cents,
        status
      ) VALUES (
        ${invoiceNumber}, ${createdCustomerId}, 'privat', 'rechnung',
        ${billingMonth}, ${billingYear}, 'Test',
        0, 0, 0,
        'versendet'
      ) RETURNING id
    `);
    createdInvoiceId = (insertRes.rows[0] as any).id as number;
  });

  afterAll(async () => {
    try {
      for (const pid of createdPriceIds) {
        await db.execute(sql`UPDATE customer_service_prices SET deleted_at = NOW() WHERE id = ${pid}`);
      }
    } catch {}
    try {
      if (createdInvoiceId) {
        await db.execute(sql`DELETE FROM invoices WHERE id = ${createdInvoiceId}`);
      }
    } catch {}
    try {
      if (createdServiceId) {
        await db.execute(sql`UPDATE services SET is_active = false WHERE id = ${createdServiceId}`);
      }
    } catch {}
  });

  it("blockiert POST mit 409, wenn die Preisänderung in einen abgerechneten Monat fällt", async () => {
    const today = new Date();
    const validFrom = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const res = await apiPost<any>(`/api/customers/${createdCustomerId}/service-prices`, {
      serviceId: createdServiceId,
      priceCents: 4200,
      validFrom,
    });
    expect(res.status).toBe(409);
    expect(res.data.code).toBe("INVOICED_PERIOD_AFFECTED");
    expect(Array.isArray(res.data.details?.invoices)).toBe(true);
    expect(res.data.details.invoices.length).toBeGreaterThan(0);
    expect(res.data.details.invoices.some((i: any) => i.id === createdInvoiceId)).toBe(true);
  });

  it("akzeptiert POST mit confirmInvoiceOverride=true und schreibt einen Audit-Eintrag", async () => {
    const today = new Date();
    const validFrom = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

    const beforeAudit = await db.execute(sql`
      SELECT COUNT(*)::int AS count FROM audit_log
      WHERE action = 'customer_price_changed_invoiced'
        AND entity_type = 'customer'
        AND entity_id = ${createdCustomerId}
    `);
    const beforeCount = (beforeAudit.rows[0] as any).count as number;

    const res = await apiPost<any>(`/api/customers/${createdCustomerId}/service-prices`, {
      serviceId: createdServiceId,
      priceCents: 4200,
      validFrom,
      confirmInvoiceOverride: true,
    });
    expect(res.status).toBe(200);
    expect(res.data.id).toBeGreaterThan(0);
    createdPriceIds.push(res.data.id);

    const afterAudit = await db.execute(sql`
      SELECT COUNT(*)::int AS count FROM audit_log
      WHERE action = 'customer_price_changed_invoiced'
        AND entity_type = 'customer'
        AND entity_id = ${createdCustomerId}
    `);
    const afterCount = (afterAudit.rows[0] as any).count as number;
    expect(afterCount).toBe(beforeCount + 1);
  });

  it("erlaubt POST ohne Override, wenn validFrom in einem nicht-abgerechneten zukünftigen Monat liegt", async () => {
    const future = new Date();
    future.setMonth(future.getMonth() + 6);
    future.setDate(15);
    const validFrom = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, "0")}-${String(future.getDate()).padStart(2, "0")}`;
    const res = await apiPost<any>(`/api/customers/${createdCustomerId}/service-prices`, {
      serviceId: createdServiceId,
      priceCents: 4900,
      validFrom,
    });
    expect(res.status).toBe(200);
    expect(res.data.id).toBeGreaterThan(0);
    createdPriceIds.push(res.data.id);
  });

  it("blockiert DELETE mit 409, wenn das Löschen eines aktiven Preises einen abgerechneten Monat betrifft", async () => {
    expect(createdPriceIds.length).toBeGreaterThan(0);
    const currentPriceId = createdPriceIds[0];
    const res = await apiDelete(`/api/customers/${createdCustomerId}/service-prices/${currentPriceId}`);
    expect(res.status).toBe(409);
    expect((res.data as any).code).toBe("INVOICED_PERIOD_AFFECTED");
    expect(Array.isArray((res.data as any).details?.invoices)).toBe(true);
  });

  it("akzeptiert DELETE mit ?confirmInvoiceOverride=true", async () => {
    const currentPriceId = createdPriceIds[0];
    const res = await apiDelete(`/api/customers/${createdCustomerId}/service-prices/${currentPriceId}?confirmInvoiceOverride=true`);
    expect(res.status).toBe(200);
    createdPriceIds.shift();
  });
});
