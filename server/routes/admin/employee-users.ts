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
import { eq, and, ne, or, isNull } from "drizzle-orm";
import { z } from "zod";
import { sendEmail, buildWelcomeEmailHtml } from "../../services/email-service";
import { resolveLogoToDataUrl } from "../../services/logo-resolver";

const router = Router();

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
    const companySettings = await getCachedCompanySettings();
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
  lbnr: z.string().nullable().optional(),
  personalnummer: z.string().nullable().optional(),
  notfallkontaktName: z.string().optional(),
  notfallkontaktTelefon: optionalGermanPhoneSchema,
  notfallkontaktBeziehung: z.string().optional(),
  roles: z.array(z.enum(EMPLOYEE_ROLES)).optional(),
  isTeamLead: z.boolean().optional(),
  teamLeadId: z.number().int().positive().nullable().optional(),
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

  const nextIsAdmin = result.data.isAdmin ?? currentUserBefore.isAdmin;
  const nextIsSuperAdmin = currentUserBefore.isSuperAdmin;
  const nextIsTeamLead = result.data.isTeamLead ?? currentUserBefore.isTeamLead;
  const teamLeadIdProvided = "teamLeadId" in result.data;

  // Auto-Bereinigung VOR den Konflikt-Checks: wenn jemand Admin oder Teamleiter
  // wird und keinen expliziten teamLeadId mitschickt, wird der bestehende
  // teamLeadId implizit entfernt.
  let effectiveTeamLeadId: number | null = teamLeadIdProvided
    ? (result.data.teamLeadId ?? null)
    : currentUserBefore.teamLeadId;
  if (!teamLeadIdProvided && (nextIsAdmin || nextIsSuperAdmin || nextIsTeamLead)) {
    effectiveTeamLeadId = null;
  }
  const nextTeamLeadId = effectiveTeamLeadId;

  if (nextIsTeamLead && (nextIsAdmin || nextIsSuperAdmin)) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Ein Administrator kann nicht gleichzeitig Teamleiter sein",
    });
    return;
  }

  if (nextTeamLeadId !== null && nextTeamLeadId === id) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Ein Mitarbeiter kann nicht sein eigener Teamleiter sein",
    });
    return;
  }

  if ((nextIsAdmin || nextIsSuperAdmin) && nextTeamLeadId !== null) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Administratoren und Hauptadministratoren können keinen Teamleiter haben",
    });
    return;
  }

  if (nextIsTeamLead && nextTeamLeadId !== null) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Ein Teamleiter kann selbst keinen Teamleiter haben",
    });
    return;
  }

  if (nextTeamLeadId !== null) {
    const lead = await authService.getUser(nextTeamLeadId);
    if (
      !lead ||
      !lead.isTeamLead ||
      !lead.isActive ||
      lead.isAnonymized ||
      lead.isAdmin ||
      lead.isSuperAdmin
    ) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Der ausgewählte Teamleiter ist nicht (mehr) verfügbar",
      });
      return;
    }
  }

  if (currentUserBefore.isTeamLead && !nextIsTeamLead) {
    const { countActiveReports } = await import("../../lib/team-lead");
    const reportCount = await countActiveReports(id);
    if (reportCount > 0) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: `Teamleiter-Markierung kann nicht entfernt werden: ${reportCount} aktive Mitarbeiter sind diesem Teamleiter noch zugeordnet. Bitte zuerst die Zuordnungen entfernen oder umhängen.`,
      });
      return;
    }
  }
  // ---------- /Teamleiter-Validierung ----------

  const { roles, carryOverDays, ...rest } = result.data;
  const userUpdates = {
    ...rest,
    ...(teamLeadIdProvided || effectiveTeamLeadId !== currentUserBefore.teamLeadId
      ? { teamLeadId: effectiveTeamLeadId }
      : {}),
  };

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
  if ((effectiveTeamLeadId ?? null) !== (currentUserBefore.teamLeadId ?? null)) {
    await auditService.log(
      req.user!.id,
      "user_team_lead_assigned",
      "user",
      id,
      { previous: currentUserBefore.teamLeadId ?? null, new: effectiveTeamLeadId ?? null },
      req.ip,
    );
  }
  // ---------- /Teamleiter-Audit ----------

  if (roles !== undefined) {
    await authService.setUserRoles(id, roles);
  }

  const vacationFieldsChanged = carryOverDays !== undefined || 'vacationDaysPerYear' in userUpdates || 'eintrittsdatum' in userUpdates;
  if (vacationFieldsChanged) {
    const { timeTrackingStorage } = await import("../../storage/time-tracking");
    const { getVacationEntitlement } = await import("@shared/domain/vacation");
    const currentYear = new Date().getFullYear();
    const vacDays = updatedUser.vacationDaysPerYear ?? 30;
    const eintritt = updatedUser.eintrittsdatum ?? null;
    const totalDays = getVacationEntitlement(vacDays, eintritt, currentYear);
    const existingAllowance = await timeTrackingStorage.getVacationAllowance(id, currentYear);
    if (carryOverDays !== undefined || existingAllowance) {
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

  const userToDeactivate = await authService.getUser(id);
  if (userToDeactivate?.isTeamLead) {
    const { countActiveReports } = await import("../../lib/team-lead");
    const reportCount = await countActiveReports(id);
    if (reportCount > 0) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: `Teamleiter kann nicht deaktiviert werden: ${reportCount} aktive Mitarbeiter sind diesem Teamleiter noch zugeordnet. Bitte zuerst die Zuordnungen entfernen oder umhängen.`,
      });
      return;
    }
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
