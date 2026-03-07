import { Router, Request, Response } from "express";
import { customerManagementStorage } from "../../../storage/customer-management";
import { asyncHandler } from "../../../lib/errors";
import {
  insertCustomerInsuranceSchema,
  insertCustomerContactSchema,
  insertCareLevelHistorySchema,
} from "@shared/schema";

const router = Router();

router.get("/customers/:id/insurance", asyncHandler("Versicherungshistorie konnte nicht geladen werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
    return;
  }
  
  const history = await customerManagementStorage.getCustomerInsuranceHistory(id);
  res.json(history);
}));

router.post("/customers/:id/insurance", asyncHandler("Versicherung konnte nicht hinzugefügt werden", async (req: Request, res: Response) => {
  const customerId = parseInt(req.params.id);
  if (isNaN(customerId)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
    return;
  }
  
  const data = insertCustomerInsuranceSchema.parse({ ...req.body, customerId });
  const insurance = await customerManagementStorage.addCustomerInsurance(data, req.user!.id);
  res.status(201).json(insurance);
}));

router.get("/customers/:id/contacts", asyncHandler("Kontakte konnten nicht geladen werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
    return;
  }
  
  const contacts = await customerManagementStorage.getCustomerContacts(id);
  res.json(contacts);
}));

router.post("/customers/:id/contacts", asyncHandler("Kontakt konnte nicht hinzugefügt werden", async (req: Request, res: Response) => {
  const customerId = parseInt(req.params.id);
  if (isNaN(customerId)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
    return;
  }
  
  const validatedData = insertCustomerContactSchema.parse({ ...req.body, customerId });
  const contact = await customerManagementStorage.addCustomerContact(validatedData);
  res.status(201).json(contact);
}));

const updateCustomerContactSchema = insertCustomerContactSchema
  .omit({ customerId: true })
  .partial();

router.patch("/customers/:customerId/contacts/:contactId", asyncHandler("Kontakt konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
  const contactId = parseInt(req.params.contactId);
  if (isNaN(contactId)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kontakt-ID" });
    return;
  }
  
  const result = updateCustomerContactSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Ungültige Kontaktdaten",
      details: result.error.issues,
    });
    return;
  }
  
  const contact = await customerManagementStorage.updateCustomerContact(contactId, result.data);
  if (!contact) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kontakt nicht gefunden" });
    return;
  }
  
  res.json(contact);
}));

router.delete("/customers/:customerId/contacts/:contactId", asyncHandler("Kontakt konnte nicht gelöscht werden", async (req: Request, res: Response) => {
  const contactId = parseInt(req.params.contactId);
  if (isNaN(contactId)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kontakt-ID" });
    return;
  }
  
  const deleted = await customerManagementStorage.deleteCustomerContact(contactId);
  if (!deleted) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kontakt nicht gefunden" });
    return;
  }
  
  res.json({ success: true });
}));

router.get("/customers/:id/care-level", asyncHandler("Pflegegrad-Historie konnte nicht geladen werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
    return;
  }
  
  const history = await customerManagementStorage.getCustomerCareLevelHistory(id);
  res.json(history);
}));

router.post("/customers/:id/care-level", asyncHandler("Pflegegrad konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
  const customerId = parseInt(req.params.id);
  if (isNaN(customerId)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
    return;
  }
  
  const validatedData = insertCareLevelHistorySchema.parse({ ...req.body, customerId });
  const careLevel = await customerManagementStorage.addCareLevelHistory(validatedData, req.user!.id);
  res.status(201).json(careLevel);
}));

export default router;
