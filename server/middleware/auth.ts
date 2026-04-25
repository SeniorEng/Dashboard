import { Request, Response, NextFunction } from "express";
import { authService } from "../services/auth";
import { adminPermissionStorage } from "../storage/admin-permissions";
import type { UserWithRoles, EmployeeRole, AdminPermissionKey } from "@shared/schema";

declare global {
  namespace Express {
    interface Request {
      user?: UserWithRoles;
    }
  }
}

const COOKIE_NAME = "careconnect_session";

export function getSessionToken(req: Request): string | null {
  const cookie = req.cookies?.[COOKIE_NAME];
  if (cookie) return cookie;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  return null;
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 12 * 60 * 60 * 1000,
    path: "/",
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = getSessionToken(req);

  if (!token) {
    req.user = undefined;
    next();
    return;
  }

  try {
    const noTouch = req.path === "/auth/session-info" || req.path === "/auth/keepalive";
    const user = await authService.validateSession(token, !noTouch);
    req.user = user ?? undefined;
    next();
  } catch (error) {
    console.error("Session validation error:", error);
    req.user = undefined;
    next();
  }
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    res.status(401).json({
      error: "UNAUTHORIZED",
      message: "Bitte melden Sie sich an",
    });
    return;
  }
  next();
}

export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    res.status(401).json({
      error: "UNAUTHORIZED",
      message: "Bitte melden Sie sich an",
    });
    return;
  }

  if (!req.user.isAdmin) {
    res.status(403).json({
      error: "FORBIDDEN",
      message: "Sie haben keine Berechtigung für diese Aktion",
    });
    return;
  }

  next();
}

export function requireSuperAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    res.status(401).json({
      error: "UNAUTHORIZED",
      message: "Bitte melden Sie sich an",
    });
    return;
  }

  if (!req.user.isSuperAdmin) {
    res.status(403).json({
      error: "FORBIDDEN",
      message: "Nur der Hauptadministrator kann diese Aktion ausführen",
    });
    return;
  }

  next();
}

export function requireAdminPermission(permissionKey: AdminPermissionKey) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({
        error: "UNAUTHORIZED",
        message: "Bitte melden Sie sich an",
      });
      return;
    }

    if (!req.user.isAdmin) {
      res.status(403).json({
        error: "FORBIDDEN",
        message: "Sie haben keine Berechtigung für diese Aktion",
      });
      return;
    }

    if (req.user.isSuperAdmin) {
      next();
      return;
    }

    const hasPermission = await adminPermissionStorage.hasPermission(req.user.id, permissionKey);
    if (!hasPermission) {
      res.status(403).json({
        error: "FORBIDDEN",
        message: "Sie haben keine Berechtigung für diesen Bereich",
      });
      return;
    }

    next();
  };
}

export function requireTeamLeadOrAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    res.status(401).json({
      error: "UNAUTHORIZED",
      message: "Bitte melden Sie sich an",
    });
    return;
  }

  if (req.user.isAdmin || (req.user.isTeamLead && req.user.isActive)) {
    next();
    return;
  }

  res.status(403).json({
    error: "FORBIDDEN",
    message: "Nur Teamleiter oder Administratoren können diese Aktion ausführen",
  });
}

export function requireRoles(...requiredRoles: EmployeeRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        error: "UNAUTHORIZED",
        message: "Bitte melden Sie sich an",
      });
      return;
    }

    if (req.user.isAdmin) {
      next();
      return;
    }

    const hasRequiredRole = requiredRoles.some((role) =>
      req.user!.roles.includes(role)
    );

    if (!hasRequiredRole) {
      res.status(403).json({
        error: "FORBIDDEN",
        message: "Sie haben keine Berechtigung für diese Aktion",
      });
      return;
    }

    next();
  };
}

function canCreateServiceType(
  userRoles: EmployeeRole[],
  isAdmin: boolean,
  serviceType: "hauswirtschaft" | "alltagsbegleitung" | "erstberatung"
): boolean {
  if (isAdmin) return true;

  switch (serviceType) {
    case "hauswirtschaft":
      return (
        userRoles.includes("hauswirtschaft") ||
        userRoles.includes("alltagsbegleitung")
      );
    case "alltagsbegleitung":
      return userRoles.includes("alltagsbegleitung");
    case "erstberatung":
      return userRoles.includes("erstberatung");
    default:
      return false;
  }
}

export function getAvailableServiceTypes(
  userRoles: EmployeeRole[],
  isAdmin: boolean
): string[] {
  if (isAdmin) {
    return ["hauswirtschaft", "alltagsbegleitung", "erstberatung"];
  }

  const services: string[] = [];

  if (
    userRoles.includes("hauswirtschaft") ||
    userRoles.includes("alltagsbegleitung")
  ) {
    services.push("hauswirtschaft");
  }

  if (userRoles.includes("alltagsbegleitung")) {
    services.push("alltagsbegleitung");
  }

  if (userRoles.includes("erstberatung")) {
    services.push("erstberatung");
  }

  return services;
}

function canCreateAppointmentType(
  userRoles: EmployeeRole[],
  isAdmin: boolean,
  appointmentType: "Kundentermin" | "Erstberatung"
): boolean {
  if (isAdmin) return true;

  if (appointmentType === "Erstberatung") {
    return userRoles.includes("erstberatung");
  }

  return (
    userRoles.includes("hauswirtschaft") ||
    userRoles.includes("alltagsbegleitung")
  );
}

/**
 * Prüft ob ein Benutzer Zugriff auf einen bestimmten Kunden hat.
 * Admins haben Zugriff auf alle Kunden.
 * Nicht-Admins haben nur Zugriff auf ihnen zugewiesene Kunden.
 */
export async function canAccessCustomer(
  userId: number,
  isAdmin: boolean,
  customerId: number,
  getAssignedCustomerIds: (employeeId: number) => Promise<number[]>
): Promise<boolean> {
  if (isAdmin) return true;
  
  const assignedCustomerIds = await getAssignedCustomerIds(userId);
  return assignedCustomerIds.includes(customerId);
}

/**
 * Middleware-Funktion die prüft ob der Benutzer auf den Kunden in req.params.customerId zugreifen darf.
 */
export function requireCustomerAccess(
  getAssignedCustomerIds: (employeeId: number) => Promise<number[]>
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({
        error: "UNAUTHORIZED",
        message: "Bitte melden Sie sich an",
      });
      return;
    }

    const customerIdRaw = parseInt(req.params.customerId, 10);
    if (isNaN(customerIdRaw)) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Ungültige Kunden-ID",
      });
      return;
    }
    const customerId = customerIdRaw;

    const hasAccess = await canAccessCustomer(
      req.user.id,
      req.user.isAdmin,
      customerId,
      getAssignedCustomerIds
    );

    if (!hasAccess) {
      res.status(403).json({
        error: "FORBIDDEN",
        message: "Sie haben keinen Zugriff auf diesen Kunden",
      });
      return;
    }

    next();
  };
}
