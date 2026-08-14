import { Router } from "express";
import { activeInvoiceSqlRaw } from "../lib/appointment-invoiced";
import { z } from "zod";
import { requireAdmin } from "../middleware/auth";
import { asyncHandler } from "../lib/errors";
import { requireIntParam } from "../lib/params";
import { todayISO, addDays } from "@shared/utils/datetime";
import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { auditService } from "../services/audit";

/**
 * Task #1357 — Firmenweite Standardpreise mit Stichtag über die Oberfläche
 * editierbar machen.
 *
 * Schreibt zeitversionierte `standard`-Zeilen in die konsolidierte `prices`-SSoT
 * (`scope='standard'`, `origin='service_rates'`, `customer_id=NULL`). Diese
 * Zeilen werden vom EINEN Preis-Resolver (`shared/domain/pricing/price-for.ts`)
 * ÜBER dem Code-Default (`shared/config/services.ts`) und UNTER Kunden-
 * Sonderpreisen ausgewertet — es entsteht KEINE zweite Preisquelle.
 *
 * Append-only/GoBD: bestehende Preiszeilen werden NIE in-place überschrieben.
 * Eine Preisänderung ist immer eine NEUE versionierte Zeile (POST):
 *   - ein neuer Standardpreis klemmt die Vorgängerphase per `valid_to` ein
 *     (nur die Phasen-Grenze, nicht Preis/`valid_from` der Vorgängerzeile),
 *   - bei identischem `valid_from` wird die alte Zeile soft-deleted
 *     (`deleted_at`, Geschäftswerte bleiben erhalten) und eine neue Zeile
 *     eingefügt (Partial-Unique-Index `prices_active_validfrom_uniq`).
 * Es gibt daher KEINEN in-place-Edit-Pfad (kein PATCH): „bearbeiten" heißt
 * „neue Korrekturphase ab Datum anlegen". Eine Phase beenden/entfernen läuft
 * über DELETE (Zukunftszeile entfernen + Vorgänger neu verbinden, aktive Phase
 * per `valid_to=heute` schließen). Historische Zeilen bleiben revisionssicher.
 * Gesiegelte Rechnungen bleiben unberührt, da sie einen eingefrorenen Snapshot
 * rendern.
 *
 * Die Katalog-IDENTITÄT (Leistungen, Codes, Töpfe, MwSt) bleibt
 * konfigurationsgesteuert/read-only (`server/routes/services.ts`).
 */

const SCOPE = "standard" as const;
const ORIGIN = "service_rates" as const;

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

const insertStandardPriceSchema = z.object({
  serviceId: z.number().int(),
  priceCents: z.number().int().min(0, "Preis darf nicht negativ sein"),
  validFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Datum muss im Format YYYY-MM-DD sein")
    .optional(),
});

const router = Router();

interface AffectedInvoice {
  id: number;
  invoiceNumber: string;
  billingMonth: number;
  billingYear: number;
  status: string;
}

/**
 * Standardpreise wirken firmenweit; eine Änderung könnte daher die erneute
 * Erstellung bereits abgerechneter Monate JEDES Kunden betreffen. Wir prüfen
 * deshalb (im Gegensatz zum Kundenpreis-Pfad) firmenweit alle Rechnungen ab dem
 * Stichtag — aber bewusst OHNE Gutschriften: ein Storno-Beleg wird von einer
 * Preisänderung nicht mehr getroffen (Task #1909). Zuvor stand hier nur der
 * Status-Filter; dadurch erschienen Gutschriften als „betroffen" und blähten die
 * Warnung auf.
 */
async function findAffectedInvoicesFromDate(
  tx: typeof db,
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
    WHERE ${activeInvoiceSqlRaw("invoices")}
      AND (billing_year > ${year}
           OR (billing_year = ${year} AND billing_month >= ${month}))
    ORDER BY billing_year, billing_month, id
    LIMIT 100
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

router.get("/standard-prices", requireAdmin, asyncHandler("Standardpreise konnten nicht geladen werden", async (req, res) => {
  const dateParam = req.query.date as string | undefined;
  const targetDate = dateParam || todayISO();
  const result = await db.execute(sql`
    SELECT p.id, p.service_id AS "serviceId",
           p.cents AS "priceCents", p.valid_from AS "validFrom", p.valid_to AS "validTo",
           s.name AS "serviceName", s.code AS "serviceCode", s.default_price_cents AS "defaultPriceCents",
           s.unit_type AS "unitType"
    FROM prices p
    JOIN services s ON s.id = p.service_id
    WHERE p.scope = ${SCOPE} AND p.origin = ${ORIGIN}
      AND p.customer_id IS NULL
      AND p.deleted_at IS NULL
      AND p.valid_from::date <= ${targetDate}::date
      AND (p.valid_to IS NULL OR p.valid_to::date >= ${targetDate}::date)
    ORDER BY s.sort_order
  `);
  res.json(result.rows);
}));

router.get("/standard-prices/all", requireAdmin, asyncHandler("Preishistorie konnte nicht geladen werden", async (_req, res) => {
  const result = await db.execute(sql`
    SELECT p.id, p.service_id AS "serviceId",
           p.cents AS "priceCents", p.valid_from AS "validFrom", p.valid_to AS "validTo",
           s.name AS "serviceName", s.code AS "serviceCode", s.default_price_cents AS "defaultPriceCents",
           s.unit_type AS "unitType"
    FROM prices p
    JOIN services s ON s.id = p.service_id
    WHERE p.scope = ${SCOPE} AND p.origin = ${ORIGIN}
      AND p.customer_id IS NULL
      AND p.deleted_at IS NULL
    ORDER BY s.sort_order, p.valid_from DESC
  `);
  res.json(result.rows);
}));

router.get("/standard-prices/future", requireAdmin, asyncHandler("Zukünftige Standardpreise konnten nicht geladen werden", async (_req, res) => {
  const today = todayISO();
  const result = await db.execute(sql`
    SELECT p.id, p.service_id AS "serviceId",
           p.cents AS "priceCents", p.valid_from AS "validFrom", p.valid_to AS "validTo",
           s.name AS "serviceName", s.code AS "serviceCode", s.default_price_cents AS "defaultPriceCents",
           s.unit_type AS "unitType"
    FROM prices p
    JOIN services s ON s.id = p.service_id
    WHERE p.scope = ${SCOPE} AND p.origin = ${ORIGIN}
      AND p.customer_id IS NULL
      AND p.deleted_at IS NULL
      AND p.valid_from::date > ${today}::date
    ORDER BY p.valid_from, s.sort_order
  `);
  res.json(result.rows);
}));

router.post("/standard-prices", requireAdmin, asyncHandler("Standardpreis konnte nicht gespeichert werden", async (req, res) => {
  const confirmInvoiceOverride = req.body?.confirmInvoiceOverride === true;
  const confirmReplace = req.body?.confirmReplace === true;
  const parsed = insertStandardPriceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: parsed.error.message });
    return;
  }
  const { serviceId, priceCents, validFrom: validFromParam } = parsed.data;

  // Service muss existieren UND abrechenbar sein — Standardpreise gibt es nur
  // für abrechenbare Leistungen (Katalog-Identität ist read-only).
  const serviceRow = await db.execute(sql`
    SELECT id, name, is_billable AS "isBillable" FROM services WHERE id = ${serviceId}
  `);
  if (serviceRow.rows.length === 0) {
    res.status(404).json({ error: "NOT_FOUND", message: "Dienstleistung nicht gefunden" });
    return;
  }
  if ((serviceRow.rows[0] as any).isBillable === false) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Für nicht abrechenbare Leistungen kann kein Standardpreis gesetzt werden." });
    return;
  }

  const today = todayISO();
  const newValidFrom = validFromParam || today;

  if (newValidFrom < today) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Gültig-ab-Datum darf nicht in der Vergangenheit liegen." });
    return;
  }

  const newValidFromDate = newValidFrom;
  const dayBeforeNew = addDays(newValidFrom, -1);

  const affectedInvoices = await findAffectedInvoicesFromDate(db, newValidFrom);
  if (affectedInvoices.length > 0 && !confirmInvoiceOverride) {
    sendInvoicedPeriodConflict(
      res,
      "Diese Preisänderung betrifft bereits abgerechnete Monate. Bitte bestätigen Sie die Änderung.",
      affectedInvoices,
    );
    return;
  }

  const existingSameDate = await db.execute(sql`
    SELECT p.id, p.cents AS "priceCents", p.valid_from AS "validFrom", s.name AS "serviceName"
    FROM prices p
    JOIN services s ON s.id = p.service_id
    WHERE p.scope = ${SCOPE} AND p.origin = ${ORIGIN}
      AND p.customer_id IS NULL AND p.service_id = ${serviceId}
      AND p.valid_from::date = ${newValidFromDate}::date AND p.deleted_at IS NULL
    ORDER BY p.id DESC LIMIT 1
  `);

  if (existingSameDate.rows.length > 0 && !confirmReplace) {
    const row = existingSameDate.rows[0] as ConflictRow;
    const validFromIso = rawDateToISO(row.validFrom);
    res.status(409).json({
      error: "PRICE_CONFLICT",
      code: "PRICE_CONFLICT",
      message: `Es existiert bereits ein aktiver Standardpreis ab dem ${validFromIso} für ${row.serviceName}. Möchten Sie ihn ersetzen?`,
      details: {
        existing: { id: row.id, priceCents: row.priceCents, validFrom: validFromIso, serviceName: row.serviceName },
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
        SELECT p.id, p.cents AS "priceCents", p.valid_from AS "validFrom", s.name AS "serviceName"
        FROM prices p
        JOIN services s ON s.id = p.service_id
        WHERE p.scope = ${SCOPE} AND p.origin = ${ORIGIN}
          AND p.customer_id IS NULL AND p.service_id = ${serviceId}
          AND p.valid_from::date = ${newValidFromDate}::date AND p.deleted_at IS NULL
        ORDER BY p.id DESC LIMIT 1
        FOR UPDATE
      `);

      if (lockedExisting.rows.length > 0) {
        if (!confirmReplace) {
          throw new PriceConflictError(lockedExisting.rows[0] as ConflictRow);
        }
        replacedRow = lockedExisting.rows[0] as ConflictRow;
      }

      await tx.execute(sql`
        UPDATE prices SET deleted_at = NOW()
        WHERE scope = ${SCOPE} AND origin = ${ORIGIN}
          AND customer_id IS NULL AND service_id = ${serviceId}
          AND valid_from::date = ${newValidFromDate}::date AND deleted_at IS NULL
      `);

      await tx.execute(sql`
        UPDATE prices
        SET valid_to = ${dayBeforeNew}::date
        WHERE scope = ${SCOPE} AND origin = ${ORIGIN}
          AND customer_id IS NULL AND service_id = ${serviceId}
          AND valid_from::date < ${newValidFromDate}::date
          AND (valid_to IS NULL OR valid_to::date >= ${newValidFromDate}::date)
          AND deleted_at IS NULL
      `);

      const futureRecords = await tx.execute(sql`
        SELECT id, valid_from FROM prices
        WHERE scope = ${SCOPE} AND origin = ${ORIGIN}
          AND customer_id IS NULL AND service_id = ${serviceId}
          AND valid_from::date > ${newValidFromDate}::date
          AND deleted_at IS NULL
        ORDER BY valid_from ASC LIMIT 1
      `);

      let newValidTo: string | null = null;
      if (futureRecords.rows.length > 0) {
        const futureDate = rawDateToISO(futureRecords.rows[0].valid_from);
        newValidTo = addDays(futureDate, -1);
      }

      const inserted = await tx.execute(sql`
        INSERT INTO prices (scope, origin, customer_id, service_id, cents, valid_from, valid_to, created_by_user_id)
        VALUES (${SCOPE}, ${ORIGIN}, NULL, ${serviceId}, ${priceCents}, ${newValidFromDate}::date, ${newValidTo ? sql`${newValidTo}::date` : sql`NULL`}, ${req.user?.id ?? null})
        RETURNING id, service_id AS "serviceId", cents AS "priceCents",
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
          SELECT p.id, p.cents AS "priceCents", p.valid_from AS "validFrom", s.name AS "serviceName"
          FROM prices p
          JOIN services s ON s.id = p.service_id
          WHERE p.scope = ${SCOPE} AND p.origin = ${ORIGIN}
            AND p.customer_id IS NULL AND p.service_id = ${serviceId}
            AND p.valid_from::date = ${newValidFromDate}::date AND p.deleted_at IS NULL
          ORDER BY p.id DESC LIMIT 1
        `);
        conflictRow = refetch.rows[0] as ConflictRow;
      }

      const validFromIso = rawDateToISO(conflictRow.validFrom);
      res.status(409).json({
        error: "PRICE_CONFLICT",
        code: "PRICE_CONFLICT",
        message: `Es existiert bereits ein aktiver Standardpreis ab dem ${validFromIso} für ${conflictRow.serviceName}. Möchten Sie ihn ersetzen?`,
        details: {
          existing: { id: conflictRow.id, priceCents: conflictRow.priceCents, validFrom: validFromIso, serviceName: conflictRow.serviceName },
          newPriceCents: priceCents,
        },
      });
      return;
    }
    throw err;
  }

  if (req.user?.id) {
    const actorId = req.user.id;
    const insertedRow = result.rows[0] as { id: number; validTo?: unknown };
    const insertedValidTo = insertedRow.validTo != null ? rawDateToISO(insertedRow.validTo) : null;
    const affectedInvoicesMeta = affectedInvoices.length > 0
      ? affectedInvoices.map((i) => ({ id: i.id, invoiceNumber: i.invoiceNumber, billingMonth: i.billingMonth, billingYear: i.billingYear }))
      : undefined;

    if (replacedRow) {
      await auditService.log(actorId, "standard_price_replaced", "service", serviceId, {
        serviceId,
        serviceName: replacedRow.serviceName,
        validFrom: newValidFromDate,
        validTo: insertedValidTo,
        replacedPriceId: replacedRow.id,
        oldPriceCents: replacedRow.priceCents,
        newPriceId: insertedRow.id,
        newPriceCents: priceCents,
        ...(affectedInvoicesMeta ? { affectedInvoices: affectedInvoicesMeta } : {}),
      }, req.ip);
    } else {
      await auditService.log(actorId, "standard_price_created", "service", serviceId, {
        serviceId,
        newPriceId: insertedRow.id,
        priceCents,
        validFrom: newValidFromDate,
        validTo: insertedValidTo,
        ...(affectedInvoicesMeta ? { affectedInvoices: affectedInvoicesMeta } : {}),
      }, req.ip);
    }

    if (affectedInvoices.length > 0) {
      await auditService.log(actorId, "standard_price_changed_invoiced", "service", serviceId, {
        action: "create_price",
        serviceId,
        priceCents,
        validFrom: newValidFrom,
        affectedInvoices: affectedInvoicesMeta,
      }, req.ip);
    }
  }

  res.json(result.rows[0]);
}));

router.delete("/standard-prices/:priceId", requireAdmin, asyncHandler("Standardpreis konnte nicht gelöscht werden", async (req, res) => {
  const priceId = requireIntParam(req.params.priceId, res);
  if (priceId === null) return;
  const today = todayISO();
  const confirmInvoiceOverride = req.body?.confirmInvoiceOverride === true
    || req.query?.confirmInvoiceOverride === "true";

  const existing = await db.execute(sql`
    SELECT id, service_id, valid_from, valid_to FROM prices
    WHERE scope = ${SCOPE} AND origin = ${ORIGIN}
      AND id = ${priceId} AND customer_id IS NULL AND deleted_at IS NULL
  `);
  if (existing.rows.length === 0) {
    res.json({ success: true });
    return;
  }
  const row = existing.rows[0] as { id: number; service_id: number; valid_from: string | Date; valid_to: string | Date | null };
  const recordValidFrom = rawDateToISO(row.valid_from);
  const recordValidToISO = row.valid_to != null ? rawDateToISO(row.valid_to) : null;

  // Append-only / GoBD: bereits beendete Historienphasen sind unveränderlich.
  // Nur künftige Phasen (Soft-Delete + Vorgänger neu verbinden) oder die aktuell
  // gültige Phase (heute schließen) dürfen entfernt werden. Eine Zeile, deren
  // Gültigkeit bereits in der Vergangenheit endete, würde durch ein
  // "valid_to = heute" rückwirkend verlängert/überschrieben — das ist verboten.
  if (recordValidToISO !== null && recordValidToISO < today) {
    res.status(409).json({
      error: "HISTORICAL_PRICE_IMMUTABLE",
      message: "Bereits beendete Standardpreis-Phasen sind revisionssicher (GoBD) und können nicht gelöscht oder geändert werden.",
    });
    return;
  }

  const affectedInvoices = await findAffectedInvoicesFromDate(db, recordValidFrom);
  if (affectedInvoices.length > 0 && !confirmInvoiceOverride) {
    sendInvoicedPeriodConflict(
      res,
      "Das Löschen dieses Standardpreises betrifft bereits abgerechnete Monate. Bitte bestätigen Sie die Änderung.",
      affectedInvoices,
    );
    return;
  }

  await db.transaction(async (tx) => {
    if (recordValidFrom > today) {
      await tx.execute(sql`UPDATE prices SET deleted_at = NOW() WHERE id = ${priceId}`);

      const previousRecord = await tx.execute(sql`
        SELECT id FROM prices
        WHERE scope = ${SCOPE} AND origin = ${ORIGIN}
          AND customer_id IS NULL AND service_id = ${row.service_id}
          AND valid_to IS NOT NULL AND valid_to::date = ${addDays(recordValidFrom, -1)}::date
          AND deleted_at IS NULL
        ORDER BY valid_from DESC LIMIT 1
      `);
      if (previousRecord.rows.length > 0) {
        const nextFuture = await tx.execute(sql`
          SELECT valid_from FROM prices
          WHERE scope = ${SCOPE} AND origin = ${ORIGIN}
            AND customer_id IS NULL AND service_id = ${row.service_id}
            AND valid_from::date > ${recordValidFrom}::date
            AND deleted_at IS NULL
          ORDER BY valid_from ASC LIMIT 1
        `);
        if (nextFuture.rows.length > 0) {
          const nfDate = rawDateToISO(nextFuture.rows[0].valid_from);
          await tx.execute(sql`
            UPDATE prices SET valid_to = ${addDays(nfDate, -1)}::date
            WHERE id = ${(previousRecord.rows[0] as any).id}
          `);
        } else {
          await tx.execute(sql`
            UPDATE prices SET valid_to = NULL
            WHERE id = ${(previousRecord.rows[0] as any).id}
          `);
        }
      }
    } else {
      await tx.execute(sql`
        UPDATE prices SET valid_to = ${today}::date
        WHERE id = ${priceId}
      `);
    }
  });

  if (req.user?.id) {
    const actorId = req.user.id;
    const recordValidTo = row.valid_to != null ? rawDateToISO(row.valid_to) : null;
    const affectedInvoicesMeta = affectedInvoices.length > 0
      ? affectedInvoices.map((i) => ({ id: i.id, invoiceNumber: i.invoiceNumber, billingMonth: i.billingMonth, billingYear: i.billingYear }))
      : undefined;

    await auditService.log(actorId, "standard_price_deleted", "service", row.service_id, {
      priceId,
      serviceId: row.service_id,
      validFrom: recordValidFrom,
      validTo: recordValidTo,
      futureOnly: recordValidFrom > today,
      ...(affectedInvoicesMeta ? { affectedInvoices: affectedInvoicesMeta } : {}),
    }, req.ip);

    if (affectedInvoices.length > 0) {
      await auditService.log(actorId, "standard_price_changed_invoiced", "service", row.service_id, {
        action: "delete_price",
        priceId,
        serviceId: row.service_id,
        validFrom: recordValidFrom,
        affectedInvoices: affectedInvoicesMeta,
      }, req.ip);
    }
  }

  res.json({ success: true });
}));

export default router;
