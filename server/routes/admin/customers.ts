import { Router, Request, Response } from "express";
import { storage } from "../../storage";
import { customerManagementStorage } from "../../storage/customer-management";
import { authService } from "../../services/auth";
import { birthdaysCache } from "../../services/cache";
import { formatDateISO, isChild } from "@shared/utils/datetime";
import { 
  insertCustomerInsuranceSchema,
  insertCustomerContactSchema,
  insertCareLevelHistorySchema,
  insertCustomerBudgetSchema,
  customers,
  users,
  userRoles,
  appointments,
  customerContracts,
  customerInsuranceHistory,
} from "@shared/schema";
import { asyncHandler } from "../../lib/errors";
import { z } from "zod";
import { validate45aAmount, validate45bAmount, validate39_42aAmount } from "@shared/domain/budgets";
import { db } from "../../lib/db";
import { eq, and, sql, gte, isNull, or, count } from "drizzle-orm";

const router = Router();

const assignCustomerSchema = z.object({
  primaryEmployeeId: z.number().nullable(),
  backupEmployeeId: z.number().nullable(),
});

router.patch("/customers/:id/assign", asyncHandler("Zuordnung konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Ungültige Kunden-ID",
    });
    return;
  }

  const result = assignCustomerSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Ungültige Daten",
      details: result.error.issues,
    });
    return;
  }

  const customer = await storage.getCustomer(id);
  if (!customer) {
    res.status(404).json({
      error: "NOT_FOUND",
      message: "Kunde nicht gefunden",
    });
    return;
  }

  const { primaryEmployeeId, backupEmployeeId } = result.data;

  if (primaryEmployeeId && backupEmployeeId && primaryEmployeeId === backupEmployeeId) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Hauptansprechpartner und Vertretung müssen unterschiedlich sein",
    });
    return;
  }

  if (primaryEmployeeId) {
    const primaryEmployee = await authService.getUser(primaryEmployeeId);
    if (!primaryEmployee || !primaryEmployee.isActive) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Hauptansprechpartner nicht gefunden oder nicht aktiv",
      });
      return;
    }
  }

  if (backupEmployeeId) {
    const backupEmployee = await authService.getUser(backupEmployeeId);
    if (!backupEmployee || !backupEmployee.isActive) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Vertretung nicht gefunden oder nicht aktiv",
      });
      return;
    }
  }

  const updatedCustomer = await customerManagementStorage.updateCustomerAssignment(id, primaryEmployeeId, backupEmployeeId, req.user?.id);
  
  // Invalidate birthday cache (employee assignments affect which customers appear for each user)
  birthdaysCache.invalidateAll();
  
  res.json(updatedCustomer);
}));

// ============================================
// CUSTOMER MANAGEMENT (Full Admin Access)
// ============================================

router.get("/customers", asyncHandler("Kunden konnten nicht geladen werden", async (req: Request, res: Response) => {
  const { search, pflegegrad, primaryEmployeeId, status, billingType, page, limit } = req.query;
  
  const filters = {
    search: search as string | undefined,
    pflegegrad: pflegegrad ? parseInt(pflegegrad as string) : undefined,
    primaryEmployeeId: primaryEmployeeId ? parseInt(primaryEmployeeId as string) : undefined,
    status: status as string | undefined,
    billingType: billingType as string | undefined,
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
  vorname: z.string().min(1),
  nachname: z.string().min(1),
  geburtsdatum: z.string().optional().nullable(),
  email: z.string().email().optional().nullable(),
  telefon: z.string().optional().nullable(),
  festnetz: z.string().optional().nullable(),
  strasse: z.string().min(1),
  nr: z.string().min(1),
  plz: z.string().regex(/^\d{5}$/),
  stadt: z.string().min(1),
  pflegegrad: z.number().min(1).max(5).optional(),
  pflegegradSeit: z.string().optional(),
  vorerkrankungen: z.string().max(2000).optional().nullable(),
  haustierVorhanden: z.boolean().optional(),
  haustierDetails: z.string().max(500).optional().nullable(),
  personenbefoerderungGewuenscht: z.boolean().optional(),
  insurance: z.object({
    providerId: z.number(),
    versichertennummer: z.string(),
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
  const userId = req.user!.id;

  const customerData: any = {
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
      await customerManagementStorage.addCustomerBudget({
        customerId: customer.id,
        entlastungsbetrag45b: data.budgets.entlastungsbetrag45b,
        verhinderungspflege39: data.budgets.verhinderungspflege39,
        pflegesachleistungen36: data.budgets.pflegesachleistungen36,
        validFrom: data.budgets.validFrom,
      }, userId);
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
            validFrom: data.contract.contractStart,
          }, userId)
        ));
      }
    } catch (err) {
      console.error(`[POST /customers] Vertrag fehlgeschlagen für Kunde ${customer.id}:`, err);
      warnings.push("Vertrag konnte nicht erstellt werden");
    }
  }

  birthdaysCache.invalidateAll();
  
  res.status(201).json({ ...customer, warnings: warnings.length > 0 ? warnings : undefined });
}));

const VALID_CUSTOMER_STATUSES = ["erstberatung", "aktiv", "inaktiv"] as const;

const updateCustomerSchema = z.object({
  vorname: z.string().min(1).optional(),
  nachname: z.string().min(1).optional(),
  billingType: z.enum(["pflegekasse_gesetzlich", "pflegekasse_privat", "selbstzahler"]).optional(),
  geburtsdatum: z.string().nullable().optional(),
  email: z.string().email().nullable().optional(),
  festnetz: z.string().nullable().optional(),
  telefon: z.string().nullable().optional(),
  strasse: z.string().min(1).optional(),
  nr: z.string().min(1).optional(),
  plz: z.string().regex(/^\d{5}$/).optional(),
  stadt: z.string().min(1).optional(),
  status: z.enum(VALID_CUSTOMER_STATUSES).optional(),
  primaryEmployeeId: z.number().nullable().optional(),
  backupEmployeeId: z.number().nullable().optional(),
  vorerkrankungen: z.string().max(2000).nullable().optional(),
  haustierVorhanden: z.boolean().optional(),
  haustierDetails: z.string().max(500).nullable().optional(),
  personenbefoerderungGewuenscht: z.boolean().optional(),
  acceptsPrivatePayment: z.boolean().optional(),
  inaktivAb: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ungültiges Datumsformat (YYYY-MM-DD erwartet)").nullable().optional(),
});

router.patch("/customers/:id", asyncHandler("Kunde konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
    return;
  }
  
  const validatedData = updateCustomerSchema.parse(req.body);
  const customer = await customerManagementStorage.updateCustomer(id, validatedData);
  
  if (!customer) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" });
    return;
  }
  
  // Invalidate birthday cache (customer data may have changed)
  birthdaysCache.invalidateAll();
  
  res.json(customer);
}));

router.get("/customers/:id/conversion-readiness", asyncHandler("Konvertierungsprüfung fehlgeschlagen", async (req: Request, res: Response) => {
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

  if (customer.status !== "erstberatung") {
    res.json({
      ready: customer.status === "aktiv",
      missing: [],
      customerStatus: customer.status,
    });
    return;
  }

  const missing: string[] = [];

  if (!customer.pflegegrad || customer.pflegegrad === 0) {
    missing.push("pflegegrad");
  }
  if (!customer.billingType) {
    missing.push("billingType");
  }
  if (!customer.primaryEmployeeId) {
    missing.push("primaryEmployee");
  }

  const isSelbstzahler = customer.billingType === "selbstzahler";

  if (!isSelbstzahler) {
    const [activeInsurance] = await db
      .select({ id: customerInsuranceHistory.id })
      .from(customerInsuranceHistory)
      .where(
        and(
          eq(customerInsuranceHistory.customerId, id),
          isNull(customerInsuranceHistory.validTo)
        )
      )
      .limit(1);

    if (!activeInsurance) {
      missing.push("insurance");
    }
  }

  const [activeContract] = await db
    .select({ id: customerContracts.id })
    .from(customerContracts)
    .where(
      and(
        eq(customerContracts.customerId, id),
        eq(customerContracts.status, "active")
      )
    )
    .limit(1);

  if (!activeContract) {
    missing.push("contract");
  }

  res.json({
    ready: missing.length === 0,
    missing,
    customerStatus: customer.status,
  });
}));

// Insurance Management
router.get("/customers/:id/insurance", asyncHandler("Versicherungshistorie konnte nicht geladen werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
    return;
  }
  
  const history = await customerManagementStorage.getCustomerInsuranceHistory(id);
  res.json(history);
}));

router.post("/customers/:id/insurance", asyncHandler("Versicherung konnte nicht hinzugefügt werden", async (req: Request, res: Response) => {
  const customerId = parseInt(req.params.id);
  if (isNaN(customerId)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
    return;
  }
  
  const data = insertCustomerInsuranceSchema.parse({ ...req.body, customerId });
  const insurance = await customerManagementStorage.addCustomerInsurance(data, req.user!.id);
  res.status(201).json(insurance);
}));

// Emergency Contacts
router.get("/customers/:id/contacts", asyncHandler("Kontakte konnten nicht geladen werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
    return;
  }
  
  const contacts = await customerManagementStorage.getCustomerContacts(id);
  res.json(contacts);
}));

router.post("/customers/:id/contacts", asyncHandler("Kontakt konnte nicht hinzugefügt werden", async (req: Request, res: Response) => {
  const customerId = parseInt(req.params.id);
  if (isNaN(customerId)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
    return;
  }
  
  const validatedData = insertCustomerContactSchema.parse({ ...req.body, customerId });
  const contact = await customerManagementStorage.addCustomerContact(validatedData);
  res.status(201).json(contact);
}));

const updateCustomerContactSchema = insertCustomerContactSchema
  .omit({ customerId: true })
  .partial();

router.patch("/customers/:customerId/contacts/:contactId", asyncHandler("Kontakt konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
  const contactId = parseInt(req.params.contactId);
  if (isNaN(contactId)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kontakt-ID" });
    return;
  }
  
  const result = updateCustomerContactSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Ungültige Kontaktdaten",
      details: result.error.issues,
    });
    return;
  }
  
  const contact = await customerManagementStorage.updateCustomerContact(contactId, result.data);
  if (!contact) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kontakt nicht gefunden" });
    return;
  }
  
  res.json(contact);
}));

router.delete("/customers/:customerId/contacts/:contactId", asyncHandler("Kontakt konnte nicht gelöscht werden", async (req: Request, res: Response) => {
  const contactId = parseInt(req.params.contactId);
  if (isNaN(contactId)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kontakt-ID" });
    return;
  }
  
  const deleted = await customerManagementStorage.deleteCustomerContact(contactId);
  if (!deleted) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kontakt nicht gefunden" });
    return;
  }
  
  res.json({ success: true });
}));

// Care Level (Pflegegrad)
router.get("/customers/:id/care-level", asyncHandler("Pflegegrad-Historie konnte nicht geladen werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
    return;
  }
  
  const history = await customerManagementStorage.getCustomerCareLevelHistory(id);
  res.json(history);
}));

router.post("/customers/:id/care-level", asyncHandler("Pflegegrad konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
  const customerId = parseInt(req.params.id);
  if (isNaN(customerId)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
    return;
  }
  
  const validatedData = insertCareLevelHistorySchema.parse({ ...req.body, customerId });
  const careLevel = await customerManagementStorage.addCareLevelHistory(validatedData, req.user!.id);
  res.status(201).json(careLevel);
}));

// Budgets
router.get("/customers/:id/budgets", asyncHandler("Budget-Historie konnte nicht geladen werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
    return;
  }
  
  const history = await customerManagementStorage.getCustomerBudgetHistory(id);
  res.json(history);
}));

router.post("/customers/:id/budgets", asyncHandler("Budget konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
  const customerId = parseInt(req.params.id);
  if (isNaN(customerId)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
    return;
  }
  
  const validatedData = insertCustomerBudgetSchema.parse({ ...req.body, customerId });
  
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

// ============================================
// EMPLOYEE MATCHING
// ============================================

interface MatchCriteria {
  plz: string | null;
  haustierVorhanden: boolean;
  personenbefoerderungGewuenscht: boolean;
  geburtsdatum: string | null;
  needsHauswirtschaft: boolean;
  needsAlltagsbegleitung: boolean;
}

interface MatchResult {
  employeeId: number;
  displayName: string;
  score: number;
  maxScore: number;
  reasons: { label: string; matched: boolean; detail: string }[];
}


function plzDistance(plz1: string | null, plz2: string | null): number | null {
  if (!plz1 || !plz2) return null;
  const n1 = parseInt(plz1);
  const n2 = parseInt(plz2);
  if (isNaN(n1) || isNaN(n2)) return null;
  return Math.abs(n1 - n2);
}

async function matchEmployees(criteria: MatchCriteria, excludeEmployeeIds: number[] = []): Promise<MatchResult[]> {
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const threeMonthsAgoStr = formatDateISO(threeMonthsAgo);

  const [activeEmployees, allRoles, activeCustomerCounts, appointmentCounts] = await Promise.all([
    db.select({
      id: users.id,
      displayName: users.displayName,
      plz: users.plz,
      haustierAkzeptiert: users.haustierAkzeptiert,
    })
    .from(users)
    .where(eq(users.isActive, true)),

    db.select({ userId: userRoles.userId, role: userRoles.role })
    .from(userRoles),

    db.select({
      employeeId: customers.primaryEmployeeId,
      count: count(),
    })
    .from(customers)
    .where(and(
      eq(customers.status, "aktiv"),
      isNull(customers.deletedAt),
      sql`${customers.primaryEmployeeId} IS NOT NULL`
    ))
    .groupBy(customers.primaryEmployeeId),

    db.select({
      employeeId: appointments.assignedEmployeeId,
      count: count(),
    })
    .from(appointments)
    .where(and(
      gte(appointments.date, threeMonthsAgoStr),
      sql`${appointments.assignedEmployeeId} IS NOT NULL`
    ))
    .groupBy(appointments.assignedEmployeeId),
  ]);

  const rolesByUser = new Map<number, string[]>();
  for (const r of allRoles) {
    if (!rolesByUser.has(r.userId)) rolesByUser.set(r.userId, []);
    rolesByUser.get(r.userId)!.push(r.role);
  }

  const customerCountMap = new Map<number, number>();
  for (const c of activeCustomerCounts) {
    if (c.employeeId) customerCountMap.set(c.employeeId, Number(c.count));
  }

  const appointmentCountMap = new Map<number, number>();
  for (const a of appointmentCounts) {
    if (a.employeeId) appointmentCountMap.set(a.employeeId, Number(a.count));
  }

  const maxCustomers = Math.max(...Array.from(customerCountMap.values()), 1);
  const maxAppointments = Math.max(...Array.from(appointmentCountMap.values()), 1);
  const customerIsChild = isChild(criteria.geburtsdatum);

  const results: MatchResult[] = [];

  for (const emp of activeEmployees) {
    if (excludeEmployeeIds.includes(emp.id)) continue;

    const roles = rolesByUser.get(emp.id) || [];
    const reasons: MatchResult["reasons"] = [];
    let score = 0;
    let maxScore = 0;

    // 1. Haustier - hard exclusion: skip employee entirely if they don't accept pets
    if (criteria.haustierVorhanden && !emp.haustierAkzeptiert) {
      continue;
    }
    maxScore += 30;
    if (criteria.haustierVorhanden) {
      score += 30;
      reasons.push({ label: "Haustiere", matched: true, detail: "Akzeptiert Haustiere" });
    } else {
      score += 30;
      reasons.push({ label: "Haustiere", matched: true, detail: "Kein Haustier beim Kunden" });
    }

    // 2. PLZ-Nähe (weight: 25)
    maxScore += 25;
    const dist = plzDistance(criteria.plz, emp.plz);
    if (dist !== null) {
      const plzScore = Math.max(0, 25 - Math.floor(dist / 400));
      score += plzScore;
      if (dist === 0) {
        reasons.push({ label: "Entfernung", matched: true, detail: "Gleiche PLZ" });
      } else if (dist <= 2000) {
        reasons.push({ label: "Entfernung", matched: true, detail: `PLZ-Differenz: ${dist}` });
      } else {
        reasons.push({ label: "Entfernung", matched: false, detail: `PLZ-Differenz: ${dist} (weit entfernt)` });
      }
    } else {
      reasons.push({ label: "Entfernung", matched: false, detail: "PLZ nicht verfügbar" });
    }

    // 3. Service-Match (weight: 20)
    maxScore += 20;
    let serviceMatches = 0;
    let serviceTotal = 0;
    if (criteria.needsHauswirtschaft) {
      serviceTotal++;
      if (roles.includes("hauswirtschaft")) serviceMatches++;
    }
    if (criteria.needsAlltagsbegleitung) {
      serviceTotal++;
      if (roles.includes("alltagsbegleitung")) serviceMatches++;
    }
    if (serviceTotal > 0) {
      const serviceScore = Math.round((serviceMatches / serviceTotal) * 20);
      score += serviceScore;
      const matched = serviceMatches === serviceTotal;
      reasons.push({
        label: "Leistungen",
        matched,
        detail: matched
          ? `Alle Leistungen abgedeckt (${serviceMatches}/${serviceTotal})`
          : `${serviceMatches}/${serviceTotal} Leistungen abgedeckt`,
      });
    } else {
      score += 20;
      reasons.push({ label: "Leistungen", matched: true, detail: "Keine spezifischen Leistungen gefordert" });
    }

    // 4. Personenbeförderung (weight: 10)
    maxScore += 10;
    if (criteria.personenbefoerderungGewuenscht) {
      if (roles.includes("personenbefoerderung")) {
        score += 10;
        reasons.push({ label: "Personenbeförderung", matched: true, detail: "Kann Personenbeförderung" });
      } else {
        reasons.push({ label: "Personenbeförderung", matched: false, detail: "Keine Personenbeförderung" });
      }
    } else {
      score += 10;
      reasons.push({ label: "Personenbeförderung", matched: true, detail: "Nicht benötigt" });
    }

    // 5. Kind (weight: 10)
    maxScore += 10;
    if (customerIsChild) {
      if (roles.includes("kinderbetreuung")) {
        score += 10;
        reasons.push({ label: "Kinderbetreuung", matched: true, detail: "Qualifiziert für Kinderbetreuung" });
      } else {
        reasons.push({ label: "Kinderbetreuung", matched: false, detail: "Keine Kinderbetreuung-Qualifikation" });
      }
    } else {
      score += 10;
      reasons.push({ label: "Kinderbetreuung", matched: true, detail: "Kein Kind" });
    }

    // 6. Kapazität (weight: 5 - based on current customer count + appointments)
    maxScore += 5;
    const empCustomers = customerCountMap.get(emp.id) || 0;
    const empAppointments = appointmentCountMap.get(emp.id) || 0;
    const loadRatio = (empCustomers / maxCustomers + empAppointments / maxAppointments) / 2;
    const capacityScore = Math.round((1 - loadRatio) * 5);
    score += Math.max(0, capacityScore);
    reasons.push({
      label: "Kapazität",
      matched: capacityScore >= 3,
      detail: `${empCustomers} Kunden, ${empAppointments} Termine (3 Mon.)`,
    });

    results.push({
      employeeId: emp.id,
      displayName: emp.displayName,
      score,
      maxScore,
      reasons,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 3);
}

router.get("/customers/:id/match-employees", asyncHandler("Matching konnte nicht durchgeführt werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
    return;
  }

  const customer = await db
    .select()
    .from(customers)
    .where(eq(customers.id, id))
    .then(r => r[0]);

  if (!customer) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" });
    return;
  }

  const needsAssessment = await customerManagementStorage.getCustomerNeedsAssessment(id);

  const needsHauswirtschaft = needsAssessment
    ? !!(needsAssessment.serviceHaushaltHilfe || needsAssessment.serviceMahlzeiten || needsAssessment.serviceReinigung || needsAssessment.serviceWaeschePflege || needsAssessment.serviceEinkauf)
    : false;
  const needsAlltagsbegleitung = needsAssessment
    ? !!(needsAssessment.serviceTagesablauf || needsAssessment.serviceAlltagsverrichtungen || needsAssessment.serviceTerminbegleitung || needsAssessment.serviceBotengaenge || needsAssessment.serviceFreizeitbegleitung || needsAssessment.serviceDemenzbetreuung || needsAssessment.serviceGesellschaft || needsAssessment.serviceSozialeKontakte)
    : false;

  const excludeIds: number[] = [];
  if (customer.primaryEmployeeId) excludeIds.push(customer.primaryEmployeeId);
  if (customer.backupEmployeeId) excludeIds.push(customer.backupEmployeeId);

  const results = await matchEmployees({
    plz: customer.plz,
    haustierVorhanden: customer.haustierVorhanden,
    personenbefoerderungGewuenscht: customer.personenbefoerderungGewuenscht,
    geburtsdatum: customer.geburtsdatum,
    needsHauswirtschaft,
    needsAlltagsbegleitung,
  }, excludeIds);

  res.json(results);
}));

const matchInlineSchema = z.object({
  plz: z.string().nullable().optional(),
  haustierVorhanden: z.boolean().optional(),
  personenbefoerderungGewuenscht: z.boolean().optional(),
  geburtsdatum: z.string().nullable().optional(),
  needsHauswirtschaft: z.boolean().optional(),
  needsAlltagsbegleitung: z.boolean().optional(),
  excludeEmployeeIds: z.array(z.number()).optional(),
});

router.post("/customers/match-employees", asyncHandler("Matching konnte nicht durchgeführt werden", async (req: Request, res: Response) => {
  const data = matchInlineSchema.parse(req.body);

  const results = await matchEmployees({
    plz: data.plz || null,
    haustierVorhanden: data.haustierVorhanden || false,
    personenbefoerderungGewuenscht: data.personenbefoerderungGewuenscht || false,
    geburtsdatum: data.geburtsdatum || null,
    needsHauswirtschaft: data.needsHauswirtschaft || false,
    needsAlltagsbegleitung: data.needsAlltagsbegleitung || false,
  }, data.excludeEmployeeIds || []);

  res.json(results);
}));

export default router;
