import { Router, Request, Response } from "express";
import { z } from "zod";
import { prospectStorage } from "../../storage/prospects";
import { insertProspectSchema, updateProspectSchema, insertProspectNoteSchema, PROSPECT_STATUSES } from "@shared/schema";
import { asyncHandler } from "../../lib/errors";
import { parseLeadEmail } from "../../services/email-parser";

const router = Router();

router.get("/prospects/stats", asyncHandler("Interessenten-Statistik konnte nicht geladen werden", async (_req: Request, res: Response) => {
  const stats = await prospectStorage.getStats();
  res.json(stats);
}));

router.get("/prospects", asyncHandler("Interessenten konnten nicht geladen werden", async (req: Request, res: Response) => {
  const { status, search } = req.query;
  const prospects = await prospectStorage.getAll({
    status: status as string | undefined,
    search: search as string | undefined,
  });
  res.json(prospects);
}));

router.get("/prospects/:id", asyncHandler("Interessent konnte nicht geladen werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Ungültige ID" });
    return;
  }

  const prospect = await prospectStorage.getById(id);
  if (!prospect) {
    res.status(404).json({ error: "Interessent nicht gefunden" });
    return;
  }

  const notes = await prospectStorage.getNotes(id);
  res.json({ ...prospect, notes });
}));

router.post("/prospects", asyncHandler("Interessent konnte nicht erstellt werden", async (req: Request, res: Response) => {
  const initialNote = typeof req.body._initialNote === "string" ? req.body._initialNote.trim() : "";
  const { _initialNote, ...bodyWithoutNote } = req.body;

  const parsed = insertProspectSchema.safeParse(bodyWithoutNote);
  if (!parsed.success) {
    res.status(400).json({ error: "Validierungsfehler", details: parsed.error.flatten() });
    return;
  }

  if (parsed.data.wiedervorlageDate && parsed.data.status !== "wiedervorlage") {
    parsed.data.status = "wiedervorlage";
  }

  const prospect = await prospectStorage.create(parsed.data);

  if (initialNote) {
    const userId = (req as any).user?.id;
    await prospectStorage.addNote({
      prospectId: prospect.id,
      userId,
      noteText: initialNote,
      noteType: "notiz",
    });
  }

  res.status(201).json(prospect);
}));

router.patch("/prospects/:id", asyncHandler("Interessent konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Ungültige ID" });
    return;
  }

  const parsed = updateProspectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validierungsfehler", details: parsed.error.flatten() });
    return;
  }

  const userId = (req as any).user?.id;

  if (parsed.data.status && parsed.data.status !== undefined) {
    const existing = await prospectStorage.getById(id);
    if (existing && existing.status !== parsed.data.status) {
      const oldLabel = existing.status;
      const newLabel = parsed.data.status;
      await prospectStorage.addNote({
        prospectId: id,
        userId,
        noteText: `Status geändert: ${oldLabel} → ${newLabel}`,
        noteType: "statuswechsel",
      });
    }
  }

  const updated = await prospectStorage.update(id, parsed.data);
  if (!updated) {
    res.status(404).json({ error: "Interessent nicht gefunden" });
    return;
  }

  res.json(updated);
}));

router.post("/prospects/:id/notes", asyncHandler("Notiz konnte nicht erstellt werden", async (req: Request, res: Response) => {
  const prospectId = parseInt(req.params.id);
  if (isNaN(prospectId)) {
    res.status(400).json({ error: "Ungültige ID" });
    return;
  }

  const prospect = await prospectStorage.getById(prospectId);
  if (!prospect) {
    res.status(404).json({ error: "Interessent nicht gefunden" });
    return;
  }

  const userId = (req as any).user?.id;
  const parsed = insertProspectNoteSchema.safeParse({
    ...req.body,
    prospectId,
    userId,
  });
  if (!parsed.success) {
    res.status(400).json({ error: "Validierungsfehler", details: parsed.error.flatten() });
    return;
  }

  const note = await prospectStorage.addNote(parsed.data);
  res.status(201).json(note);
}));

router.post("/prospects/:id/reparse", asyncHandler("E-Mail konnte nicht neu geparst werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Ungültige ID" });
    return;
  }

  const prospect = await prospectStorage.getById(id);
  if (!prospect) {
    res.status(404).json({ error: "Interessent nicht gefunden" });
    return;
  }

  if (!prospect.rawEmailContent) {
    res.status(400).json({ error: "Kein E-Mail-Inhalt vorhanden" });
    return;
  }

  const leadData = parseLeadEmail(prospect.rawEmailContent, prospect.quelleDetails || undefined);

  const updated = await prospectStorage.update(id, {
    vorname: leadData.vorname,
    nachname: leadData.nachname,
    telefon: leadData.telefon || null,
    email: leadData.email || null,
    strasse: leadData.strasse || null,
    nr: leadData.nr || null,
    plz: leadData.plz || null,
    stadt: leadData.stadt || null,
    pflegegrad: leadData.pflegegrad || null,
    quelle: leadData.quelle || prospect.quelle || null,
    quelleDetails: leadData.quelleDetails || prospect.quelleDetails || null,
  });

  const userId = (req as any).user?.id;
  const noteParts: string[] = ["Daten aus E-Mail neu geparst"];
  if (leadData.notizen) {
    noteParts.push("");
    noteParts.push(leadData.notizen);
  }

  await prospectStorage.addNote({
    prospectId: id,
    userId,
    noteText: noteParts.join("\n"),
    noteType: "notiz",
  });

  const notes = await prospectStorage.getNotes(id);
  res.json({ ...updated, notes });
}));

router.delete("/prospects/:id", asyncHandler("Interessent konnte nicht gelöscht werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Ungültige ID" });
    return;
  }

  const deleted = await prospectStorage.softDelete(id);
  if (!deleted) {
    res.status(404).json({ error: "Interessent nicht gefunden" });
    return;
  }

  res.json({ success: true });
}));

export default router;
