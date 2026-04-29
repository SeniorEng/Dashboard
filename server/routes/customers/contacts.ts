import { Router } from "express";
import { insertCustomerContactSchema } from "@shared/schema";
import { customerManagementStorage } from "../../storage/customer-management";
import { asyncHandler } from "../../lib/errors";
import { requireIntParam, requireCustomerAccess, requireCustomerReadAccess } from "../../lib/params";
import { auditService } from "../../services/audit";

const router = Router();

const employeeContactUpdateSchema = insertCustomerContactSchema
  .omit({ customerId: true })
  .partial();

router.get("/:id/contacts", asyncHandler("Kontakte konnten nicht geladen werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  if (!await requireCustomerReadAccess(req, res, id)) return;

  const contacts = await customerManagementStorage.getCustomerContacts(id);
  res.json(contacts);
}));

router.post("/:id/contacts", asyncHandler("Kontakt konnte nicht hinzugefügt werden", async (req, res) => {
  const user = req.user!;
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  if (!await requireCustomerAccess(req, res, id)) return;

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
  const customerId = requireIntParam(req.params.id, res);
  if (customerId === null) return;
  const contactId = requireIntParam(req.params.contactId, res);
  if (contactId === null) return;
  if (!await requireCustomerAccess(req, res, customerId)) return;

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
  const customerId = requireIntParam(req.params.id, res);
  if (customerId === null) return;
  const contactId = requireIntParam(req.params.contactId, res);
  if (contactId === null) return;
  if (!await requireCustomerAccess(req, res, customerId)) return;

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
