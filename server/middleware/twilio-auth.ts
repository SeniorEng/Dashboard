import type { Request, Response, NextFunction } from "express";
import twilio from "twilio";
import { getCachedCompanySettings } from "../services/cache";

/**
 * Twilio-Webhook-Signaturprüfung als Express-Middleware (Task #450).
 *
 * Vorher lebte die Prüfung inline in `server/routes/webhook-twilio.ts` und
 * musste in jeder neuen Webhook-Route manuell aufgerufen werden. Als
 * Middleware-Mount per `router.use(...)` ist Vergessen ausgeschlossen.
 */
export async function verifyTwilioSignature(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const settings = await getCachedCompanySettings();
    const authToken = settings?.twilioAuthToken;
    if (!authToken) {
      console.error("[twilio-webhook] No Twilio auth token configured");
      res.status(403).send("Forbidden");
      return;
    }
    const twilioSignature = req.headers["x-twilio-signature"] as string | undefined;
    if (!twilioSignature) {
      console.error("[twilio-webhook] Missing X-Twilio-Signature header");
      res.status(403).send("Forbidden");
      return;
    }
    const protoHeader = req.headers["x-forwarded-proto"];
    const proto = (Array.isArray(protoHeader) ? protoHeader[0] : protoHeader) || req.protocol;
    const url = `${proto}://${req.get("host")}${req.originalUrl}`;
    if (!twilio.validateRequest(authToken, twilioSignature, url, req.body)) {
      console.error("[twilio-webhook] Invalid Twilio signature");
      res.status(403).send("Forbidden");
      return;
    }
    next();
  } catch (err) {
    console.error("[twilio-webhook] Signature validation error:", err);
    res.status(403).send("Forbidden");
  }
}
