import { Router, Request, Response } from "express";
import { storage } from "../../storage";
import { customerManagementStorage } from "../../storage/customer-management";
import { authService } from "../../services/auth";
import { birthdaysCache } from "../../services/cache";
import { 
  createFullCustomerSchema,
  insertCustomerInsuranceSchema,
  insertCustomerContactSchema,
  insertCareLevelHistorySchema,
  insertCustomerBudgetSchema,
} from "@shared/schema";
import { handleRouteError } from "../../lib/errors";
import { z } from "zod";
import { fromError } from "zod-validation-error";
import { todayISO } from "@shared/utils/datetime";
import { validate45aAmount, validate45bAmount, validate39_42aAmount } from "@shared/domain/budgets";

const router = Router();

const assignCustomerSchema = z.object({
  primaryEmployeeId: z.number().nullable(),
  backupEmployeeId: z.number().nullable(),
});

router.patch("/customers/:id/assign", async (req: Request, res: Response) => {
  try {
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

    const updatedCustomer = await updateCustomerAssignment(id, primaryEmployeeId, backupEmployeeId, req.user?.id);
    
    // Invalidate birthday cache (employee assignments affect which customers appear for each user)
    birthdaysCache.invalidateAll();
    
    res.json(updatedCustomer);
  } catch (error) {
    handleRouteError(res, error, "Zuordnung konnte nicht aktualisiert werden");
  }
});

async function updateCustomerAssignment(
  customerId: number,
  primaryEmployeeId: number | null,
  backupEmployeeId: number | null,
  changedByUserId?: number
) {
  const { eq, and, isNull } = await import("drizzle-orm");
  const { customers, customerAssignmentHistory } = await import("@shared/schema");
  const { customerIdsCache } = await import("../../services/cache");
  const { db } = await import("../../lib/db");

  const [existing] = await db.select().from(customers).where(eq(customers.id, customerId));
  
  const today = todayISO();

  if (existing) {
    if (existing.primaryEmployeeId !== primaryEmployeeId) {
      if (existing.primaryEmployeeId) {
        await db.update(customerAssignmentHistory)
          .set({ validTo: today })
          .where(and(
            eq(customerAssignmentHistory.customerId, customerId),
            eq(customerAssignmentHistory.employeeId, existing.primaryEmployeeId),
            eq(customerAssignmentHistory.role, "primary"),
            isNull(customerAssignmentHistory.validTo)
          ));
      }
      if (primaryEmployeeId) {
        await db.insert(customerAssignmentHistory).values({
          customerId,
          employeeId: primaryEmployeeId,
          role: "primary",
          validFrom: today,
          changedByUserId: changedByUserId ?? null,
        });
      }
    }

    if (existing.backupEmployeeId !== backupEmployeeId) {
      if (existing.backupEmployeeId) {
        await db.update(customerAssignmentHistory)
          .set({ validTo: today })
          .where(and(
            eq(customerAssignmentHistory.customerId, customerId),
            eq(customerAssignmentHistory.employeeId, existing.backupEmployeeId),
            eq(customerAssignmentHistory.role, "backup"),
            isNull(customerAssignmentHistory.validTo)
          ));
      }
      if (backupEmployeeId) {
        await db.insert(customerAssignmentHistory).values({
          customerId,
          employeeId: backupEmployeeId,
          role: "backup",
          validFrom: today,
          changedByUserId: changedByUserId ?? null,
        });
      }
    }
  }

  const [updated] = await db
    .update(customers)
    .set({ primaryEmployeeId, backupEmployeeId })
    .where(eq(customers.id, customerId))
    .returning();

  if (existing) {
    customerIdsCache.invalidateForCustomer(existing.primaryEmployeeId, existing.backupEmployeeId);
  }
  customerIdsCache.invalidateForCustomer(primaryEmployeeId, backupEmployeeId);

  return updated;
}

// ============================================
// CUSTOMER MANAGEMENT (Full Admin Access)
// ============================================

router.get("/customers", async (req: Request, res: Response) => {
  try {
    const { search, pflegegrad, primaryEmployeeId, page, limit } = req.query;
    
    const filters = {
      search: search as string | undefined,
      pflegegrad: pflegegrad ? parseInt(pflegegrad as string) : undefined,
      primaryEmployeeId: primaryEmployeeId ? parseInt(primaryEmployeeId as string) : undefined,
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
  } catch (error) {
    handleRouteError(res, error, "Kunden konnten nicht geladen werden");
  }
});

router.get("/customers/:id/details", async (req: Request, res: Response) => {
  try {
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
        contractStart: customer.contract.contractStart,
        contractEnd: customer.contract.contractEnd,
        hoursPerPeriod: customer.contract.hoursPerPeriod,
        periodType: customer.contract.periodType,
        status: customer.contract.status,
        hauswirtschaftRateCents: customer.contract.hauswirtschaftRateCents ?? 0,
        alltagsbegleitungRateCents: customer.contract.alltagsbegleitungRateCents ?? 0,
        kilometerRateCents: customer.contract.kilometerRateCents ?? 0,
        notes: customer.contract.notes,
      } : null,
      activeContractCount: customer.contract ? 1 : 0,
      pricingHistory: customer.pricingHistory || [],
      currentPricing: customer.currentPricing || null,
      budgetSummary: customer.budgetSummary || null,
    };
    
    res.json(response);
  } catch (error) {
    handleRouteError(res, error, "Kunde konnte nicht geladen werden");
  }
});

router.post("/customers", async (req: Request, res: Response) => {
  try {
    const validatedData = createFullCustomerSchema.parse(req.body);
    const customer = await customerManagementStorage.createFullCustomer(validatedData, req.user!.id);
    
    // Invalidate birthday cache (new customer may have birthday)
    birthdaysCache.invalidateAll();
    
    res.status(201).json(customer);
  } catch (error: any) {
    if (error.name === "ZodError") {
      res.status(400).json({ error: "VALIDATION_ERROR", message: fromError(error).toString() });
      return;
    }
    handleRouteError(res, error, "Kunde konnte nicht erstellt werden");
  }
});

const updateCustomerSchema = z.object({
  vorname: z.string().min(1).optional(),
  nachname: z.string().min(1).optional(),
  email: z.string().email().nullable().optional(),
  festnetz: z.string().nullable().optional(),
  telefon: z.string().nullable().optional(),
  strasse: z.string().min(1).optional(),
  nr: z.string().min(1).optional(),
  plz: z.string().regex(/^\d{5}$/).optional(),
  stadt: z.string().min(1).optional(),
  primaryEmployeeId: z.number().nullable().optional(),
  backupEmployeeId: z.number().nullable().optional(),
});

router.patch("/customers/:id", async (req: Request, res: Response) => {
  try {
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
  } catch (error: any) {
    if (error.name === "ZodError") {
      res.status(400).json({ error: "VALIDATION_ERROR", message: fromError(error).toString() });
      return;
    }
    handleRouteError(res, error, "Kunde konnte nicht aktualisiert werden");
  }
});

// Insurance Management
router.get("/customers/:id/insurance", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
      return;
    }
    
    const history = await customerManagementStorage.getCustomerInsuranceHistory(id);
    res.json(history);
  } catch (error) {
    handleRouteError(res, error, "Versicherungshistorie konnte nicht geladen werden");
  }
});

router.post("/customers/:id/insurance", async (req: Request, res: Response) => {
  try {
    const customerId = parseInt(req.params.id);
    if (isNaN(customerId)) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
      return;
    }
    
    const data = insertCustomerInsuranceSchema.parse({ ...req.body, customerId });
    const insurance = await customerManagementStorage.addCustomerInsurance(data, req.user!.id);
    res.status(201).json(insurance);
  } catch (error: any) {
    if (error.name === "ZodError") {
      res.status(400).json({ error: "VALIDATION_ERROR", message: fromError(error).toString() });
      return;
    }
    handleRouteError(res, error, "Versicherung konnte nicht hinzugefügt werden");
  }
});

// Emergency Contacts
router.get("/customers/:id/contacts", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
      return;
    }
    
    const contacts = await customerManagementStorage.getCustomerContacts(id);
    res.json(contacts);
  } catch (error) {
    handleRouteError(res, error, "Kontakte konnten nicht geladen werden");
  }
});

router.post("/customers/:id/contacts", async (req: Request, res: Response) => {
  try {
    const customerId = parseInt(req.params.id);
    if (isNaN(customerId)) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
      return;
    }
    
    const validatedData = insertCustomerContactSchema.parse({ ...req.body, customerId });
    const contact = await customerManagementStorage.addCustomerContact(validatedData);
    res.status(201).json(contact);
  } catch (error: any) {
    if (error.name === "ZodError") {
      res.status(400).json({ error: "VALIDATION_ERROR", message: fromError(error).toString() });
      return;
    }
    handleRouteError(res, error, "Kontakt konnte nicht hinzugefügt werden");
  }
});

router.patch("/customers/:customerId/contacts/:contactId", async (req: Request, res: Response) => {
  try {
    const contactId = parseInt(req.params.contactId);
    if (isNaN(contactId)) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kontakt-ID" });
      return;
    }
    
    const contact = await customerManagementStorage.updateCustomerContact(contactId, req.body);
    if (!contact) {
      res.status(404).json({ error: "NOT_FOUND", message: "Kontakt nicht gefunden" });
      return;
    }
    
    res.json(contact);
  } catch (error: any) {
    if (error.name === "ZodError") {
      res.status(400).json({ error: "VALIDATION_ERROR", message: fromError(error).toString() });
      return;
    }
    handleRouteError(res, error, "Kontakt konnte nicht aktualisiert werden");
  }
});

router.delete("/customers/:customerId/contacts/:contactId", async (req: Request, res: Response) => {
  try {
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
  } catch (error) {
    handleRouteError(res, error, "Kontakt konnte nicht gelöscht werden");
  }
});

// Care Level (Pflegegrad)
router.get("/customers/:id/care-level", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
      return;
    }
    
    const history = await customerManagementStorage.getCustomerCareLevelHistory(id);
    res.json(history);
  } catch (error) {
    handleRouteError(res, error, "Pflegegrad-Historie konnte nicht geladen werden");
  }
});

router.post("/customers/:id/care-level", async (req: Request, res: Response) => {
  try {
    const customerId = parseInt(req.params.id);
    if (isNaN(customerId)) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
      return;
    }
    
    const validatedData = insertCareLevelHistorySchema.parse({ ...req.body, customerId });
    const careLevel = await customerManagementStorage.addCareLevelHistory(validatedData, req.user!.id);
    res.status(201).json(careLevel);
  } catch (error: any) {
    if (error.name === "ZodError") {
      res.status(400).json({ error: "VALIDATION_ERROR", message: fromError(error).toString() });
      return;
    }
    handleRouteError(res, error, "Pflegegrad konnte nicht aktualisiert werden");
  }
});

// Budgets
router.get("/customers/:id/budgets", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
      return;
    }
    
    const history = await customerManagementStorage.getCustomerBudgetHistory(id);
    res.json(history);
  } catch (error) {
    handleRouteError(res, error, "Budget-Historie konnte nicht geladen werden");
  }
});

router.post("/customers/:id/budgets", async (req: Request, res: Response) => {
  try {
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
  } catch (error: any) {
    if (error.name === "ZodError") {
      res.status(400).json({ error: "VALIDATION_ERROR", message: fromError(error).toString() });
      return;
    }
    handleRouteError(res, error, "Budget konnte nicht aktualisiert werden");
  }
});

export default router;
