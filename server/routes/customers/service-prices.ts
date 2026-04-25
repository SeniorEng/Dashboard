import { Router } from "express";
import { insertCustomerServicePriceSchema } from "@shared/schema";
import { requireAdmin } from "../../middleware/auth";
import { asyncHandler } from "../../lib/errors";
import { requireIntParam } from "../../lib/params";
import { todayISO, addDays } from "@shared/utils/datetime";
import { db } from "../../lib/db";
import { sql } from "drizzle-orm";
import { auditService } from "../../services/audit";

const router = Router();

interface AffectedInvoice {
  id: number;
  invoiceNumber: string;
  billingMonth: number;
  billingYear: number;
  status: string;
}

async function findAffectedInvoicesFromDate(
  tx: typeof db,
  customerId: number,
  fromDate: string,
): Promise<AffectedInvoice[]> {
  const [yearStr, monthStr] = fromDate.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const result = await tx.execute(sql`
    SELECT id, invoice_number AS "invoiceNumber",
           billing_month AS "billingMonth", billing_year AS "billingYear",
           status
    FROM invoices
    WHERE customer_id = ${customerId}
      AND status != 'storniert'
      AND (billing_year > ${year}
           OR (billing_year = ${year} AND billing_month >= ${month}))
    ORDER BY billing_year, billing_month, id
  `);
  return result.rows as unknown as AffectedInvoice[];
}

function sendInvoicedPeriodConflict(res: any, message: string, invoices: AffectedInvoice[]) {
  res.status(409).json({
    code: "INVOICED_PERIOD_AFFECTED",
    message,
    details: { invoices },
  });
}

router.get("/:id/service-prices", requireAdmin, asyncHandler("Kundenpreise konnten nicht geladen werden", async (req, res) => {
  const customerId = requireIntParam(req.params.id, res);
  if (customerId === null) return;
  const dateParam = req.query.date as string | undefined;
  const targetDate = dateParam || todayISO();

  const result = await db.execute(sql`
    SELECT csp.id, csp.customer_id AS "customerId", csp.service_id AS "serviceId",
           csp.price_cents AS "priceCents", csp.valid_from AS "validFrom", csp.valid_to AS "validTo",
           s.name AS "serviceName", s.code AS "serviceCode", s.default_price_cents AS "defaultPriceCents",
           s.unit_type AS "unitType"
    FROM customer_service_prices csp
    JOIN services s ON s.id = csp.service_id
    WHERE csp.customer_id = ${customerId}
      AND csp.deleted_at IS NULL
      AND csp.valid_from::date <= ${targetDate}::date
      AND (csp.valid_to IS NULL OR csp.valid_to::date >= ${targetDate}::date)
    ORDER BY s.sort_order
  `);
  res.json(result.rows);
}));

router.get("/:id/service-prices/all", requireAdmin, asyncHandler("Preishistorie konnte nicht geladen werden", async (req, res) => {
  const customerId = requireIntParam(req.params.id, res);
  if (customerId === null) return;
  const result = await db.execute(sql`
    SELECT csp.id, csp.customer_id AS "customerId", csp.service_id AS "serviceId",
           csp.price_cents AS "priceCents", csp.valid_from AS "validFrom", csp.valid_to AS "validTo",
           s.name AS "serviceName", s.code AS "serviceCode", s.default_price_cents AS "defaultPriceCents",
           s.unit_type AS "unitType"
    FROM customer_service_prices csp
    JOIN services s ON s.id = csp.service_id
    WHERE csp.customer_id = ${customerId}
      AND csp.deleted_at IS NULL
    ORDER BY s.sort_order, csp.valid_from DESC
  `);
  res.json(result.rows);
}));

router.get("/:id/service-prices/future", requireAdmin, asyncHandler("Zukünftige Preise konnten nicht geladen werden", async (req, res) => {
  const customerId = requireIntParam(req.params.id, res);
  if (customerId === null) return;
  const today = todayISO();
  const result = await db.execute(sql`
    SELECT csp.id, csp.customer_id AS "customerId", csp.service_id AS "serviceId",
           csp.price_cents AS "priceCents", csp.valid_from AS "validFrom", csp.valid_to AS "validTo",
           s.name AS "serviceName", s.code AS "serviceCode", s.default_price_cents AS "defaultPriceCents",
           s.unit_type AS "unitType"
    FROM customer_service_prices csp
    JOIN services s ON s.id = csp.service_id
    WHERE csp.customer_id = ${customerId}
      AND csp.deleted_at IS NULL
      AND csp.valid_from::date > ${today}::date
    ORDER BY csp.valid_from, s.sort_order
  `);
  res.json(result.rows);
}));

router.post("/:id/service-prices", requireAdmin, asyncHandler("Kundenpreis konnte nicht gespeichert werden", async (req, res) => {
  const customerId = requireIntParam(req.params.id, res);
  if (customerId === null) return;
  const confirmInvoiceOverride = req.body?.confirmInvoiceOverride === true;
  const parsed = insertCustomerServicePriceSchema.safeParse({ ...req.body, customerId });
  if (!parsed.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: parsed.error.message });
    return;
  }
  const { serviceId, priceCents, validFrom: validFromParam } = parsed.data;

  const today = todayISO();
  const newValidFrom = validFromParam || today;

  if (newValidFrom < today) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Gültig-ab-Datum darf nicht in der Vergangenheit liegen." });
    return;
  }

  const newValidFromDate = newValidFrom;
  const dayBeforeNew = addDays(newValidFrom, -1);

  const affectedInvoices = await findAffectedInvoicesFromDate(db, customerId, newValidFrom);
  if (affectedInvoices.length > 0 && !confirmInvoiceOverride) {
    sendInvoicedPeriodConflict(
      res,
      "Diese Preisänderung betrifft bereits abgerechnete Monate. Bitte bestätigen Sie die Änderung.",
      affectedInvoices,
    );
    return;
  }

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE customer_service_prices SET deleted_at = NOW()
      WHERE customer_id = ${customerId} AND service_id = ${serviceId}
        AND valid_from::date = ${newValidFromDate}::date AND deleted_at IS NULL
    `);

    await tx.execute(sql`
      UPDATE customer_service_prices
      SET valid_to = ${dayBeforeNew}::date
      WHERE customer_id = ${customerId} AND service_id = ${serviceId}
        AND valid_from::date < ${newValidFromDate}::date
        AND (valid_to IS NULL OR valid_to::date >= ${newValidFromDate}::date)
        AND deleted_at IS NULL
    `);

    const futureRecords = await tx.execute(sql`
      SELECT id, valid_from FROM customer_service_prices
      WHERE customer_id = ${customerId} AND service_id = ${serviceId}
        AND valid_from::date > ${newValidFromDate}::date
        AND deleted_at IS NULL
      ORDER BY valid_from ASC LIMIT 1
    `);

    let newValidTo: string | null = null;
    if (futureRecords.rows.length > 0) {
      const futureStartRaw = futureRecords.rows[0].valid_from;
      const futureDate = futureStartRaw instanceof Date
        ? `${futureStartRaw.getFullYear()}-${String(futureStartRaw.getMonth() + 1).padStart(2, "0")}-${String(futureStartRaw.getDate()).padStart(2, "0")}`
        : String(futureStartRaw).substring(0, 10);
      newValidTo = addDays(futureDate, -1);
    }

    const inserted = await tx.execute(sql`
      INSERT INTO customer_service_prices (customer_id, service_id, price_cents, valid_from, valid_to)
      VALUES (${customerId}, ${serviceId}, ${priceCents}, ${newValidFromDate}::date, ${newValidTo ? sql`${newValidTo}::date` : sql`NULL`})
      RETURNING id, customer_id AS "customerId", service_id AS "serviceId", price_cents AS "priceCents",
                valid_from AS "validFrom", valid_to AS "validTo"
    `);
    return inserted;
  });

  if (affectedInvoices.length > 0 && req.user?.id) {
    await auditService.log(
      req.user.id,
      "customer_price_changed_invoiced",
      "customer",
      customerId,
      {
        action: "create_price",
        serviceId,
        priceCents,
        validFrom: newValidFrom,
        affectedInvoices: affectedInvoices.map(i => ({
          id: i.id,
          invoiceNumber: i.invoiceNumber,
          billingMonth: i.billingMonth,
          billingYear: i.billingYear,
        })),
      },
      req.ip,
    );
  }

  res.json(result.rows[0]);
}));

router.delete("/:id/service-prices/:priceId", requireAdmin, asyncHandler("Kundenpreis konnte nicht gelöscht werden", async (req, res) => {
  const customerId = requireIntParam(req.params.id, res);
  if (customerId === null) return;
  const priceId = requireIntParam(req.params.priceId, res);
  if (priceId === null) return;
  const today = todayISO();
  const confirmInvoiceOverride = req.body?.confirmInvoiceOverride === true
    || req.query?.confirmInvoiceOverride === "true";

  const existing = await db.execute(sql`
    SELECT id, customer_id, service_id, valid_from, valid_to FROM customer_service_prices
    WHERE id = ${priceId} AND customer_id = ${customerId} AND deleted_at IS NULL
  `);
  if (existing.rows.length === 0) {
    res.json({ success: true });
    return;
  }
  const row = existing.rows[0] as { id: number; customer_id: number; service_id: number; valid_from: string | Date; valid_to: string | Date | null };
  const vf = row.valid_from;
  const recordValidFrom = vf instanceof Date
    ? `${vf.getFullYear()}-${String(vf.getMonth() + 1).padStart(2, "0")}-${String(vf.getDate()).padStart(2, "0")}`
    : String(vf).substring(0, 10);

  const affectFromDate = recordValidFrom > today ? recordValidFrom : addDays(today, 1);
  const affectedInvoices = await findAffectedInvoicesFromDate(db, customerId, affectFromDate);
  if (affectedInvoices.length > 0 && !confirmInvoiceOverride) {
    sendInvoicedPeriodConflict(
      res,
      "Das Löschen dieses Preises betrifft bereits abgerechnete Monate. Bitte bestätigen Sie die Änderung.",
      affectedInvoices,
    );
    return;
  }

  await db.transaction(async (tx) => {
    if (recordValidFrom > today) {
      await tx.execute(sql`UPDATE customer_service_prices SET deleted_at = NOW() WHERE id = ${priceId}`);

      const previousRecord = await tx.execute(sql`
        SELECT id FROM customer_service_prices
        WHERE customer_id = ${customerId} AND service_id = ${row.service_id}
          AND valid_to IS NOT NULL AND valid_to::date = ${addDays(recordValidFrom, -1)}::date
          AND deleted_at IS NULL
        ORDER BY valid_from DESC LIMIT 1
      `);
      if (previousRecord.rows.length > 0) {
        const nextFuture = await tx.execute(sql`
          SELECT valid_from FROM customer_service_prices
          WHERE customer_id = ${customerId} AND service_id = ${row.service_id}
            AND valid_from::date > ${recordValidFrom}::date
            AND deleted_at IS NULL
          ORDER BY valid_from ASC LIMIT 1
        `);
        if (nextFuture.rows.length > 0) {
          const nfRaw = nextFuture.rows[0].valid_from;
          const nfDate = nfRaw instanceof Date
            ? `${nfRaw.getFullYear()}-${String(nfRaw.getMonth() + 1).padStart(2, "0")}-${String(nfRaw.getDate()).padStart(2, "0")}`
            : String(nfRaw).substring(0, 10);
          await tx.execute(sql`
            UPDATE customer_service_prices SET valid_to = ${addDays(nfDate, -1)}::date
            WHERE id = ${(previousRecord.rows[0] as any).id}
          `);
        } else {
          await tx.execute(sql`
            UPDATE customer_service_prices SET valid_to = NULL
            WHERE id = ${(previousRecord.rows[0] as any).id}
          `);
        }
      }
    } else {
      await tx.execute(sql`
        UPDATE customer_service_prices SET valid_to = ${today}::date
        WHERE id = ${priceId}
      `);
    }
  });

  if (affectedInvoices.length > 0 && req.user?.id) {
    await auditService.log(
      req.user.id,
      "customer_price_changed_invoiced",
      "customer",
      customerId,
      {
        action: "delete_price",
        priceId,
        serviceId: row.service_id,
        validFrom: recordValidFrom,
        affectedInvoices: affectedInvoices.map(i => ({
          id: i.id,
          invoiceNumber: i.invoiceNumber,
          billingMonth: i.billingMonth,
          billingYear: i.billingYear,
        })),
      },
      req.ip,
    );
  }

  res.json({ success: true });
}));

export default router;
