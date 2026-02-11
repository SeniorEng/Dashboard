import { Router, Request, Response } from "express";
import { customerPricingStorage } from "../../storage/customer-pricing";
import { insertCustomerPricingSchema } from "@shared/schema";
import { handleRouteError } from "../../lib/errors";
import { fromError } from "zod-validation-error";
import { todayISO } from "@shared/utils/datetime";

const router = Router();

// ============================================
// CUSTOMER PRICING
// ============================================

router.get("/customers/:customerId/pricing", async (req: Request, res: Response) => {
  try {
    const customerId = parseInt(req.params.customerId);
    if (isNaN(customerId)) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
      return;
    }

    const history = await customerPricingStorage.getPricingHistory(customerId);
    res.json(history);
  } catch (error) {
    handleRouteError(res, error, "Preishistorie konnte nicht geladen werden");
  }
});

router.get("/customers/:customerId/pricing/current", async (req: Request, res: Response) => {
  try {
    const customerId = parseInt(req.params.customerId);
    if (isNaN(customerId)) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
      return;
    }

    const current = await customerPricingStorage.getCurrentPricing(customerId);
    res.json(current);
  } catch (error) {
    handleRouteError(res, error, "Aktuelle Preise konnten nicht geladen werden");
  }
});

router.post("/customers/:customerId/pricing", async (req: Request, res: Response) => {
  try {
    const customerId = parseInt(req.params.customerId);
    if (isNaN(customerId)) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
      return;
    }

    const data = { ...req.body, customerId };
    const validatedData = insertCustomerPricingSchema.parse(data);
    
    // Prevent backdated pricing entries - only today or future allowed
    const today = todayISO();
    if (validatedData.validFrom < today) {
      res.status(400).json({ 
        error: "VALIDATION_ERROR", 
        message: "Preise können nicht rückwirkend angelegt werden. Bitte wählen Sie ein Datum ab heute." 
      });
      return;
    }
    
    const pricing = await customerPricingStorage.addPricing(validatedData, req.user!.id);
    res.status(201).json(pricing);
  } catch (error: any) {
    if (error.name === "ZodError") {
      res.status(400).json({ error: "VALIDATION_ERROR", message: fromError(error).toString() });
      return;
    }
    handleRouteError(res, error, "Preise konnten nicht hinzugefügt werden");
  }
});

export default router;
