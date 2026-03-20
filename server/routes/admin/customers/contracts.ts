import { Router, Request, Response } from "express";
import { storage } from "../../../storage";
import { customerManagementStorage } from "../../../storage/customer-management";
import { asyncHandler } from "../../../lib/errors";
import { requireIntParam } from "../../../lib/params";
import { z } from "zod";
import {
  customers,
  customerContracts,
  customerInsuranceHistory,
} from "@shared/schema";
import { db } from "../../../lib/db";
import { eq, and, isNull } from "drizzle-orm";

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
  const result = await customerManagementStorage.createCustomerContract({
    customerId: id,
    contractStart: data.contractStart,
    contractDate: data.contractDate || null,
    contractEnd: data.contractEnd || null,
    hoursPerPeriod: data.hoursPerPeriod ?? 0,
    periodType: data.periodType ?? "week",
    status: "active",
    hauswirtschaftRateCents: 0,
    alltagsbegleitungRateCents: 0,
    kilometerRateCents: 0,
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
  const result = await customerManagementStorage.updateCustomerContract(latestContract.id, validatedData);

  if (!result) {
    res.status(404).json({ error: "NOT_FOUND", message: "Vertrag nicht gefunden" });
    return;
  }

  if (validatedData.contractEnd !== undefined) {
    const newContractEnd = validatedData.contractEnd;
    if (newContractEnd) {
      await db.update(customers)
        .set({ inaktivAb: newContractEnd, updatedAt: new Date() })
        .where(eq(customers.id, id));
    } else {
      await db.update(customers)
        .set({ inaktivAb: null, updatedAt: new Date() })
        .where(eq(customers.id, id));
    }
  }

  res.json(result);
}));

router.patch("/customers/:id/needs-assessment", asyncHandler("Leistungen konnten nicht aktualisiert werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const validatedData = updateNeedsAssessmentSchema.parse(req.body);
  const result = await customerManagementStorage.updateNeedsAssessment(id, validatedData);

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

  if (customer.status !== "erstberatung") {
    res.json({
      ready: customer.status === "aktiv",
      missing: [],
      customerStatus: customer.status,
    });
    return;
  }

  const missing: string[] = [];

  if (!customer.pflegegrad || customer.pflegegrad === 0) {
    missing.push("pflegegrad");
  }
  if (!customer.billingType) {
    missing.push("billingType");
  }
  if (!customer.primaryEmployeeId) {
    missing.push("primaryEmployee");
  }

  const isSelbstzahler = customer.billingType === "selbstzahler";

  if (!isSelbstzahler) {
    const [activeInsurance] = await db
      .select({ id: customerInsuranceHistory.id })
      .from(customerInsuranceHistory)
      .where(
        and(
          eq(customerInsuranceHistory.customerId, id),
          isNull(customerInsuranceHistory.validTo)
        )
      )
      .limit(1);

    if (!activeInsurance) {
      missing.push("insurance");
    }
  }

  const [activeContract] = await db
    .select({ id: customerContracts.id })
    .from(customerContracts)
    .where(
      and(
        eq(customerContracts.customerId, id),
        eq(customerContracts.status, "active")
      )
    )
    .limit(1);

  if (!activeContract) {
    missing.push("contract");
  }

  res.json({
    ready: missing.length === 0,
    missing,
    customerStatus: customer.status,
  });
}));

export default router;
