import { Router, Request, Response } from "express";
import { customerManagementStorage } from "../../storage/customer-management";
import { insertInsuranceProviderSchema } from "@shared/schema";
import { handleRouteError } from "../../lib/errors";
import { fromError } from "zod-validation-error";

const router = Router();

// Insurance Providers (Lookup table)
router.get("/insurance-providers", async (req: Request, res: Response) => {
  try {
    const includeInactive = req.query.all === "true";
    const providers = await customerManagementStorage.getInsuranceProviders(!includeInactive);
    res.json(providers);
  } catch (error) {
    handleRouteError(res, error, "Pflegekassen konnten nicht geladen werden");
  }
});

router.post("/insurance-providers", async (req: Request, res: Response) => {
  try {
    const validatedData = insertInsuranceProviderSchema.parse(req.body);
    
    const existing = await customerManagementStorage.getInsuranceProviderByIK(validatedData.ikNummer);
    if (existing) {
      res.status(409).json({ error: "CONFLICT", message: "Eine Pflegekasse mit dieser IK-Nummer existiert bereits" });
      return;
    }
    
    const provider = await customerManagementStorage.createInsuranceProvider(validatedData);
    res.status(201).json(provider);
  } catch (error: any) {
    if (error.name === "ZodError") {
      res.status(400).json({ error: "VALIDATION_ERROR", message: fromError(error).toString() });
      return;
    }
    handleRouteError(res, error, "Pflegekasse konnte nicht erstellt werden");
  }
});

router.get("/insurance-providers/:id", async (req: Request, res: Response) => {
  try {
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
  } catch (error) {
    handleRouteError(res, error, "Pflegekasse konnte nicht geladen werden");
  }
});

router.get("/insurance-providers/:id/active-customers", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige ID" });
      return;
    }
    const count = await customerManagementStorage.getActiveCustomerCountForProvider(id);
    res.json({ count });
  } catch (error) {
    handleRouteError(res, error, "Kundenzuweisungen konnten nicht geprüft werden");
  }
});

router.put("/insurance-providers/:id", async (req: Request, res: Response) => {
  try {
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
  } catch (error: any) {
    if (error.name === "ZodError") {
      res.status(400).json({ error: "VALIDATION_ERROR", message: fromError(error).toString() });
      return;
    }
    handleRouteError(res, error, "Pflegekasse konnte nicht aktualisiert werden");
  }
});

export default router;
