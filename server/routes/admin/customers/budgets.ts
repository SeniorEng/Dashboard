import { Router, Request, Response } from "express";
import { storage } from "../../../storage";
import { budgetLedgerStorage } from "../../../storage/budget-ledger";
import { computeDataHash } from "../../../services/signature-integrity";
import { auditService } from "../../../services/audit";
import { asyncHandler } from "../../../lib/errors";
import { requireIntParam, parseOptionalIntQuery } from "../../../lib/params";
import { z } from "zod";
import { validate45aAmount, validate45bAmount, validate39_42aAmount } from "@shared/domain/budgets";
import { appointments } from "@shared/schema";
import { db } from "../../../lib/db";
import { appointmentsRepo } from "../../../repos";
import { eq, and, sql, gte, lte, isNull, isNotNull } from "drizzle-orm";

const router = Router();

/**
 * Task #742 — Admin/Importer-Schreibpfad für die Topf-Konfiguration eines Kunden.
 *
 * Schreibt direkt in den SSoT `customer_budget_type_settings` via
 * `budgetLedgerStorage.upsertBudgetTypeSettings` (gleicher Historisierungs-
 * Pfad wie das UI unter `PUT /api/budget/:customerId/type-settings`). Die
 * frühere Variante schrieb in die abgeschaltete Legacy-Tabelle und war nach
 * Task #728 Phase 2.1 zum No-Op degradiert. Es gibt keinen
 * Frontend-Aufrufer, daher wird das Eingabeschema bewusst durch die
 * Topf-Liste ersetzt (statt der Legacy-Drei-Felder-Form).
 *
 * Pflichten/Invarianten (analog zum UI-PUT):
 *  - Eindeutige `priority`-Werte pro Save.
 *  - §45b-`monthlyLimitCents` ≤ gesetzliches Monats-Maximum.
 *  - §45a-`monthlyLimitCents` ≤ pflegegrad-abhängiges Maximum.
 *  - §39/§42a-`yearlyLimitCents` ≤ gesetzliches Jahres-Maximum.
 *  - `validFrom <= validTo`, wenn beide gesetzt.
 */
const adminBudgetTypeSettingsSchema = z.object({
  settings: z.array(z.object({
    budgetType: z.enum(["entlastungsbetrag_45b", "umwandlung_45a", "ersatzpflege_39_42a"]),
    enabled: z.boolean(),
    priority: z.number().int().min(1).max(3),
    monthlyLimitCents: z.number().int().min(0).nullable().optional(),
    yearlyLimitCents: z.number().int().min(0).nullable().optional(),
    validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  })).min(1).max(3),
}).strict();

router.post("/customers/:id/budgets", asyncHandler("Budget konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.id, res);
  if (customerId === null) return;

  const parsed = adminBudgetTypeSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Daten", details: parsed.error.issues });
    return;
  }
  const { settings } = parsed.data;

  const priorities = settings.map(s => s.priority);
  if (new Set(priorities).size !== priorities.length) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Jeder Budget-Topf muss eine eindeutige Priorität haben" });
    return;
  }

  const customer = await storage.getCustomer(customerId);
  if (!customer) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" });
    return;
  }

  for (const s of settings) {
    if (s.validFrom && s.validTo && s.validFrom > s.validTo) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: `'Gültig ab' darf nicht nach 'Gültig bis' liegen (${s.budgetType})` });
      return;
    }
    if (s.budgetType === "entlastungsbetrag_45b" && s.monthlyLimitCents != null && s.monthlyLimitCents > 0) {
      const err = validate45bAmount(s.monthlyLimitCents);
      if (err) {
        res.status(400).json({ error: "VALIDATION_ERROR", message: err });
        return;
      }
    }
    if (s.budgetType === "umwandlung_45a" && s.monthlyLimitCents != null && s.monthlyLimitCents > 0) {
      const err = validate45aAmount(s.monthlyLimitCents, customer.pflegegrad);
      if (err) {
        res.status(400).json({ error: "VALIDATION_ERROR", message: err });
        return;
      }
    }
    if (s.budgetType === "ersatzpflege_39_42a" && s.yearlyLimitCents != null && s.yearlyLimitCents > 0) {
      const err = validate39_42aAmount(s.yearlyLimitCents);
      if (err) {
        res.status(400).json({ error: "VALIDATION_ERROR", message: err });
        return;
      }
    }
  }

  const userId = req.user!.id;
  const saved = await budgetLedgerStorage.upsertBudgetTypeSettings(customerId, settings, undefined, userId);
  await budgetLedgerStorage.syncCarryoverAndExpiry(customerId);

  await auditService.log(userId, "budget_type_settings_updated", "budget", customerId, {
    customerId,
    source: "admin_customers_budgets_post",
    settings: settings.map(s => ({
      budgetType: s.budgetType,
      enabled: s.enabled,
      priority: s.priority,
      monthlyLimitCents: s.monthlyLimitCents ?? null,
      yearlyLimitCents: s.yearlyLimitCents ?? null,
      validFrom: s.validFrom ?? null,
      validTo: s.validTo ?? null,
    })),
  }, req.ip || req.socket.remoteAddress);

  res.status(200).json({ settings: saved });
}));

router.get("/budget/backfill-preview", asyncHandler("Vorschau fehlgeschlagen", async (req: Request, res: Response) => {
  const customerIdParsed = parseOptionalIntQuery(req.query.customerId, res, "customerId");
  if (customerIdParsed === null) return;
  const customerIdFilter = customerIdParsed ?? null;
  const dateFrom = typeof req.query.dateFrom === "string" ? req.query.dateFrom : null;
  const dateTo = typeof req.query.dateTo === "string" ? req.query.dateTo : null;

  const conditions = [
    eq(appointments.status, "completed"),
    isNotNull(appointments.actualStart),
    isNotNull(appointments.actualEnd),
    isNull(appointments.deletedAt),
    sql`${appointments.id} NOT IN (SELECT appointment_id FROM budget_transactions WHERE appointment_id IS NOT NULL)`,
  ];
  if (customerIdFilter) {
    conditions.push(eq(appointments.customerId, customerIdFilter));
  }
  if (dateFrom) {
    conditions.push(gte(appointments.date, dateFrom));
  }
  if (dateTo) {
    conditions.push(lte(appointments.date, dateTo));
  }

  const appointmentsWithoutBudget = await appointmentsRepo.selectColumnsFrom({
    id: appointments.id,
    customerId: appointments.customerId,
    date: appointments.date,
    actualStart: appointments.actualStart,
    actualEnd: appointments.actualEnd,
    signatureData: appointments.signatureData,
  })
  .where(and(...conditions))
  .orderBy(appointments.date);

  const byCustomer: Record<number, { count: number; missingSignatures: number; dates: string[] }> = {};
  for (const appt of appointmentsWithoutBudget) {
    const cid = appt.customerId!;
    if (!byCustomer[cid]) {
      byCustomer[cid] = { count: 0, missingSignatures: 0, dates: [] };
    }
    byCustomer[cid].count++;
    if (!appt.signatureData) byCustomer[cid].missingSignatures++;
    byCustomer[cid].dates.push(String(appt.date));
  }

  res.json({
    totalAppointments: appointmentsWithoutBudget.length,
    customerBreakdown: byCustomer,
  });
}));

const backfillSchema = z.object({
  customerId: z.number().int().optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

router.post("/budget/backfill-transactions", asyncHandler("Budget-Nachbuchung fehlgeschlagen", async (req: Request, res: Response) => {
  const data = backfillSchema.parse(req.body);
  const customerIdFilter = data.customerId ?? null;

  const conditions = [
    eq(appointments.status, "completed"),
    isNotNull(appointments.actualStart),
    isNotNull(appointments.actualEnd),
    isNull(appointments.deletedAt),
    sql`${appointments.appointmentType} != 'Erstberatung'`,
    sql`${appointments.id} NOT IN (SELECT appointment_id FROM budget_transactions WHERE appointment_id IS NOT NULL)`,
  ];
  if (customerIdFilter) {
    conditions.push(eq(appointments.customerId, customerIdFilter));
  }
  if (data.dateFrom) {
    conditions.push(gte(appointments.date, data.dateFrom));
  }
  if (data.dateTo) {
    conditions.push(lte(appointments.date, data.dateTo));
  }

  const apptRows = await appointmentsRepo.selectColumnsFrom({
    id: appointments.id,
    customerId: appointments.customerId,
    date: appointments.date,
    actualStart: appointments.actualStart,
    actualEnd: appointments.actualEnd,
    travelKilometers: appointments.travelKilometers,
    customerKilometers: appointments.customerKilometers,
    signatureData: appointments.signatureData,
  })
  .where(and(...conditions))
  .orderBy(appointments.date);

  // Resolve dominant lohnart_kategorie per appointment via appointment_services.
  const apptIds = apptRows.map((a) => a.id);
  const categoryByAppt = new Map<number, "hauswirtschaft" | "alltagsbegleitung" | null>();
  if (apptIds.length > 0) {
    const catRows = await db.execute(sql`
      SELECT DISTINCT ON (asvc.appointment_id)
        asvc.appointment_id AS id,
        s.lohnart_kategorie AS category
      FROM appointment_services asvc
      JOIN services s ON s.id = asvc.service_id
      WHERE asvc.appointment_id IN (${sql.join(apptIds.map((id) => sql`${id}`), sql`, `)})
      ORDER BY asvc.appointment_id,
        CASE WHEN s.lohnart_kategorie IN ('hauswirtschaft','alltagsbegleitung') THEN 0 ELSE 1 END,
        COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes, 0) DESC NULLS LAST
    `);
    for (const r of catRows.rows as Array<{ id: number; category: string | null }>) {
      const cat = r.category === "hauswirtschaft" || r.category === "alltagsbegleitung" ? r.category : null;
      categoryByAppt.set(Number(r.id), cat);
    }
  }
  const appointmentsWithoutBudget = apptRows.map((a) => ({
    ...a,
    serviceCategory: categoryByAppt.get(a.id) ?? null,
  }));

  const results: Array<{ appointmentId: number; customerId: number; date: string; status: string; error?: string }> = [];
  const systemSignatureText = "SYSTEMGENERIERT";
  const signatureHash = computeDataHash(systemSignatureText);

  for (const appt of appointmentsWithoutBudget) {
    const startParts = appt.actualStart!.split(":").map(Number);
    const endParts = appt.actualEnd!.split(":").map(Number);
    const durationMinutes = (endParts[0] * 60 + endParts[1]) - (startParts[0] * 60 + startParts[1]);

    if (durationMinutes <= 0) {
      results.push({ appointmentId: appt.id, customerId: appt.customerId!, date: String(appt.date), status: "skipped", error: "Ungültige Dauer" });
      continue;
    }

    const hwMinutes = appt.serviceCategory === "hauswirtschaft" ? durationMinutes : 0;
    const abMinutes = appt.serviceCategory === "alltagsbegleitung" ? durationMinutes : 0;
    const travelKm = appt.travelKilometers || 0;
    const customerKm = appt.customerKilometers || 0;

    if (hwMinutes === 0 && abMinutes === 0 && travelKm === 0 && customerKm === 0) {
      results.push({ appointmentId: appt.id, customerId: appt.customerId!, date: String(appt.date), status: "skipped", error: "Keine abrechenbare Leistung" });
      continue;
    }

    try {
      await budgetLedgerStorage.createConsumptionTransaction({
        customerId: appt.customerId!,
        appointmentId: appt.id,
        transactionDate: String(appt.date),
        hauswirtschaftMinutes: hwMinutes,
        alltagsbegleitungMinutes: abMinutes,
        travelKilometers: travelKm,
        customerKilometers: customerKm,
        userId: req.user?.id,
      });

      if (!appt.signatureData) {
        await db.update(appointments).set({
          signatureData: systemSignatureText,
          signatureHash: signatureHash,
          signedAt: new Date(),
          signedByUserId: req.user!.id,
        }).where(eq(appointments.id, appt.id));
      }

      await auditService.log(
        req.user!.id,
        "documentation_submitted",
        "appointment",
        appt.id,
        { customerId: appt.customerId!, systemBackfill: true, hasSignature: true, signatureType: "SYSTEMGENERIERT" },
        req.ip || req.socket.remoteAddress
      );

      results.push({ appointmentId: appt.id, customerId: appt.customerId!, date: String(appt.date), status: "created" });
    } catch (err: unknown) {
      results.push({ appointmentId: appt.id, customerId: appt.customerId!, date: String(appt.date), status: "error", error: err instanceof Error ? err.message : "Unbekannter Fehler" });
    }
  }

  const created = results.filter(r => r.status === "created").length;
  const skipped = results.filter(r => r.status === "skipped").length;
  const errors = results.filter(r => r.status === "error").length;

  res.json({
    total: appointmentsWithoutBudget.length,
    created,
    skipped,
    errors,
    details: results,
  });
}));

export default router;
