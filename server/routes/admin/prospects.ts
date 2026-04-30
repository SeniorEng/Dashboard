import { Router, Request, Response } from "express";
import { z } from "zod";
import { prospectStorage } from "../../storage/prospects";
import {
  insertProspectSchema, updateProspectSchema, insertProspectNoteSchema,
  qualifyProspectSchema, insertProspectOfferSchema,
  PROSPECT_STATUSES,
  customers, prospects, appointments, prospectOffers, prospectNotes,
} from "@shared/schema";
import { optionalGermanPhoneSchema, validateVersichertennummerFor } from "@shared/schema/common";
import { convertProspectSchema } from "../../lib/conversion-schemas";
import { customerManagementStorage } from "../../storage/customer-management";
import { isPflegekasseCustomer } from "@shared/domain/customers";
import { asyncHandler } from "../../lib/errors";
import { requireIntParam } from "../../lib/params";
import { parseLeadEmail } from "../../services/email-parser";
import { auditService } from "../../services/audit";
import { authService } from "../../services/auth";
import { geocodeCustomer } from "../../services/geocoding";
import { birthdaysCache, customerIdsCache } from "../../services/cache";
import { validateGeburtsdatum } from "@shared/utils/datetime";
import { createCustomerRelatedData, buildCustomerInsertData } from "../../lib/customer-creation-helpers";
import { findCustomerDuplicates } from "../../lib/duplicate-check";
import { readTestFaults } from "../../lib/test-fault-injector";
import { db } from "../../lib/db";
import { eq, and, isNull } from "drizzle-orm";

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
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

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
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

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
  const prospectId = requireIntParam(req.params.id, res);
  if (prospectId === null) return;

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
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

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
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const deleted = await prospectStorage.softDelete(id);
  if (!deleted) {
    res.status(404).json({ error: "Interessent nicht gefunden" });
    return;
  }

  res.json({ success: true });
}));

router.get("/prospects/:id/appointment-data", asyncHandler("Termindaten konnten nicht geladen werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const data = await prospectStorage.getAppointmentData(id);
  if (!data) {
    res.status(404).json({ error: "Interessent nicht gefunden" });
    return;
  }

  res.json(data);
}));

router.patch("/prospects/:id/qualify", asyncHandler("Qualifizierung fehlgeschlagen", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const parsed = qualifyProspectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validierungsfehler", details: parsed.error.flatten() });
    return;
  }

  const prospect = await prospectStorage.getById(id);
  if (!prospect) {
    res.status(404).json({ error: "Interessent nicht gefunden" });
    return;
  }

  const userId = (req as any).user?.id;
  let updated;

  if (parsed.data.action === "qualify") {
    updated = await prospectStorage.qualify(id, prospect.geoQualified);
    await prospectStorage.addNote({
      prospectId: id,
      userId,
      noteText: "Interessent als qualifiziert markiert",
      noteType: "statuswechsel",
    });
  } else {
    updated = await prospectStorage.disqualify(id, parsed.data.disqualificationReason!);
    await prospectStorage.addNote({
      prospectId: id,
      userId,
      noteText: `Interessent disqualifiziert: ${parsed.data.disqualificationReason}`,
      noteType: "statuswechsel",
    });
  }

  res.json(updated);
}));

router.post("/prospects/:id/offers", asyncHandler("Angebot konnte nicht gespeichert werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const parsed = insertProspectOfferSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validierungsfehler", details: parsed.error.flatten() });
    return;
  }

  const prospect = await prospectStorage.getById(id);
  if (!prospect) {
    res.status(404).json({ error: "Interessent nicht gefunden" });
    return;
  }

  const userId = (req as any).user?.id;
  const offer = await prospectStorage.createOffer(id, parsed.data.wizardData, userId, parsed.data.expiresAt);

  await prospectStorage.update(id, { status: "angebot_gemacht" });
  await prospectStorage.addNote({
    prospectId: id,
    userId,
    noteText: "Angebot erstellt und gespeichert",
    noteType: "statuswechsel",
  });

  res.status(201).json(offer);
}));

router.get("/prospects/:id/offer", asyncHandler("Angebot konnte nicht geladen werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const offer = await prospectStorage.getOpenOffer(id);
  res.json(offer || null);
}));


router.post("/prospects/:id/convert", asyncHandler("Konvertierung fehlgeschlagen", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const prospect = await prospectStorage.getById(id);
  if (!prospect) {
    res.status(404).json({ error: "NOT_FOUND", message: "Interessent nicht gefunden" });
    return;
  }

  if (prospect.convertedCustomerId) {
    res.status(400).json({ error: "ALREADY_CONVERTED", message: "Interessent wurde bereits konvertiert" });
    return;
  }

  const data = convertProspectSchema.parse(req.body);

  if (data.insurance?.versichertennummer) {
    const vnr = data.insurance.versichertennummer;
    const provider = await customerManagementStorage.getInsuranceProvider(data.insurance.providerId);
    const result = validateVersichertennummerFor(vnr, {
      billingType: data.billingType,
      isPrivateProvider: provider?.isPrivate ?? false,
    });
    if (!result.ok) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: result.message });
      return;
    }
  }

  if (!data.skipDuplicateCheck) {
    const duplicates = await findCustomerDuplicates(data.vorname, data.nachname, data.geburtsdatum);
    if (duplicates.length > 0) {
      res.status(409).json({
        error: "DUPLICATE_WARNING",
        code: "DUPLICATE_WARNING",
        message: `Es existiert bereits ${duplicates.length === 1 ? "ein Kunde" : `${duplicates.length} Kunden`} mit gleichem Namen. Zum Konvertieren "skipDuplicateCheck" setzen.`,
        details: { duplicates },
      });
      return;
    }
  }

  const geburtsdatumError = validateGeburtsdatum(data.geburtsdatum);
  if (geburtsdatumError) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: geburtsdatumError });
    return;
  }

  const userId = req.user!.id;
  const warnings: string[] = [];
  const testFaults = readTestFaults(req);

  // Atomare Konvertierung (Task #267): Customer-Insert, Appointment-
  // Reassign, Offer-Update, Prospect-Status UND die gesamte Pflicht-
  // Cascade (Pflegegrad, Insurance, Budget, Vertrag) müssen gemeinsam
  // committen. Sonst entstehen "halb konvertierte" Interessenten, die im
  // UI als gewonnen markiert sind, aber Folge-Workflows scheitern lassen.
  const { result, relatedWarnings } = await db.transaction(async (tx) => {
    const [customer] = await tx.insert(customers).values({
      ...buildCustomerInsertData(data, userId),
      status: "aktiv",
      primaryEmployeeId: data.primaryEmployeeId ?? null,
      backupEmployeeId: data.backupEmployeeId ?? null,
      backupEmployeeId2: data.backupEmployeeId2 ?? null,
      convertedFromProspectId: id,
    }).returning();

    await tx.update(appointments)
      .set({ customerId: customer.id })
      .where(and(
        eq(appointments.prospectId, id),
        isNull(appointments.customerId),
      ));

    const openOffer = await tx
      .select()
      .from(prospectOffers)
      .where(and(
        eq(prospectOffers.prospectId, id),
        eq(prospectOffers.status, "offen"),
      ))
      .then(rows => rows[0]);

    if (openOffer) {
      await tx.update(prospectOffers)
        .set({ status: "angenommen" })
        .where(eq(prospectOffers.id, openOffer.id));
    }

    await tx.update(prospects)
      .set({
        status: "gewonnen",
        convertedCustomerId: customer.id,
        updatedAt: new Date(),
      })
      .where(eq(prospects.id, id));

    const w = await createCustomerRelatedData({
      customerId: customer.id,
      userId,
      logPrefix: "POST /prospects/:id/convert",
      pflegegrad: data.pflegegrad,
      pflegegradSeit: data.pflegegradSeit,
      insurance: data.insurance && isPflegekasseCustomer(data.billingType) ? data.insurance : undefined,
      contacts: data.contacts,
      budgets: data.budgets && isPflegekasseCustomer(data.billingType) ? data.budgets : undefined,
      contract: data.contract,
      useLedgerBudgets: false,
      tx,
      testFaults,
    });

    return { result: customer, relatedWarnings: w };
  });

  customerIdsCache.invalidateAll();
  warnings.push(...relatedWarnings);

  if (data.primaryEmployeeId !== undefined || data.backupEmployeeId !== undefined || data.backupEmployeeId2 !== undefined) {
    const empIds = [data.primaryEmployeeId, data.backupEmployeeId, data.backupEmployeeId2].filter((id): id is number => id != null);
    const uniqueEmpIds = new Set(empIds);
    if (empIds.length !== uniqueEmpIds.size) {
      warnings.push("Mitarbeiter-Zuordnung: Alle zugewiesenen Mitarbeiter müssen unterschiedlich sein");
    } else {
      for (const empId of empIds) {
        const emp = await authService.getUser(empId);
        if (!emp || !emp.isActive) {
          warnings.push(`Mitarbeiter ${empId} nicht gefunden oder nicht aktiv`);
        }
      }
    }
  }

  auditService.log(userId, "prospect_converted", "prospect", id, { customerId: result.id }, req.ip);

  birthdaysCache.invalidateAll();
  geocodeCustomer(result.id).catch(err => console.error("[geocoding] Background geocoding failed:", err));

  res.status(201).json({
    customer: result,
    warnings: warnings.length > 0 ? warnings : undefined,
  });
}));

export default router;
