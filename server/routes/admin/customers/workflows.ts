import { Router, Request, Response } from "express";
import { storage } from "../../../storage";
import { customerManagementStorage } from "../../../storage/customer-management";
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
  customerContracts,
  appointments,
  prospects,
  monthlyServiceRecords,
  serviceRecordAppointments,
  invoices as invoicesTable,
  invoiceLineItems,
} from "@shared/schema";
import { db } from "../../../lib/db";
import { eq, and, sql, isNull, gte, lte, ne, inArray } from "drizzle-orm";

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

router.get("/customers/:id/deactivation-readiness", asyncHandler("Deaktivierungsprüfung fehlgeschlagen", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const customer = await storage.getCustomer(id);
  if (!customer) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" });
    return;
  }

  const currentContract = await customerManagementStorage.getCustomerCurrentContract(id);
  if (!currentContract?.contractEnd) {
    res.json({
      ready: false,
      hasContractEnd: false,
      contractEnd: null,
      checks: [],
      message: "Kein Vertragsende festgelegt.",
    });
    return;
  }

  const contractEnd = currentContract.contractEnd;
  const today = todayISO();

  const allAppointments = await db.select({
    id: appointments.id,
    date: appointments.date,
    status: appointments.status,
  })
    .from(appointments)
    .where(and(
      eq(appointments.customerId, id),
      lte(appointments.date, contractEnd),
      isNull(appointments.deletedAt),
      ne(appointments.status, "cancelled"),
    ));

  const undocumented = allAppointments.filter(a => a.status !== "completed");
  const allDocumented = undocumented.length === 0;

  const futureAppointments = await db.select({
    id: appointments.id,
    date: appointments.date,
    status: appointments.status,
  })
    .from(appointments)
    .where(and(
      eq(appointments.customerId, id),
      sql`${appointments.date} > ${contractEnd}`,
      isNull(appointments.deletedAt),
      ne(appointments.status, "cancelled"),
    ));

  const months = new Set<string>();
  for (const a of allAppointments) {
    const d = a.date as string;
    const [y, m] = d.split("-");
    months.add(`${y}-${m}`);
  }

  const serviceRecordChecks: Array<{ year: number; month: number; hasRecord: boolean }> = [];
  for (const ym of months) {
    const [y, m] = ym.split("-").map(Number);
    const records = await db.select({ id: monthlyServiceRecords.id, status: monthlyServiceRecords.status })
      .from(monthlyServiceRecords)
      .where(and(
        eq(monthlyServiceRecords.customerId, id),
        eq(monthlyServiceRecords.year, y),
        eq(monthlyServiceRecords.month, m),
        isNull(monthlyServiceRecords.deletedAt),
      ));
    serviceRecordChecks.push({
      year: y,
      month: m,
      hasRecord: records.length > 0,
    });
  }
  const allServiceRecords = serviceRecordChecks.every(c => c.hasRecord);

  const invoiceChecks: Array<{ year: number; month: number; hasInvoice: boolean }> = [];
  for (const ym of months) {
    const [y, m] = ym.split("-").map(Number);
    const existingInvoices = await db.select({ id: invoicesTable.id })
      .from(invoicesTable)
      .where(and(
        eq(invoicesTable.customerId, id),
        eq(invoicesTable.billingYear, y),
        eq(invoicesTable.billingMonth, m),
        ne(invoicesTable.status, "storniert"),
      ))
      .limit(1);
    invoiceChecks.push({
      year: y,
      month: m,
      hasInvoice: existingInvoices.length > 0,
    });
  }
  const allInvoiced = invoiceChecks.every(c => c.hasInvoice);

  const contractEndReached = contractEnd <= today;

  const checks = [
    {
      key: "contractEndReached",
      label: "Vertragsende erreicht",
      met: contractEndReached,
      detail: contractEndReached ? `Vertragsende: ${contractEnd}` : `Vertragsende am ${contractEnd} noch nicht erreicht`,
    },
    {
      key: "allDocumented",
      label: "Alle Termine dokumentiert",
      met: allDocumented,
      detail: allDocumented
        ? `${allAppointments.length} Termine abgeschlossen`
        : `${undocumented.length} von ${allAppointments.length} Terminen noch nicht dokumentiert`,
    },
    {
      key: "allServiceRecords",
      label: "Leistungsnachweise erstellt",
      met: allServiceRecords,
      detail: allServiceRecords
        ? `${serviceRecordChecks.length} Monat(e) abgedeckt`
        : `${serviceRecordChecks.filter(c => !c.hasRecord).length} Monat(e) ohne Leistungsnachweis`,
    },
    {
      key: "allInvoiced",
      label: "Rechnungen erstellt",
      met: allInvoiced,
      detail: allInvoiced
        ? `${invoiceChecks.length} Monat(e) abgerechnet`
        : `${invoiceChecks.filter(c => !c.hasInvoice).length} Monat(e) ohne Rechnung`,
    },
  ];

  const ready = checks.every(c => c.met);

  res.json({
    ready,
    hasContractEnd: true,
    contractEnd,
    checks,
    futureAppointmentsCount: futureAppointments.length,
    futureAppointments: futureAppointments.slice(0, 10).map(a => ({
      id: a.id,
      date: a.date,
      status: a.status,
    })),
  });
}));

const completeDeactivationSchema = z.object({
  deactivationReason: z.string().min(1, "Grund ist erforderlich"),
  deactivationNote: z.string().max(1000).optional(),
});

router.post("/customers/:id/complete-deactivation", asyncHandler("Deaktivierung fehlgeschlagen", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const customer = await storage.getCustomer(id);
  if (!customer) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" });
    return;
  }

  if (customer.status !== "aktiv") {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Nur aktive Kunden können deaktiviert werden" });
    return;
  }

  const currentContract = await customerManagementStorage.getCustomerCurrentContract(id);
  if (!currentContract?.contractEnd) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Kein Vertragsende festgelegt. Bitte setzen Sie zuerst ein Vertragsende." });
    return;
  }

  const { deactivationReason, deactivationNote } = completeDeactivationSchema.parse(req.body);

  const contractEnd = currentContract.contractEnd;
  const today = todayISO();

  if (contractEnd > today) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Vertragsende noch nicht erreicht. Deaktivierung erst nach Vertragsende möglich." });
    return;
  }

  const appointmentsBeforeEnd = await db.select({ id: appointments.id, date: appointments.date, status: appointments.status })
    .from(appointments)
    .where(and(
      eq(appointments.customerId, id),
      lte(appointments.date, contractEnd),
      isNull(appointments.deletedAt),
      ne(appointments.status, "cancelled"),
    ));
  const undocumented = appointmentsBeforeEnd.filter(a => a.status !== "completed");
  if (undocumented.length > 0) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: `${undocumented.length} Termin(e) noch nicht dokumentiert. Bitte alle Termine vor dem Vertragsende abschließen.` });
    return;
  }

  const months = new Set<string>();
  for (const a of appointmentsBeforeEnd) {
    const d = a.date as string;
    const [y, m] = d.split("-");
    months.add(`${y}-${m}`);
  }

  for (const ym of months) {
    const [y, m] = ym.split("-").map(Number);
    const records = await db.select({ id: monthlyServiceRecords.id })
      .from(monthlyServiceRecords)
      .where(and(
        eq(monthlyServiceRecords.customerId, id),
        eq(monthlyServiceRecords.year, y),
        eq(monthlyServiceRecords.month, m),
        isNull(monthlyServiceRecords.deletedAt),
      ))
      .limit(1);
    if (records.length === 0) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: `Leistungsnachweis für ${m}/${y} fehlt. Bitte alle Leistungsnachweise erstellen.` });
      return;
    }
  }

  for (const ym of months) {
    const [y, m] = ym.split("-").map(Number);
    const existingInvoices = await db.select({ id: invoicesTable.id })
      .from(invoicesTable)
      .where(and(
        eq(invoicesTable.customerId, id),
        eq(invoicesTable.billingYear, y),
        eq(invoicesTable.billingMonth, m),
        ne(invoicesTable.status, "storniert"),
      ))
      .limit(1);
    if (existingInvoices.length === 0) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: `Rechnung für ${m}/${y} fehlt. Bitte alle Rechnungen erstellen.` });
      return;
    }
  }

  const updated = await db.transaction(async (tx) => {
    await tx.update(customerContracts)
      .set({
        status: "terminated",
        updatedAt: new Date(),
      })
      .where(eq(customerContracts.id, currentContract.id));

    const [result] = await tx.update(customers)
      .set({
        status: "inaktiv",
        inaktivAb: currentContract.contractEnd,
        deactivationReason,
        deactivationNote: deactivationNote || null,
        updatedAt: new Date(),
      })
      .where(eq(customers.id, id))
      .returning();

    return result;
  });

  await auditService.log(req.user!.id, "customer_updated", "customer", id, {
    action: "complete_deactivation",
    contractId: currentContract.id,
    contractEnd: currentContract.contractEnd,
    deactivationReason,
    previousStatus: "aktiv",
    newStatus: "inaktiv",
  }, req.ip);

  birthdaysCache.invalidateAll();

  res.json(updated);
}));

export default router;
