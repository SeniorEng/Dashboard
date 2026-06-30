import { Router } from "express";
import { requireAdmin } from "../middleware/auth";
import { asyncHandler } from "../lib/errors";
import { requireIntParam } from "../lib/params";
import { todayISO, addDays } from "@shared/utils/datetime";
import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { auditService } from "../services/audit";
import { insertRoleWageRateSchema, WAGE_ROLES, type WageRole } from "@shared/schema";

/**
 * Task #1503 — Rollenbasierte Vergütung (Lohnsatz je Rolle × Leistung).
 *
 * Schreibt zeitversionierte Zeilen in die `role_wage_rates`-SSoT. Diese Zeilen
 * werden vom EINEN Lohn-Resolver (`shared/domain/pricing/wage-for.ts`) ÜBER dem
 * Katalog-Default (`services.employee_rate_cents`) ausgewertet — es entsteht
 * KEINE zweite Lohnquelle.
 *
 * Append-only/GoBD: bestehende Zeilen werden NIE in-place überschrieben. Eine
 * Lohnänderung ist immer eine NEUE versionierte Zeile (POST):
 *   - ein neuer Satz klemmt die Vorgängerphase per `valid_to` ein,
 *   - bei identischem `valid_from` wird die alte Zeile soft-deleted
 *     (`deleted_at`) und eine neue eingefügt (Partial-Unique-Index
 *     `role_wage_rates_active_validfrom_uniq`).
 * Es gibt KEINEN in-place-Edit-Pfad (kein PATCH): „bearbeiten" heißt „neue
 * Korrekturphase ab Datum anlegen". Eine Phase beenden/entfernen läuft über
 * DELETE (Zukunftszeile entfernen + Vorgänger neu verbinden, aktive Phase per
 * `valid_to=heute` schließen). Historische Zeilen bleiben revisionssicher.
 *
 * Konflikt-Guard: Ein Satz, der einen bereits ABGESCHLOSSENEN Lohn-Monat
 * (`employee_month_closings`, nicht wieder geöffnet) rückwirkend ändern würde,
 * wird mit einem Bestätigungs-Konflikt (409, `CLOSED_WAGE_PERIOD_AFFECTED`)
 * abgesichert — analog `INVOICED_PERIOD_AFFECTED` auf der Preis-Seite.
 *
 * Die Katalog-IDENTITÄT (Leistungen, Codes, Standard-Lohn) bleibt
 * konfigurationsgesteuert/read-only (`server/routes/services.ts`).
 */

function rawDateToISO(value: unknown): string {
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  return String(value).substring(0, 10);
}

type ConflictRow = { id: number; cents: number; validFrom: unknown; serviceName: string; role: string };

class WageConflictError extends Error {
  readonly row: ConflictRow;
  constructor(row: ConflictRow) {
    super("WAGE_CONFLICT");
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

const roleLabel: Record<WageRole, string> = {
  admin: "Verwaltung",
  teamLead: "Teamleitung",
  employee: "Mitarbeiter",
};

const router = Router();

interface AffectedClosedMonth {
  year: number;
  month: number;
  employeeCount: number;
}

/**
 * Lohn-Sätze wirken firmenweit pro Rolle; eine Änderung könnte daher bereits
 * abgeschlossene Lohn-Monate JEDES Mitarbeiters betreffen. Wir prüfen deshalb
 * ALLE nicht wieder geöffneten Monatsabschlüsse ab dem Stichtag.
 */
async function findAffectedClosedMonthsFromDate(
  tx: typeof db,
  fromDate: string,
): Promise<AffectedClosedMonth[]> {
  const [yearStr, monthStr] = fromDate.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const result = await tx.execute(sql`
    SELECT year, month, COUNT(*)::int AS "employeeCount"
    FROM employee_month_closings
    WHERE reopened_at IS NULL
      AND (year > ${year} OR (year = ${year} AND month >= ${month}))
    GROUP BY year, month
    ORDER BY year, month
    LIMIT 100
  `);
  return result.rows as unknown as AffectedClosedMonth[];
}

function sendClosedPeriodConflict(res: any, message: string, months: AffectedClosedMonth[]) {
  res.status(409).json({
    code: "CLOSED_WAGE_PERIOD_AFFECTED",
    message,
    details: { months },
  });
}

router.get("/role-wage-rates", requireAdmin, asyncHandler("Lohnsätze konnten nicht geladen werden", async (req, res) => {
  const dateParam = req.query.date as string | undefined;
  const targetDate = dateParam || todayISO();
  const result = await db.execute(sql`
    SELECT w.id, w.role, w.service_id AS "serviceId",
           w.cents, w.valid_from AS "validFrom", w.valid_to AS "validTo",
           s.name AS "serviceName", s.code AS "serviceCode",
           s.employee_rate_cents AS "defaultRateCents", s.unit_type AS "unitType"
    FROM role_wage_rates w
    JOIN services s ON s.id = w.service_id
    WHERE w.deleted_at IS NULL
      AND w.valid_from::date <= ${targetDate}::date
      AND (w.valid_to IS NULL OR w.valid_to::date >= ${targetDate}::date)
    ORDER BY s.sort_order, w.role
  `);
  res.json(result.rows);
}));

router.get("/role-wage-rates/all", requireAdmin, asyncHandler("Lohnsatz-Historie konnte nicht geladen werden", async (_req, res) => {
  const result = await db.execute(sql`
    SELECT w.id, w.role, w.service_id AS "serviceId",
           w.cents, w.valid_from AS "validFrom", w.valid_to AS "validTo",
           s.name AS "serviceName", s.code AS "serviceCode",
           s.employee_rate_cents AS "defaultRateCents", s.unit_type AS "unitType"
    FROM role_wage_rates w
    JOIN services s ON s.id = w.service_id
    WHERE w.deleted_at IS NULL
    ORDER BY s.sort_order, w.role, w.valid_from DESC
  `);
  res.json(result.rows);
}));

router.get("/role-wage-rates/future", requireAdmin, asyncHandler("Zukünftige Lohnsätze konnten nicht geladen werden", async (_req, res) => {
  const today = todayISO();
  const result = await db.execute(sql`
    SELECT w.id, w.role, w.service_id AS "serviceId",
           w.cents, w.valid_from AS "validFrom", w.valid_to AS "validTo",
           s.name AS "serviceName", s.code AS "serviceCode",
           s.employee_rate_cents AS "defaultRateCents", s.unit_type AS "unitType"
    FROM role_wage_rates w
    JOIN services s ON s.id = w.service_id
    WHERE w.deleted_at IS NULL
      AND w.valid_from::date > ${today}::date
    ORDER BY w.valid_from, s.sort_order, w.role
  `);
  res.json(result.rows);
}));

router.post("/role-wage-rates", requireAdmin, asyncHandler("Lohnsatz konnte nicht gespeichert werden", async (req, res) => {
  const confirmClosedOverride = req.body?.confirmClosedOverride === true;
  const confirmReplace = req.body?.confirmReplace === true;
  const parsed = insertRoleWageRateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: parsed.error.message });
    return;
  }
  const { role, serviceId, cents, validFrom: validFromParam } = parsed.data;

  const serviceRow = await db.execute(sql`
    SELECT id, name FROM services WHERE id = ${serviceId}
  `);
  if (serviceRow.rows.length === 0) {
    res.status(404).json({ error: "NOT_FOUND", message: "Dienstleistung nicht gefunden" });
    return;
  }

  const today = todayISO();
  const newValidFrom = validFromParam || today;

  // Rückwirkende Korrekturen sind erlaubt (GoBD-Phasen-Append). Ein `validFrom`
  // in der Vergangenheit wird NICHT pauschal abgelehnt — betrifft es bereits
  // ABGESCHLOSSENE Lohn-Monate, greift unten der Bestätigungs-Guard
  // (`CLOSED_WAGE_PERIOD_AFFECTED`, 409). Bereits beendete Historienphasen
  // bleiben über den DELETE-Pfad (`HISTORICAL_WAGE_IMMUTABLE`) revisionssicher.
  const newValidFromDate = newValidFrom;
  const dayBeforeNew = addDays(newValidFrom, -1);

  const affectedMonths = await findAffectedClosedMonthsFromDate(db, newValidFrom);
  if (affectedMonths.length > 0 && !confirmClosedOverride) {
    sendClosedPeriodConflict(
      res,
      "Diese Lohnänderung betrifft bereits abgeschlossene Lohn-Monate. Bitte bestätigen Sie die Änderung.",
      affectedMonths,
    );
    return;
  }

  const existingSameDate = await db.execute(sql`
    SELECT w.id, w.cents, w.valid_from AS "validFrom", w.role, s.name AS "serviceName"
    FROM role_wage_rates w
    JOIN services s ON s.id = w.service_id
    WHERE w.role = ${role} AND w.service_id = ${serviceId}
      AND w.valid_from::date = ${newValidFromDate}::date AND w.deleted_at IS NULL
    ORDER BY w.id DESC LIMIT 1
  `);

  if (existingSameDate.rows.length > 0 && !confirmReplace) {
    const row = existingSameDate.rows[0] as ConflictRow;
    const validFromIso = rawDateToISO(row.validFrom);
    res.status(409).json({
      error: "WAGE_CONFLICT",
      code: "WAGE_CONFLICT",
      message: `Es existiert bereits ein aktiver Lohnsatz ab dem ${validFromIso} für ${roleLabel[role]} · ${row.serviceName}. Möchten Sie ihn ersetzen?`,
      details: {
        existing: { id: row.id, cents: row.cents, validFrom: validFromIso, serviceName: row.serviceName, role },
        newCents: cents,
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
        SELECT w.id, w.cents, w.valid_from AS "validFrom", w.role, s.name AS "serviceName"
        FROM role_wage_rates w
        JOIN services s ON s.id = w.service_id
        WHERE w.role = ${role} AND w.service_id = ${serviceId}
          AND w.valid_from::date = ${newValidFromDate}::date AND w.deleted_at IS NULL
        ORDER BY w.id DESC LIMIT 1
        FOR UPDATE
      `);

      if (lockedExisting.rows.length > 0) {
        if (!confirmReplace) {
          throw new WageConflictError(lockedExisting.rows[0] as ConflictRow);
        }
        replacedRow = lockedExisting.rows[0] as ConflictRow;
      }

      await tx.execute(sql`
        UPDATE role_wage_rates SET deleted_at = NOW()
        WHERE role = ${role} AND service_id = ${serviceId}
          AND valid_from::date = ${newValidFromDate}::date AND deleted_at IS NULL
      `);

      await tx.execute(sql`
        UPDATE role_wage_rates
        SET valid_to = ${dayBeforeNew}::date
        WHERE role = ${role} AND service_id = ${serviceId}
          AND valid_from::date < ${newValidFromDate}::date
          AND (valid_to IS NULL OR valid_to::date >= ${newValidFromDate}::date)
          AND deleted_at IS NULL
      `);

      const futureRecords = await tx.execute(sql`
        SELECT id, valid_from FROM role_wage_rates
        WHERE role = ${role} AND service_id = ${serviceId}
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
        INSERT INTO role_wage_rates (role, service_id, cents, valid_from, valid_to, created_by_user_id)
        VALUES (${role}, ${serviceId}, ${cents}, ${newValidFromDate}::date, ${newValidTo ? sql`${newValidTo}::date` : sql`NULL`}, ${req.user?.id ?? null})
        RETURNING id, role, service_id AS "serviceId", cents,
                  valid_from AS "validFrom", valid_to AS "validTo"
      `);
      return inserted;
    });
  } catch (err) {
    const isAppConflict = err instanceof WageConflictError;
    const isPgUniqueViolation = !isAppConflict && isUniqueViolation(err);

    if (isAppConflict || isPgUniqueViolation) {
      let conflictRow: ConflictRow;
      if (isAppConflict) {
        conflictRow = err.row;
      } else {
        const refetch = await db.execute(sql`
          SELECT w.id, w.cents, w.valid_from AS "validFrom", w.role, s.name AS "serviceName"
          FROM role_wage_rates w
          JOIN services s ON s.id = w.service_id
          WHERE w.role = ${role} AND w.service_id = ${serviceId}
            AND w.valid_from::date = ${newValidFromDate}::date AND w.deleted_at IS NULL
          ORDER BY w.id DESC LIMIT 1
        `);
        conflictRow = refetch.rows[0] as ConflictRow;
      }

      const validFromIso = rawDateToISO(conflictRow.validFrom);
      res.status(409).json({
        error: "WAGE_CONFLICT",
        code: "WAGE_CONFLICT",
        message: `Es existiert bereits ein aktiver Lohnsatz ab dem ${validFromIso} für ${roleLabel[role]} · ${conflictRow.serviceName}. Möchten Sie ihn ersetzen?`,
        details: {
          existing: { id: conflictRow.id, cents: conflictRow.cents, validFrom: validFromIso, serviceName: conflictRow.serviceName, role },
          newCents: cents,
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
    const affectedMonthsMeta = affectedMonths.length > 0 ? affectedMonths : undefined;

    if (replacedRow) {
      await auditService.log(actorId, "role_wage_rate_replaced", "service", serviceId, {
        role,
        serviceId,
        serviceName: replacedRow.serviceName,
        validFrom: newValidFromDate,
        validTo: insertedValidTo,
        replacedRateId: replacedRow.id,
        oldCents: replacedRow.cents,
        newRateId: insertedRow.id,
        newCents: cents,
        ...(affectedMonthsMeta ? { affectedMonths: affectedMonthsMeta } : {}),
      }, req.ip);
    } else {
      await auditService.log(actorId, "role_wage_rate_created", "service", serviceId, {
        role,
        serviceId,
        newRateId: insertedRow.id,
        cents,
        validFrom: newValidFromDate,
        validTo: insertedValidTo,
        ...(affectedMonthsMeta ? { affectedMonths: affectedMonthsMeta } : {}),
      }, req.ip);
    }

    if (affectedMonths.length > 0) {
      await auditService.log(actorId, "role_wage_rate_changed_closed", "service", serviceId, {
        action: "create_rate",
        role,
        serviceId,
        cents,
        validFrom: newValidFrom,
        affectedMonths,
      }, req.ip);
    }
  }

  res.json(result.rows[0]);
}));

router.delete("/role-wage-rates/:rateId", requireAdmin, asyncHandler("Lohnsatz konnte nicht gelöscht werden", async (req, res) => {
  const rateId = requireIntParam(req.params.rateId, res);
  if (rateId === null) return;
  const today = todayISO();
  const confirmClosedOverride = req.body?.confirmClosedOverride === true
    || req.query?.confirmClosedOverride === "true";

  const existing = await db.execute(sql`
    SELECT id, role, service_id, valid_from, valid_to FROM role_wage_rates
    WHERE id = ${rateId} AND deleted_at IS NULL
  `);
  if (existing.rows.length === 0) {
    res.json({ success: true });
    return;
  }
  const row = existing.rows[0] as { id: number; role: string; service_id: number; valid_from: string | Date; valid_to: string | Date | null };
  const recordValidFrom = rawDateToISO(row.valid_from);
  const recordValidToISO = row.valid_to != null ? rawDateToISO(row.valid_to) : null;

  // Append-only / GoBD: bereits beendete Historienphasen sind unveränderlich.
  if (recordValidToISO !== null && recordValidToISO < today) {
    res.status(409).json({
      error: "HISTORICAL_WAGE_IMMUTABLE",
      message: "Bereits beendete Lohnsatz-Phasen sind revisionssicher (GoBD) und können nicht gelöscht oder geändert werden.",
    });
    return;
  }

  const affectedMonths = await findAffectedClosedMonthsFromDate(db, recordValidFrom);
  if (affectedMonths.length > 0 && !confirmClosedOverride) {
    sendClosedPeriodConflict(
      res,
      "Das Löschen dieses Lohnsatzes betrifft bereits abgeschlossene Lohn-Monate. Bitte bestätigen Sie die Änderung.",
      affectedMonths,
    );
    return;
  }

  await db.transaction(async (tx) => {
    if (recordValidFrom > today) {
      await tx.execute(sql`UPDATE role_wage_rates SET deleted_at = NOW() WHERE id = ${rateId}`);

      const previousRecord = await tx.execute(sql`
        SELECT id FROM role_wage_rates
        WHERE role = ${row.role} AND service_id = ${row.service_id}
          AND valid_to IS NOT NULL AND valid_to::date = ${addDays(recordValidFrom, -1)}::date
          AND deleted_at IS NULL
        ORDER BY valid_from DESC LIMIT 1
      `);
      if (previousRecord.rows.length > 0) {
        const nextFuture = await tx.execute(sql`
          SELECT valid_from FROM role_wage_rates
          WHERE role = ${row.role} AND service_id = ${row.service_id}
            AND valid_from::date > ${recordValidFrom}::date
            AND deleted_at IS NULL
          ORDER BY valid_from ASC LIMIT 1
        `);
        if (nextFuture.rows.length > 0) {
          const nfDate = rawDateToISO(nextFuture.rows[0].valid_from);
          await tx.execute(sql`
            UPDATE role_wage_rates SET valid_to = ${addDays(nfDate, -1)}::date
            WHERE id = ${(previousRecord.rows[0] as any).id}
          `);
        } else {
          await tx.execute(sql`
            UPDATE role_wage_rates SET valid_to = NULL
            WHERE id = ${(previousRecord.rows[0] as any).id}
          `);
        }
      }
    } else {
      await tx.execute(sql`
        UPDATE role_wage_rates SET valid_to = ${today}::date
        WHERE id = ${rateId}
      `);
    }
  });

  if (req.user?.id) {
    const actorId = req.user.id;
    const recordValidTo = row.valid_to != null ? rawDateToISO(row.valid_to) : null;
    const affectedMonthsMeta = affectedMonths.length > 0 ? affectedMonths : undefined;

    await auditService.log(actorId, "role_wage_rate_deleted", "service", row.service_id, {
      rateId,
      role: row.role,
      serviceId: row.service_id,
      validFrom: recordValidFrom,
      validTo: recordValidTo,
      futureOnly: recordValidFrom > today,
      ...(affectedMonthsMeta ? { affectedMonths: affectedMonthsMeta } : {}),
    }, req.ip);

    if (affectedMonths.length > 0) {
      await auditService.log(actorId, "role_wage_rate_changed_closed", "service", row.service_id, {
        action: "delete_rate",
        rateId,
        role: row.role,
        serviceId: row.service_id,
        validFrom: recordValidFrom,
        affectedMonths,
      }, req.ip);
    }
  }

  res.json({ success: true });
}));

export default router;
