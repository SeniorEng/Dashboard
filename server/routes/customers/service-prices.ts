import { Router } from "express";
import { insertCustomerServicePriceSchema } from "@shared/schema";
import { requireAdmin } from "../../middleware/auth";
import { asyncHandler } from "../../lib/errors";
import { requireIntParam } from "../../lib/params";
import { todayISO, addDays } from "@shared/utils/datetime";
import { db } from "../../lib/db";
import { sql } from "drizzle-orm";

const router = Router();

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
  res.json(result.rows[0]);
}));

router.delete("/:id/service-prices/:priceId", requireAdmin, asyncHandler("Kundenpreis konnte nicht gelöscht werden", async (req, res) => {
  const customerId = requireIntParam(req.params.id, res);
  if (customerId === null) return;
  const priceId = requireIntParam(req.params.priceId, res);
  if (priceId === null) return;
  const today = todayISO();

  await db.transaction(async (tx) => {
    const record = await tx.execute(sql`
      SELECT id, customer_id, service_id, valid_from, valid_to FROM customer_service_prices
      WHERE id = ${priceId} AND customer_id = ${customerId} AND deleted_at IS NULL
    `);
    if (record.rows.length === 0) {
      return;
    }
    const row = record.rows[0] as { id: number; customer_id: number; service_id: number; valid_from: string | Date; valid_to: string | Date | null };
    const vf = row.valid_from;
    const recordValidFrom = vf instanceof Date
      ? `${vf.getFullYear()}-${String(vf.getMonth() + 1).padStart(2, "0")}-${String(vf.getDate()).padStart(2, "0")}`
      : String(vf).substring(0, 10);

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

  res.json({ success: true });
}));

export default router;
