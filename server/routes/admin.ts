import { Router, Request, Response } from "express";
import { authService } from "../services/auth";
import { storage } from "../storage";
import { customerManagementStorage } from "../storage/customer-management";
import { 
  insertUserSchema, 
  EMPLOYEE_ROLES, 
  type EmployeeRole,
  createFullCustomerSchema,
  insertInsuranceProviderSchema,
  insertCustomerContactSchema,
  insertCareLevelHistorySchema,
  insertCustomerBudgetSchema,
} from "@shared/schema";
import { requireAdmin } from "../middleware/auth";
import { handleRouteError } from "../lib/errors";
import { z } from "zod";
import { fromError } from "zod-validation-error";

const router = Router();

router.use(requireAdmin);

router.get("/users", async (_req: Request, res: Response) => {
  try {
    const users = await authService.getAllUsers();
    const safeUsers = users.map(({ passwordHash, ...user }) => user);
    res.json(safeUsers);
  } catch (error) {
    handleRouteError(res, error, "Benutzer konnten nicht geladen werden");
  }
});

router.get("/users/:id", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Ungültige Benutzer-ID",
      });
      return;
    }

    const user = await authService.getUser(id);
    if (!user) {
      res.status(404).json({
        error: "NOT_FOUND",
        message: "Benutzer nicht gefunden",
      });
      return;
    }

    const { passwordHash, ...safeUser } = user;
    res.json(safeUser);
  } catch (error) {
    handleRouteError(res, error, "Benutzer konnte nicht geladen werden");
  }
});

router.post("/users", async (req: Request, res: Response) => {
  try {
    const result = insertUserSchema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Ungültige Daten",
        details: result.error.issues,
      });
      return;
    }

    const user = await authService.createUser({
      email: result.data.email,
      password: result.data.password,
      vorname: result.data.vorname,
      nachname: result.data.nachname,
      strasse: result.data.strasse,
      hausnummer: result.data.hausnummer,
      plz: result.data.plz,
      stadt: result.data.stadt,
      geburtsdatum: result.data.geburtsdatum,
      isAdmin: result.data.isAdmin,
      roles: result.data.roles,
    });

    const { passwordHash, ...safeUser } = user;
    res.status(201).json(safeUser);
  } catch (error) {
    if (error instanceof Error && error.message.includes("existiert bereits")) {
      res.status(409).json({
        error: "CONFLICT",
        message: error.message,
      });
      return;
    }
    handleRouteError(res, error, "Benutzer konnte nicht erstellt werden");
  }
});

const updateUserSchema = z.object({
  email: z.string().email().optional(),
  vorname: z.string().min(1).optional(),
  nachname: z.string().min(1).optional(),
  strasse: z.string().optional(),
  hausnummer: z.string().optional(),
  plz: z.string().optional(),
  stadt: z.string().optional(),
  geburtsdatum: z.string().optional(),
  isActive: z.boolean().optional(),
  isAdmin: z.boolean().optional(),
  roles: z.array(z.enum(EMPLOYEE_ROLES)).optional(),
});

router.patch("/users/:id", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Ungültige Benutzer-ID",
      });
      return;
    }

    if (id === req.user!.id && req.body.isActive === false) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Sie können sich nicht selbst deaktivieren",
      });
      return;
    }

    if (id === req.user!.id && req.body.isAdmin === false) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Sie können sich nicht selbst die Admin-Rechte entziehen",
      });
      return;
    }

    const result = updateUserSchema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Ungültige Daten",
        details: result.error.issues,
      });
      return;
    }

    const { roles, ...userUpdates } = result.data;

    const updatedUser = await authService.updateUser(id, userUpdates);
    if (!updatedUser) {
      res.status(404).json({
        error: "NOT_FOUND",
        message: "Benutzer nicht gefunden",
      });
      return;
    }

    if (roles !== undefined) {
      await authService.setUserRoles(id, roles);
    }

    const finalUser = await authService.getUser(id);
    const { passwordHash, ...safeUser } = finalUser!;
    res.json(safeUser);
  } catch (error) {
    if (error instanceof Error && error.message.includes("bereits verwendet")) {
      res.status(409).json({
        error: "CONFLICT",
        message: error.message,
      });
      return;
    }
    handleRouteError(res, error, "Benutzer konnte nicht aktualisiert werden");
  }
});

router.post("/users/:id/reset-password", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Ungültige Benutzer-ID",
      });
      return;
    }

    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Passwort muss mindestens 8 Zeichen haben",
      });
      return;
    }

    const success = await authService.changePassword(id, newPassword);
    if (!success) {
      res.status(404).json({
        error: "NOT_FOUND",
        message: "Benutzer nicht gefunden",
      });
      return;
    }

    res.json({
      success: true,
      message: "Passwort wurde zurückgesetzt",
    });
  } catch (error) {
    handleRouteError(res, error, "Passwort konnte nicht zurückgesetzt werden");
  }
});

router.post("/users/:id/deactivate", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Ungültige Benutzer-ID",
      });
      return;
    }

    if (id === req.user!.id) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Sie können sich nicht selbst deaktivieren",
      });
      return;
    }

    const success = await authService.deactivateUser(id);
    if (!success) {
      res.status(404).json({
        error: "NOT_FOUND",
        message: "Benutzer nicht gefunden",
      });
      return;
    }

    res.json({
      success: true,
      message: "Benutzer wurde deaktiviert",
    });
  } catch (error) {
    handleRouteError(res, error, "Benutzer konnte nicht deaktiviert werden");
  }
});

router.post("/users/:id/activate", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Ungültige Benutzer-ID",
      });
      return;
    }

    const success = await authService.activateUser(id);
    if (!success) {
      res.status(404).json({
        error: "NOT_FOUND",
        message: "Benutzer nicht gefunden",
      });
      return;
    }

    res.json({
      success: true,
      message: "Benutzer wurde aktiviert",
    });
  } catch (error) {
    handleRouteError(res, error, "Benutzer konnte nicht aktiviert werden");
  }
});

router.delete("/users/:id", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Ungültige Benutzer-ID",
      });
      return;
    }

    if (id === req.user!.id) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Sie können sich nicht selbst löschen",
      });
      return;
    }

    const success = await authService.deleteUser(id);
    if (!success) {
      res.status(404).json({
        error: "NOT_FOUND",
        message: "Benutzer nicht gefunden",
      });
      return;
    }

    res.json({
      success: true,
      message: "Benutzer wurde gelöscht",
    });
  } catch (error) {
    handleRouteError(res, error, "Benutzer konnte nicht gelöscht werden");
  }
});

router.get("/employees", async (_req: Request, res: Response) => {
  try {
    const employees = await authService.getActiveEmployees();
    const safeEmployees = employees.map(({ passwordHash, ...employee }) => employee);
    res.json(safeEmployees);
  } catch (error) {
    handleRouteError(res, error, "Mitarbeiter konnten nicht geladen werden");
  }
});

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

    const updatedCustomer = await updateCustomerAssignment(id, primaryEmployeeId, backupEmployeeId);
    res.json(updatedCustomer);
  } catch (error) {
    handleRouteError(res, error, "Zuordnung konnte nicht aktualisiert werden");
  }
});

async function updateCustomerAssignment(
  customerId: number,
  primaryEmployeeId: number | null,
  backupEmployeeId: number | null
) {
  const { neon } = await import("@neondatabase/serverless");
  const { drizzle } = await import("drizzle-orm/neon-http");
  const { eq } = await import("drizzle-orm");
  const { customers } = await import("@shared/schema");

  const sql = neon(process.env.DATABASE_URL!);
  const db = drizzle(sql);

  const [updated] = await db
    .update(customers)
    .set({ primaryEmployeeId, backupEmployeeId })
    .where(eq(customers.id, customerId))
    .returning();

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
    
    res.json(customer);
  } catch (error) {
    handleRouteError(res, error, "Kunde konnte nicht geladen werden");
  }
});

router.post("/customers", async (req: Request, res: Response) => {
  try {
    const validatedData = createFullCustomerSchema.parse(req.body);
    const customer = await customerManagementStorage.createFullCustomer(validatedData, req.user!.id);
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
    
    const data = { ...req.body, customerId };
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

// Insurance Providers (Lookup table)
router.get("/insurance-providers", async (_req: Request, res: Response) => {
  try {
    const providers = await customerManagementStorage.getInsuranceProviders();
    res.json(providers);
  } catch (error) {
    handleRouteError(res, error, "Pflegekassen konnten nicht geladen werden");
  }
});

router.post("/insurance-providers", async (req: Request, res: Response) => {
  try {
    const validatedData = insertInsuranceProviderSchema.parse(req.body);
    
    const existing = await customerManagementStorage.getInsuranceProviderByIK(validatedData.ikNummer);
    if (existing) {
      res.status(409).json({ error: "CONFLICT", message: "Eine Pflegekasse mit dieser IK-Nummer existiert bereits" });
      return;
    }
    
    const provider = await customerManagementStorage.createInsuranceProvider(validatedData);
    res.status(201).json(provider);
  } catch (error: any) {
    if (error.name === "ZodError") {
      res.status(400).json({ error: "VALIDATION_ERROR", message: fromError(error).toString() });
      return;
    }
    handleRouteError(res, error, "Pflegekasse konnte nicht erstellt werden");
  }
});

export default router;
