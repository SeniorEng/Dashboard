import { Router } from "express";
import { storage } from "../storage";
import { insertCustomerSchema } from "@shared/schema";
import { fromError } from "zod-validation-error";
import { requireAuth } from "../middleware/auth";
import { birthdaysCache } from "../services/cache";
import { documentStorage } from "../storage/documents";

const router = Router();

router.use(requireAuth);

router.get("/", async (req, res) => {
  try {
    const user = req.user!;
    const statusFilter = req.query.status as string | undefined;
    
    if (user.isAdmin) {
      let allCustomers = await storage.getCustomers();
      if (statusFilter) {
        allCustomers = allCustomers.filter(c => c.status === statusFilter);
      }
      return res.json(allCustomers);
    }
    
    let customersWithAccess = await storage.getCustomersForEmployee(user.id);
    if (statusFilter) {
      customersWithAccess = customersWithAccess.filter(c => c.status === statusFilter);
    }
    res.json(customersWithAccess);
  } catch (error) {
    console.error("Failed to fetch customers:", error);
    res.status(500).json({ error: "Kunden konnten nicht geladen werden" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const user = req.user!;
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Ungültige Kunden-ID" });
    }
    
    if (!user.isAdmin) {
      const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
      if (!assignedCustomerIds.includes(id)) {
        return res.status(403).json({ error: "Zugriff verweigert" });
      }
    }
    
    const customer = await storage.getCustomer(id);
    if (!customer) {
      return res.status(404).json({ error: "Kunde nicht gefunden" });
    }
    res.json(customer);
  } catch (error) {
    console.error("Failed to fetch customer:", error);
    res.status(500).json({ error: "Kunde konnte nicht geladen werden" });
  }
});

router.post("/", async (req, res) => {
  try {
    const validatedData = insertCustomerSchema.parse(req.body);
    const customer = await storage.createCustomer(validatedData);
    
    // Invalidate birthday cache (new customer may have birthday)
    birthdaysCache.invalidateAll();
    
    res.status(201).json(customer);
  } catch (error: any) {
    if (error.name === "ZodError") {
      return res.status(400).json({ error: fromError(error).toString() });
    }
    console.error("Failed to create customer:", error);
    res.status(500).json({ error: "Kunde konnte nicht erstellt werden" });
  }
});

router.get("/document-templates/billing-type/:billingType", async (req, res) => {
  try {
    const templates = await documentStorage.getTemplatesForBillingType(req.params.billingType);
    res.json(templates);
  } catch (error) {
    console.error("Failed to load templates:", error);
    res.status(500).json({ error: "Vorlagen konnten nicht geladen werden" });
  }
});

export default router;
