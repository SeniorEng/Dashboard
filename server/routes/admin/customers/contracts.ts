import { Router, Request, Response } from "express";
import { birthdaysCache } from "../../../services/cache";
import { storage } from "../../../storage";
import { customerManagementStorage } from "../../../storage/customer-management";
import { asyncHandler } from "../../../lib/errors";
import { requireIntParam } from "../../../lib/params";
import { withAudit } from "../../../lib/with-audit";
import { z } from "zod";
import {
  customers,
  customerContracts,
} from "@shared/schema";
import { db } from "../../../lib/db";
import { eq, and } from "drizzle-orm";

const router = Router();

const updateNeedsAssessmentSchema = z.object({
  serviceHaushaltHilfe: z.boolean().optional(),
  serviceMahlzeiten: z.boolean().optional(),
  serviceReinigung: z.boolean().optional(),
  serviceWaeschePflege: z.boolean().optional(),
  serviceEinkauf: z.boolean().optional(),
  serviceTagesablauf: z.boolean().optional(),
  serviceAlltagsverrichtungen: z.boolean().optional(),
  serviceTerminbegleitung: z.boolean().optional(),
  serviceBotengaenge: z.boolean().optional(),
  serviceGrundpflege: z.boolean().optional(),
  serviceFreizeitbegleitung: z.boolean().optional(),
  serviceDemenzbetreuung: z.boolean().optional(),
  serviceGesellschaft: z.boolean().optional(),
  serviceSozialeKontakte: z.boolean().optional(),
  serviceFreizeitgestaltung: z.boolean().optional(),
  serviceKreativ: z.boolean().optional(),
  sonstigeLeistungen: z.string().max(250, "Maximal 250 Zeichen erlaubt").nullable().optional(),
});

const updateContractSchema = z.object({
  vereinbarteLeistungen: z.string().max(2000, "Maximal 2000 Zeichen erlaubt").nullable().optional(),
  contractDate: z.string().nullable().optional(),
  contractStart: z.string().optional(),
  contractEnd: z.string().nullable().optional(),
  hoursPerPeriod: z.number().int().min(0, "Muss mindestens 0 sein").optional(),
  periodType: z.enum(["week", "month", "year"]).optional(),
  status: z.enum(["active", "paused", "terminated"]).optional(),
});

const createContractSchema = z.object({
  contractStart: z.string(),
  contractDate: z.string().nullable().optional(),
  contractEnd: z.string().nullable().optional(),
  hoursPerPeriod: z.number().int().min(0, "Muss mindestens 0 sein").optional(),
  periodType: z.enum(["week", "month", "year"]).optional(),
});

router.post("/customers/:id/contract", asyncHandler("Vertrag konnte nicht angelegt werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const customer = await storage.getCustomer(id);
  if (!customer) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" });
    return;
  }

  const [existingContract] = await db
    .select({ id: customerContracts.id })
    .from(customerContracts)
    .where(and(
      eq(customerContracts.customerId, id),
      eq(customerContracts.status, "active")
    ))
    .limit(1);

  if (existingContract) {
    res.status(409).json({ error: "CONFLICT", message: "Kunde hat bereits einen aktiven Vertrag" });
    return;
  }

  const data = createContractSchema.parse(req.body);

  const result = await withAudit(async (tx, audit) => {
    const created = await customerManagementStorage.createCustomerContract({
      customerId: id,
      contractStart: data.contractStart,
      contractDate: data.contractDate || null,
      contractEnd: data.contractEnd || null,
      hoursPerPeriod: data.hoursPerPeriod ?? 0,
      periodType: data.periodType ?? "week",
      status: "active",
    }, req.user!.id, tx);

    audit.record({
      userId: req.user!.id,
      action: "customer_contract_updated",
      entityType: "customer",
      entityId: id,
      metadata: {
        changedFields: ["vertrag_angelegt"],
        oldValues: {},
        newValues: {
          contractId: created.id,
          contractStart: created.contractStart,
          contractEnd: created.contractEnd,
          hoursPerPeriod: created.hoursPerPeriod,
          periodType: created.periodType,
          status: created.status,
        },
      },
      ipAddress: req.ip,
    });
    return created;
  });

  res.status(201).json(result);
}));

router.patch("/customers/:id/contract", asyncHandler("Vertrag konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const customer = await storage.getCustomer(id);
  if (!customer) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" });
    return;
  }

  const [latestContract] = await db
    .select()
    .from(customerContracts)
    .where(eq(customerContracts.customerId, id))
    .orderBy(customerContracts.id)
    .limit(1);

  if (!latestContract) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kein Vertrag gefunden" });
    return;
  }

  const validatedData = updateContractSchema.parse(req.body);

  const changedFields = Object.keys(validatedData);
  const oldValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};
  for (const field of changedFields) {
    oldValues[field] = (latestContract as Record<string, unknown>)[field];
    newValues[field] = (validatedData as Record<string, unknown>)[field];
  }

  const result = await withAudit(async (tx, audit) => {
    const updated = await customerManagementStorage.updateCustomerContract(latestContract.id, validatedData, tx);

    if (!updated) {
      return null;
    }

    if (validatedData.contractEnd !== undefined) {
      const newContractEnd = validatedData.contractEnd;
      await tx.update(customers)
        .set({
          inaktivAb: newContractEnd || null,
          updatedAt: new Date(),
        })
        .where(eq(customers.id, id));
    }

    audit.record({
      userId: req.user!.id,
      action: "customer_contract_updated",
      entityType: "customer",
      entityId: id,
      metadata: {
        changedFields,
        oldValues: { contractId: latestContract.id, ...oldValues },
        newValues,
      },
      ipAddress: req.ip,
    });

    return updated;
  });

  if (!result) {
    res.status(404).json({ error: "NOT_FOUND", message: "Vertrag nicht gefunden" });
    return;
  }

  // Der Vertragsstatus entscheidet seit 6hHW39Gx ueber den Lebenszyklus und
  // damit darueber, wer in den Geburtstags-Ansichten steht. Ohne diese Zeile
  // zeigte die Liste einen soeben pausierten oder gekuendigten Kunden bis zu
  // einer Stunde weiter (TTL des Caches). Der Kunden-PATCH und die
  // Zuweisungs-Routen invalidieren laengst; dieser Pfad war vorher schlicht
  // nicht beteiligt.
  birthdaysCache.invalidateAll();

  res.json(result);
}));

router.patch("/customers/:id/needs-assessment", asyncHandler("Leistungen konnten nicht aktualisiert werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const validatedData = updateNeedsAssessmentSchema.parse(req.body);

  const changedFields = Object.keys(validatedData);

  const result = await withAudit(async (tx, audit) => {
    const existing = await customerManagementStorage.getCustomerNeedsAssessment(id, tx);
    const updated = await customerManagementStorage.updateNeedsAssessment(id, validatedData, tx);

    if (!updated) {
      return undefined;
    }

    const oldValues: Record<string, unknown> = {};
    const newValues: Record<string, unknown> = {};
    for (const field of changedFields) {
      oldValues[field] = existing ? (existing as Record<string, unknown>)[field] : undefined;
      newValues[field] = (validatedData as Record<string, unknown>)[field];
    }

    audit.record({
      userId: req.user!.id,
      action: "customer_contract_updated",
      entityType: "customer",
      entityId: id,
      metadata: {
        changedFields: ["bedarfserhebung_aktualisiert", ...changedFields],
        oldValues,
        newValues,
      },
      ipAddress: req.ip,
    });

    return updated;
  });

  if (!result) {
    res.status(404).json({ error: "NOT_FOUND", message: "Bedarfserhebung nicht gefunden" });
    return;
  }

  res.json(result);
}));

router.get("/customers/:id/conversion-readiness", asyncHandler("Konvertierungsprüfung fehlgeschlagen", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const customer = await storage.getCustomer(id);
  if (!customer) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" });
    return;
  }

  res.json({
    ready: customer.status === "aktiv",
    missing: [],
    customerStatus: customer.status,
  });
}));

export default router;
