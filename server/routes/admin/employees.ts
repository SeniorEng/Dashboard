import { Router, Request, Response } from "express";
import { randomBytes } from "crypto";
import { authService } from "../../services/auth";
import { storage } from "../../storage";
import { usersCache, birthdaysCache } from "../../services/cache";
import { 
  insertUserSchema, 
  EMPLOYEE_ROLES,
  EMPLOYMENT_TYPES,
  EMPLOYMENT_STATUSES,
  users,
  userRoles,
  appointments,
  sessions,
  passwordResetTokens,
  customers,
  employeeTimeEntries,
} from "@shared/schema";
import { asyncHandler } from "../../lib/errors";
import { auditService } from "../../services/audit";
import { db } from "../../lib/db";
import { eq, and, ne, or, isNull, inArray, gte, lte, sql, asc } from "drizzle-orm";
import { z } from "zod";
import { sendEmail, buildWelcomeEmailHtml } from "../../services/email-service";

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
  const bodyWithPassword = {
    ...req.body,
    password: req.body.password || randomBytes(24).toString("hex"),
  };

  const result = insertUserSchema.safeParse(bodyWithPassword);
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
      isEuRentner: result.data.isEuRentner,
      employmentType: result.data.employmentType,
      weeklyWorkDays: result.data.weeklyWorkDays,
      monthlyWorkHours: result.data.monthlyWorkHours,
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

  usersCache.invalidateAll();
  birthdaysCache.invalidateAll();

  try {
    const companySettings = await storage.getCompanySettings();
    if (companySettings.smtpHost && companySettings.smtpUser) {
      console.log(`[email] Sende Willkommens-E-Mail an ${result.data.email}...`);
      const welcomeToken = await authService.createWelcomeToken(user.id);
      const baseUrl = `${req.protocol}://${req.get("host")}`;
      const resetUrl = `${baseUrl}/reset-password?token=${welcomeToken}`;

      const html = buildWelcomeEmailHtml({
        vorname: result.data.vorname,
        nachname: result.data.nachname,
        email: result.data.email,
        companyName: companySettings.companyName || "SeniorenEngel",
        resetUrl,
        logoUrl: companySettings.logoUrl,
      });

      const emailResult = await sendEmail(companySettings, {
        to: result.data.email,
        subject: `Willkommen bei ${companySettings.companyName || "SeniorenEngel"} – Ihr Zugang`,
        html,
      });
      console.log(`[email] Willkommens-E-Mail erfolgreich gesendet: ${emailResult.messageId}`);
    } else {
      console.log("[email] SMTP nicht konfiguriert, keine Willkommens-E-Mail gesendet");
    }
  } catch (emailError: any) {
    console.error("[email] Willkommens-E-Mail fehlgeschlagen:", emailError?.message || emailError);
    console.error("[email] Stack:", emailError?.stack);
  }

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
  isEuRentner: z.boolean().optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  employmentStatus: z.enum(EMPLOYMENT_STATUSES).optional(),
  weeklyWorkDays: z.number().int().min(1).max(7).optional(),
  monthlyWorkHours: z.number().min(1).max(300).nullable().optional(),
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

  const success = await authService.adminResetPassword(id, newPassword);
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

router.post("/users/:id/resend-welcome", asyncHandler("Willkommens-E-Mail konnte nicht erneut gesendet werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Benutzer-ID" });
    return;
  }

  const user = await authService.getUser(id);
  if (!user) {
    res.status(404).json({ error: "NOT_FOUND", message: "Benutzer nicht gefunden" });
    return;
  }

  const companySettings = await storage.getCompanySettings();
  if (!companySettings.smtpHost || !companySettings.smtpUser) {
    res.status(400).json({ error: "SMTP_NOT_CONFIGURED", message: "E-Mail-Versand ist nicht konfiguriert" });
    return;
  }

  const welcomeToken = await authService.createWelcomeToken(user.id);
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const resetUrl = `${baseUrl}/reset-password?token=${welcomeToken}`;

  const html = buildWelcomeEmailHtml({
    vorname: user.vorname || "",
    nachname: user.nachname || "",
    email: user.email,
    companyName: companySettings.companyName || "SeniorenEngel",
    resetUrl,
    logoUrl: companySettings.logoUrl,
  });

  const emailResult = await sendEmail(companySettings, {
    to: user.email,
    subject: `Willkommen bei ${companySettings.companyName || "SeniorenEngel"} – Ihr Zugang`,
    html,
  });

  console.log(`[email] Willkommens-E-Mail erneut gesendet an ${user.email}: ${emailResult.messageId}`);

  res.json({ success: true, message: "Willkommens-E-Mail wurde erneut gesendet" });
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

router.get("/employees/availability", asyncHandler("Verfügbarkeiten konnten nicht geladen werden", async (req: Request, res: Response) => {
  const { date } = req.query;
  if (!date || typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "Gültiges Datum im Format YYYY-MM-DD erforderlich" });
  }

  const erstberatungEmployeeIds = await db
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .where(eq(userRoles.role, "erstberatung"));

  const employeeIds = erstberatungEmployeeIds.map(e => e.userId);
  if (employeeIds.length === 0) {
    return res.json([]);
  }

  const [employeeData, availabilityEntries, absenceEntries, dayAppointments] = await Promise.all([
    db.select({
      id: users.id,
      displayName: users.displayName,
      vorname: users.vorname,
      nachname: users.nachname,
    })
    .from(users)
    .where(and(
      inArray(users.id, employeeIds),
      eq(users.isActive, true)
    )),

    db.select({
      userId: employeeTimeEntries.userId,
      startTime: employeeTimeEntries.startTime,
      endTime: employeeTimeEntries.endTime,
    })
    .from(employeeTimeEntries)
    .where(and(
      inArray(employeeTimeEntries.userId, employeeIds),
      eq(employeeTimeEntries.entryDate, date),
      eq(employeeTimeEntries.entryType, "verfuegbar"),
      isNull(employeeTimeEntries.deletedAt)
    ))
    .orderBy(asc(employeeTimeEntries.startTime)),

    db.select({
      userId: employeeTimeEntries.userId,
      entryType: employeeTimeEntries.entryType,
    })
    .from(employeeTimeEntries)
    .where(and(
      inArray(employeeTimeEntries.userId, employeeIds),
      eq(employeeTimeEntries.entryDate, date),
      inArray(employeeTimeEntries.entryType, ["urlaub", "krankheit"]),
      isNull(employeeTimeEntries.deletedAt)
    )),

    db.select({
      assignedEmployeeId: appointments.assignedEmployeeId,
      scheduledStart: appointments.scheduledStart,
      scheduledEnd: appointments.scheduledEnd,
      durationPromised: appointments.durationPromised,
      customerName: sql`COALESCE(${customers.vorname} || ' ' || ${customers.nachname}, ${customers.name})`.as("customer_name"),
    })
    .from(appointments)
    .innerJoin(customers, eq(appointments.customerId, customers.id))
    .where(and(
      inArray(appointments.assignedEmployeeId, employeeIds),
      eq(appointments.date, date),
      isNull(appointments.deletedAt),
      sql`${appointments.status} != 'cancelled'`
    ))
    .orderBy(asc(appointments.scheduledStart)),
  ]);

  const result = employeeData.map(emp => {
    const availability = availabilityEntries
      .filter(a => a.userId === emp.id)
      .map(a => ({
        startTime: a.startTime?.slice(0, 5) || null,
        endTime: a.endTime?.slice(0, 5) || null,
      }));

    const existingAppointments = dayAppointments
      .filter(a => a.assignedEmployeeId === emp.id)
      .map(a => ({
        scheduledStart: a.scheduledStart?.slice(0, 5) || null,
        scheduledEnd: a.scheduledEnd?.slice(0, 5) || null,
        durationMinutes: a.durationPromised,
        customerName: String(a.customerName),
      }));

    const absence = absenceEntries.find(a => a.userId === emp.id);

    return {
      id: emp.id,
      displayName: emp.displayName || `${emp.vorname || ""} ${emp.nachname || ""}`.trim(),
      availability,
      appointments: existingAppointments,
      absence: absence ? absence.entryType as "urlaub" | "krankheit" : null,
    };
  });

  result.sort((a, b) => {
    if (a.absence && !b.absence) return 1;
    if (!a.absence && b.absence) return -1;
    if (a.availability.length > 0 && b.availability.length === 0) return -1;
    if (a.availability.length === 0 && b.availability.length > 0) return 1;
    return a.displayName.localeCompare(b.displayName);
  });

  res.json(result);
}));

export default router;
