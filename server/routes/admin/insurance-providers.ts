import { Router, Request, Response } from "express";
import { customerManagementStorage } from "../../storage/customer-management";
import { insertInsuranceProviderSchema, insuranceProviderBaseSchema } from "@shared/schema";
import { ikNummerSchema } from "@shared/schema/common";
import { asyncHandler } from "../../lib/errors";
import { requireIntParam } from "../../lib/params";

const router = Router();

// Insurance Providers (Lookup table)
router.get("/insurance-providers", asyncHandler("Pflegekassen konnten nicht geladen werden", async (req: Request, res: Response) => {
  const includeInactive = req.query.all === "true";
  const providers = await customerManagementStorage.getInsuranceProviders(!includeInactive);
  res.json(providers);
}));

router.post("/insurance-providers", asyncHandler("Pflegekasse konnte nicht erstellt werden", async (req: Request, res: Response) => {
  const validatedData = insertInsuranceProviderSchema.parse(req.body);
  
  if (validatedData.ikNummer && validatedData.ikNummer.trim()) {
    const existing = await customerManagementStorage.getInsuranceProviderByIK(validatedData.ikNummer);
    if (existing) {
      res.status(409).json({ error: "CONFLICT", message: "Eine Pflegekasse mit dieser IK-Nummer existiert bereits" });
      return;
    }
  }

  const dataToSave = {
    ...validatedData,
    ikNummer: validatedData.ikNummer && validatedData.ikNummer.trim() ? validatedData.ikNummer : null,
  };
  
  const provider = await customerManagementStorage.createInsuranceProvider(dataToSave);
  res.status(201).json(provider);
}));

router.get("/insurance-providers/:id", asyncHandler("Pflegekasse konnte nicht geladen werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  const provider = await customerManagementStorage.getInsuranceProvider(id);
  if (!provider) {
    res.status(404).json({ error: "NOT_FOUND", message: "Pflegekasse nicht gefunden" });
    return;
  }
  res.json(provider);
}));

router.get("/insurance-providers/:id/active-customers", asyncHandler("Kundenzuweisungen konnten nicht geprüft werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  const count = await customerManagementStorage.getActiveCustomerCountForProvider(id);
  res.json({ count });
}));

router.put("/insurance-providers/:id", asyncHandler("Pflegekasse konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  
  const validatedData = insuranceProviderBaseSchema.partial().parse(req.body);

  if (validatedData.ikNummer !== undefined) {
    validatedData.ikNummer = validatedData.ikNummer && validatedData.ikNummer.trim() ? validatedData.ikNummer : null;
  }

  const existingProvider = await customerManagementStorage.getInsuranceProvider(id);
  if (!existingProvider) {
    res.status(404).json({ error: "NOT_FOUND", message: "Pflegekasse nicht gefunden" });
    return;
  }

  const isPrivate = validatedData.isPrivate !== undefined ? validatedData.isPrivate : existingProvider.isPrivate;
  const ikNummer = validatedData.ikNummer !== undefined ? validatedData.ikNummer : existingProvider.ikNummer;
  if (!isPrivate && !ikNummer) {
    res.status(400).json({ error: "VALIDATION", message: "IK-Nummer ist für gesetzliche Pflegekassen erforderlich" });
    return;
  }

  if (ikNummer) {
    const ikResult = ikNummerSchema.safeParse(ikNummer);
    if (!ikResult.success) {
      res.status(400).json({ error: "VALIDATION", message: "IK-Nummer muss genau 9 Ziffern haben" });
      return;
    }
  }
  
  if (validatedData.ikNummer && validatedData.ikNummer.trim()) {
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
