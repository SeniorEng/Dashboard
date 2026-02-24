import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

const CSRF_COOKIE_NAME = "careconnect_csrf";
const CSRF_HEADER_NAME = "x-csrf-token";

export function generateCsrfToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function setCsrfCookie(res: Response, token: string): void {
  res.cookie(CSRF_COOKIE_NAME, token, {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 12 * 60 * 60 * 1000,
    path: "/",
  });
}

export function csrfProtection(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const safeMethods = ["GET", "HEAD", "OPTIONS"];
  
  if (safeMethods.includes(req.method)) {
    next();
    return;
  }

  if (req.path.startsWith("/webhook/")) {
    next();
    return;
  }

  const cookieToken = req.cookies?.[CSRF_COOKIE_NAME];
  const headerToken = req.headers[CSRF_HEADER_NAME] as string | undefined;

  if (!cookieToken) {
    const newToken = generateCsrfToken();
    setCsrfCookie(res, newToken);
    res.status(403).json({
      error: "CSRF_TOKEN_MISSING",
      message: "CSRF-Token fehlt. Bitte laden Sie die Seite neu.",
    });
    return;
  }

  if (!headerToken || headerToken !== cookieToken) {
    res.status(403).json({
      error: "CSRF_TOKEN_INVALID",
      message: "CSRF-Token ungültig. Bitte laden Sie die Seite neu.",
    });
    return;
  }

  next();
}

export function csrfTokenHandler(req: Request, res: Response): void {
  let token = req.cookies?.[CSRF_COOKIE_NAME];
  
  if (!token) {
    token = generateCsrfToken();
    setCsrfCookie(res, token);
  }
  
  res.json({ csrfToken: token });
}
