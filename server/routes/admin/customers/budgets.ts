import { Router, Request, Response } from "express";
import { storage } from "../../../storage";
import { customerManagementStorage } from "../../../storage/customer-management";
import { budgetLedgerStorage } from "../../../storage/budget-ledger";
import { computeDataHash } from "../../../services/signature-integrity";
import { auditService } from "../../../services/audit";
import { asyncHandler } from "../../../lib/errors";
import { requireIntParam, parseOptionalIntQuery } from "../../../lib/params";
import { z } from "zod";
import { validate45aAmount, validate45bAmount, validate39_42aAmount } from "@shared/domain/budgets";
import {
  insertCustomerBudgetSchema,
  appointments,
} from "@shared/schema";
import { db } from "../../../lib/db";
import { appointmentsRepo } from "../../../repos";
import { eq, and, sql, gte, lte, isNull, isNotNull } from "drizzle-orm";

const router = Router();

router.get("/customers/:id/budgets", asyncHandler("Budget-Historie konnte nicht geladen werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const history = await customerManagementStorage.getCustomerBudgetHistory(id);
  res.json(history);
}));

const customerBudgetBodySchema = insertCustomerBudgetSchema
  .pick({
    entlastungsbetrag45b: true,
    verhinderungspflege39: true,
    pflegesachleistungen36: true,
    validFrom: true,
    validTo: true,
    notes: true,
  })
  .strict();

router.post("/customers/:id/budgets", asyncHandler("Budget konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.id, res);
  if (customerId === null) return;

  const body = customerBudgetBodySchema.parse(req.body);
  const validatedData = { ...body, customerId };
  
  const customer = await storage.getCustomer(customerId);
  if (!customer) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" });
    return;
  }
  
  if (validatedData.entlastungsbetrag45b > 0) {
    const error45b = validate45bAmount(validatedData.entlastungsbetrag45b);
    if (error45b) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: error45b });
      return;
    }
  }
  
  if (validatedData.pflegesachleistungen36 > 0 && customer) {
    const error45a = validate45aAmount(validatedData.pflegesachleistungen36, customer.pflegegrad);
    if (error45a) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: error45a });
      return;
    }
  }
  
  if (validatedData.verhinderungspflege39 > 0) {
    const error39 = validate39_42aAmount(validatedData.verhinderungspflege39);
    if (error39) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: error39 });
      return;
    }
  }
  
  const budget = await customerManagementStorage.addCustomerBudget(validatedData, req.user!.id);
  res.status(201).json(budget);
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
