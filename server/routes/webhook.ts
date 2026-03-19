import { Router, Request, Response } from "express";
import crypto from "crypto";
import { z } from "zod";
import { prospectStorage } from "../storage/prospects";
import { parseLeadEmail } from "../services/email-parser";
import { asyncHandler } from "../lib/errors";
import { initiateLeadCallBridge } from "../services/twilio-call-bridge";

const router = Router();

const emailWebhookSchema = z.object({
  from: z.string().optional(),
  subject: z.string().optional(),
  body: z.string().min(1, "Email-Inhalt ist erforderlich"),
  receivedAt: z.string().optional(),
});

router.post("/email-lead", asyncHandler("Webhook-Verarbeitung fehlgeschlagen", async (req: Request, res: Response) => {
  const headerKeys = Object.keys(req.headers);
  const secretHeader = headerKeys.find(k => k.replace(/[\t\s]/g, "").toLowerCase() === "x-webhook-secret");
  const secret = secretHeader ? String(req.headers[secretHeader]).trim() : undefined;
  const expectedSecret = process.env.EMAIL_WEBHOOK_SECRET?.trim();

  const secretBuf = secret ? Buffer.from(secret) : Buffer.alloc(0);
  const expectedBuf = expectedSecret ? Buffer.from(expectedSecret) : Buffer.alloc(0);
  const secretsMatch = expectedSecret && secret && secretBuf.length === expectedBuf.length
    ? crypto.timingSafeEqual(secretBuf, expectedBuf)
    : false;
  if (!secretsMatch) {
    console.error(`[webhook] Auth failed. Header key found: ${secretHeader ? "yes" : "NONE"} | Secret provided: ${secret ? "yes" : "no"} | Expected configured: ${expectedSecret ? "yes" : "no"}`);
    res.status(401).json({ error: "Ungültiger Webhook-Schlüssel" });
    return;
  }

  const parsed = emailWebhookSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Ungültige Anfrage", details: parsed.error.flatten() });
    return;
  }

  const { from, subject, body } = parsed.data;

  const leadData = parseLeadEmail(body, subject);

  const prospect = await prospectStorage.create({
    vorname: leadData.vorname,
    nachname: leadData.nachname,
    telefon: leadData.telefon || null,
    email: leadData.email || null,
    strasse: leadData.strasse || null,
    nr: leadData.nr || null,
    plz: leadData.plz || null,
    stadt: leadData.stadt || null,
    pflegegrad: leadData.pflegegrad || null,
    status: "neu",
    quelle: leadData.quelle || from || null,
    quelleDetails: leadData.quelleDetails || subject || null,
    rawEmailContent: body,
  });

  const noteParts: string[] = [];
  noteParts.push(`Automatisch aus E-Mail erstellt. Absender: ${from || "unbekannt"}, Betreff: ${subject || "kein Betreff"}`);
  if (leadData.notizen) {
    noteParts.push("");
    noteParts.push(leadData.notizen);
  }

  await prospectStorage.addNote({
    prospectId: prospect.id,
    noteText: noteParts.join("\n"),
    noteType: "email",
  });

  if (leadData.telefon) {
    initiateLeadCallBridge({
      prospectId: prospect.id,
      leadName: `${leadData.vorname} ${leadData.nachname}`.trim(),
      leadPhone: leadData.telefon,
      quelle: leadData.quelle || from || "unbekannt",
    }).catch(err => {
      console.error("[webhook] Lead call bridge error (non-blocking):", err);
    });
  }

  res.status(201).json({ success: true, prospectId: prospect.id });
}));

export default router;
