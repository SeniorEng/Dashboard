import { Router, Request, Response } from "express";
import { authService } from "../../services/auth";
import { storage } from "../../storage";
import { usersCache, birthdaysCache } from "../../services/cache";
import { 
  insertUserSchema, 
  EMPLOYEE_ROLES,
  users,
  appointments,
  sessions,
  passwordResetTokens,
} from "@shared/schema";
import { asyncHandler } from "../../lib/errors";
import { auditService } from "../../services/audit";
import { db } from "../../lib/db";
import { eq, and, ne, or, isNull } from "drizzle-orm";
import { z } from "zod";

const router = Router();

router.get("/users", asyncHandler("Benutzer konnten nicht geladen werden", async (_req: Request, res: Response) => {
  // Check cache first
  const cached = usersCache.getAllUsers();
  if (cached) {
    return res.json(cached);
  }

  const users = await authService.getAllUsers();
  const safeUsers = users.map(({ passwordHash, ...user }) => user);
  
  // Store in cache
  usersCache.setAllUsers(safeUsers);
  
  res.json(safeUsers);
}));

router.get("/users/:id", asyncHandler("Benutzer konnte nicht geladen werden", async (req: Request, res: Response) => {
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
}));

router.post("/users", asyncHandler("Benutzer konnte nicht erstellt werden", async (req: Request, res: Response) => {
  const result = insertUserSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Ungültige Daten",
      details: result.error.issues,
    });
    return;
  }

  let user;
  try {
    user = await authService.createUser({
      email: result.data.email,
      password: result.data.password,
      vorname: result.data.vorname,
      nachname: result.data.nachname,
      telefon: result.data.telefon,
      strasse: result.data.strasse,
      hausnummer: result.data.hausnummer,
      plz: result.data.plz,
      stadt: result.data.stadt,
      geburtsdatum: result.data.geburtsdatum,
      eintrittsdatum: result.data.eintrittsdatum,
      vacationDaysPerYear: result.data.vacationDaysPerYear,
      isAdmin: result.data.isAdmin,
      haustierAkzeptiert: result.data.haustierAkzeptiert,
      roles: result.data.roles,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("existiert bereits")) {
      res.status(409).json({
        error: "CONFLICT",
        message: error.message,
      });
      return;
    }
    throw error;
  }

  // Invalidate caches after creating user (affects users list and birthdays)
  usersCache.invalidateAll();
  birthdaysCache.invalidateAll();

  const { passwordHash, ...safeUser } = user;
  res.status(201).json(safeUser);
}));

const updateUserSchema = z.object({
  email: z.string().email().optional(),
  vorname: z.string().min(1).optional(),
  nachname: z.string().min(1).optional(),
  telefon: z.string().optional(),
  strasse: z.string().optional(),
  hausnummer: z.string().optional(),
  plz: z.string().optional(),
  stadt: z.string().optional(),
  geburtsdatum: z.string().optional(),
  eintrittsdatum: z.string().optional(),
  austrittsDatum: z.string().nullable().optional(),
  vacationDaysPerYear: z.number().int().min(0).max(365).optional(),
  isActive: z.boolean().optional(),
  isAdmin: z.boolean().optional(),
  haustierAkzeptiert: z.boolean().optional(),
  lbnr: z.string().nullable().optional(),
  personalnummer: z.string().nullable().optional(),
  notfallkontaktName: z.string().optional(),
  notfallkontaktTelefon: z.string().optional(),
  notfallkontaktBeziehung: z.string().optional(),
  roles: z.array(z.enum(EMPLOYEE_ROLES)).optional(),
});

router.patch("/users/:id", asyncHandler("Benutzer konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
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

  let updatedUser;
  try {
    updatedUser = await authService.updateUser(id, userUpdates);
  } catch (error) {
    if (error instanceof Error && error.message.includes("bereits verwendet")) {
      res.status(409).json({
        error: "CONFLICT",
        message: error.message,
      });
      return;
    }
    throw error;
  }

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

  // Invalidate caches after updating user (affects users list and birthdays)
  usersCache.invalidateAll();
  birthdaysCache.invalidateAll();

  const finalUser = await authService.getUser(id);
  const { passwordHash, ...safeUser } = finalUser!;
  res.json(safeUser);
}));

router.post("/users/:id/reset-password", asyncHandler("Passwort konnte nicht zurückgesetzt werden", async (req: Request, res: Response) => {
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
}));

router.post("/users/:id/deactivate", asyncHandler("Benutzer konnte nicht deaktiviert werden", async (req: Request, res: Response) => {
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

  // Invalidate caches after deactivating user (affects users list and birthdays)
  usersCache.invalidateAll();
  birthdaysCache.invalidateAll();

  res.json({
    success: true,
    message: "Benutzer wurde deaktiviert",
  });
}));

router.post("/users/:id/activate", asyncHandler("Benutzer konnte nicht aktiviert werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Ungültige Benutzer-ID",
    });
    return;
  }

  let success: boolean;
  try {
    success = await authService.activateUser(id);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Anonymisierte")) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: error.message,
      });
      return;
    }
    throw error;
  }
  if (!success) {
    res.status(404).json({
      error: "NOT_FOUND",
      message: "Benutzer nicht gefunden",
    });
    return;
  }

  usersCache.invalidateAll();
  birthdaysCache.invalidateAll();

  res.json({
    success: true,
    message: "Benutzer wurde aktiviert",
  });
}));

router.delete("/users/:id", asyncHandler("Benutzer konnte nicht deaktiviert werden", async (req: Request, res: Response) => {
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

  usersCache.invalidateAll();
  birthdaysCache.invalidateAll();

  res.json({
    success: true,
    message: "Benutzer wurde deaktiviert",
  });
}));

router.post("/users/:id/anonymize", asyncHandler("Mitarbeiter konnte nicht anonymisiert werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Benutzer-ID" });
    return;
  }

  if (id === req.user!.id) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Sie können sich nicht selbst anonymisieren" });
    return;
  }

  const user = await authService.getUser(id);
  if (!user) {
    res.status(404).json({ error: "NOT_FOUND", message: "Benutzer nicht gefunden" });
    return;
  }

  if (user.isActive) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Nur inaktive Mitarbeiter können anonymisiert werden. Bitte deaktivieren Sie den Mitarbeiter zuerst." });
    return;
  }

  if (user.isAnonymized) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Mitarbeiter wurde bereits anonymisiert" });
    return;
  }

  const openAppointments = await db.select({ id: appointments.id })
    .from(appointments)
    .where(and(
      or(
        eq(appointments.assignedEmployeeId, id),
        eq(appointments.performedByEmployeeId, id)
      ),
      ne(appointments.status, "completed"),
      isNull(appointments.deletedAt)
    ));

  if (openAppointments.length > 0) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: `Anonymisierung nicht möglich: ${openAppointments.length} offene/nicht dokumentierte Termine vorhanden. Alle Termine müssen abgeschlossen sein.`,
    });
    return;
  }

  const now = new Date();
  const anonymizedLabel = `Ehem. Mitarbeiter #${id}`;
  const anonymizedEmail = `anonymized_${id}@deleted.local`;

  await db.update(users).set({
    displayName: anonymizedLabel,
    vorname: null,
    nachname: null,
    email: anonymizedEmail,
    telefon: null,
    strasse: null,
    hausnummer: null,
    plz: null,
    stadt: null,
    geburtsdatum: null,
    notfallkontaktName: null,
    notfallkontaktTelefon: null,
    notfallkontaktBeziehung: null,
    passwordHash: "anonymized",
    isAnonymized: true,
    anonymizedAt: now,
    updatedAt: now,
  }).where(eq(users.id, id));

  await db.delete(sessions).where(eq(sessions.userId, id));
  await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, id));

  await auditService.log(
    req.user!.id,
    "employee_anonymized",
    "user",
    id,
    {
      anonymizedBy: req.user!.id,
      originalDisplayName: user.displayName,
      reason: "DSGVO Art. 17 - Recht auf Löschung",
    },
    req.ip
  );

  usersCache.invalidateAll();
  birthdaysCache.invalidateAll();

  res.json({
    success: true,
    message: `Mitarbeiter "${user.displayName}" wurde DSGVO-konform anonymisiert`,
  });
}));

router.get("/employees", asyncHandler("Mitarbeiter konnten nicht geladen werden", async (_req: Request, res: Response) => {
  // Check cache first
  const cached = usersCache.getActiveEmployees();
  if (cached) {
    return res.json(cached);
  }

  const employees = await authService.getActiveEmployees();
  const safeEmployees = employees.map(({ passwordHash, ...employee }) => employee);
  
  // Store in cache
  usersCache.setActiveEmployees(safeEmployees);
  
  res.json(safeEmployees);
}));

export default router;
