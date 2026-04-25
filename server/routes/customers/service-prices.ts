import { Router } from "express";
import { z } from "zod";
import { insertCustomerServicePriceSchema } from "@shared/schema";
import { requireAdmin } from "../../middleware/auth";
import { asyncHandler } from "../../lib/errors";
import { requireIntParam } from "../../lib/params";
import { todayISO, addDays } from "@shared/utils/datetime";
import { db } from "../../lib/db";
import { sql } from "drizzle-orm";
import { auditService } from "../../services/audit";

function rawDateToISO(value: unknown): string {
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  return String(value).substring(0, 10);
}

type ConflictRow = { id: number; priceCents: number; validFrom: unknown; serviceName: string };

class PriceConflictError extends Error {
  readonly row: ConflictRow;
  constructor(row: ConflictRow) {
    super("PRICE_CONFLICT");
    this.row = row;
  }
}

function hasPgCode(value: unknown): value is { code: string } {
  return typeof value === "object" && value !== null && "code" in value
    && typeof (value as { code: unknown }).code === "string";
}

function isUniqueViolation(err: unknown): boolean {
  if (hasPgCode(err) && err.code === "23505") return true;
  if (typeof err === "object" && err !== null && "cause" in err) {
    const cause = (err as { cause: unknown }).cause;
    if (hasPgCode(cause) && cause.code === "23505") return true;
  }
  return false;
}

const updateCustomerServicePriceSchema = z
  .object({
    priceCents: z.number().int().min(1, "Preis muss mindestens 1 Cent betragen").optional(),
    validFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Datum muss im Format YYYY-MM-DD sein")
      .optional(),
    validTo: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Datum muss im Format YYYY-MM-DD sein")
      .nullable()
      .optional(),
  })
  .refine(
    (d) => d.priceCents !== undefined || d.validFrom !== undefined || d.validTo !== undefined,
    { message: "Mindestens ein Feld (priceCents, validFrom oder validTo) muss angegeben werden" },
  );

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
  const confirmReplace = req.body?.confirmReplace === true;
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

  const existingSameDate = await db.execute(sql`
    SELECT csp.id, csp.price_cents AS "priceCents", csp.valid_from AS "validFrom",
           s.name AS "serviceName"
    FROM customer_service_prices csp
    JOIN services s ON s.id = csp.service_id
    WHERE csp.customer_id = ${customerId} AND csp.service_id = ${serviceId}
      AND csp.valid_from::date = ${newValidFromDate}::date AND csp.deleted_at IS NULL
    ORDER BY csp.id DESC LIMIT 1
  `);

  if (existingSameDate.rows.length > 0 && !confirmReplace) {
    const row = existingSameDate.rows[0] as ConflictRow;
    const validFromIso = rawDateToISO(row.validFrom);
    res.status(409).json({
      error: "PRICE_CONFLICT",
      code: "PRICE_CONFLICT",
      message: `Es existiert bereits ein aktiver Preis ab dem ${validFromIso} für ${row.serviceName}. Möchten Sie ihn ersetzen?`,
      details: {
        existing: {
          id: row.id,
          priceCents: row.priceCents,
          validFrom: validFromIso,
          serviceName: row.serviceName,
        },
        newPriceCents: priceCents,
      },
    });
    return;
  }

  let replacedRow: ConflictRow | null = existingSameDate.rows.length > 0
    ? (existingSameDate.rows[0] as ConflictRow)
    : null;

  let result;
  try {
    result = await db.transaction(async (tx) => {
      const lockedExisting = await tx.execute(sql`
        SELECT csp.id, csp.price_cents AS "priceCents", csp.valid_from AS "validFrom",
               s.name AS "serviceName"
        FROM customer_service_prices csp
        JOIN services s ON s.id = csp.service_id
        WHERE csp.customer_id = ${customerId} AND csp.service_id = ${serviceId}
          AND csp.valid_from::date = ${newValidFromDate}::date AND csp.deleted_at IS NULL
        ORDER BY csp.id DESC LIMIT 1
        FOR UPDATE
      `);

      if (lockedExisting.rows.length > 0) {
        if (!confirmReplace) {
          throw new PriceConflictError(lockedExisting.rows[0] as ConflictRow);
        }
        replacedRow = lockedExisting.rows[0] as ConflictRow;
      }

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
        const futureDate = rawDateToISO(futureStartRaw);
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
  } catch (err) {
    const isAppConflict = err instanceof PriceConflictError;
    const isPgUniqueViolation = !isAppConflict && isUniqueViolation(err);

    if (isAppConflict || isPgUniqueViolation) {
      let conflictRow: ConflictRow;
      if (isAppConflict) {
        conflictRow = err.row;
      } else {
        const refetch = await db.execute(sql`
          SELECT csp.id, csp.price_cents AS "priceCents", csp.valid_from AS "validFrom",
                 s.name AS "serviceName"
          FROM customer_service_prices csp
          JOIN services s ON s.id = csp.service_id
          WHERE csp.customer_id = ${customerId} AND csp.service_id = ${serviceId}
            AND csp.valid_from::date = ${newValidFromDate}::date AND csp.deleted_at IS NULL
          ORDER BY csp.id DESC LIMIT 1
        `);
        conflictRow = refetch.rows[0] as ConflictRow;
      }

      const validFromIso = rawDateToISO(conflictRow.validFrom);
      res.status(409).json({
        error: "PRICE_CONFLICT",
        code: "PRICE_CONFLICT",
        message: `Es existiert bereits ein aktiver Preis ab dem ${validFromIso} für ${conflictRow.serviceName}. Möchten Sie ihn ersetzen?`,
        details: {
          existing: {
            id: conflictRow.id,
            priceCents: conflictRow.priceCents,
            validFrom: validFromIso,
            serviceName: conflictRow.serviceName,
          },
          newPriceCents: priceCents,
        },
      });
      return;
    }
    throw err;
  }

  if (replacedRow && req.user) {
    const insertedRow = result.rows[0] as { id: number };
    auditService.log(
      req.user.id,
      "customer_price_replaced",
      "customer",
      customerId,
      {
        customerId,
        serviceId,
        serviceName: replacedRow.serviceName,
        validFrom: newValidFromDate,
        replacedPriceId: replacedRow.id,
        oldPriceCents: replacedRow.priceCents,
        newPriceId: insertedRow.id,
        newPriceCents: priceCents,
      },
      req.ip,
    ).catch(() => {});
  }

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

router.patch("/:id/service-prices/:priceId", requireAdmin, asyncHandler("Kundenpreis konnte nicht aktualisiert werden", async (req, res) => {
  const customerId = requireIntParam(req.params.id, res);
  if (customerId === null) return;
  const priceId = requireIntParam(req.params.priceId, res);
  if (priceId === null) return;

  const confirmInvoiceOverride = req.body?.confirmInvoiceOverride === true;
  const { confirmInvoiceOverride: _omit, ...patchBody } = req.body ?? {};
  const parsed = updateCustomerServicePriceSchema.safeParse(patchBody);
  if (!parsed.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: parsed.error.message });
    return;
  }

  const existing = await db.execute(sql`
    SELECT id, service_id, price_cents, valid_from, valid_to FROM customer_service_prices
    WHERE id = ${priceId} AND customer_id = ${customerId} AND deleted_at IS NULL
  `);
  if (existing.rows.length === 0) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kundenpreis nicht gefunden" });
    return;
  }
  const row = existing.rows[0] as {
    id: number;
    service_id: number;
    price_cents: number;
    valid_from: string | Date;
    valid_to: string | Date | null;
  };

  function dateToISO(v: string | Date): string {
    return v instanceof Date
      ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`
      : String(v).substring(0, 10);
  }

  const oldValidFrom = dateToISO(row.valid_from);
  const oldValidTo = row.valid_to ? dateToISO(row.valid_to) : null;
  const oldPriceCents = row.price_cents;

  const newValidFrom = parsed.data.validFrom ?? oldValidFrom;
  const newValidTo = parsed.data.validTo === undefined ? oldValidTo : parsed.data.validTo;
  const newPriceCents = parsed.data.priceCents ?? oldPriceCents;

  if (newValidTo !== null && newValidTo < newValidFrom) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Gültig-bis-Datum darf nicht vor Gültig-ab-Datum liegen.",
    });
    return;
  }

  const validFromChanged = newValidFrom !== oldValidFrom;
  const validToChanged = (newValidTo ?? null) !== (oldValidTo ?? null);
  const priceChanged = newPriceCents !== oldPriceCents;

  let affectedInvoices: AffectedInvoice[] = [];
  if (validFromChanged || validToChanged || priceChanged) {
    const earliestAffected = newValidFrom < oldValidFrom ? newValidFrom : oldValidFrom;
    affectedInvoices = await findAffectedInvoicesFromDate(db, customerId, earliestAffected);
  }

  if (affectedInvoices.length > 0 && !confirmInvoiceOverride) {
    sendInvoicedPeriodConflict(
      res,
      "Diese Preisänderung betrifft bereits abgerechnete Monate. Bitte bestätigen Sie die Änderung.",
      affectedInvoices,
    );
    return;
  }

  await db.execute(sql`
    UPDATE customer_service_prices
    SET price_cents = ${newPriceCents},
        valid_from = ${newValidFrom}::date,
        valid_to = ${newValidTo ? sql`${newValidTo}::date` : sql`NULL`}
    WHERE id = ${priceId}
  `);

  if (affectedInvoices.length > 0 && req.user?.id) {
    await auditService.log(
      req.user.id,
      "customer_price_changed_invoiced",
      "customer",
      customerId,
      {
        action: "update_price",
        priceId,
        serviceId: row.service_id,
        before: { priceCents: oldPriceCents, validFrom: oldValidFrom, validTo: oldValidTo },
        after: { priceCents: newPriceCents, validFrom: newValidFrom, validTo: newValidTo },
        affectedInvoices: affectedInvoices.map((i) => ({
          id: i.id,
          invoiceNumber: i.invoiceNumber,
          billingMonth: i.billingMonth,
          billingYear: i.billingYear,
        })),
      },
      req.ip,
    );
  }

  const updated = await db.execute(sql`
    SELECT id, customer_id AS "customerId", service_id AS "serviceId", price_cents AS "priceCents",
           valid_from AS "validFrom", valid_to AS "validTo"
    FROM customer_service_prices WHERE id = ${priceId}
  `);
  res.json(updated.rows[0]);
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
