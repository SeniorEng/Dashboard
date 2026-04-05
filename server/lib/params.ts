import { sendBadRequest } from "./errors";
import type { Request, Response } from "express";
import { storage } from "../storage";

export function requireIntParam(value: string, res: Response): number | null {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    sendBadRequest(res, `Ungültiger Parameter: "${value}" ist keine gültige Zahl.`);
    return null;
  }
  return parsed;
}

export async function requireCustomerAccess(req: Request, res: Response, customerId: number): Promise<boolean> {
  const user = req.user!;
  if (user.isAdmin) return true;
  const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
  if (!assignedCustomerIds.includes(customerId)) {
    res.status(403).json({ error: "Zugriff verweigert" });
    return false;
  }
  return true;
}
