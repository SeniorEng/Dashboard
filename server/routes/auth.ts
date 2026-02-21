import { Router, Request, Response } from "express";
import { authService } from "../services/auth";
import {
  loginSchema,
  passwordResetRequestSchema,
  passwordResetSchema,
  insertUserSchema,
  EMPLOYEE_ROLES,
  type EmployeeRole,
} from "@shared/schema";
import {
  requireAuth,
  requireAdmin,
  setSessionCookie,
  clearSessionCookie,
  getAvailableServiceTypes,
  getSessionToken,
} from "../middleware/auth";
import { asyncHandler } from "../lib/errors";
import { generateCsrfToken, setCsrfCookie, csrfProtection } from "../middleware/csrf";
import { getOpenTaskCount } from "../storage/tasks";
import { storage } from "../storage";
import { sendEmail, buildPasswordResetEmailHtml } from "../services/email-service";
import { timeTrackingStorage } from "../storage/time-tracking";
import { birthdaysCache } from "../services/cache";
import { todayISO } from "@shared/utils/datetime";
import { calculateDaysUntilBirthday } from "./birthdays";

const router = Router();

router.post("/login", asyncHandler("Anmeldung fehlgeschlagen", async (req: Request, res: Response) => {
  const result = loginSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Ungültige Anmeldedaten",
      details: result.error.issues,
    });
    return;
  }

  const { email, password } = result.data;
  const loginResult = await authService.login(email, password);

  if (!loginResult) {
    res.status(401).json({
      error: "UNAUTHORIZED",
      message: "E-Mail-Adresse oder Passwort ist falsch",
    });
    return;
  }

  setSessionCookie(res, loginResult.token);
  setCsrfCookie(res, generateCsrfToken());

  const { passwordHash, ...userWithoutPassword } = loginResult.user;
  res.json({
    user: userWithoutPassword,
    availableServices: getAvailableServiceTypes(
      loginResult.user.roles,
      loginResult.user.isAdmin
    ),
  });
}));

router.post("/logout", requireAuth, asyncHandler("Abmeldung fehlgeschlagen", async (req: Request, res: Response) => {
  const token = req.cookies?.careconnect_session;
  if (token) {
    await authService.logout(token);
  }
  clearSessionCookie(res);
  res.json({ success: true });
}));

router.get("/me", asyncHandler("Benutzerinformationen konnten nicht geladen werden", async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({
      error: "UNAUTHORIZED",
      message: "Nicht angemeldet",
    });
    return;
  }

  const existingCsrf = req.cookies?.careconnect_csrf;
  if (!existingCsrf) {
    setCsrfCookie(res, generateCsrfToken());
  }

  const { passwordHash, ...userWithoutPassword } = req.user;

  const userId = req.user.id;
  const isAdmin = req.user.isAdmin;
  const today = todayISO();

  const [badgeCount, birthdayCount] = await Promise.all([
    (async () => {
      try {
        const customerIds = isAdmin ? undefined : await storage.getAssignedCustomerIds(userId);
        const [userTaskCount, undocumentedAppts, openTasks, pendingRecords] = await Promise.all([
          getOpenTaskCount(userId),
          (customerIds && customerIds.length === 0) ? Promise.resolve(0) : storage.getUndocumentedAppointments(today, customerIds).then(a => a.length),
          timeTrackingStorage.getOpenTasks(userId).then(t => t.daysWithMissingBreaks?.length || 0),
          storage.getPendingServiceRecords(userId).then(r => r.length),
        ]);
        return userTaskCount + undocumentedAppts + openTasks + pendingRecords;
      } catch {
        return 0;
      }
    })(),
    (async () => {
      try {
        const cached = birthdaysCache.get(userId, isAdmin, 7);
        if (cached) return cached.length;
        let count = 0;
        if (isAdmin) {
          const [employees, customers] = await Promise.all([
            storage.getActiveEmployeesWithBirthday(),
            storage.getActiveCustomersWithBirthday(),
          ]);
          for (const emp of employees) {
            if (emp.geburtsdatum && calculateDaysUntilBirthday(emp.geburtsdatum) <= 7) count++;
          }
          for (const cust of customers) {
            if (cust.geburtsdatum && calculateDaysUntilBirthday(cust.geburtsdatum) <= 7) count++;
          }
        } else {
          if (req.user!.geburtsdatum && calculateDaysUntilBirthday(req.user!.geburtsdatum) <= 7) count++;
          const assignedIds = await storage.getAssignedCustomerIds(userId);
          if (assignedIds.length > 0) {
            const customers = await storage.getCustomersByIds(assignedIds);
            for (const cust of customers) {
              if (cust.geburtsdatum && calculateDaysUntilBirthday(cust.geburtsdatum) <= 7) count++;
            }
          }
        }
        return count;
      } catch {
        return 0;
      }
    })(),
  ]);

  res.json({
    user: userWithoutPassword,
    availableServices: getAvailableServiceTypes(
      req.user.roles,
      req.user.isAdmin
    ),
    badgeCount,
    birthdayCount,
  });
}));

router.post(
  "/password-reset/request",
  asyncHandler("Passwort-Zurücksetzung fehlgeschlagen", async (req: Request, res: Response) => {
    const result = passwordResetRequestSchema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Ungültige E-Mail-Adresse",
      });
      return;
    }

    const token = await authService.createPasswordResetToken(result.data.email);
    
    if (token) {
      try {
        const user = await authService.getUserByEmail(result.data.email);
        const companySettings = await storage.getCompanySettings();
        if (user && companySettings.smtpHost && companySettings.smtpUser) {
          const baseUrl = `${req.protocol}://${req.get("host")}`;
          const resetUrl = `${baseUrl}/reset-password?token=${token}`;

          const html = buildPasswordResetEmailHtml({
            vorname: user.vorname,
            nachname: user.nachname,
            companyName: companySettings.companyName || "SeniorenEngel",
            resetUrl,
            logoUrl: companySettings.logoUrl,
          });

          await sendEmail(companySettings, {
            to: result.data.email,
            subject: `Passwort zurücksetzen – ${companySettings.companyName || "SeniorenEngel"}`,
            html,
          });
        }
      } catch (emailError) {
        console.error("Passwort-Reset-E-Mail konnte nicht gesendet werden:", emailError);
      }
    }

    res.json({
      success: true,
      message:
        "Falls ein Konto mit dieser E-Mail existiert, wurde eine Anleitung zum Zurücksetzen des Passworts gesendet.",
    });
  })
);

router.post("/password-reset/confirm", asyncHandler("Passwort konnte nicht geändert werden", async (req: Request, res: Response) => {
  const result = passwordResetSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Ungültige Daten",
      details: result.error.issues,
    });
    return;
  }

  const success = await authService.resetPassword(
    result.data.token,
    result.data.newPassword
  );

  if (!success) {
    res.status(400).json({
      error: "INVALID_TOKEN",
      message: "Der Link zum Zurücksetzen ist ungültig oder abgelaufen",
    });
    return;
  }

  res.json({
    success: true,
    message: "Passwort wurde erfolgreich geändert",
  });
}));

router.post(
  "/change-password",
  csrfProtection,
  requireAuth,
  asyncHandler("Passwort konnte nicht geändert werden", async (req: Request, res: Response) => {
    const { newPassword } = req.body;
    
    if (!newPassword || newPassword.length < 8) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Passwort muss mindestens 8 Zeichen haben",
      });
      return;
    }

    const success = await authService.changePassword(req.user!.id, newPassword);

    if (!success) {
      res.status(500).json({
        error: "SERVER_ERROR",
        message: "Passwort konnte nicht geändert werden",
      });
      return;
    }

    clearSessionCookie(res);
    res.json({
      success: true,
      message: "Passwort wurde geändert. Bitte melden Sie sich erneut an.",
    });
  })
);

router.get("/session-info", requireAuth, asyncHandler("Session-Info konnte nicht geladen werden", async (req: Request, res: Response) => {
  const token = getSessionToken(req);
  if (!token) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return;
  }

  const info = await authService.getSessionInfo(token);
  if (!info) {
    res.status(401).json({ error: "SESSION_EXPIRED" });
    return;
  }

  res.json(info);
}));

router.post("/keepalive", requireAuth, asyncHandler("Session konnte nicht verlängert werden", async (req: Request, res: Response) => {
  const token = getSessionToken(req);
  if (!token) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return;
  }

  const success = await authService.touchSession(token);
  if (!success) {
    res.status(401).json({ error: "SESSION_EXPIRED" });
    return;
  }

  const info = await authService.getSessionInfo(token);
  res.json({ success: true, ...info });
}));

router.get("/setup-required", asyncHandler("Setup-Status konnte nicht überprüft werden", async (_req: Request, res: Response) => {
  const hasAdmin = await authService.hasAnyAdmin();
  res.json({ setupRequired: !hasAdmin });
}));

router.post("/setup", asyncHandler("Administrator-Konto konnte nicht erstellt werden", async (req: Request, res: Response) => {
  const hasAdmin = await authService.hasAnyAdmin();
  if (hasAdmin) {
    res.status(403).json({
      error: "FORBIDDEN",
      message: "Setup wurde bereits abgeschlossen",
    });
    return;
  }

  const result = insertUserSchema.safeParse({
    ...req.body,
    isAdmin: true,
    roles: EMPLOYEE_ROLES as unknown as EmployeeRole[],
  });

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
    isAdmin: true,
    roles: [...EMPLOYEE_ROLES],
  });

  const loginResult = await authService.login(
    result.data.email,
    result.data.password
  );

  if (loginResult) {
    setSessionCookie(res, loginResult.token);
  }

  const { passwordHash, ...userWithoutPassword } = user;
  res.status(201).json({
    user: userWithoutPassword,
    message: "Administrator-Konto wurde erstellt",
  });
}));

export default router;
