import { sendBadRequest } from "./errors";
import type { Request, Response } from "express";
import { storage } from "../storage";
import { isTeamLead } from "./team-lead";

export function requireIntParam(value: string, res: Response): number | null {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    sendBadRequest(res, `Ungültiger Parameter: "${value}" ist keine gültige Zahl.`);
    return null;
  }
  return parsed;
}

/**
 * Parst einen optionalen ganzzahligen Query-Parameter (z. B. ?year=2026).
 *
 * Liefert `undefined` wenn der Parameter fehlt. Ungültige Werte (NaN) führen
 * zu einer 400-Antwort und Rückgabe `null`. Aufrufer müssen `null` prüfen
 * und in dem Fall sofort returnen, weil bereits geantwortet wurde.
 *
 * Beispiel:
 *   const year = parseOptionalIntQuery(req.query.year, res);
 *   if (year === null) return;            // Antwort wurde bereits gesendet
 *   const value = year ?? new Date().getFullYear();
 */
export function parseOptionalIntQuery(
  raw: unknown,
  res: Response,
  paramName = "Parameter",
): number | undefined | null {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") {
    sendBadRequest(res, `Ungültiger ${paramName}: erwartet eine Zahl.`);
    return null;
  }
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    sendBadRequest(res, `Ungültiger ${paramName}: "${raw}" ist keine gültige Zahl.`);
    return null;
  }
  return parsed;
}

export async function requireCustomerAccess(req: Request, res: Response, customerId: number): Promise<boolean> {
  const user = req.user!;
  // Admin und Teamleitung haben firmenweiten Lese-/Schreibzugriff auf Kunden
  // (flacher Marker, keine Hierarchie).
  if (user.isAdmin || isTeamLead(user)) return true;
  const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
  if (!assignedCustomerIds.includes(customerId)) {
    res.status(403).json({ error: "Zugriff verweigert" });
    return false;
  }
  return true;
}

