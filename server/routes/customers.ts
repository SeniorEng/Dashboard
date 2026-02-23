import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { insertCustomerSchema } from "@shared/schema";
import { fromError } from "zod-validation-error";
import { requireAuth, requireRoles } from "../middleware/auth";
import { birthdaysCache } from "../services/cache";
import { documentStorage } from "../storage/documents";
import { BILLING_TYPES } from "@shared/domain/customers";
import { isPflegekasseCustomer } from "@shared/domain/customers";
import { renderTemplateForCustomer } from "../services/template-engine";
import { computeDataHash } from "../services/signature-integrity";
import { customerManagementStorage } from "../storage/customer-management";
import { asyncHandler, forbidden } from "../lib/errors";
import { todayISO } from "@shared/utils/datetime";
import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { insertCustomerServicePriceSchema } from "@shared/schema";

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

router.get("/:id/details", async (req, res) => {
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
    
    const [contacts, insurance, contract] = await Promise.all([
      customerManagementStorage.getCustomerContacts(id),
      customerManagementStorage.getCustomerCurrentInsurance(id),
      customerManagementStorage.getCustomerCurrentContract(id),
    ]);
    
    res.json({
      contacts,
      insurance: insurance ? {
        providerName: insurance.provider?.name || "Unbekannt",
        ikNummer: insurance.provider?.ikNummer || undefined,
        versichertennummer: insurance.versichertennummer,
      } : null,
      contract: contract ? {
        vereinbarteLeistungen: contract.vereinbarteLeistungen,
        contractStart: contract.contractStart,
        status: contract.status,
      } : null,
    });
  } catch (error) {
    console.error("Failed to fetch customer details:", error);
    res.status(500).json({ error: "Kundendetails konnten nicht geladen werden" });
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

    const user = req.user!;
    if (!user.isAdmin) {
      const assignedIds = await storage.getAssignedCustomerIds(user.id);
      if (!assignedIds.includes(customerId)) {
        return res.status(403).json({
          error: "FORBIDDEN",
          message: "Kein Zugriff auf diesen Kunden",
        });
      }
    }

    const customer = await storage.getCustomer(customerId);
    if (!customer) {
      return res.status(404).json({ error: "Kunde nicht gefunden" });
    }

    const parsed = signaturePayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Ungültige Daten", details: parsed.error.issues });
    }

    const userId = user.id;
    const results = [];
    const errors: { slug: string; error: string }[] = [];

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
          signingStatus: "complete" as const,
        }, userId);
        results.push(doc);
      } catch (err) {
        errors.push({ slug: sig.templateSlug, error: String(err) });
        console.error(`Signatur ${sig.templateSlug} fehlgeschlagen:`, err);
      }
    }

    if (errors.length > 0 && results.length === 0) {
      return res.status(500).json({ error: "Alle Unterschriften fehlgeschlagen", details: errors });
    }

    res.status(results.length === parsed.data.signatures.length ? 201 : 207).json({ results, errors });
  } catch (error) {
    console.error("Failed to save signatures:", error);
    res.status(500).json({ error: "Unterschriften konnten nicht gespeichert werden" });
  }
});

const convertCustomerSchema = z.object({
  billingType: z.enum(["pflegekasse_gesetzlich", "pflegekasse_privat", "selbstzahler"]),
  vorname: z.string().min(1),
  nachname: z.string().min(1),
  geburtsdatum: z.string().optional().nullable(),
  email: z.string().email().optional().nullable(),
  telefon: z.string().optional().nullable(),
  festnetz: z.string().optional().nullable(),
  strasse: z.string().min(1),
  nr: z.string().min(1),
  plz: z.string().regex(/^\d{5}$/),
  stadt: z.string().min(1),
  pflegegrad: z.number().min(1).max(5).optional(),
  pflegegradSeit: z.string().optional(),
  vorerkrankungen: z.string().max(2000).optional().nullable(),
  haustierVorhanden: z.boolean().optional(),
  haustierDetails: z.string().max(500).optional().nullable(),
  personenbefoerderungGewuenscht: z.boolean().optional(),
  documentDeliveryMethod: z.enum(["email", "post"]).optional(),
  insurance: z.object({
    providerId: z.number(),
    versichertennummer: z.string(),
    validFrom: z.string(),
  }).optional(),
  contacts: z.array(z.object({
    contactType: z.string(),
    isPrimary: z.boolean(),
    vorname: z.string(),
    nachname: z.string(),
    telefon: z.string(),
    email: z.string().optional(),
  })).optional(),
  budgets: z.object({
    entlastungsbetrag45b: z.number(),
    verhinderungspflege39: z.number(),
    pflegesachleistungen36: z.number(),
    validFrom: z.string(),
  }).optional(),
  contract: z.object({
    contractStart: z.string(),
    contractDate: z.string().optional(),
    vereinbarteLeistungen: z.string().optional(),
    hoursPerPeriod: z.number(),
    periodType: z.string(),
    rates: z.array(z.object({
      serviceCategory: z.string(),
      hourlyRateCents: z.number(),
    })).optional(),
  }).optional(),
  primaryEmployeeId: z.number().nullable().optional(),
  backupEmployeeId: z.number().nullable().optional(),
});

router.post("/:id/convert", requireRoles("erstberatung"), asyncHandler("Konvertierung fehlgeschlagen", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
    return;
  }

  if (!req.user!.isAdmin) {
    const assignedCustomerIds = await storage.getAssignedCustomerIds(req.user!.id);
    if (!assignedCustomerIds.includes(id)) {
      res.status(403).json({ error: "FORBIDDEN", message: "Zugriff verweigert" });
      return;
    }
  }

  const customer = await storage.getCustomer(id);
  if (!customer) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" });
    return;
  }

  if (customer.status !== "erstberatung") {
    res.status(400).json({ error: "INVALID_STATUS", message: "Nur Erstberatungskunden können konvertiert werden" });
    return;
  }

  const data = convertCustomerSchema.parse(req.body);
  const userId = req.user!.id;
  const today = todayISO();
  const warnings: string[] = [];

  const updateData: any = {
    name: `${data.nachname}, ${data.vorname}`,
    vorname: data.vorname,
    nachname: data.nachname,
    email: data.email || null,
    telefon: data.telefon || null,
    festnetz: data.festnetz || null,
    address: `${data.strasse} ${data.nr}, ${data.plz} ${data.stadt}`,
    strasse: data.strasse,
    nr: data.nr,
    plz: data.plz,
    stadt: data.stadt,
    pflegegrad: data.pflegegrad || null,
    geburtsdatum: data.geburtsdatum || null,
    vorerkrankungen: data.vorerkrankungen || null,
    haustierVorhanden: data.haustierVorhanden || false,
    haustierDetails: data.haustierVorhanden ? (data.haustierDetails || null) : null,
    personenbefoerderungGewuenscht: data.personenbefoerderungGewuenscht || false,
    documentDeliveryMethod: data.documentDeliveryMethod || "email",
    billingType: data.billingType,
    status: "aktiv",
  };

  const updated = await customerManagementStorage.updateCustomer(id, updateData);
  if (!updated) {
    res.status(500).json({ error: "UPDATE_FAILED", message: "Kunde konnte nicht aktualisiert werden" });
    return;
  }

  if (data.pflegegrad && data.pflegegradSeit) {
    try {
      await customerManagementStorage.addCareLevelHistory({
        customerId: id,
        pflegegrad: data.pflegegrad,
        validFrom: data.pflegegradSeit,
      }, userId);
    } catch (err) {
      console.error(`[POST /:id/convert] Pflegegrad-Historie fehlgeschlagen:`, err);
      warnings.push("Pflegegrad-Historie konnte nicht gespeichert werden");
    }
  }

  if (data.insurance && isPflegekasseCustomer(data.billingType)) {
    try {
      await customerManagementStorage.addCustomerInsurance({
        customerId: id,
        insuranceProviderId: data.insurance.providerId,
        versichertennummer: data.insurance.versichertennummer,
        validFrom: data.insurance.validFrom,
      }, userId);
    } catch (err) {
      console.error(`[POST /:id/convert] Versicherung fehlgeschlagen:`, err);
      warnings.push("Versicherung konnte nicht gespeichert werden");
    }
  }

  if (data.contacts) {
    for (let i = 0; i < data.contacts.length; i++) {
      const c = data.contacts[i];
      try {
        await customerManagementStorage.addCustomerContact({
          customerId: id,
          contactType: c.contactType as "familie" | "angehoerige" | "nachbar" | "hausarzt" | "betreuer" | "sonstige",
          isPrimary: c.isPrimary,
          vorname: c.vorname,
          nachname: c.nachname,
          telefon: c.telefon,
          email: c.email || null,
          sortOrder: i,
        });
      } catch (err) {
        console.error(`[POST /:id/convert] Kontakt ${i} fehlgeschlagen:`, err);
        warnings.push(`Kontakt "${c.vorname} ${c.nachname}" konnte nicht gespeichert werden`);
      }
    }
  }

  if (data.budgets && isPflegekasseCustomer(data.billingType)) {
    try {
      await customerManagementStorage.addCustomerBudget({
        customerId: id,
        entlastungsbetrag45b: data.budgets.entlastungsbetrag45b,
        verhinderungspflege39: data.budgets.verhinderungspflege39,
        pflegesachleistungen36: data.budgets.pflegesachleistungen36,
        validFrom: data.budgets.validFrom,
      }, userId);
    } catch (err) {
      console.error(`[POST /:id/convert] Budgets fehlgeschlagen:`, err);
      warnings.push("Budgets konnten nicht gespeichert werden");
    }
  }

  if (data.contract) {
    try {
      const hauswirtschaftRate = data.contract.rates?.find(r => r.serviceCategory === "hauswirtschaft");
      const alltagsbegleitungRate = data.contract.rates?.find(r => r.serviceCategory === "alltagsbegleitung");
      const kilometerRate = data.contract.rates?.find(r => r.serviceCategory === "kilometer");
      await customerManagementStorage.createCustomerContract({
        customerId: id,
        contractStart: data.contract.contractStart,
        contractDate: data.contract.contractDate || null,
        vereinbarteLeistungen: data.contract.vereinbarteLeistungen || null,
        hoursPerPeriod: data.contract.hoursPerPeriod,
        periodType: data.contract.periodType as "week" | "month" | "year",
        hauswirtschaftRateCents: hauswirtschaftRate?.hourlyRateCents || 0,
        alltagsbegleitungRateCents: alltagsbegleitungRate?.hourlyRateCents || 0,
        kilometerRateCents: kilometerRate?.hourlyRateCents || 0,
        status: "active",
      }, userId);
    } catch (err) {
      console.error(`[POST /:id/convert] Vertrag fehlgeschlagen:`, err);
      warnings.push("Vertrag konnte nicht erstellt werden");
    }
  }

  if (data.primaryEmployeeId !== undefined || data.backupEmployeeId !== undefined) {
    try {
      await customerManagementStorage.updateCustomer(id, {
        primaryEmployeeId: data.primaryEmployeeId ?? null,
        backupEmployeeId: data.backupEmployeeId ?? null,
      });
    } catch (err) {
      console.error(`[POST /:id/convert] Mitarbeiter-Zuordnung fehlgeschlagen:`, err);
      warnings.push("Mitarbeiter-Zuordnung konnte nicht gespeichert werden");
    }
  }

  birthdaysCache.invalidateAll();

  res.json({ ...updated, status: "aktiv", warnings: warnings.length > 0 ? warnings : undefined });
}));

router.post("/:id/reject", requireRoles("erstberatung"), asyncHandler("Ablehnung fehlgeschlagen", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
    return;
  }

  if (!req.user!.isAdmin) {
    const assignedCustomerIds = await storage.getAssignedCustomerIds(req.user!.id);
    if (!assignedCustomerIds.includes(id)) {
      res.status(403).json({ error: "FORBIDDEN", message: "Zugriff verweigert" });
      return;
    }
  }

  const customer = await storage.getCustomer(id);
  if (!customer) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" });
    return;
  }

  if (customer.status !== "erstberatung") {
    res.status(400).json({ error: "INVALID_STATUS", message: "Nur Erstberatungskunden können abgelehnt werden" });
    return;
  }

  const updated = await customerManagementStorage.updateCustomer(id, { status: "inaktiv" });
  res.json(updated);
}));

router.get("/:id/service-prices", requireRoles("admin"), asyncHandler("Kundenpreise konnten nicht geladen werden", async (req, res) => {
  const customerId = parseInt(req.params.id);
  const result = await db.execute(sql`
    SELECT csp.id, csp.customer_id AS "customerId", csp.service_id AS "serviceId",
           csp.price_cents AS "priceCents", csp.valid_from AS "validFrom", csp.valid_to AS "validTo",
           s.name AS "serviceName", s.code AS "serviceCode", s.default_price_cents AS "defaultPriceCents",
           s.unit_type AS "unitType"
    FROM customer_service_prices csp
    JOIN services s ON s.id = csp.service_id
    WHERE csp.customer_id = ${customerId} AND csp.valid_to IS NULL
    ORDER BY s.sort_order
  `);
  res.json(result.rows);
}));

router.post("/:id/service-prices", requireRoles("admin"), asyncHandler("Kundenpreis konnte nicht gespeichert werden", async (req, res) => {
  const customerId = parseInt(req.params.id);
  const parsed = insertCustomerServicePriceSchema.safeParse({ ...req.body, customerId });
  if (!parsed.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: parsed.error.message });
    return;
  }
  const { serviceId, priceCents } = parsed.data;
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE customer_service_prices
      SET valid_to = NOW()
      WHERE customer_id = ${customerId} AND service_id = ${serviceId} AND valid_to IS NULL
    `);
    const inserted = await tx.execute(sql`
      INSERT INTO customer_service_prices (customer_id, service_id, price_cents)
      VALUES (${customerId}, ${serviceId}, ${priceCents})
      RETURNING id, customer_id AS "customerId", service_id AS "serviceId", price_cents AS "priceCents",
                valid_from AS "validFrom", valid_to AS "validTo"
    `);
    return inserted;
  });
  res.json(result.rows[0]);
}));

router.delete("/:id/service-prices/:priceId", requireRoles("admin"), asyncHandler("Kundenpreis konnte nicht gelöscht werden", async (req, res) => {
  const customerId = parseInt(req.params.id);
  const priceId = parseInt(req.params.priceId);
  await db.execute(sql`
    UPDATE customer_service_prices
    SET valid_to = NOW()
    WHERE id = ${priceId} AND customer_id = ${customerId} AND valid_to IS NULL
  `);
  res.json({ success: true });
}));

export default router;
