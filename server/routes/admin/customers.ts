import { Router, Request, Response } from "express";
import { storage } from "../../storage";
import { customerManagementStorage } from "../../storage/customer-management";
import { birthdaysCache } from "../../services/cache";
import { budgetLedgerStorage } from "../../storage/budget-ledger";
import { auditService } from "../../services/audit";
import { geocodeCustomer } from "../../services/geocoding";
import { parseLocalDate, todayISO, validateGeburtsdatum } from "@shared/utils/datetime";
import { 
  versichertennummerSchema,
  customers,
  type InsertCustomer,
} from "@shared/schema";
import { internationalEmailSchema } from "@shared/schema/common";
import { asyncHandler } from "../../lib/errors";
import { z } from "zod";
import { db } from "../../lib/db";
import { eq, and, sql, isNull, desc } from "drizzle-orm";
import { auditLog, users } from "@shared/schema";

import assignmentsRouter from "./customers/assignments";
import budgetsRouter from "./customers/budgets";
import detailsRouter from "./customers/details";
import contractsRouter from "./customers/contracts";
import workflowsRouter from "./customers/workflows";

const router = Router();

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

  const conditions = [
    sql`LOWER(${customers.vorname}) = LOWER(${vorname})`,
    sql`LOWER(${customers.nachname}) = LOWER(${nachname})`,
    isNull(customers.deletedAt),
  ];

  if (geburtsdatum) {
    conditions.push(eq(customers.geburtsdatum, geburtsdatum));
  }

  const existing = await db.select({
    id: customers.id,
    vorname: customers.vorname,
    nachname: customers.nachname,
    geburtsdatum: customers.geburtsdatum,
    stadt: customers.stadt,
    strasse: customers.strasse,
    nr: customers.nr,
    status: customers.status,
  })
    .from(customers)
    .where(and(...conditions))
    .limit(5);

  res.json({ duplicates: existing });
}));

router.get("/customers", asyncHandler("Kunden konnten nicht geladen werden", async (req: Request, res: Response) => {
  const { search, pflegegrad, primaryEmployeeId, status, billingType, insuranceProviderId, page, limit, sortBy, sortOrder } = req.query;
  
  const validSortBy = ["name", "contractStart", "createdAt"].includes(sortBy as string)
    ? (sortBy as "name" | "contractStart" | "createdAt")
    : undefined;
  const validSortOrder = ["asc", "desc"].includes(sortOrder as string)
    ? (sortOrder as "asc" | "desc")
    : undefined;

  const filters = {
    search: search as string | undefined,
    pflegegrad: pflegegrad ? parseInt(pflegegrad as string) : undefined,
    primaryEmployeeId: primaryEmployeeId ? parseInt(primaryEmployeeId as string) : undefined,
    status: status as string | undefined,
    billingType: billingType as string | undefined,
    insuranceProviderId: insuranceProviderId ? parseInt(insuranceProviderId as string) : undefined,
    sortBy: validSortBy,
    sortOrder: validSortOrder,
  };
  
  const pageNum = page ? parseInt(page as string) : 1;
  const limitNum = limit ? parseInt(limit as string) : 20;
  
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

router.get("/customers/:id/details", asyncHandler("Kunde konnte nicht geladen werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
    return;
  }
  
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
      hauswirtschaftRateCents: customer.contract.hauswirtschaftRateCents ?? 0,
      alltagsbegleitungRateCents: customer.contract.alltagsbegleitungRateCents ?? 0,
      kilometerRateCents: customer.contract.kilometerRateCents ?? 0,
      notes: customer.contract.notes,
    } : null,
    activeContractCount: customer.contract ? 1 : 0,
  };
  
  res.json(response);
}));

const simpleCreateCustomerSchema = z.object({
  billingType: z.enum(["pflegekasse_gesetzlich", "pflegekasse_privat", "selbstzahler"]).default("pflegekasse_gesetzlich"),
  vorname: z.string().min(1, "Vorname ist erforderlich"),
  nachname: z.string().min(1, "Nachname ist erforderlich"),
  geburtsdatum: z.string().optional().nullable(),
  email: internationalEmailSchema.optional().nullable(),
  telefon: z.string().optional().nullable(),
  festnetz: z.string().optional().nullable(),
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
  documentDeliveryMethod: z.enum(["email", "post"]).optional(),
  insurance: z.object({
    providerId: z.number(),
    versichertennummer: versichertennummerSchema,
    validFrom: z.string(),
  }).optional(),
  contacts: z.array(z.object({
    contactType: z.string(),
    isPrimary: z.boolean(),
    vorname: z.string(),
    nachname: z.string(),
    telefon: z.string(),
    email: z.string().optional(),
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
});

router.post("/customers", asyncHandler("Kunde konnte nicht erstellt werden", async (req: Request, res: Response) => {
  const data = simpleCreateCustomerSchema.parse(req.body);

  const geburtsdatumError = validateGeburtsdatum(data.geburtsdatum);
  if (geburtsdatumError) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: geburtsdatumError });
    return;
  }

  const userId = req.user!.id;

  const customerData: InsertCustomer = {
    name: `${data.nachname}, ${data.vorname}`,
    vorname: data.vorname,
    nachname: data.nachname,
    email: data.email || null,
    telefon: data.telefon || null,
    festnetz: data.festnetz || null,
    address: `${data.strasse} ${data.nr}, ${data.plz} ${data.stadt}`,
    strasse: data.strasse,
    nr: data.nr,
    plz: data.plz,
    stadt: data.stadt,
    pflegegrad: data.pflegegrad || null,
    geburtsdatum: data.geburtsdatum || null,
    vorerkrankungen: data.vorerkrankungen || null,
    haustierVorhanden: data.haustierVorhanden || false,
    haustierDetails: data.haustierVorhanden ? (data.haustierDetails || null) : null,
    personenbefoerderungGewuenscht: data.personenbefoerderungGewuenscht || false,
    documentDeliveryMethod: data.documentDeliveryMethod || "email",
    billingType: data.billingType,
    createdByUserId: userId,
  };

  const customer = await customerManagementStorage.createCustomerDirect(customerData);

  const warnings: string[] = [];

  if (data.pflegegrad && data.pflegegradSeit) {
    try {
      await customerManagementStorage.addCareLevelHistory({
        customerId: customer.id,
        pflegegrad: data.pflegegrad,
        validFrom: data.pflegegradSeit,
      }, userId);
    } catch (err) {
      console.error(`[POST /customers] Pflegegrad-Historie fehlgeschlagen für Kunde ${customer.id}:`, err);
      warnings.push("Pflegegrad-Historie konnte nicht gespeichert werden");
    }
  }

  if (data.insurance) {
    try {
      await customerManagementStorage.addCustomerInsurance({
        customerId: customer.id,
        insuranceProviderId: data.insurance.providerId,
        versichertennummer: data.insurance.versichertennummer,
        validFrom: data.insurance.validFrom,
      }, userId);
    } catch (err) {
      console.error(`[POST /customers] Versicherung fehlgeschlagen für Kunde ${customer.id}:`, err);
      warnings.push("Versicherung konnte nicht gespeichert werden");
    }
  }

  if (data.contacts && data.contacts.length > 0) {
    try {
      await Promise.all(data.contacts.map((c, i) =>
        customerManagementStorage.addCustomerContact({
          customerId: customer.id,
          contactType: c.contactType as "familie" | "angehoerige" | "nachbar" | "hausarzt" | "betreuer" | "sonstige",
          isPrimary: c.isPrimary,
          vorname: c.vorname,
          nachname: c.nachname,
          telefon: c.telefon,
          email: c.email || null,
          sortOrder: i,
        })
      ));
    } catch (err) {
      console.error(`[POST /customers] Kontakte fehlgeschlagen für Kunde ${customer.id}:`, err);
      warnings.push("Kontakte konnten nicht gespeichert werden");
    }
  }

  if (data.budgets) {
    try {
      const typeSettings: Array<{ budgetType: string; enabled: boolean; priority: number; monthlyLimitCents?: number | null; yearlyLimitCents?: number | null }> = [];
      if (data.budgets.entlastungsbetrag45b > 0) {
        typeSettings.push({ budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: data.budgets.entlastungsbetrag45b });
      }
      if (data.budgets.pflegesachleistungen36 > 0) {
        typeSettings.push({ budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: data.budgets.pflegesachleistungen36 });
      }
      if (data.budgets.verhinderungspflege39 > 0) {
        typeSettings.push({ budgetType: "ersatzpflege_39_42a", enabled: true, priority: 3, yearlyLimitCents: data.budgets.verhinderungspflege39 });
      }
      if (typeSettings.length > 0) {
        try {
          await budgetLedgerStorage.upsertBudgetTypeSettings(customer.id, typeSettings);
        } catch (err) {
          console.error(`[POST /customers] Budget-Type-Settings fehlgeschlagen für Kunde ${customer.id}:`, err);
          warnings.push("Budget-Einstellungen konnten nicht gespeichert werden");
        }
      }

      if (typeSettings.length > 0) {
        try {
          await budgetLedgerStorage.syncBudgetAllocations(customer.id);
        } catch (err) {
          console.error(`[POST /customers] Budget-Sync fehlgeschlagen für Kunde ${customer.id}:`, err);
        }
      }

      if (data.budgets.carryoverAmountCents && data.budgets.carryoverAmountCents > 0) {
        try {
          const validFrom = data.budgets.validFrom || todayISO();
          const validFromDate = parseLocalDate(validFrom);
          const currentYear = validFromDate.getFullYear();
          await budgetLedgerStorage.createBudgetAllocation({
            customerId: customer.id,
            budgetType: "entlastungsbetrag_45b",
            year: currentYear - 1,
            month: null,
            amountCents: data.budgets.carryoverAmountCents,
            source: "carryover",
            validFrom,
            expiresAt: `${currentYear}-06-30`,
            notes: `Übertrag aus ${currentYear - 1}`,
          }, userId);
        } catch (err) {
          console.error(`[POST /customers] Carryover-Allocation fehlgeschlagen für Kunde ${customer.id}:`, err);
          warnings.push("Übertrag aus Vorjahr konnte nicht gespeichert werden");
        }
      }
    } catch (err) {
      console.error(`[POST /customers] Budgets fehlgeschlagen für Kunde ${customer.id}:`, err);
      warnings.push("Budgets konnten nicht gespeichert werden");
    }
  }

  if (data.contract) {
    try {
      const hauswirtschaftRate = data.contract.rates?.find(r => r.serviceCategory === "hauswirtschaft");
      const alltagsbegleitungRate = data.contract.rates?.find(r => r.serviceCategory === "alltagsbegleitung");
      const kilometerRate = data.contract.rates?.find(r => r.serviceCategory === "kilometer");
      const contract = await customerManagementStorage.createCustomerContract({
        customerId: customer.id,
        contractStart: data.contract.contractStart,
        contractDate: data.contract.contractDate || null,
        vereinbarteLeistungen: data.contract.vereinbarteLeistungen || null,
        hoursPerPeriod: data.contract.hoursPerPeriod,
        periodType: data.contract.periodType as "week" | "month" | "year",
        hauswirtschaftRateCents: hauswirtschaftRate?.hourlyRateCents || 0,
        alltagsbegleitungRateCents: alltagsbegleitungRate?.hourlyRateCents || 0,
        kilometerRateCents: kilometerRate?.hourlyRateCents || 0,
        status: "active",
      }, userId);

      if (data.contract.rates && data.contract.rates.length > 0) {
        await Promise.all(data.contract.rates.map(rate =>
          customerManagementStorage.addContractRate({
            contractId: contract.id,
            serviceCategory: rate.serviceCategory as "hauswirtschaft" | "alltagsbegleitung" | "erstberatung",
            hourlyRateCents: rate.hourlyRateCents,
            validFrom: data.contract!.contractStart,
          }, userId)
        ));
      }
    } catch (err) {
      console.error(`[POST /customers] Vertrag fehlgeschlagen für Kunde ${customer.id}:`, err);
      warnings.push("Vertrag konnte nicht erstellt werden");
    }
  }

  birthdaysCache.invalidateAll();

  auditService.customerCreated(userId, customer.id, {
    customerName: `${data.vorname} ${data.nachname}`,
    billingType: data.billingType,
  }, req.ip).catch(() => {});

  geocodeCustomer(customer.id).catch(err => console.error("[geocoding] Background geocoding failed:", err));
  
  res.status(201).json({ ...customer, warnings: warnings.length > 0 ? warnings : undefined });
}));

const VALID_CUSTOMER_STATUSES = ["aktiv", "inaktiv"] as const;

const updateCustomerSchema = z.object({
  vorname: z.string().min(1, "Vorname ist erforderlich").optional(),
  nachname: z.string().min(1, "Nachname ist erforderlich").optional(),
  billingType: z.enum(["pflegekasse_gesetzlich", "pflegekasse_privat", "selbstzahler"]).optional(),
  geburtsdatum: z.string().nullable().optional(),
  email: internationalEmailSchema.nullable().optional(),
  festnetz: z.string().nullable().optional(),
  telefon: z.string().nullable().optional(),
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
  acceptsPrivatePayment: z.boolean().optional(),
  inaktivAb: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ungültiges Datumsformat (YYYY-MM-DD erwartet)").nullable().optional(),
  deactivationReason: z.string().nullable().optional(),
  deactivationNote: z.string().max(1000, "Maximal 1000 Zeichen erlaubt").nullable().optional(),
});

router.patch("/customers/:id", asyncHandler("Kunde konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
    return;
  }
  
  const validatedData = updateCustomerSchema.parse(req.body);

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
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
    return;
  }

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
