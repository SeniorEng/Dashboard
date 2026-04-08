import { Router, Request, Response } from "express";
import { customerManagementStorage } from "../../../storage/customer-management";
import { asyncHandler } from "../../../lib/errors";
import { requireIntParam } from "../../../lib/params";
import {
  insertCustomerInsuranceSchema,
  insertCustomerContactSchema,
  insertCareLevelHistorySchema,
} from "@shared/schema";
import { versichertennummerFlexSchema } from "@shared/schema/common";

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
  const provider = providerId ? await customerManagementStorage.getInsuranceProvider(providerId) : null;
  const isPrivate = provider?.isPrivate || false;

  const schema = isPrivate
    ? insertCustomerInsuranceSchema.extend({ versichertennummer: versichertennummerFlexSchema })
    : insertCustomerInsuranceSchema;

  const data = schema.parse({ ...req.body, customerId });
  const insurance = await customerManagementStorage.addCustomerInsurance(data, req.user!.id);
  res.status(201).json(insurance);
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
  const contact = await customerManagementStorage.addCustomerContact(validatedData);
  res.status(201).json(contact);
}));

const updateCustomerContactSchema = insertCustomerContactSchema
  .omit({ customerId: true })
  .partial();

router.patch("/customers/:customerId/contacts/:contactId", asyncHandler("Kontakt konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
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
  
  const contact = await customerManagementStorage.updateCustomerContact(contactId, result.data);
  if (!contact) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kontakt nicht gefunden" });
    return;
  }
  
  res.json(contact);
}));

router.delete("/customers/:customerId/contacts/:contactId", asyncHandler("Kontakt konnte nicht gelöscht werden", async (req: Request, res: Response) => {
  const contactId = requireIntParam(req.params.contactId, res);
  if (contactId === null) return;
  
  const deleted = await customerManagementStorage.deleteCustomerContact(contactId);
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
  
  const validatedData = insertCareLevelHistorySchema.parse({ ...req.body, customerId });
  const careLevel = await customerManagementStorage.addCareLevelHistory(validatedData, req.user!.id);
  res.status(201).json(careLevel);
}));

export default router;
