import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { apiGet, apiPost, apiPatch, apiDelete, uniqueId } from "./test-utils";
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

describe("Schutz gegen direktes PATCH-Update von Kundenpreisen in abgerechneten Monaten (Task #192)", () => {
  let svcId: number = 0;
  let custId: number = 0;
  let invId: number = 0;
  let priceId: number = 0;

  beforeAll(async () => {
    const svcRes = await apiPost<any>("/api/services", {
      name: "QS-Pricing-Patch_" + uniqueId(),
      unitType: "hours",
      defaultPriceCents: 5000,
      vatRate: 19,
    });
    expect(svcRes.status).toBe(201);
    svcId = svcRes.data.id;

    const customers = await apiGet<any[]>("/api/customers");
    expect(customers.status).toBe(200);
    expect(customers.data.length).toBeGreaterThan(0);
    custId = customers.data[0].id;

    const future = new Date();
    future.setMonth(future.getMonth() + 6);
    future.setDate(15);
    const futureValidFrom = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, "0")}-${String(future.getDate()).padStart(2, "0")}`;
    const priceRes = await apiPost<any>(`/api/customers/${custId}/service-prices`, {
      serviceId: svcId,
      priceCents: 4800,
      validFrom: futureValidFrom,
    });
    expect(priceRes.status).toBe(200);
    priceId = priceRes.data.id;

    const today = new Date();
    const invoiceNumber = "QS-INV-PATCH-" + uniqueId();
    const insertRes = await db.execute(sql`
      INSERT INTO invoices (
        invoice_number, customer_id, billing_type, invoice_type,
        billing_month, billing_year, recipient_name,
        net_amount_cents, vat_amount_cents, gross_amount_cents,
        status
      ) VALUES (
        ${invoiceNumber}, ${custId}, 'privat', 'rechnung',
        ${today.getMonth() + 1}, ${today.getFullYear()}, 'Test',
        0, 0, 0,
        'versendet'
      ) RETURNING id
    `);
    invId = (insertRes.rows[0] as any).id as number;
  });

  afterAll(async () => {
    try {
      if (priceId) {
        await db.execute(sql`UPDATE customer_service_prices SET deleted_at = NOW() WHERE id = ${priceId}`);
      }
    } catch {}
    try {
      if (invId) {
        await db.execute(sql`DELETE FROM invoices WHERE id = ${invId}`);
      }
    } catch {}
    try {
      if (svcId) {
        await db.execute(sql`UPDATE services SET is_active = false WHERE id = ${svcId}`);
      }
    } catch {}
  });

  it("akzeptiert PATCH ohne Override, wenn nur ein zukünftiger validFrom verschoben wird (kein abgerechneter Monat betroffen)", async () => {
    const future = new Date();
    future.setMonth(future.getMonth() + 7);
    future.setDate(1);
    const newValidFrom = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, "0")}-${String(future.getDate()).padStart(2, "0")}`;
    const res = await apiPatch<any>(`/api/customers/${custId}/service-prices/${priceId}`, {
      validFrom: newValidFrom,
    });
    expect(res.status).toBe(200);
    expect(res.data.id).toBe(priceId);
  });

  it("blockiert PATCH mit 409, wenn validFrom in einen bereits abgerechneten Monat verschoben wird", async () => {
    const today = new Date();
    const pastValidFrom = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
    const res = await apiPatch<any>(`/api/customers/${custId}/service-prices/${priceId}`, {
      validFrom: pastValidFrom,
    });
    expect(res.status).toBe(409);
    expect(res.data.code).toBe("INVOICED_PERIOD_AFFECTED");
    expect(Array.isArray(res.data.details?.invoices)).toBe(true);
    expect(res.data.details.invoices.some((i: any) => i.id === invId)).toBe(true);
  });

  it("akzeptiert PATCH mit confirmInvoiceOverride=true und schreibt einen Audit-Eintrag", async () => {
    const beforeAudit = await db.execute(sql`
      SELECT COUNT(*)::int AS count FROM audit_log
      WHERE action = 'customer_price_changed_invoiced'
        AND entity_type = 'customer'
        AND entity_id = ${custId}
        AND metadata->>'action' = 'update_price'
    `);
    const beforeCount = (beforeAudit.rows[0] as any).count as number;

    const today = new Date();
    const pastValidFrom = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
    const res = await apiPatch<any>(`/api/customers/${custId}/service-prices/${priceId}`, {
      validFrom: pastValidFrom,
      priceCents: 5500,
      confirmInvoiceOverride: true,
    });
    expect(res.status).toBe(200);
    expect(res.data.id).toBe(priceId);
    expect(res.data.priceCents).toBe(5500);

    const afterAudit = await db.execute(sql`
      SELECT COUNT(*)::int AS count FROM audit_log
      WHERE action = 'customer_price_changed_invoiced'
        AND entity_type = 'customer'
        AND entity_id = ${custId}
        AND metadata->>'action' = 'update_price'
    `);
    const afterCount = (afterAudit.rows[0] as any).count as number;
    expect(afterCount).toBe(beforeCount + 1);
  });

  it("liefert 400 zurück, wenn validTo vor validFrom liegt", async () => {
    const res = await apiPatch<any>(`/api/customers/${custId}/service-prices/${priceId}`, {
      validTo: "2020-01-01",
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toBe("VALIDATION_ERROR");
  });

  it("liefert 404 zurück, wenn die Preis-ID nicht existiert", async () => {
    const res = await apiPatch<any>(`/api/customers/${custId}/service-prices/999999999`, {
      priceCents: 1234,
    });
    expect(res.status).toBe(404);
    expect(res.data.error).toBe("NOT_FOUND");
  });

  it("liefert 400 zurück, wenn keine Felder zum Aktualisieren übergeben werden", async () => {
    const res = await apiPatch<any>(`/api/customers/${custId}/service-prices/${priceId}`, {});
    expect(res.status).toBe(400);
    expect(res.data.error).toBe("VALIDATION_ERROR");
  });
});
