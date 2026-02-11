import { Request, Response, NextFunction } from "express";

const NO_STORE_PATHS = [
  "/api/auth",
  "/api/csrf-token",
];

const STABLE_DATA_PATHS = [
  "/api/services",
  "/api/admin/insurance-providers",
  "/api/admin/services",
];

const SEMI_STABLE_PATHS = [
  "/api/admin/employees",
  "/api/admin/users",
  "/api/settings",
  "/api/birthdays",
];

export function cacheHeaders(req: Request, res: Response, next: NextFunction) {
  if (req.method !== "GET") {
    return next();
  }

  const path = req.path;

  if (NO_STORE_PATHS.some(p => path.startsWith(p))) {
    res.set("Cache-Control", "private, no-store");
  } else if (STABLE_DATA_PATHS.some(p => path.startsWith(p))) {
    res.set("Cache-Control", "private, max-age=300");
  } else if (SEMI_STABLE_PATHS.some(p => path.startsWith(p))) {
    res.set("Cache-Control", "private, max-age=60");
  } else {
    res.set("Cache-Control", "private, no-cache");
  }

  next();
}
