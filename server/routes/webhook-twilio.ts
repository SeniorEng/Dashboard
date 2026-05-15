import { Router, Request, Response } from "express";
import { prospectStorage } from "../storage/prospects";
import { escapeXml } from "../lib/xml";
import { verifyTwilioSignature } from "../middleware/twilio-auth";
import { verifyCallbackToken } from "../lib/twilio-callback-token";

const router = Router();

// Signatur-Prüfung als Middleware: ein zentraler Mount stellt sicher, dass
// keine neue Webhook-Route den Check vergessen kann (Task #450).
router.use(verifyTwilioSignature);

function resolveProspectId(req: Request): number | null {
  const result = verifyCallbackToken(req.query.t as string | undefined);
  if (result.ok && typeof result.prospectId === "number") return result.prospectId;
  if (!result.ok) {
    console.error(`[twilio-webhook] Token-Prüfung fehlgeschlagen: ${result.reason}`);
  }
  return null;
}

router.post("/gather", async (req: Request, res: Response) => {
  try {
    const { Digits } = req.body;
    const prospectId = resolveProspectId(req);
    const leadPhone = typeof req.query.leadPhone === "string" ? decodeURIComponent(req.query.leadPhone) : "";
    const twilioPhone = typeof req.query.twilioPhone === "string" ? decodeURIComponent(req.query.twilioPhone) : "";

    res.set("Content-Type", "text/xml");

    if (Digits === "1" && leadPhone) {
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="de-DE">Sie werden jetzt verbunden.</Say>
  <Dial callerId="${escapeXml(twilioPhone)}" timeout="30">
    <Number>${escapeXml(leadPhone)}</Number>
  </Dial>
</Response>`;

      if (prospectId !== null) {
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

      if (prospectId !== null) {
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
    const prospectId = resolveProspectId(req);
    const { CallStatus, CallDuration } = req.body;

    if (prospectId !== null && CallStatus) {
      const statusMap: Record<string, string> = {
        completed: "Anruf abgeschlossen",
        busy: "Mitarbeiter besetzt",
        "no-answer": "Mitarbeiter nicht erreichbar",
        failed: "Anruf fehlgeschlagen",
        canceled: "Anruf abgebrochen",
      };

      const statusText = statusMap[CallStatus] || CallStatus;
      const durationText = CallDuration ? ` (Dauer: ${CallDuration}s)` : "";

      await Promise.race([
        prospectStorage.addNote({
          prospectId,
          noteText: `Anruf-Status: ${statusText}${durationText}`,
          noteType: "anruf",
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 5000)),
      ]);
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("[twilio-webhook] Error in /status:", err);
    res.status(200).send("OK");
  }
});

export default router;
