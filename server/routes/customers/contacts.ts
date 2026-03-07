import { Router } from "express";
import { insertCustomerContactSchema } from "@shared/schema";
import { storage } from "../../storage";
import { customerManagementStorage } from "../../storage/customer-management";
import { asyncHandler } from "../../lib/errors";
import { auditService } from "../../services/audit";

const router = Router();

const employeeContactUpdateSchema = insertCustomerContactSchema
  .omit({ customerId: true })
  .partial();

router.get("/:id/contacts", asyncHandler("Kontakte konnten nicht geladen werden", async (req, res) => {
  const user = req.user!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" }); return; }

  if (!user.isAdmin) {
    const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
    if (!assignedCustomerIds.includes(id)) { res.status(403).json({ error: "Zugriff verweigert" }); return; }
  }

  const contacts = await customerManagementStorage.getCustomerContacts(id);
  res.json(contacts);
}));

router.post("/:id/contacts", asyncHandler("Kontakt konnte nicht hinzugefügt werden", async (req, res) => {
  const user = req.user!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" }); return; }

  if (!user.isAdmin) {
    const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
    if (!assignedCustomerIds.includes(id)) { res.status(403).json({ error: "Zugriff verweigert" }); return; }
  }

  const validatedData = insertCustomerContactSchema.parse({ ...req.body, customerId: id });
  const contact = await customerManagementStorage.addCustomerContact(validatedData);

  await auditService.customerUpdated(user.id, id, {
    changedFields: ["notfallkontakt_hinzugefügt"],
    oldValues: {},
    newValues: { vorname: contact.vorname, nachname: contact.nachname, contactType: contact.contactType },
  }, req.ip);

  res.status(201).json(contact);
}));

router.patch("/:id/contacts/:contactId", asyncHandler("Kontakt konnte nicht aktualisiert werden", async (req, res) => {
  const user = req.user!;
  const customerId = parseInt(req.params.id);
  const contactId = parseInt(req.params.contactId);
  if (isNaN(customerId) || isNaN(contactId)) { res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige ID" }); return; }

  if (!user.isAdmin) {
    const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
    if (!assignedCustomerIds.includes(customerId)) { res.status(403).json({ error: "Zugriff verweigert" }); return; }
  }

  const result = employeeContactUpdateSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kontaktdaten", details: result.error.issues });
    return;
  }

  const contact = await customerManagementStorage.updateCustomerContact(contactId, result.data);
  if (!contact) { res.status(404).json({ error: "NOT_FOUND", message: "Kontakt nicht gefunden" }); return; }

  await auditService.customerUpdated(user.id, customerId, {
    changedFields: ["notfallkontakt_aktualisiert"],
    oldValues: {},
    newValues: { contactId, ...result.data },
  }, req.ip);

  res.json(contact);
}));

router.delete("/:id/contacts/:contactId", asyncHandler("Kontakt konnte nicht gelöscht werden", async (req, res) => {
  const user = req.user!;
  const customerId = parseInt(req.params.id);
  const contactId = parseInt(req.params.contactId);
  if (isNaN(customerId) || isNaN(contactId)) { res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige ID" }); return; }

  if (!user.isAdmin) {
    const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
    if (!assignedCustomerIds.includes(customerId)) { res.status(403).json({ error: "Zugriff verweigert" }); return; }
  }

  const deleted = await customerManagementStorage.deleteCustomerContact(contactId);
  if (!deleted) { res.status(404).json({ error: "NOT_FOUND", message: "Kontakt nicht gefunden" }); return; }

  await auditService.customerUpdated(user.id, customerId, {
    changedFields: ["notfallkontakt_gelöscht"],
    oldValues: { contactId },
    newValues: {},
  }, req.ip);

  res.json({ success: true });
}));

export default router;
