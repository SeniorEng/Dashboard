import { Router, Request, Response } from "express";
import { storage } from "../../../storage";
import { birthdaysCache } from "../../../services/cache";
import { auditService } from "../../../services/audit";
import { asyncHandler } from "../../../lib/errors";
import { requireIntParam } from "../../../lib/params";
import { z } from "zod";
import { todayISO } from "@shared/utils/datetime";
import {
  customers,
  customerContacts,
  customerInsuranceHistory,
  customerNeedsAssessments,
  appointments,
  prospects,
} from "@shared/schema";
import { db } from "../../../lib/db";
import { eq, and, sql, isNull } from "drizzle-orm";

const router = Router();

const declineErstberatungSchema = z.object({
  note: z.string().max(500).optional(),
});

router.post("/customers/:id/decline-erstberatung", asyncHandler("Erstberatung konnte nicht abgelehnt werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const customer = await storage.getCustomer(id);
  if (!customer) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" });
    return;
  }

  if (customer.status !== "erstberatung") {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Nur Erstberatungskunden können abgelehnt werden" });
    return;
  }

  const { note } = declineErstberatungSchema.parse(req.body);
  const today = todayISO();

  const updated = await db.transaction(async (tx) => {
    const [result] = await tx.update(customers)
      .set({
        status: "inaktiv",
        inaktivAb: today,
        deactivationReason: "kein_interesse",
        deactivationNote: note || "Kein Interesse nach Erstberatung",
        updatedAt: new Date(),
      })
      .where(eq(customers.id, id))
      .returning();

    const [linkedProspect] = await tx
      .select()
      .from(prospects)
      .where(and(eq(prospects.convertedCustomerId, id), isNull(prospects.deletedAt)));

    if (linkedProspect) {
      await tx.update(prospects)
        .set({
          status: "nicht_interessiert",
          statusNotiz: "Automatisch: Kein Interesse nach Erstberatung",
          updatedAt: new Date(),
        })
        .where(eq(prospects.id, linkedProspect.id));
    }

    return result;
  });

  await auditService.log(req.user!.id, "customer_updated", "customer", id, {
    action: "decline_erstberatung",
    note: note || null,
    previousStatus: "erstberatung",
    newStatus: "inaktiv",
  });

  res.json(updated);
}));

const mergeErstberatungSchema = z.object({
  targetCustomerId: z.number().int().positive(),
  note: z.string().max(500).optional(),
});

router.post("/customers/:id/merge-erstberatung", asyncHandler("Erstberatung konnte nicht zusammengeführt werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const { targetCustomerId, note } = mergeErstberatungSchema.parse(req.body);

  if (id === targetCustomerId) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Der Erstberatungskunde kann nicht mit sich selbst zusammengeführt werden" });
    return;
  }

  const sourceCustomer = await storage.getCustomer(id);
  if (!sourceCustomer) {
    res.status(404).json({ error: "NOT_FOUND", message: "Erstberatungskunde nicht gefunden" });
    return;
  }

  if (sourceCustomer.status !== "erstberatung") {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Nur Erstberatungskunden können zusammengeführt werden" });
    return;
  }

  if (sourceCustomer.mergedIntoCustomerId) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Dieser Kunde wurde bereits zusammengeführt" });
    return;
  }

  const targetCustomer = await storage.getCustomer(targetCustomerId);
  if (!targetCustomer) {
    res.status(404).json({ error: "NOT_FOUND", message: "Zielkunde nicht gefunden" });
    return;
  }

  if (targetCustomer.status !== "aktiv") {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Der Zielkunde muss aktiv sein" });
    return;
  }

  const today = todayISO();

  const updated = await db.transaction(async (tx) => {
    const [result] = await tx.update(customers)
      .set({
        status: "inaktiv",
        inaktivAb: today,
        deactivationReason: "zusammengefuehrt",
        deactivationNote: note || `Zusammengeführt mit ${targetCustomer.name} (ID: ${targetCustomerId})`,
        mergedIntoCustomerId: targetCustomerId,
        updatedAt: new Date(),
      })
      .where(eq(customers.id, id))
      .returning();

    const [linkedProspect] = await tx
      .select()
      .from(prospects)
      .where(and(eq(prospects.convertedCustomerId, id), isNull(prospects.deletedAt)));

    if (linkedProspect) {
      await tx.update(prospects)
        .set({
          status: "gewonnen",
          statusNotiz: `Automatisch: Erstberatung zusammengeführt mit ${targetCustomer.name}`,
          convertedCustomerId: targetCustomerId,
          updatedAt: new Date(),
        })
        .where(eq(prospects.id, linkedProspect.id));
    }

    return result;
  });

  await auditService.log(req.user!.id, "customer_updated", "customer", id, {
    action: "merge_erstberatung",
    sourceCustomerId: id,
    sourceCustomerName: sourceCustomer.name,
    targetCustomerId,
    targetCustomerName: targetCustomer.name,
    note: note || null,
    previousStatus: "erstberatung",
    newStatus: "inaktiv",
  });

  birthdaysCache.invalidateAll();

  res.json(updated);
}));

router.post("/customers/:id/anonymize", asyncHandler("Kunde konnte nicht anonymisiert werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const customer = await storage.getCustomer(id);
  if (!customer) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" });
    return;
  }

  if (customer.isAnonymized) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Kunde wurde bereits anonymisiert" });
    return;
  }

  if (customer.status === "aktiv") {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Nur inaktive Kunden können anonymisiert werden. Bitte deaktivieren Sie den Kunden zuerst." });
    return;
  }

  const openAppts = await db.select({ id: appointments.id })
    .from(appointments)
    .where(and(
      eq(appointments.customerId, id),
      sql`${appointments.status} NOT IN ('completed', 'cancelled')`,
      isNull(appointments.deletedAt)
    ));

  if (openAppts.length > 0) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: `Anonymisierung nicht möglich: ${openAppts.length} offene Termine vorhanden. Alle Termine müssen abgeschlossen oder storniert sein.`,
    });
    return;
  }

  const now = new Date();
  const anonymizedLabel = `Ehem. Kunde #${id}`;

  await db.transaction(async (tx) => {
    await tx.update(customers).set({
      name: anonymizedLabel,
      vorname: null,
      nachname: null,
      email: null,
      festnetz: null,
      telefon: null,
      geburtsdatum: null,
      address: "Anonymisiert",
      strasse: null,
      nr: null,
      plz: null,
      stadt: null,
      vorerkrankungen: null,
      haustierDetails: null,
      deactivationNote: null,
      isAnonymized: true,
      anonymizedAt: now,
      updatedAt: now,
    }).where(eq(customers.id, id));

    await tx.update(customerContacts).set({
      vorname: "Anonymisiert",
      nachname: "Anonymisiert",
      telefon: "0000000000",
      email: null,
      notes: null,
    }).where(eq(customerContacts.customerId, id));

    await tx.update(customerNeedsAssessments).set({
      anamnese: null,
      sonstigeLeistungen: null,
    }).where(eq(customerNeedsAssessments.customerId, id));

    await tx.update(customerInsuranceHistory).set({
      versichertennummer: "ANONYMISIERT",
      notes: null,
    }).where(eq(customerInsuranceHistory.customerId, id));
  });

  await auditService.log(
    req.user!.id,
    "customer_anonymized",
    "customer",
    id,
    {
      anonymizedBy: req.user!.id,
      originalName: customer.name,
      reason: "DSGVO Art. 17 - Recht auf Löschung",
    },
    req.ip
  );

  birthdaysCache.invalidateAll();

  res.json({
    success: true,
    message: `Kunde "${customer.name}" wurde DSGVO-konform anonymisiert`,
  });
}));

export default router;
