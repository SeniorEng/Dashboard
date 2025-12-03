import { Request, Response, NextFunction } from "express";
import { authService } from "../services/auth";
import type { UserWithRoles, EmployeeRole } from "@shared/schema";

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
    maxAge: 7 * 24 * 60 * 60 * 1000,
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
    const user = await authService.validateSession(token);
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

export function canCreateServiceType(
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

export function canCreateAppointmentType(
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
