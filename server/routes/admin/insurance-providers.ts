import { Router, Request, Response } from "express";
import { customerManagementStorage } from "../../storage/customer-management";
import { insertInsuranceProviderSchema } from "@shared/schema";
import { asyncHandler } from "../../lib/errors";

const router = Router();

// Insurance Providers (Lookup table)
router.get("/insurance-providers", asyncHandler("Pflegekassen konnten nicht geladen werden", async (req: Request, res: Response) => {
  const includeInactive = req.query.all === "true";
  const providers = await customerManagementStorage.getInsuranceProviders(!includeInactive);
  res.json(providers);
}));

router.post("/insurance-providers", asyncHandler("Pflegekasse konnte nicht erstellt werden", async (req: Request, res: Response) => {
  const validatedData = insertInsuranceProviderSchema.parse(req.body);
  
  const existing = await customerManagementStorage.getInsuranceProviderByIK(validatedData.ikNummer);
  if (existing) {
    res.status(409).json({ error: "CONFLICT", message: "Eine Pflegekasse mit dieser IK-Nummer existiert bereits" });
    return;
  }
  
  const provider = await customerManagementStorage.createInsuranceProvider(validatedData);
  res.status(201).json(provider);
}));

router.get("/insurance-providers/:id", asyncHandler("Pflegekasse konnte nicht geladen werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige ID" });
    return;
  }
  const provider = await customerManagementStorage.getInsuranceProvider(id);
  if (!provider) {
    res.status(404).json({ error: "NOT_FOUND", message: "Pflegekasse nicht gefunden" });
    return;
  }
  res.json(provider);
}));

router.get("/insurance-providers/:id/active-customers", asyncHandler("Kundenzuweisungen konnten nicht geprüft werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige ID" });
    return;
  }
  const count = await customerManagementStorage.getActiveCustomerCountForProvider(id);
  res.json({ count });
}));

router.put("/insurance-providers/:id", asyncHandler("Pflegekasse konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige ID" });
    return;
  }
  
  const validatedData = insertInsuranceProviderSchema.partial().parse(req.body);
  
  if (validatedData.ikNummer) {
    const existing = await customerManagementStorage.getInsuranceProviderByIK(validatedData.ikNummer);
    if (existing && existing.id !== id) {
      res.status(409).json({ error: "CONFLICT", message: "Eine andere Pflegekasse mit dieser IK-Nummer existiert bereits" });
      return;
    }
  }
  
  const provider = await customerManagementStorage.updateInsuranceProvider(id, validatedData);
  if (!provider) {
    res.status(404).json({ error: "NOT_FOUND", message: "Pflegekasse nicht gefunden" });
    return;
  }
  res.json(provider);
}));

export default router;
