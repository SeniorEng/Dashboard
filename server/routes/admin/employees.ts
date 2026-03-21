import { Router, Request, Response } from "express";
import { randomBytes } from "crypto";
import { authService } from "../../services/auth";
import { storage } from "../../storage";
import { usersCache, birthdaysCache, customerIdsCache } from "../../services/cache";
import { log } from "../../lib/log";
import { sanitizeUser } from "../../utils/sanitize-user";
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
  customerAssignmentHistory,
} from "@shared/schema";
import { validateGeburtsdatum, timeToMinutes, addDays as addDaysShared, minutesToTimeDisplay } from "@shared/utils/datetime";
import { asyncHandler } from "../../lib/errors";
import { requireIntParam } from "../../lib/params";
import { auditService } from "../../services/audit";
import { geocodeEmployee } from "../../services/geocoding";
import { db } from "../../lib/db";
import { eq, and, ne, or, isNull, inArray, sql, asc } from "drizzle-orm";
import { z } from "zod";
import { sendEmail, buildWelcomeEmailHtml } from "../../services/email-service";
import { resolveLogoToDataUrl } from "../../services/logo-resolver";

const router = Router();

router.get("/users", asyncHandler("Benutzer konnten nicht geladen werden", async (_req: Request, res: Response) => {
  // Check cache first
  const cached = usersCache.getAllUsers();
  if (cached) {
    return res.json(cached);
  }

  const users = await authService.getAllUsers();
  const safeUsers = users.map(sanitizeUser);
  
  // Store in cache
  usersCache.setAllUsers(safeUsers);
  
  res.json(safeUsers);
}));

router.get("/users/:id", asyncHandler("Benutzer konnte nicht geladen werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const user = await authService.getUser(id);
  if (!user) {
    res.status(404).json({
      error: "NOT_FOUND",
      message: "Benutzer nicht gefunden",
    });
    return;
  }

  const { getUserWhatsAppPreferences } = await import("../../storage/whatsapp");
  const whatsappPrefs = await getUserWhatsAppPreferences(id);
  res.json({ ...sanitizeUser(user), whatsappEnabled: whatsappPrefs?.enabled ?? false });
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

  if (result.data.isAdmin && !req.user!.isSuperAdmin) {
    res.status(403).json({
      error: "FORBIDDEN",
      message: "Nur der Hauptadministrator kann Administratoren anlegen",
    });
    return;
  }

  const geburtsdatumError = validateGeburtsdatum(result.data.geburtsdatum);
  if (geburtsdatumError) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: geburtsdatumError });
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
      log(`Sende Willkommens-E-Mail an ${result.data.email}...`, "email");
      const welcomeToken = await authService.createWelcomeToken(user.id);
      const baseUrl = `${req.protocol}://${req.get("host")}`;
      const resetUrl = `${baseUrl}/reset-password?token=${welcomeToken}`;

      const resolvedLogo = await resolveLogoToDataUrl(companySettings.logoUrl);
      const html = buildWelcomeEmailHtml({
        vorname: result.data.vorname,
        nachname: result.data.nachname,
        email: result.data.email,
        companyName: companySettings.companyName || "SeniorenEngel",
        resetUrl,
        logoUrl: resolvedLogo,
      });

      const emailResult = await sendEmail(companySettings, {
        to: result.data.email,
        subject: `Willkommen bei ${companySettings.companyName || "SeniorenEngel"} – Ihr Zugang`,
        html,
      });
      log(`Willkommens-E-Mail erfolgreich gesendet: ${emailResult.messageId}`, "email");
    } else {
      log("SMTP nicht konfiguriert, keine Willkommens-E-Mail gesendet", "email");
    }
  } catch (emailError: unknown) {
    const emailErrMsg = emailError instanceof Error ? emailError.message : String(emailError);
    const emailErrStack = emailError instanceof Error ? emailError.stack : undefined;
    console.error("[email] Willkommens-E-Mail fehlgeschlagen:", emailErrMsg);
    console.error("[email] Stack:", emailErrStack);
  }

  res.status(201).json(sanitizeUser(user));
}));

const updateUserSchema = z.object({
  email: z.string().email("Ungültige E-Mail-Adresse").optional(),
  vorname: z.string().min(1, "Vorname ist erforderlich").optional(),
  nachname: z.string().min(1, "Nachname ist erforderlich").optional(),
  telefon: z.string().optional(),
  strasse: z.string().optional(),
  hausnummer: z.string().optional(),
  plz: z.string().optional(),
  stadt: z.string().optional(),
  geburtsdatum: z.string().optional(),
  eintrittsdatum: z.string().optional(),
  austrittsDatum: z.string().nullable().optional(),
  vacationDaysPerYear: z.number().int().min(0, "Muss mindestens 0 sein").max(365, "Maximal 365 Tage").optional(),
  isActive: z.boolean().optional(),
  isAdmin: z.boolean().optional(),
  haustierAkzeptiert: z.boolean().optional(),
  isEuRentner: z.boolean().optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  employmentStatus: z.enum(EMPLOYMENT_STATUSES).optional(),
  weeklyWorkDays: z.number().int().min(1, "Muss mindestens 1 Tag sein").max(7, "Maximal 7 Tage").optional(),
  monthlyWorkHours: z.number().min(1, "Muss mindestens 1 Stunde sein").max(300, "Maximal 300 Stunden").nullable().optional(),
  lbnr: z.string().nullable().optional(),
  personalnummer: z.string().nullable().optional(),
  notfallkontaktName: z.string().optional(),
  notfallkontaktTelefon: z.string().optional(),
  notfallkontaktBeziehung: z.string().optional(),
  roles: z.array(z.enum(EMPLOYEE_ROLES)).optional(),
});

router.patch("/users/:id", asyncHandler("Benutzer konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

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

  if (req.body.isAdmin !== undefined && !req.user!.isSuperAdmin) {
    const currentUser = await authService.getUser(id);
    if (currentUser && currentUser.isAdmin !== req.body.isAdmin) {
      res.status(403).json({
        error: "FORBIDDEN",
        message: "Nur der Hauptadministrator kann Admin-Rechte vergeben oder entziehen",
      });
      return;
    }
  }

  const { whatsappEnabled, ...bodyWithoutWhatsapp } = req.body;

  const result = updateUserSchema.safeParse(bodyWithoutWhatsapp);
  if (!result.success) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Ungültige Daten",
      details: result.error.issues,
    });
    return;
  }

  if (result.data.geburtsdatum !== undefined) {
    const geburtsdatumError = validateGeburtsdatum(result.data.geburtsdatum);
    if (geburtsdatumError) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: geburtsdatumError });
      return;
    }
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

  if (typeof whatsappEnabled === "boolean") {
    const { upsertUserWhatsAppPreferences } = await import("../../storage/whatsapp");
    await upsertUserWhatsAppPreferences(id, { enabled: whatsappEnabled });
  }

  const addressFields = ["strasse", "hausnummer", "plz", "stadt"] as const;
  const addressChanged = addressFields.some(f => (f in userUpdates));
  if (addressChanged) {
    geocodeEmployee(id).catch(err => console.error("[geocoding] Background employee geocoding failed:", err));
  }

  usersCache.invalidateAll();
  birthdaysCache.invalidateAll();

  const finalUser = await authService.getUser(id);
  res.json(sanitizeUser(finalUser!));
}));

router.post("/users/:id/reset-password", asyncHandler("Passwort konnte nicht zurückgesetzt werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Passwort muss mindestens 8 Zeichen haben",
    });
    return;
  }
  if (!/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Passwort muss mindestens einen Großbuchstaben, einen Kleinbuchstaben und eine Ziffer enthalten",
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
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

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

  const resolvedLogo = await resolveLogoToDataUrl(companySettings.logoUrl);
  const html = buildWelcomeEmailHtml({
    vorname: user.vorname || "",
    nachname: user.nachname || "",
    email: user.email,
    companyName: companySettings.companyName || "SeniorenEngel",
    resetUrl,
    logoUrl: resolvedLogo,
  });

  const emailResult = await sendEmail(companySettings, {
    to: user.email,
    subject: `Willkommen bei ${companySettings.companyName || "SeniorenEngel"} – Ihr Zugang`,
    html,
  });

  log(`Willkommens-E-Mail erneut gesendet an ${user.email}: ${emailResult.messageId}`, "email");

  res.json({ success: true, message: "Willkommens-E-Mail wurde erneut gesendet" });
}));

router.post("/users/:id/deactivate", asyncHandler("Benutzer konnte nicht deaktiviert werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

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
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

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
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

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
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

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

  await db.transaction(async (tx) => {
    await tx.update(users).set({
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

    await tx.delete(sessions).where(eq(sessions.userId, id));
    await tx.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, id));
  });

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
  const safeEmployees = employees.map(sanitizeUser);
  
  // Store in cache
  usersCache.setActiveEmployees(safeEmployees);
  
  res.json(safeEmployees);
}));

function computeFreeSlots(
  availability: { startTime: string | null; endTime: string | null }[],
  blockedSlots: { start: number; end: number }[]
): { start: string; end: string }[] {
  if (availability.length === 0) return [];
  
  const freeSlots: { start: string; end: string }[] = [];
  
  for (const slot of availability) {
    if (!slot.startTime || !slot.endTime) continue;
    const slotStart = timeToMinutes(slot.startTime);
    const slotEnd = timeToMinutes(slot.endTime);
    
    const relevantBlocks = blockedSlots
      .filter(b => b.start < slotEnd && b.end > slotStart)
      .sort((a, b) => a.start - b.start);
    
    let cursor = slotStart;
    for (const block of relevantBlocks) {
      if (block.start > cursor) {
        freeSlots.push({ start: minutesToHHMM(cursor), end: minutesToHHMM(block.start) });
      }
      cursor = Math.max(cursor, block.end);
    }
    if (cursor < slotEnd) {
      freeSlots.push({ start: minutesToHHMM(cursor), end: minutesToHHMM(slotEnd) });
    }
  }
  
  return freeSlots;
}

function minutesToHHMM(mins: number): string {
  return minutesToTimeDisplay(((mins % 1440) + 1440) % 1440);
}

function addDaysISO(dateStr: string, days: number): string {
  return addDaysShared(dateStr, days);
}

function isValidCalendarDate(dateStr: string): boolean {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

router.get("/employees/weekly-availability", asyncHandler("Wochen-Verfügbarkeit konnte nicht geladen werden", async (req: Request, res: Response) => {
  const { startDate, days: daysParam, allEmployees: allEmployeesParam } = req.query;
  if (!startDate || typeof startDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !isValidCalendarDate(startDate)) {
    return res.status(400).json({ error: "Gültiges startDate im Format YYYY-MM-DD erforderlich" });
  }
  const days = Math.min(Math.max(parseInt(daysParam as string) || 5, 1), 7);
  const showAllEmployees = allEmployeesParam === "true";

  const dates: string[] = [];
  for (let i = 0; i < days; i++) {
    dates.push(addDaysISO(startDate, i));
  }

  let employeeIds: number[];
  if (showAllEmployees) {
    const activeEmployees = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isActive, true));
    employeeIds = activeEmployees.map(e => e.id);
  } else {
    const erstberatungEmployeeIds = await db
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .where(eq(userRoles.role, "erstberatung"));
    employeeIds = erstberatungEmployeeIds.map(e => e.userId);
  }

  if (employeeIds.length === 0) {
    return res.json({ dates, employees: [] });
  }

  const [employeeData, availabilityEntries, absenceEntries, rangeAppointments, timeEntries] = await Promise.all([
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
    ))
    .orderBy(asc(users.displayName)),

    db.select({
      userId: employeeTimeEntries.userId,
      entryDate: employeeTimeEntries.entryDate,
      startTime: employeeTimeEntries.startTime,
      endTime: employeeTimeEntries.endTime,
    })
    .from(employeeTimeEntries)
    .where(and(
      inArray(employeeTimeEntries.userId, employeeIds),
      inArray(employeeTimeEntries.entryDate, dates),
      eq(employeeTimeEntries.entryType, "verfuegbar"),
      isNull(employeeTimeEntries.deletedAt)
    ))
    .orderBy(asc(employeeTimeEntries.startTime)),

    db.select({
      userId: employeeTimeEntries.userId,
      entryDate: employeeTimeEntries.entryDate,
      entryType: employeeTimeEntries.entryType,
    })
    .from(employeeTimeEntries)
    .where(and(
      inArray(employeeTimeEntries.userId, employeeIds),
      inArray(employeeTimeEntries.entryDate, dates),
      inArray(employeeTimeEntries.entryType, ["urlaub", "krankheit"]),
      isNull(employeeTimeEntries.deletedAt)
    )),

    db.select({
      assignedEmployeeId: appointments.assignedEmployeeId,
      date: appointments.date,
      scheduledStart: appointments.scheduledStart,
      scheduledEnd: appointments.scheduledEnd,
      durationPromised: appointments.durationPromised,
      customerName: sql`COALESCE(${customers.vorname} || ' ' || ${customers.nachname}, ${customers.name})`.as("customer_name"),
      status: appointments.status,
    })
    .from(appointments)
    .innerJoin(customers, eq(appointments.customerId, customers.id))
    .where(and(
      inArray(appointments.assignedEmployeeId, employeeIds),
      inArray(appointments.date, dates),
      isNull(appointments.deletedAt),
      sql`${appointments.status} != 'cancelled'`
    ))
    .orderBy(asc(appointments.scheduledStart)),

    db.select({
      userId: employeeTimeEntries.userId,
      entryDate: employeeTimeEntries.entryDate,
      startTime: employeeTimeEntries.startTime,
      endTime: employeeTimeEntries.endTime,
      entryType: employeeTimeEntries.entryType,
    })
    .from(employeeTimeEntries)
    .where(and(
      inArray(employeeTimeEntries.userId, employeeIds),
      inArray(employeeTimeEntries.entryDate, dates),
      inArray(employeeTimeEntries.entryType, ["arbeitszeit", "pause", "fahrt"]),
      isNull(employeeTimeEntries.deletedAt)
    )),
  ]);

  const result = employeeData.map(emp => {
    const empName = emp.displayName || `${emp.vorname || ""} ${emp.nachname || ""}`.trim();
    
    const daysData: Record<string, {
      availability: { startTime: string | null; endTime: string | null }[];
      appointments: { scheduledStart: string | null; scheduledEnd: string | null; durationMinutes: number; customerName: string; status: string }[];
      absence: "urlaub" | "krankheit" | null;
      freeSlots: { start: string; end: string }[];
    }> = {};

    for (const date of dates) {
      const dayAvail = availabilityEntries
        .filter(a => a.userId === emp.id && a.entryDate === date)
        .map(a => ({
          startTime: a.startTime?.slice(0, 5) || null,
          endTime: a.endTime?.slice(0, 5) || null,
        }));

      const dayAppointments = rangeAppointments
        .filter(a => a.assignedEmployeeId === emp.id && a.date === date)
        .map(a => {
          const start = a.scheduledStart?.slice(0, 5) || null;
          let end = a.scheduledEnd?.slice(0, 5) || null;
          if (!end && start && a.durationPromised) {
            end = minutesToHHMM(timeToMinutes(start) + a.durationPromised);
          }
          return {
            scheduledStart: start,
            scheduledEnd: end,
            durationMinutes: a.durationPromised,
            customerName: String(a.customerName),
            status: a.status as string,
          };
        });

      const dayTimeEntries = timeEntries
        .filter(t => t.userId === emp.id && t.entryDate === date && t.startTime && t.endTime);

      const absence = absenceEntries.find(a => a.userId === emp.id && a.entryDate === date);

      const blockedSlots: { start: number; end: number }[] = [];
      for (const appt of dayAppointments) {
        if (appt.scheduledStart) {
          const s = timeToMinutes(appt.scheduledStart);
          const e = appt.scheduledEnd ? timeToMinutes(appt.scheduledEnd) : s + (appt.durationMinutes || 60);
          blockedSlots.push({ start: s, end: e });
        }
      }
      for (const te of dayTimeEntries) {
        if (te.startTime && te.endTime) {
          blockedSlots.push({
            start: timeToMinutes(te.startTime.slice(0, 5)),
            end: timeToMinutes(te.endTime.slice(0, 5)),
          });
        }
      }

      const freeSlots = absence ? [] : computeFreeSlots(dayAvail, blockedSlots);

      daysData[date] = {
        availability: dayAvail,
        appointments: dayAppointments,
        absence: absence ? absence.entryType as "urlaub" | "krankheit" : null,
        freeSlots,
      };
    }

    return {
      id: emp.id,
      displayName: empName,
      days: daysData,
    };
  });

  res.json({ dates, employees: result });
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

const handoverSchema = z.object({
  targetEmployeeId: z.number().int().positive(),
});

router.get("/employees/:id/handover-preview", asyncHandler("Übergabe-Vorschau konnte nicht geladen werden", async (req: Request, res: Response) => {
  const sourceId = requireIntParam(req.params.id, res);
  if (sourceId === null) return;
  const targetId = parseInt(req.query.targetEmployeeId as string);
  if (!targetId || isNaN(targetId)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "targetEmployeeId ist erforderlich" });
    return;
  }

  const sourceEmployee = await authService.getUser(sourceId);
  if (!sourceEmployee) {
    res.status(404).json({ error: "NOT_FOUND", message: "Quell-Mitarbeiter nicht gefunden" });
    return;
  }
  const targetEmployee = await authService.getUser(targetId);
  if (!targetEmployee || !targetEmployee.isActive) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ziel-Mitarbeiter nicht gefunden oder nicht aktiv" });
    return;
  }

  const today = new Date().toISOString().split("T")[0];

  const [primaryCustomers, backupCustomers, backup2Customers, futureAppointments] = await Promise.all([
    db.select({ id: customers.id, name: customers.name, vorname: customers.vorname, nachname: customers.nachname })
      .from(customers)
      .where(and(eq(customers.primaryEmployeeId, sourceId), isNull(customers.deletedAt))),
    db.select({ id: customers.id, name: customers.name, vorname: customers.vorname, nachname: customers.nachname })
      .from(customers)
      .where(and(eq(customers.backupEmployeeId, sourceId), isNull(customers.deletedAt))),
    db.select({ id: customers.id, name: customers.name, vorname: customers.vorname, nachname: customers.nachname })
      .from(customers)
      .where(and(eq(customers.backupEmployeeId2, sourceId), isNull(customers.deletedAt))),
    db.execute(sql`
      SELECT a.id, a.date, a.scheduled_start AS "startTime", a.scheduled_end AS "endTime",
             c.name AS "customerName", c.vorname AS "customerVorname", c.nachname AS "customerNachname"
      FROM appointments a
      JOIN customers c ON c.id = a.customer_id
      WHERE a.assigned_employee_id = ${sourceId}
        AND a.deleted_at IS NULL
        AND a.status IN ('scheduled', 'in_progress', 'documenting')
        AND a.date >= ${today}
      ORDER BY a.date, a.scheduled_start
    `),
  ]);

  res.json({
    sourceEmployee: { id: sourceId, displayName: sourceEmployee.displayName },
    targetEmployee: { id: targetId, displayName: targetEmployee.displayName },
    primaryCustomers,
    backupCustomers,
    backup2Customers,
    futureAppointments: futureAppointments.rows,
    summary: {
      primaryCount: primaryCustomers.length,
      backupCount: backupCustomers.length,
      backup2Count: backup2Customers.length,
      appointmentCount: futureAppointments.rows.length,
    },
  });
}));

router.post("/employees/:id/handover", asyncHandler("Übergabe konnte nicht durchgeführt werden", async (req: Request, res: Response) => {
  const sourceId = requireIntParam(req.params.id, res);
  if (sourceId === null) return;

  const result = handoverSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "targetEmployeeId ist erforderlich" });
    return;
  }
  const { targetEmployeeId } = result.data;

  if (sourceId === targetEmployeeId) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Quell- und Ziel-Mitarbeiter dürfen nicht identisch sein" });
    return;
  }

  const sourceEmployee = await authService.getUser(sourceId);
  if (!sourceEmployee) {
    res.status(404).json({ error: "NOT_FOUND", message: "Quell-Mitarbeiter nicht gefunden" });
    return;
  }
  const targetEmployee = await authService.getUser(targetEmployeeId);
  if (!targetEmployee || !targetEmployee.isActive) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ziel-Mitarbeiter nicht gefunden oder nicht aktiv" });
    return;
  }

  const today = new Date().toISOString().split("T")[0];
  const changedByUserId = req.user?.id ?? null;

  const counts = await db.transaction(async (tx) => {
    const affectedPrimary = await tx.select({ id: customers.id, primaryEmployeeId: customers.primaryEmployeeId, backupEmployeeId: customers.backupEmployeeId, backupEmployeeId2: customers.backupEmployeeId2 })
      .from(customers)
      .where(and(eq(customers.primaryEmployeeId, sourceId), isNull(customers.deletedAt)));

    for (const cust of affectedPrimary) {
      await tx.update(customerAssignmentHistory)
        .set({ validTo: today })
        .where(and(
          eq(customerAssignmentHistory.customerId, cust.id),
          eq(customerAssignmentHistory.employeeId, sourceId),
          eq(customerAssignmentHistory.role, "primary"),
          isNull(customerAssignmentHistory.validTo)
        ));
      await tx.insert(customerAssignmentHistory).values({
        customerId: cust.id,
        employeeId: targetEmployeeId,
        role: "primary",
        validFrom: today,
        changedByUserId,
      });
      const updateData: Record<string, number | null> = { primaryEmployeeId: targetEmployeeId };
      if (cust.backupEmployeeId === targetEmployeeId) {
        await tx.update(customerAssignmentHistory)
          .set({ validTo: today })
          .where(and(
            eq(customerAssignmentHistory.customerId, cust.id),
            eq(customerAssignmentHistory.employeeId, targetEmployeeId),
            eq(customerAssignmentHistory.role, "backup"),
            isNull(customerAssignmentHistory.validTo)
          ));
        updateData.backupEmployeeId = null;
      }
      if (cust.backupEmployeeId2 === targetEmployeeId) {
        await tx.update(customerAssignmentHistory)
          .set({ validTo: today })
          .where(and(
            eq(customerAssignmentHistory.customerId, cust.id),
            eq(customerAssignmentHistory.employeeId, targetEmployeeId),
            eq(customerAssignmentHistory.role, "backup2"),
            isNull(customerAssignmentHistory.validTo)
          ));
        updateData.backupEmployeeId2 = null;
      }
      await tx.update(customers).set(updateData).where(eq(customers.id, cust.id));
    }

    const affectedBackup = await tx.select({ id: customers.id, primaryEmployeeId: customers.primaryEmployeeId, backupEmployeeId2: customers.backupEmployeeId2 })
      .from(customers)
      .where(and(eq(customers.backupEmployeeId, sourceId), isNull(customers.deletedAt)));

    for (const cust of affectedBackup) {
      if (cust.primaryEmployeeId === targetEmployeeId) {
        await tx.update(customerAssignmentHistory)
          .set({ validTo: today })
          .where(and(
            eq(customerAssignmentHistory.customerId, cust.id),
            eq(customerAssignmentHistory.employeeId, sourceId),
            eq(customerAssignmentHistory.role, "backup"),
            isNull(customerAssignmentHistory.validTo)
          ));
        await tx.update(customers).set({ backupEmployeeId: null }).where(eq(customers.id, cust.id));
        continue;
      }
      await tx.update(customerAssignmentHistory)
        .set({ validTo: today })
        .where(and(
          eq(customerAssignmentHistory.customerId, cust.id),
          eq(customerAssignmentHistory.employeeId, sourceId),
          eq(customerAssignmentHistory.role, "backup"),
          isNull(customerAssignmentHistory.validTo)
        ));
      await tx.insert(customerAssignmentHistory).values({
        customerId: cust.id,
        employeeId: targetEmployeeId,
        role: "backup",
        validFrom: today,
        changedByUserId,
      });
      const updateData: Record<string, number | null> = { backupEmployeeId: targetEmployeeId };
      if (cust.backupEmployeeId2 === targetEmployeeId) {
        await tx.update(customerAssignmentHistory)
          .set({ validTo: today })
          .where(and(
            eq(customerAssignmentHistory.customerId, cust.id),
            eq(customerAssignmentHistory.employeeId, targetEmployeeId),
            eq(customerAssignmentHistory.role, "backup2"),
            isNull(customerAssignmentHistory.validTo)
          ));
        updateData.backupEmployeeId2 = null;
      }
      await tx.update(customers).set(updateData).where(eq(customers.id, cust.id));
    }

    const affectedBackup2 = await tx.select({ id: customers.id, primaryEmployeeId: customers.primaryEmployeeId, backupEmployeeId: customers.backupEmployeeId })
      .from(customers)
      .where(and(eq(customers.backupEmployeeId2, sourceId), isNull(customers.deletedAt)));

    for (const cust of affectedBackup2) {
      if (cust.primaryEmployeeId === targetEmployeeId || cust.backupEmployeeId === targetEmployeeId) {
        await tx.update(customerAssignmentHistory)
          .set({ validTo: today })
          .where(and(
            eq(customerAssignmentHistory.customerId, cust.id),
            eq(customerAssignmentHistory.employeeId, sourceId),
            eq(customerAssignmentHistory.role, "backup2"),
            isNull(customerAssignmentHistory.validTo)
          ));
        await tx.update(customers).set({ backupEmployeeId2: null }).where(eq(customers.id, cust.id));
        continue;
      }
      await tx.update(customerAssignmentHistory)
        .set({ validTo: today })
        .where(and(
          eq(customerAssignmentHistory.customerId, cust.id),
          eq(customerAssignmentHistory.employeeId, sourceId),
          eq(customerAssignmentHistory.role, "backup2"),
          isNull(customerAssignmentHistory.validTo)
        ));
      await tx.insert(customerAssignmentHistory).values({
        customerId: cust.id,
        employeeId: targetEmployeeId,
        role: "backup2",
        validFrom: today,
        changedByUserId,
      });
      await tx.update(customers).set({ backupEmployeeId2: targetEmployeeId }).where(eq(customers.id, cust.id));
    }

    const appointmentResult = await tx.execute(sql`
      UPDATE appointments
      SET assigned_employee_id = ${targetEmployeeId}
      WHERE assigned_employee_id = ${sourceId}
        AND deleted_at IS NULL
        AND status IN ('scheduled', 'in_progress', 'documenting')
        AND date >= ${today}
    `);

    return {
      primaryCount: affectedPrimary.length,
      backupCount: affectedBackup.length,
      backup2Count: affectedBackup2.length,
      appointmentCount: Number(appointmentResult.rowCount || 0),
    };
  });

  birthdaysCache.invalidateAll();
  usersCache.invalidateAll();
  customerIdsCache.invalidateAll();

  await auditService.log({
    action: "employee_handover",
    entityType: "employee",
    entityId: sourceId,
    userId: changedByUserId ?? 0,
    details: {
      sourceEmployeeId: sourceId,
      sourceEmployeeName: sourceEmployee.displayName,
      targetEmployeeId,
      targetEmployeeName: targetEmployee.displayName,
      ...counts,
    },
  });

  log(`Employee handover: ${sourceEmployee.displayName} → ${targetEmployee.displayName} (${counts.primaryCount} primary, ${counts.backupCount} backup, ${counts.backup2Count} backup2, ${counts.appointmentCount} appointments)`);

  res.json({
    message: "Übergabe erfolgreich durchgeführt",
    ...counts,
  });
}));

export default router;
