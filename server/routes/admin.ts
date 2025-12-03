import { Router, Request, Response } from "express";
import { authService } from "../services/auth";
import { storage } from "../storage";
import { insertUserSchema, EMPLOYEE_ROLES, type EmployeeRole } from "@shared/schema";
import { requireAdmin } from "../middleware/auth";
import { handleRouteError } from "../lib/errors";
import { z } from "zod";

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

export default router;
