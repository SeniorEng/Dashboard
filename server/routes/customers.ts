import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { insertCustomerSchema } from "@shared/schema";
import { fromError } from "zod-validation-error";
import { requireAuth } from "../middleware/auth";
import { birthdaysCache } from "../services/cache";
import { documentStorage } from "../storage/documents";
import { BILLING_TYPES } from "@shared/domain/customers";
import { renderTemplateForCustomer } from "../services/template-engine";
import { computeDataHash } from "../services/signature-integrity";

const billingTypeEnum = z.enum(BILLING_TYPES as unknown as [string, ...string[]]);

const router = Router();

router.use(requireAuth);

router.get("/document-templates/billing-type/:billingType", async (req, res) => {
  try {
    const parsed = billingTypeEnum.safeParse(req.params.billingType);
    if (!parsed.success) {
      return res.status(400).json({ error: "Ungültiger Kundentyp" });
    }
    const templates = await documentStorage.getTemplatesForBillingType(parsed.data);
    res.json(templates);
  } catch (error) {
    console.error("Failed to load templates:", error);
    res.status(500).json({ error: "Vorlagen konnten nicht geladen werden" });
  }
});

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

const signaturePayloadSchema = z.object({
  signatures: z.array(z.object({
    templateSlug: z.string().min(1),
    customerSignatureData: z.string().regex(/^data:image\/(png|jpeg);base64,/, "Ungültiges Signaturformat"),
  })),
});

router.post("/:id/signatures", async (req, res) => {
  try {
    const customerId = parseInt(req.params.id);
    if (isNaN(customerId)) {
      return res.status(400).json({ error: "Ungültige Kunden-ID" });
    }

    const customer = await storage.getCustomer(customerId);
    if (!customer) {
      return res.status(404).json({ error: "Kunde nicht gefunden" });
    }

    const parsed = signaturePayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Ungültige Daten", details: parsed.error.issues });
    }

    const userId = req.user!.id;
    const results = [];

    for (const sig of parsed.data.signatures) {
      try {
        const rendered = await renderTemplateForCustomer(sig.templateSlug, customerId);
        const hash = computeDataHash(JSON.stringify({
          customerId,
          templateId: rendered.templateId,
          templateVersion: rendered.templateVersion,
          customerSignatureData: sig.customerSignatureData,
        }));

        const doc = await documentStorage.createGeneratedDocument({
          customerId,
          templateId: rendered.templateId,
          templateVersion: rendered.templateVersion,
          fileName: `${sig.templateSlug}_signed.html`,
          objectPath: `generated/${customerId}/${sig.templateSlug}_${Date.now()}.html`,
          customerSignatureData: sig.customerSignatureData,
          integrityHash: hash,
        }, userId);
        results.push(doc);
      } catch {
      }
    }

    res.status(201).json(results);
  } catch (error) {
    console.error("Failed to save signatures:", error);
    res.status(500).json({ error: "Unterschriften konnten nicht gespeichert werden" });
  }
});

export default router;
