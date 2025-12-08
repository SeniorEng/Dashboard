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
} from "../middleware/auth";
import { handleRouteError } from "../lib/errors";
import { generateCsrfToken, setCsrfCookie } from "../middleware/csrf";

const router = Router();

router.post("/login", async (req: Request, res: Response) => {
  try {
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
  } catch (error) {
    handleRouteError(res, error, "Anmeldung fehlgeschlagen");
  }
});

router.post("/logout", requireAuth, async (req: Request, res: Response) => {
  try {
    const token = req.cookies?.careconnect_session;
    if (token) {
      await authService.logout(token);
    }
    clearSessionCookie(res);
    res.json({ success: true });
  } catch (error) {
    handleRouteError(res, error, "Abmeldung fehlgeschlagen");
  }
});

router.get("/me", async (req: Request, res: Response) => {
  try {
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
    res.json({
      user: userWithoutPassword,
      availableServices: getAvailableServiceTypes(
        req.user.roles,
        req.user.isAdmin
      ),
    });
  } catch (error) {
    handleRouteError(res, error, "Benutzerinformationen konnten nicht geladen werden");
  }
});

router.post(
  "/password-reset/request",
  async (req: Request, res: Response) => {
    try {
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
        console.log(`Password reset token for ${result.data.email}: ${token}`);
      }

      res.json({
        success: true,
        message:
          "Falls ein Konto mit dieser E-Mail existiert, wurde eine Anleitung zum Zurücksetzen des Passworts gesendet.",
      });
    } catch (error) {
      handleRouteError(res, error, "Passwort-Zurücksetzung fehlgeschlagen");
    }
  }
);

router.post("/password-reset/confirm", async (req: Request, res: Response) => {
  try {
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
  } catch (error) {
    handleRouteError(res, error, "Passwort konnte nicht geändert werden");
  }
});

router.post(
  "/change-password",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
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
    } catch (error) {
      handleRouteError(res, error, "Passwort konnte nicht geändert werden");
    }
  }
);

router.get("/setup-required", async (_req: Request, res: Response) => {
  try {
    const hasAdmin = await authService.hasAnyAdmin();
    res.json({ setupRequired: !hasAdmin });
  } catch (error) {
    handleRouteError(res, error, "Setup-Status konnte nicht überprüft werden");
  }
});

router.post("/setup", async (req: Request, res: Response) => {
  try {
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
  } catch (error) {
    handleRouteError(res, error, "Administrator-Konto konnte nicht erstellt werden");
  }
});

export default router;
