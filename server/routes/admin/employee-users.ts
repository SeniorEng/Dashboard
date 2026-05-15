import { Router, Request, Response } from "express";
import { randomBytes } from "crypto";
import { authService } from "../../services/auth";
import { storage } from "../../storage";
import { usersCache, birthdaysCache, getCachedCompanySettings } from "../../services/cache";
import { log } from "../../lib/log";
import { sanitizeUser } from "../../utils/sanitize-user";
import { 
  insertUserSchema, 
  adminResetPasswordSchema,
  EMPLOYEE_ROLES,
  EMPLOYMENT_TYPES,
  EMPLOYMENT_STATUSES,
  users,
  appointments,
  sessions,
  passwordResetTokens,
} from "@shared/schema";
import { validateGeburtsdatum } from "@shared/utils/datetime";
import { optionalGermanPhoneSchema } from "@shared/schema/common";
import { asyncHandler, executeUserUpdate } from "../../lib/errors";
import { requireIntParam } from "../../lib/params";
import { auditService } from "../../services/audit";
import { geocodeEmployee } from "../../services/geocoding";
import { db } from "../../lib/db";
import { appointmentsRepo } from "../../repos";
import { eq, and, ne, or, isNull } from "drizzle-orm";
import { z } from "zod";
import { sendEmail, buildWelcomeEmailHtml } from "../../services/email-service";

const router = Router();

function isPrivilegedTarget(targetUser: { isAdmin?: boolean | null; isSuperAdmin?: boolean | null }): boolean {
  return !!targetUser.isAdmin || !!targetUser.isSuperAdmin;
}

function denyIfPrivilegedTarget(targetUser: { isAdmin?: boolean | null; isSuperAdmin?: boolean | null }, req: Request, res: Response): boolean {
  if (isPrivilegedTarget(targetUser) && !req.user!.isSuperAdmin) {
    const isSuperAdmin = !!targetUser.isSuperAdmin;
    res.status(403).json({
      error: "FORBIDDEN",
      message: isSuperAdmin
        ? "Aktionen auf den Hauptadministrator-Account sind nur dem Hauptadministrator erlaubt"
        : "Nur der Hauptadministrator kann Aktionen auf andere Administrator-Accounts durchführen",
    });
    return true;
  }
  return false;
}

router.get("/users", asyncHandler("Benutzer konnten nicht geladen werden", async (_req: Request, res: Response) => {
  const cached = usersCache.getAllUsers();
  if (cached) {
    return res.json(cached);
  }

  const users = await authService.getAllUsers();
  const safeUsers = users.map(sanitizeUser);
  
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
  const { timeTrackingStorage } = await import("../../storage/time-tracking");
  const currentYear = new Date().getFullYear();
  const [whatsappPrefs, vacationAllowance] = await Promise.all([
    getUserWhatsAppPreferences(id),
    timeTrackingStorage.getVacationAllowance(id, currentYear),
  ]);
  res.json({
    ...sanitizeUser(user),
    whatsappEnabled: whatsappPrefs?.enabled ?? false,
    carryOverDays: vacationAllowance?.carryOverDays ?? null,
  });
}));

router.post("/users", asyncHandler("Benutzer konnte nicht erstellt werden", async (req: Request, res: Response) => {
  if (!req.body.password || typeof req.body.password !== "string" || req.body.password.trim().length === 0) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Passwort ist erforderlich",
    });
    return;
  }

  const result = insertUserSchema.safeParse(req.body);
  if (!result.success) {
    const fieldMessages = result.error.issues.map(issue => {
      const field = issue.path.length > 0 ? issue.path.join(".") : undefined;
      return field ? `${field}: ${issue.message}` : issue.message;
    });
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: fieldMessages.join("; "),
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

  if (result.data.isTeamLead && !req.user!.isSuperAdmin) {
    res.status(403).json({
      error: "FORBIDDEN",
      message: "Nur der Hauptadministrator kann Teamleitungen anlegen",
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
      isTeamLead: result.data.isTeamLead,
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

  // Lege direkt einen `employeeVacationAllowance`-Eintrag für das aktuelle
  // Jahr an, damit die Urlaubs-Übersicht (Task #413) sofort den schnellen
  // Pfad nutzen kann und nicht erst auf den nächtlichen
  // `syncVacationCarryover`-Job oder den ersten Patch von
  // `vacationDaysPerYear` warten muss.
  if (user.isActive) {
    try {
      const { timeTrackingStorage } = await import("../../storage/time-tracking");
      const currentYear = new Date().getFullYear();
      const vacDays = user.vacationDaysPerYear ?? 30;
      const eintritt = user.eintrittsdatum ?? null;
      const totalDays = timeTrackingStorage.computeAnnualEntitlement(
        [],
        vacDays,
        eintritt,
        currentYear,
      );
      await timeTrackingStorage.setVacationAllowance({
        userId: user.id,
        year: currentYear,
        totalDays,
        carryOverDays: 0,
      });
    } catch (allowanceError) {
      const msg = allowanceError instanceof Error ? allowanceError.message : String(allowanceError);
      console.error("[vacation] Initiale Allowance konnte nicht angelegt werden:", msg);
    }
  }

  try {
    const companySettings = await getCachedCompanySettings();
    if (companySettings.smtpHost && companySettings.smtpUser) {
      log(`Sende Willkommens-E-Mail an ${result.data.email}...`, "email");
      const welcomeToken = await authService.createWelcomeToken(user.id);
      const baseUrl = `${req.protocol}://${req.get("host")}`;
      const resetUrl = `${baseUrl}/reset-password?token=${welcomeToken}`;

      const html = buildWelcomeEmailHtml({
        vorname: result.data.vorname,
        nachname: result.data.nachname,
        email: result.data.email,
        companyName: companySettings.companyName || "SeniorenEngel",
        resetUrl,
        logoUrl: companySettings.logoUrl ? "/api/public/logo/main" : null,
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
  telefon: optionalGermanPhoneSchema,
  strasse: z.string().optional(),
  hausnummer: z.string().optional(),
  plz: z.string().optional(),
  stadt: z.string().optional(),
  geburtsdatum: z.string().optional(),
  eintrittsdatum: z.string().optional(),
  austrittsDatum: z.string().nullable().optional(),
  vacationDaysPerYear: z.number().int().min(0, "Muss mindestens 0 sein").max(365, "Maximal 365 Tage").optional(),
  carryOverDays: z.number().int().min(0, "Muss mindestens 0 sein").max(365, "Maximal 365 Tage").nullable().optional(),
  isActive: z.boolean().optional(),
  isAdmin: z.boolean().optional(),
  haustierAkzeptiert: z.boolean().optional(),
  isEuRentner: z.boolean().optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  employmentStatus: z.enum(EMPLOYMENT_STATUSES).optional(),
  weeklyWorkDays: z.number().int().min(1, "Muss mindestens 1 Tag sein").max(7, "Maximal 7 Tage").optional(),
  monthlyWorkHours: z.number().min(1, "Muss mindestens 1 Stunde sein").max(300, "Maximal 300 Stunden").nullable().optional(),
  notfallkontaktName: z.string().optional(),
  notfallkontaktTelefon: optionalGermanPhoneSchema,
  notfallkontaktBeziehung: z.string().optional(),
  roles: z.array(z.enum(EMPLOYEE_ROLES)).optional(),
  isTeamLead: z.boolean().optional(),
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

  if (req.body.isTeamLead !== undefined && !req.user!.isSuperAdmin) {
    const currentUser = await authService.getUser(id);
    if (currentUser && currentUser.isTeamLead !== req.body.isTeamLead) {
      res.status(403).json({
        error: "FORBIDDEN",
        message: "Nur der Hauptadministrator kann die Teamleiter-Markierung vergeben oder entziehen",
      });
      return;
    }
  }

  const { whatsappEnabled, carryOverDays: carryOverDaysRaw, ...bodyWithoutExtras } = req.body;

  const result = updateUserSchema.safeParse({ ...bodyWithoutExtras, carryOverDays: carryOverDaysRaw });
  if (!result.success) {
    const fieldMessages = result.error.issues.map(issue => {
      const field = issue.path.length > 0 ? issue.path.join(".") : undefined;
      return field ? `${field}: ${issue.message}` : issue.message;
    });
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: fieldMessages.join("; "),
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

  // ---------- Teamleiter-Validierung ----------
  const currentUserBefore = await authService.getUser(id);
  if (!currentUserBefore) {
    res.status(404).json({ error: "NOT_FOUND", message: "Benutzer nicht gefunden" });
    return;
  }

  if (denyIfPrivilegedTarget(currentUserBefore, req, res)) return;

  const nextIsAdmin = result.data.isAdmin ?? currentUserBefore.isAdmin;
  const nextIsSuperAdmin = currentUserBefore.isSuperAdmin;
  const requestedIsTeamLead = result.data.isTeamLead ?? currentUserBefore.isTeamLead;
  const nextIsActive = result.data.isActive ?? currentUserBefore.isActive;

  if (requestedIsTeamLead && (nextIsAdmin || nextIsSuperAdmin)) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Ein Administrator kann nicht gleichzeitig Teamleiter sein",
    });
    return;
  }

  if (
    result.data.isTeamLead === true &&
    (currentUserBefore.isAnonymized || nextIsActive === false)
  ) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message:
        "Inaktive oder anonymisierte Mitarbeiter können nicht als Teamleitung markiert werden",
    });
    return;
  }

  let nextIsTeamLead = requestedIsTeamLead;
  if (currentUserBefore.isAnonymized || nextIsActive === false) {
    nextIsTeamLead = false;
    if (currentUserBefore.isTeamLead) {
      result.data.isTeamLead = false;
    }
  }
  // ---------- /Teamleiter-Validierung ----------

  const { roles, carryOverDays, ...rest } = result.data;
  const userUpdates = { ...rest };

  const updatedUser = await executeUserUpdate(res, id, userUpdates, authService.updateUser.bind(authService));
  if (!updatedUser) return;

  // ---------- Teamleiter-Audit ----------
  if (currentUserBefore.isTeamLead !== nextIsTeamLead) {
    await auditService.log(
      req.user!.id,
      nextIsTeamLead ? "user_team_lead_set" : "user_team_lead_unset",
      "user",
      id,
      { previous: currentUserBefore.isTeamLead, new: nextIsTeamLead },
      req.ip,
    );
  }
  // ---------- /Teamleiter-Audit ----------

  if (roles !== undefined) {
    // Defense-in-depth: Nur Hauptadministratoren dürfen Rollen
    // privilegierter Accounts (Admin/SuperAdmin) ändern. `denyIfPrivilegedTarget`
    // oben blockiert das bereits — diese zusätzliche Prüfung schützt den
    // Pfad, falls die obige Logik je überarbeitet wird.
    if (!req.user!.isSuperAdmin && isPrivilegedTarget(currentUserBefore)) {
      res.status(403).json({
        error: "FORBIDDEN",
        message: "Nur der Hauptadministrator kann Rollen von Administrator-Accounts ändern",
      });
      return;
    }
    await authService.setUserRoles(id, roles);
  }

  const vacationFieldsChanged = carryOverDays !== undefined || 'vacationDaysPerYear' in userUpdates || 'eintrittsdatum' in userUpdates;
  const vacationDaysActuallyChanged = (
    'vacationDaysPerYear' in userUpdates &&
    (currentUserBefore.vacationDaysPerYear ?? 30) !== (updatedUser.vacationDaysPerYear ?? 30)
  );
  if (vacationFieldsChanged) {
    const { timeTrackingStorage } = await import("../../storage/time-tracking");
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1; // 1-12
    const vacDays = updatedUser.vacationDaysPerYear ?? 30;
    const eintritt = updatedUser.eintrittsdatum ?? null;

    // Wenn der Jahresurlaubsanspruch tatsächlich geändert wird, schreiben wir
    // einen History-Eintrag für den aktuellen Monat (Upsert: mehrere Änderungen
    // im selben Monat ergeben einen Eintrag — letzter Wert gewinnt).
    if (vacationDaysActuallyChanged) {
      await timeTrackingStorage.upsertVacationEntitlementHistory({
        userId: id,
        validFromYear: currentYear,
        validFromMonth: currentMonth,
        daysPerYear: vacDays,
        createdBy: req.user!.id,
      });
    }

    const history = await timeTrackingStorage.getVacationEntitlementHistoryForUser(id);
    const totalDays = timeTrackingStorage.computeAnnualEntitlement(history, vacDays, eintritt, currentYear);
    const existingAllowance = await timeTrackingStorage.getVacationAllowance(id, currentYear);
    if (carryOverDays !== undefined || existingAllowance || vacationDaysActuallyChanged) {
      await timeTrackingStorage.setVacationAllowance({
        userId: id,
        year: currentYear,
        totalDays,
        carryOverDays: carryOverDays ?? existingAllowance?.carryOverDays ?? 0,
      });
    }
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

  const targetUser = await authService.getUser(id);
  if (!targetUser) {
    res.status(404).json({ error: "NOT_FOUND", message: "Benutzer nicht gefunden" });
    return;
  }

  if (denyIfPrivilegedTarget(targetUser, req, res)) return;

  const parsed = adminResetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: parsed.error.errors[0]?.message ?? "Ungültige Eingabe",
    });
    return;
  }

  const success = await authService.adminResetPassword(id, parsed.data.newPassword);
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

  const companySettings = await getCachedCompanySettings();
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
    logoUrl: companySettings.logoUrl ? "/api/public/logo/main" : null,
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

  const targetUser = await authService.getUser(id);
  if (!targetUser) {
    res.status(404).json({ error: "NOT_FOUND", message: "Benutzer nicht gefunden" });
    return;
  }

  if (denyIfPrivilegedTarget(targetUser, req, res)) return;

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

  const targetUser = await authService.getUser(id);
  if (!targetUser) {
    res.status(404).json({ error: "NOT_FOUND", message: "Benutzer nicht gefunden" });
    return;
  }

  if (denyIfPrivilegedTarget(targetUser, req, res)) return;

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

  if (denyIfPrivilegedTarget(user, req, res)) return;

  if (user.isActive) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Nur inaktive Mitarbeiter können anonymisiert werden. Bitte deaktivieren Sie den Mitarbeiter zuerst." });
    return;
  }

  if (user.isAnonymized) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Mitarbeiter wurde bereits anonymisiert" });
    return;
  }

  const openAppointments = await appointmentsRepo.selectColumnsFrom({ id: appointments.id })
    .where(and(
      or(
        eq(appointments.assignedEmployeeId, id),
        eq(appointments.performedByEmployeeId, id)
      ),
      ne(appointments.status, "completed"),
      appointmentsRepo.activeOnly()
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
      isTeamLead: false,
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

router.get("/vacation-summaries/:year", asyncHandler("Urlaubsübersichten konnten nicht geladen werden", async (req: Request, res: Response) => {
  const year = requireIntParam(req.params.year, res);
  if (year === null) return;

  const { timeTrackingStorage } = await import("../../storage/time-tracking");
  const allEmployees = await db.select({ id: users.id })
    .from(users)
    .where(eq(users.isAnonymized, false));

  const summaries: Record<number, Awaited<ReturnType<typeof timeTrackingStorage.getVacationSummary>>> = {};
  await Promise.all(
    allEmployees.map(async (emp) => {
      summaries[emp.id] = await timeTrackingStorage.getVacationSummary(emp.id, year);
    })
  );
  res.json(summaries);
}));

export default router;
