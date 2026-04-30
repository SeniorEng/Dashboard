import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth, requireRoles } from "../middleware/auth";
import { prospectStorage } from "../storage/prospects";
import { asyncHandler } from "../lib/errors";
import { requireIntParam } from "../lib/params";
import { optionalGermanPhoneSchema, internationalEmailSchema, plzSchema } from "@shared/schema/common";
import type { Prospect } from "@shared/schema";

const router = Router();

router.use(requireAuth);

router.get("/search", requireRoles("erstberatung"), asyncHandler("Interessenten konnten nicht geladen werden", async (req: Request, res: Response) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const search = typeof req.query.search === "string" ? req.query.search : undefined;

  const prospects = await prospectStorage.getAll({ status, search });

  const safeFields: Array<Pick<Prospect, "id" | "vorname" | "nachname" | "telefon" | "email" | "strasse" | "nr" | "plz" | "stadt" | "pflegegrad" | "status">> = prospects.map((p) => ({
    id: p.id,
    vorname: p.vorname,
    nachname: p.nachname,
    telefon: p.telefon,
    email: p.email,
    strasse: p.strasse,
    nr: p.nr,
    plz: p.plz,
    stadt: p.stadt,
    pflegegrad: p.pflegegrad,
    status: p.status,
  }));
  res.json(safeFields);
}));

const inlineProspectSchema = z.object({
  vorname: z.string().min(1),
  nachname: z.string().min(1),
  telefon: optionalGermanPhoneSchema,
  email: z.string().optional().nullable(),
  strasse: z.string().optional().nullable(),
  nr: z.string().optional().nullable(),
  plz: z.string().optional().nullable(),
  stadt: z.string().optional().nullable(),
  pflegegrad: z.number().int().min(1).max(5).optional().nullable(),
  quelleDetails: z.string().optional().nullable(),
}).strict();

// Erlaubt Erstberatungs-Berechtigten (inkl. Teamleitungen) das Aktualisieren
// derselben Stammdaten-Felder, die auch das Formular zur Erstberatungs-
// Bearbeitung sendet. Wir spiegeln hier bewusst den Feldumfang des Admin-
// Endpunkts (Vor-/Nachname inklusive), damit Admins keinen Funktionsverlust
// erleiden, wenn das Frontend auf diesen Endpunkt umstellt.
const prospectContactUpdateSchema = z.object({
  vorname: z.string().min(1, "Vorname ist erforderlich").max(100, "Maximal 100 Zeichen").optional(),
  nachname: z.string().min(1, "Nachname ist erforderlich").max(100, "Maximal 100 Zeichen").optional(),
  telefon: optionalGermanPhoneSchema.nullable(),
  email: internationalEmailSchema.optional().or(z.literal("")).nullable(),
  strasse: z.string().max(200, "Maximal 200 Zeichen").optional().nullable(),
  nr: z.string().max(20, "Maximal 20 Zeichen").optional().nullable(),
  plz: z.string().regex(/^\d{5}$/, "PLZ muss 5 Ziffern haben").optional().or(z.literal("")).nullable(),
  stadt: z.string().max(100, "Maximal 100 Zeichen").optional().nullable(),
  pflegegrad: z.number().int().min(1, "Pflegegrad muss zwischen 1 und 5 liegen").max(5, "Pflegegrad muss zwischen 1 und 5 liegen").optional().nullable(),
}).strict();

router.post("/inline", requireRoles("erstberatung"), asyncHandler("Interessent konnte nicht erstellt werden", async (req: Request, res: Response) => {
  const parsed = inlineProspectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validierungsfehler", details: parsed.error.flatten() });
    return;
  }

  const prospect = await prospectStorage.create({
    ...parsed.data,
    status: "erstberatung_vereinbart",
    quelle: "direktkontakt",
  });
  res.status(201).json(prospect);
}));

router.get("/:id/appointment-data", requireRoles("erstberatung"), asyncHandler("Termindaten konnten nicht geladen werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const prospect = await prospectStorage.getById(id);
  if (!prospect) {
    res.status(404).json({ error: "Interessent nicht gefunden" });
    return;
  }

  if (!["erstberatung_vereinbart", "erstberatung_durchgeführt", "neu", "kontaktiert", "wiedervorlage", "qualifiziert"].includes(prospect.status)) {
    res.status(403).json({ error: "Zugriff verweigert" });
    return;
  }

  const data = await prospectStorage.getAppointmentData(id);
  res.json(data);
}));

router.patch("/:id", requireRoles("erstberatung"), asyncHandler("Interessent konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const prospect = await prospectStorage.getById(id);
  if (!prospect) {
    res.status(404).json({ error: "Interessent nicht gefunden" });
    return;
  }

  const parsed = prospectContactUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validierungsfehler", details: parsed.error.flatten() });
    return;
  }

  const updated = await prospectStorage.update(id, parsed.data);
  res.json(updated);
}));

export default router;
