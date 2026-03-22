import { Router, Request, Response } from "express";
import twilio from "twilio";
import { prospectStorage } from "../storage/prospects";
import { storage } from "../storage";
import { getCachedCompanySettings } from "../services/cache";

const router = Router();

async function validateTwilioSignature(req: Request, res: Response): Promise<boolean> {
  const settings = await getCachedCompanySettings();
  if (!settings?.twilioAuthToken) {
    console.error("[twilio-webhook] No Twilio auth token configured");
    res.status(403).send("Forbidden");
    return false;
  }
  const twilioSignature = req.headers["x-twilio-signature"] as string;
  if (!twilioSignature) {
    console.error("[twilio-webhook] Missing X-Twilio-Signature header");
    res.status(403).send("Forbidden");
    return false;
  }
  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const url = `${protocol}://${req.get("host")}${req.originalUrl}`;
  if (!twilio.validateRequest(settings.twilioAuthToken, twilioSignature, url, req.body)) {
    console.error("[twilio-webhook] Invalid Twilio signature");
    res.status(403).send("Forbidden");
    return false;
  }
  return true;
}

router.post("/gather", async (req: Request, res: Response) => {
  try {
    if (!(await validateTwilioSignature(req, res))) return;

    const { Digits } = req.body;
    const prospectId = parseInt(req.query.prospectId as string, 10);
    const leadPhone = decodeURIComponent(req.query.leadPhone as string);
    const twilioPhone = decodeURIComponent(req.query.twilioPhone as string);

    res.set("Content-Type", "text/xml");

    if (Digits === "1" && leadPhone) {
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="de-DE">Sie werden jetzt verbunden.</Say>
  <Dial callerId="${escapeXml(twilioPhone)}" timeout="30">
    <Number>${escapeXml(leadPhone)}</Number>
  </Dial>
</Response>`;

      if (!isNaN(prospectId)) {
        prospectStorage.addNote({
          prospectId,
          noteText: "Mitarbeiter hat Taste 1 gedrückt — Verbindung zum Lead wird hergestellt",
          noteType: "anruf",
        }).catch(err => console.error("[twilio-webhook] Failed to add note:", err));
      }

      res.send(twiml);
    } else {
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="de-DE">Keine gültige Eingabe. Auf Wiedersehen.</Say>
</Response>`;

      if (!isNaN(prospectId)) {
        prospectStorage.addNote({
          prospectId,
          noteText: `Mitarbeiter hat Taste ${Digits || "keine"} gedrückt — Verbindung nicht hergestellt`,
          noteType: "notiz",
        }).catch(err => console.error("[twilio-webhook] Failed to add note:", err));
      }

      res.send(twiml);
    }
  } catch (err) {
    console.error("[twilio-webhook] Error in /gather:", err);
    res.set("Content-Type", "text/xml");
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say language="de-DE">Ein Fehler ist aufgetreten.</Say></Response>`);
  }
});

router.post("/status", async (req: Request, res: Response) => {
  try {
    if (!(await validateTwilioSignature(req, res))) return;

    const prospectId = parseInt(req.query.prospectId as string, 10);
    const { CallStatus, CallDuration } = req.body;

    if (!isNaN(prospectId) && CallStatus) {
      const statusMap: Record<string, string> = {
        completed: "Anruf abgeschlossen",
        busy: "Mitarbeiter besetzt",
        "no-answer": "Mitarbeiter nicht erreichbar",
        failed: "Anruf fehlgeschlagen",
        canceled: "Anruf abgebrochen",
      };

      const statusText = statusMap[CallStatus] || CallStatus;
      const durationText = CallDuration ? ` (Dauer: ${CallDuration}s)` : "";

      await prospectStorage.addNote({
        prospectId,
        noteText: `Anruf-Status: ${statusText}${durationText}`,
        noteType: "anruf",
      });
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("[twilio-webhook] Error in /status:", err);
    res.status(200).send("OK");
  }
});

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export default router;
