import { Router, Request, Response } from "express";
import { customerManagementStorage } from "../../../storage/customer-management";
import { storage } from "../../../storage";
import { asyncHandler, notFound } from "../../../lib/errors";
import { requireIntParam } from "../../../lib/params";
import { withAudit } from "../../../lib/with-audit";
import {
  insertCustomerInsuranceSchema,
  updateCustomerInsuranceSchema,
  insertCustomerContactSchema,
  insertCareLevelHistorySchema,
} from "@shared/schema";
import { pickVersichertennummerSchema } from "@shared/schema/common";

const router = Router();

router.get("/customers/:id/insurance", asyncHandler("Versicherungshistorie konnte nicht geladen werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  
  const history = await customerManagementStorage.getCustomerInsuranceHistory(id);
  res.json(history);
}));

router.post("/customers/:id/insurance", asyncHandler("Versicherung konnte nicht hinzugefügt werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.id, res);
  if (customerId === null) return;
  
  const providerId = Number(req.body.insuranceProviderId);
  const [provider, customer] = await Promise.all([
    providerId ? customerManagementStorage.getInsuranceProvider(providerId) : Promise.resolve(null),
    storage.getCustomer(customerId),
  ]);

  const versichertennummerSchemaForCase = pickVersichertennummerSchema({
    billingType: customer?.billingType,
    isPrivateProvider: provider?.isPrivate ?? false,
  });

  const schema = insertCustomerInsuranceSchema.extend({ versichertennummer: versichertennummerSchemaForCase });

  const data = schema.parse({ ...req.body, customerId });

  const insurance = await withAudit(async (tx, audit) => {
    const created = await customerManagementStorage.addCustomerInsurance(data, req.user!.id, tx);
    audit.record({
      userId: req.user!.id,
      action: "customer_updated",
      entityType: "customer",
      entityId: customerId,
      metadata: {
        changedFields: ["versicherung_hinzugefügt"],
        oldValues: {},
        newValues: {
          insuranceId: created.id,
          insuranceProviderId: created.insuranceProviderId,
          versichertennummer: created.versichertennummer,
          validFrom: created.validFrom,
        },
      },
      ipAddress: req.ip,
    });
    return created;
  });

  res.status(201).json(insurance);
}));

// Task #1893 — Korrektur einer bestehenden Kostenträger-Zuordnung.
// Gültig-ab/-bis und Versichertennummer sind korrigierbar; Kasse und Kunde nicht
// (ein Wechsel ist eine neue Zeile, keine Korrektur). Die Fenster-Regeln
// (Monatserster, überlappungs-/lückenfrei) erzwingt `updateCustomerInsurance`.
router.patch("/customers/:id/insurance/:insuranceId", asyncHandler("Versicherung konnte nicht geändert werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.id, res);
  if (customerId === null) return;
  const insuranceId = requireIntParam(req.params.insuranceId, res);
  if (insuranceId === null) return;

  const patch = updateCustomerInsuranceSchema.parse(req.body);

  const existing = await customerManagementStorage.getCustomerInsuranceHistory(customerId);
  const target = existing.find((e) => e.id === insuranceId);
  if (!target) throw notFound("Versicherungs-Zuordnung nicht gefunden");

  const updated = await withAudit(async (tx, audit) => {
    const row = await customerManagementStorage.updateCustomerInsurance(insuranceId, patch, tx);
    audit.record({
      userId: req.user!.id,
      action: "customer_updated",
      entityType: "customer",
      entityId: customerId,
      metadata: {
        changedFields: ["versicherung_korrigiert"],
        oldValues: {
          insuranceId: target.id,
          validFrom: target.validFrom,
          validTo: target.validTo,
          versichertennummer: target.versichertennummer,
        },
        newValues: {
          insuranceId: row.id,
          validFrom: row.validFrom,
          validTo: row.validTo,
          versichertennummer: row.versichertennummer,
        },
      },
      ipAddress: req.ip,
    });
    return row;
  });

  res.json(updated);
}));

router.get("/customers/:id/contacts", asyncHandler("Kontakte konnten nicht geladen werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  
  const contacts = await customerManagementStorage.getCustomerContacts(id);
  res.json(contacts);
}));

router.post("/customers/:id/contacts", asyncHandler("Kontakt konnte nicht hinzugefügt werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.id, res);
  if (customerId === null) return;
  
  const validatedData = insertCustomerContactSchema.parse({ ...req.body, customerId });

  const contact = await withAudit(async (tx, audit) => {
    const created = await customerManagementStorage.addCustomerContact(validatedData, tx);
    audit.record({
      userId: req.user!.id,
      action: "customer_updated",
      entityType: "customer",
      entityId: customerId,
      metadata: {
        changedFields: ["notfallkontakt_hinzugefügt"],
        oldValues: {},
        newValues: { contactId: created.id, vorname: created.vorname, nachname: created.nachname, contactType: created.contactType },
      },
      ipAddress: req.ip,
    });
    return created;
  });

  res.status(201).json(contact);
}));

const updateCustomerContactSchema = insertCustomerContactSchema
  .omit({ customerId: true })
  .partial();

router.patch("/customers/:customerId/contacts/:contactId", asyncHandler("Kontakt konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;
  const contactId = requireIntParam(req.params.contactId, res);
  if (contactId === null) return;
  
  const result = updateCustomerContactSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Ungültige Kontaktdaten",
      details: result.error.issues,
    });
    return;
  }

  // Bindung des Kontakts an den Kunden in der URL verifizieren, damit der
  // Audit-Eintrag nicht unter einer fremden Kunden-ID landet (IDOR/Integrität).
  const existingContact = await customerManagementStorage.getCustomerContact(contactId);
  if (!existingContact || existingContact.customerId !== customerId) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kontakt nicht gefunden" });
    return;
  }

  const contact = await withAudit(async (tx, audit) => {
    const updated = await customerManagementStorage.updateCustomerContact(contactId, result.data, tx);
    if (!updated) return undefined;
    audit.record({
      userId: req.user!.id,
      action: "customer_updated",
      entityType: "customer",
      entityId: customerId,
      metadata: {
        changedFields: ["notfallkontakt_aktualisiert"],
        oldValues: { contactId, vorname: existingContact.vorname, nachname: existingContact.nachname, contactType: existingContact.contactType },
        newValues: { contactId, ...result.data },
      },
      ipAddress: req.ip,
    });
    return updated;
  });

  if (!contact) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kontakt nicht gefunden" });
    return;
  }
  
  res.json(contact);
}));

router.delete("/customers/:customerId/contacts/:contactId", asyncHandler("Kontakt konnte nicht gelöscht werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;
  const contactId = requireIntParam(req.params.contactId, res);
  if (contactId === null) return;

  // Bindung des Kontakts an den Kunden in der URL verifizieren, damit der
  // Audit-Eintrag nicht unter einer fremden Kunden-ID landet (IDOR/Integrität).
  const existingContact = await customerManagementStorage.getCustomerContact(contactId);
  if (!existingContact || existingContact.customerId !== customerId) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kontakt nicht gefunden" });
    return;
  }

  const deleted = await withAudit(async (tx, audit) => {
    const ok = await customerManagementStorage.deleteCustomerContact(contactId, tx);
    if (!ok) return false;
    audit.record({
      userId: req.user!.id,
      action: "customer_updated",
      entityType: "customer",
      entityId: customerId,
      metadata: {
        changedFields: ["notfallkontakt_gelöscht"],
        oldValues: { contactId, vorname: existingContact.vorname, nachname: existingContact.nachname, contactType: existingContact.contactType },
        newValues: {},
      },
      ipAddress: req.ip,
    });
    return ok;
  });

  if (!deleted) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kontakt nicht gefunden" });
    return;
  }
  
  res.json({ success: true });
}));

router.get("/customers/:id/care-level", asyncHandler("Pflegegrad-Historie konnte nicht geladen werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  
  const history = await customerManagementStorage.getCustomerCareLevelHistory(id);
  res.json(history);
}));

router.post("/customers/:id/care-level", asyncHandler("Pflegegrad konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.id, res);
  if (customerId === null) return;
  
  const customer = await storage.getCustomer(customerId);
  const oldPflegegrad = customer?.pflegegrad ?? null;

  const validatedData = insertCareLevelHistorySchema.parse({ ...req.body, customerId });

  const careLevel = await withAudit(async (tx, audit) => {
    const created = await customerManagementStorage.addCareLevelHistory(validatedData, req.user!.id, tx);
    audit.record({
      userId: req.user!.id,
      action: "customer_care_level_changed",
      entityType: "customer",
      entityId: customerId,
      metadata: {
        oldPflegegrad,
        newPflegegrad: validatedData.pflegegrad,
        seitDatum: validatedData.validFrom,
      },
      ipAddress: req.ip,
    });
    return created;
  });

  res.status(201).json(careLevel);
}));

export default router;
