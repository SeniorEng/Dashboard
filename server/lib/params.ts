import { sendBadRequest } from "./errors";
import type { Response } from "express";

export function requireIntParam(value: string, res: Response): number | null {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    sendBadRequest(res, `Ungültiger Parameter: "${value}" ist keine gültige Zahl.`);
    return null;
  }
  return parsed;
}
