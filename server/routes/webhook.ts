import { Router, Request, Response } from "express";
import { z } from "zod";
import { prospectStorage } from "../storage/prospects";
import { parseLeadEmail } from "../services/email-parser";
import { asyncHandler } from "../lib/errors";

const router = Router();

const emailWebhookSchema = z.object({
  from: z.string().optional(),
  subject: z.string().optional(),
  body: z.string().min(1, "Email-Inhalt ist erforderlich"),
  receivedAt: z.string().optional(),
});

router.post("/email-lead", asyncHandler("Webhook-Verarbeitung fehlgeschlagen", async (req: Request, res: Response) => {
  const secret = req.headers["x-webhook-secret"];
  const expectedSecret = process.env.EMAIL_WEBHOOK_SECRET;

  if (!expectedSecret || secret !== expectedSecret) {
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

  res.status(201).json({ success: true, prospectId: prospect.id });
}));

export default router;
