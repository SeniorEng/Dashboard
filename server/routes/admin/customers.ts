import { Router, Request, Response } from "express";
import { storage } from "../../storage";
import { customerManagementStorage } from "../../storage/customer-management";
import { birthdaysCache } from "../../services/cache";
import { auditService } from "../../services/audit";
import { geocodeCustomer } from "../../services/geocoding";
import { validateGeburtsdatum } from "@shared/utils/datetime";
import { isPflegekasseCustomer, isSelbstzahlerCustomer } from "@shared/domain/customers";
import { createCustomerRelatedData, buildCustomerInsertData } from "../../lib/customer-creation-helpers";
import { findCustomerDuplicates } from "../../lib/duplicate-check";
import { readTestFaults } from "../../lib/test-fault-injector";
import { 
  versichertennummerSchema,
  customers,
  type InsertCustomer,
  type Customer,
} from "@shared/schema";
import type { CustomerDetail } from "@shared/api";
import { internationalEmailSchema, optionalGermanPhoneSchema, validateVersichertennummerFor } from "@shared/schema/common";
import { asyncHandler } from "../../lib/errors";
import { requireIntParam, parseOptionalIntQuery } from "../../lib/params";
import { z } from "zod";
import { db } from "../../lib/db";
import { eq, and, sql, isNull, desc } from "drizzle-orm";
import { auditLog, users } from "@shared/schema";

import assignmentsRouter from "./customers/assignments";
import budgetsRouter from "./customers/budgets";
import detailsRouter from "./customers/details";
import contractsRouter from "./customers/contracts";
import workflowsRouter from "./customers/workflows";
import duplicatesRouter from "./customers/duplicates";

const router = Router();

router.use("/", duplicatesRouter);
router.use("/", assignmentsRouter);
router.use("/", budgetsRouter);
router.use("/", detailsRouter);
router.use("/", contractsRouter);
router.use("/", workflowsRouter);

router.get("/customers/check-duplicate", asyncHandler("Duplikatprüfung fehlgeschlagen", async (req: Request, res: Response) => {
  const vorname = String(req.query.vorname || "").trim();
  const nachname = String(req.query.nachname || "").trim();
  const geburtsdatum = req.query.geburtsdatum ? String(req.query.geburtsdatum).trim() : null;

  if (!vorname || !nachname) {
    res.json({ duplicates: [] });
    return;
  }

  const duplicates = await findCustomerDuplicates(vorname, nachname, geburtsdatum);
  res.json({ duplicates });
}));

router.get("/customers", asyncHandler("Kunden konnten nicht geladen werden", async (req: Request, res: Response) => {
  const { search, pflegegrad, responsibleEmployeeId, primaryEmployeeId, status, billingType, insuranceProviderId, page, limit, sortBy, sortOrder } = req.query;
  
  const validSortBy = ["name", "contractStart", "createdAt"].includes(sortBy as string)
    ? (sortBy as "name" | "contractStart" | "createdAt")
    : undefined;
  const validSortOrder = ["asc", "desc"].includes(sortOrder as string)
    ? (sortOrder as "asc" | "desc")
    : undefined;

  let resolvedEmployeeId: number | "unassigned" | undefined;
  if ((responsibleEmployeeId as string) === "unassigned") {
    resolvedEmployeeId = "unassigned";
  } else if (responsibleEmployeeId !== undefined) {
    const v = parseOptionalIntQuery(responsibleEmployeeId, res, "responsibleEmployeeId");
    if (v === null) return;
    resolvedEmployeeId = v;
  } else {
    const v = parseOptionalIntQuery(primaryEmployeeId, res, "primaryEmployeeId");
    if (v === null) return;
    resolvedEmployeeId = v;
  }

  const pflegegradNum = parseOptionalIntQuery(pflegegrad, res, "pflegegrad");
  if (pflegegradNum === null) return;
  const insuranceProviderIdNum = parseOptionalIntQuery(insuranceProviderId, res, "insuranceProviderId");
  if (insuranceProviderIdNum === null) return;

  const filters = {
    search: search as string | undefined,
    pflegegrad: pflegegradNum,
    responsibleEmployeeId: resolvedEmployeeId,
    status: status as string | undefined,
    billingType: billingType as string | undefined,
    insuranceProviderId: insuranceProviderIdNum,
    sortBy: validSortBy,
    sortOrder: validSortOrder,
  };

  const pageNumOrNull = parseOptionalIntQuery(page, res, "page");
  if (pageNumOrNull === null) return;
  const limitNumOrNull = parseOptionalIntQuery(limit, res, "limit");
  if (limitNumOrNull === null) return;
  const pageNum = pageNumOrNull ?? 1;
  const limitNum = limitNumOrNull ?? 20;
  
  const result = await customerManagementStorage.getCustomersPaginated(filters, {
    limit: limitNum,
    offset: (pageNum - 1) * limitNum,
  });
  
  res.json({
    ...result,
    page: pageNum,
    totalPages: Math.ceil(result.total / result.limit),
  });
}));

router.get("/customers/unassigned-count", asyncHandler("Zählung konnte nicht geladen werden", async (_req: Request, res: Response) => {
  const count = await customerManagementStorage.getUnassignedActiveCustomerCount();
  res.json({ count });
}));

router.get("/customers/:id/details", asyncHandler("Kunde konnte nicht geladen werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const customer = await customerManagementStorage.getCustomerWithDetails(id);
  if (!customer) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" });
    return;
  }
  
  const response = {
    ...customer,
    currentInsurance: customer.insurance ? {
      id: customer.insurance.id,
      providerName: customer.insurance.provider?.name || "Unbekannt",
      ikNummer: customer.insurance.provider?.ikNummer || undefined,
      versichertennummer: customer.insurance.versichertennummer,
      validFrom: customer.insurance.validFrom,
    } : null,
    currentBudgets: customer.budget ? {
      entlastungsbetrag45b: customer.budget.entlastungsbetrag45b,
      verhinderungspflege39: customer.budget.verhinderungspflege39,
      pflegesachleistungen36: customer.budget.pflegesachleistungen36,
    } : null,
    needsAssessment: customer.needsAssessment || null,
    currentContract: customer.contract ? {
      id: customer.contract.id,
      contractDate: customer.contract.contractDate,
      contractStart: customer.contract.contractStart,
      contractEnd: customer.contract.contractEnd,
      vereinbarteLeistungen: customer.contract.vereinbarteLeistungen,
      hoursPerPeriod: customer.contract.hoursPerPeriod,
      periodType: customer.contract.periodType,
      status: customer.contract.status,
      notes: customer.contract.notes,
    } : null,
    activeContractCount: customer.contract ? 1 : 0,
  };
  
  res.json(response as unknown as CustomerDetail);
}));

const simpleCreateCustomerSchema = z.object({
  billingType: z.enum(["pflegekasse_gesetzlich", "pflegekasse_privat", "selbstzahler"]).default("pflegekasse_gesetzlich"),
  vorname: z.string().min(1, "Vorname ist erforderlich"),
  nachname: z.string().min(1, "Nachname ist erforderlich"),
  geburtsdatum: z.string().optional().nullable(),
  email: internationalEmailSchema.optional().nullable(),
  telefon: optionalGermanPhoneSchema,
  festnetz: optionalGermanPhoneSchema,
  strasse: z.string().min(1, "Straße ist erforderlich"),
  nr: z.string().min(1, "Hausnummer ist erforderlich"),
  plz: z.string().regex(/^\d{5}$/, "Ungültige PLZ (5 Stellen erwartet)"),
  stadt: z.string().min(1, "Stadt ist erforderlich"),
  pflegegrad: z.number().min(1, "Pflegegrad muss zwischen 1 und 5 liegen").max(5, "Pflegegrad muss zwischen 1 und 5 liegen").optional(),
  pflegegradSeit: z.string().optional(),
  vorerkrankungen: z.string().max(2000, "Maximal 2000 Zeichen erlaubt").optional().nullable(),
  haustierVorhanden: z.boolean().optional(),
  haustierDetails: z.string().max(500, "Maximal 500 Zeichen erlaubt").optional().nullable(),
  personenbefoerderungGewuenscht: z.boolean().optional(),
  acceptsPrivatePayment: z.boolean().optional(),
  beihilfeBerechtigt: z.boolean().optional(),
  documentDeliveryMethod: z.enum(["email", "post"]).optional(),
  receivesMonthlyInvoice: z.boolean().optional(),
  insurance: z.object({
    providerId: z.number(),
    versichertennummer: z.string().min(3).max(20),
    validFrom: z.string(),
  }).optional(),
  contacts: z.array(z.object({
    contactType: z.string(),
    isPrimary: z.boolean(),
    vorname: z.string(),
    nachname: z.string(),
    festnetz: optionalGermanPhoneSchema,
    mobilnummer: optionalGermanPhoneSchema,
    email: z.string().optional(),
    notes: z.string().optional(),
  })).optional(),
  budgets: z.object({
    entlastungsbetrag45b: z.number(),
    verhinderungspflege39: z.number(),
    pflegesachleistungen36: z.number(),
    validFrom: z.string(),
    carryoverAmountCents: z.number().min(0, "Betrag darf nicht negativ sein").optional(),
  }).optional(),
  contract: z.object({
    contractStart: z.string(),
    contractDate: z.string().optional(),
    vereinbarteLeistungen: z.string().optional(),
    hoursPerPeriod: z.number(),
    periodType: z.string(),
    rates: z.array(z.object({
      serviceCategory: z.string(),
      hourlyRateCents: z.number(),
    })).optional(),
  }).optional(),
  skipDuplicateCheck: z.boolean().optional(),
});

router.post("/customers", asyncHandler("Kunde konnte nicht erstellt werden", async (req: Request, res: Response) => {
  const data = simpleCreateCustomerSchema.parse(req.body);

  if (!data.skipDuplicateCheck) {
    const duplicates = await findCustomerDuplicates(data.vorname, data.nachname, data.geburtsdatum);
    if (duplicates.length > 0) {
      res.status(409).json({
        error: "DUPLICATE_WARNING",
        code: "DUPLICATE_WARNING",
        message: `Es existiert bereits ${duplicates.length === 1 ? "ein Kunde" : `${duplicates.length} Kunden`} mit gleichem Namen. Zum Anlegen "skipDuplicateCheck" setzen.`,
        details: { duplicates },
      });
      return;
    }
  }

  if (data.insurance?.versichertennummer) {
    const vnr = data.insurance.versichertennummer;
    const provider = await customerManagementStorage.getInsuranceProvider(data.insurance.providerId);
    const result = validateVersichertennummerFor(vnr, {
      billingType: data.billingType,
      isPrivateProvider: provider?.isPrivate ?? false,
    });
    if (!result.ok) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: result.message });
      return;
    }
  }

  if (isPflegekasseCustomer(data.billingType)) {
    if (!data.geburtsdatum) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: "Geburtsdatum ist erforderlich für Pflegekasse-Kunden" });
      return;
    }
    if (!data.pflegegrad) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: "Pflegegrad ist erforderlich für Pflegekasse-Kunden" });
      return;
    }
  }

  if (isSelbstzahlerCustomer(data.billingType)) {
    const effectiveDelivery = data.documentDeliveryMethod || "email";
    if (effectiveDelivery === "email" && (!data.email || !data.email.trim())) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: "E-Mail-Adresse ist erforderlich für den E-Mail-Versand bei Selbstzahlern" });
      return;
    }
  }

  const geburtsdatumError = validateGeburtsdatum(data.geburtsdatum);
  if (geburtsdatumError) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: geburtsdatumError });
    return;
  }

  const userId = req.user!.id;

  const customerData = buildCustomerInsertData(data, userId);
  const testFaults = readTestFaults(req);

  // Atomare Customer-Anlage (Task #267): Pflicht-Cascade (Pflegegrad,
  // Insurance, Budget-Type-Settings, Vertrag/Raten) muss als Einheit
  // committen oder zurückrollen. Andernfalls bleibt der Customer als
  // "Halbleiche" zurück und stört Folge-Workflows (Termin-Anlage,
  // Rechnungslauf, §45b-Buchungen).
  const { customer, warnings } = await db.transaction(async (tx) => {
    const created = await customerManagementStorage.createCustomerDirect(customerData, tx);
    const w = await createCustomerRelatedData({
      customerId: created.id,
      userId,
      logPrefix: "POST /customers",
      pflegegrad: data.pflegegrad,
      pflegegradSeit: data.pflegegradSeit,
      insurance: data.insurance,
      contacts: data.contacts,
      budgets: data.budgets,
      contract: data.contract,
      useLedgerBudgets: true,
      tx,
      testFaults,
    });
    return { customer: created, warnings: w };
  });

  birthdaysCache.invalidateAll();

  auditService.customerCreated(userId, customer.id, {
    customerName: `${data.vorname} ${data.nachname}`,
    billingType: data.billingType,
  }, req.ip).catch(() => {});

  geocodeCustomer(customer.id).catch(err => console.error("[geocoding] Background geocoding failed:", err));

  import("../../startup/prospect-customer-matching")
    .then(({ matchNewCustomerToProspects }) =>
      matchNewCustomerToProspects(customer.id, data.vorname, data.nachname, data.telefon)
    )
    .catch(err => console.warn("[prospect-matching] Prospect-Abgleich nach Kundenanlage fehlgeschlagen:", err));

  const { generateInfoDocumentPdfs } = await import("../../services/document-pdf");
  generateInfoDocumentPdfs({
    customerId: customer.id,
    billingType: data.billingType,
    generatedByUserId: userId,
  }).catch(err => console.error("[info-docs] Background info doc generation failed:", err));
  res.status(201).json({ ...customer, warnings: warnings.length > 0 ? warnings : undefined });
}));

const VALID_CUSTOMER_STATUSES = ["aktiv", "inaktiv"] as const;

const updateCustomerSchema = z.object({
  vorname: z.string().min(1, "Vorname ist erforderlich").optional(),
  nachname: z.string().min(1, "Nachname ist erforderlich").optional(),
  billingType: z.enum(["pflegekasse_gesetzlich", "pflegekasse_privat", "selbstzahler"]).optional(),
  geburtsdatum: z.string().nullable().optional(),
  email: internationalEmailSchema.nullable().optional(),
  festnetz: optionalGermanPhoneSchema,
  telefon: optionalGermanPhoneSchema,
  strasse: z.string().min(1, "Straße ist erforderlich").optional(),
  nr: z.string().min(1, "Hausnummer ist erforderlich").optional(),
  plz: z.string().regex(/^\d{5}$/, "Ungültige PLZ (5 Stellen erwartet)").optional(),
  stadt: z.string().min(1, "Stadt ist erforderlich").optional(),
  status: z.enum(VALID_CUSTOMER_STATUSES).optional(),
  primaryEmployeeId: z.number().nullable().optional(),
  backupEmployeeId: z.number().nullable().optional(),
  backupEmployeeId2: z.number().nullable().optional(),
  vorerkrankungen: z.string().max(2000, "Maximal 2000 Zeichen erlaubt").nullable().optional(),
  haustierVorhanden: z.boolean().optional(),
  haustierDetails: z.string().max(500, "Maximal 500 Zeichen erlaubt").nullable().optional(),
  personenbefoerderungGewuenscht: z.boolean().optional(),
  documentDeliveryMethod: z.enum(["email", "post"]).optional(),
  receivesMonthlyInvoice: z.boolean().optional(),
  acceptsPrivatePayment: z.boolean().optional(),
  beihilfeBerechtigt: z.boolean().optional(),
  inaktivAb: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ungültiges Datumsformat (YYYY-MM-DD erwartet)").nullable().optional(),
  deactivationReason: z.string().nullable().optional(),
  deactivationNote: z.string().max(1000, "Maximal 1000 Zeichen erlaubt").nullable().optional(),
  skipDuplicateCheck: z.boolean().optional(),
});

router.patch("/customers/:id", asyncHandler("Kunde konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const parsed = updateCustomerSchema.parse(req.body);
  const { skipDuplicateCheck, ...validatedData } = parsed;

  if (validatedData.geburtsdatum !== undefined) {
    const geburtsdatumError = validateGeburtsdatum(validatedData.geburtsdatum);
    if (geburtsdatumError) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: geburtsdatumError });
      return;
    }
  }

  const existingCustomer = await storage.getCustomer(id);
  if (!existingCustomer) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" });
    return;
  }

  const nameChanging = (validatedData.vorname !== undefined && validatedData.vorname !== existingCustomer.vorname)
    || (validatedData.nachname !== undefined && validatedData.nachname !== existingCustomer.nachname);

  if (nameChanging && !skipDuplicateCheck) {
    const checkVorname = validatedData.vorname ?? existingCustomer.vorname ?? "";
    const checkNachname = validatedData.nachname ?? existingCustomer.nachname ?? "";
    const checkGeburtsdatum = validatedData.geburtsdatum !== undefined
      ? validatedData.geburtsdatum
      : existingCustomer.geburtsdatum;
    const duplicates = await findCustomerDuplicates(checkVorname, checkNachname, checkGeburtsdatum, id);
    if (duplicates.length > 0) {
      res.status(409).json({
        error: "DUPLICATE_WARNING",
        code: "DUPLICATE_WARNING",
        message: `Es existiert bereits ${duplicates.length === 1 ? "ein Kunde" : `${duplicates.length} Kunden`} mit gleichem Namen. Zum Speichern "skipDuplicateCheck" setzen.`,
        details: { duplicates },
      });
      return;
    }
  }

  const changedFields: string[] = [];
  const oldValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(validatedData)) {
    const oldVal = (existingCustomer as Record<string, unknown>)[key];
    if (oldVal !== value) {
      changedFields.push(key);
      oldValues[key] = oldVal;
      newValues[key] = value;
    }
  }

  const customer = await customerManagementStorage.updateCustomer(id, validatedData);
  
  if (!customer) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" });
    return;
  }

  if (changedFields.length > 0) {
    await auditService.customerUpdated(req.user!.id, id, { changedFields, oldValues, newValues }, req.ip);
  }

  const addressChanged = changedFields.some(f => ["strasse", "nr", "plz", "stadt"].includes(f));
  if (addressChanged) {
    geocodeCustomer(id).catch(err => console.error("[geocoding] Background geocoding failed:", err));
  }
  
  birthdaysCache.invalidateAll();
  
  res.json(customer);
}));

router.get("/customers/:id/timeline", asyncHandler("Timeline konnte nicht geladen werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const customer = await storage.getCustomer(id);
  if (!customer) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" });
    return;
  }

  const { entries: directEntries } = await auditService.getEntries({
    entityType: "customer",
    entityId: id,
    limit: 50,
    offset: 0,
  });

  const relatedEntries = await db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      userName: users.displayName,
      metadata: auditLog.metadata,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .innerJoin(users, eq(auditLog.userId, users.id))
    .where(
      and(
        sql`${auditLog.metadata} @> ${JSON.stringify({ customerId: id })}::jsonb`,
        sql`${auditLog.entityType} != 'customer'`
      )
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(50);

  const directIds = new Set(directEntries.map(e => e.id));
  const merged = [
    ...directEntries.map(entry => ({
      id: entry.id,
      action: entry.action,
      userName: entry.userName,
      metadata: entry.metadata,
      createdAt: entry.createdAt,
    })),
    ...relatedEntries.filter(e => !directIds.has(e.id)),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
   .slice(0, 50);

  res.json(merged);
}));

export default router;
