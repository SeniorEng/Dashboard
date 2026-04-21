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
  tasks,
} from "@shared/schema";
import { requireSuperAdmin } from "../../../middleware/auth";
import { db } from "../../../lib/db";
import { eq, and, sql, isNull, gte, lte, ne, inArray } from "drizzle-orm";

const router = Router();

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
      festnetz: null,
      mobilnummer: "0000000000",
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

// ============================================================================
// HARD-DELETE (Karteileichen) — SuperAdmin only
// ============================================================================

type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

async function computeHardDeleteReadiness(id: number, executor: DbExecutor = db) {
  const [apptRows] = await executor
    .select({ c: sql<number>`count(*)::int` })
    .from(appointments)
    .where(eq(appointments.customerId, id));

  const [serviceRows] = await executor
    .select({ c: sql<number>`count(*)::int` })
    .from(monthlyServiceRecords)
    .where(eq(monthlyServiceRecords.customerId, id));

  const [invoiceRows] = await executor
    .select({ c: sql<number>`count(*)::int` })
    .from(invoicesTable)
    .where(eq(invoicesTable.customerId, id));

  const [mergeRows] = await executor
    .select({ c: sql<number>`count(*)::int` })
    .from(customers)
    .where(eq(customers.mergedIntoCustomerId, id));

  const [prospectRows] = await executor
    .select({ c: sql<number>`count(*)::int` })
    .from(prospects)
    .where(eq(prospects.convertedCustomerId, id));

  const [taskRows] = await executor
    .select({ c: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(eq(tasks.customerId, id), isNull(tasks.deletedAt)));

  const checks = [
    { key: "noAppointments", label: "Keine Termine vorhanden", count: apptRows.c, met: apptRows.c === 0 },
    { key: "noServiceRecords", label: "Keine Leistungsnachweise vorhanden", count: serviceRows.c, met: serviceRows.c === 0 },
    { key: "noInvoices", label: "Keine Rechnungen vorhanden", count: invoiceRows.c, met: invoiceRows.c === 0 },
    { key: "noMergeRefs", label: "Keine Merge-Verlinkungen", count: mergeRows.c, met: mergeRows.c === 0 },
    { key: "noProspectRefs", label: "Keine Interessenten-Verknüpfung", count: prospectRows.c, met: prospectRows.c === 0 },
    { key: "noTasks", label: "Keine offenen Aufgaben", count: taskRows.c, met: taskRows.c === 0 },
  ];

  return { ready: checks.every(c => c.met), checks };
}

router.get(
  "/customers/:id/hard-delete-readiness",
  requireSuperAdmin,
  asyncHandler("Lösch-Vorprüfung fehlgeschlagen", async (req: Request, res: Response) => {
    const id = requireIntParam(req.params.id, res);
    if (id === null) return;

    const customer = await storage.getCustomer(id);
    if (!customer) {
      res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" });
      return;
    }

    const result = await computeHardDeleteReadiness(id);
    res.json(result);
  })
);

const hardDeleteSchema = z.object({
  reason: z.string().min(5, "Grund muss mindestens 5 Zeichen lang sein").max(1000, "Grund darf maximal 1000 Zeichen haben"),
  confirmName: z.string().min(1, "Bitte den Kundennamen zur Bestätigung eingeben"),
});

router.delete(
  "/customers/:id",
  requireSuperAdmin,
  asyncHandler("Löschen fehlgeschlagen", async (req: Request, res: Response) => {
    const id = requireIntParam(req.params.id, res);
    if (id === null) return;

    const { reason, confirmName } = hardDeleteSchema.parse(req.body);

    const customer = await storage.getCustomer(id);
    if (!customer) {
      res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" });
      return;
    }

    if (confirmName.trim() !== customer.name.trim()) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Eingegebener Name stimmt nicht mit dem Kundennamen überein",
      });
      return;
    }

    const snapshot = {
      customerName: customer.name,
      vorname: customer.vorname,
      nachname: customer.nachname,
      geburtsdatum: customer.geburtsdatum,
      createdAt: customer.createdAt ? customer.createdAt.toISOString() : null,
      reason,
    };

    let conflict: { ready: boolean; checks: Array<{ key: string; label: string; count: number; met: boolean }> } | null = null;
    let fkConflict = false;

    try {
      await db.transaction(async (tx) => {
        // Lock the customer row to serialize concurrent hard-deletes / writes
        // against this customer for the duration of the transaction.
        const lockResult = await tx.execute(
          sql`SELECT id FROM customers WHERE id = ${id} FOR UPDATE`
        );
        if (lockResult.rows.length === 0) {
          conflict = { ready: false, checks: [] };
          return;
        }
        // Recheck readiness *inside* the transaction using `tx`, so the counts
        // reflect the locked snapshot. Concurrent inserts into operative tables
        // either committed before (and will be seen here) or after (and will
        // hit the FK constraint, since we're about to delete the customer row).
        const recheck = await computeHardDeleteReadiness(id, tx);
        if (!recheck.ready) {
          conflict = recheck;
          return;
        }
        await tx.delete(customers).where(eq(customers.id, id));
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "23503") {
        fkConflict = true;
      } else {
        throw err;
      }
    }

    if (conflict) {
      res.status(409).json({
        error: "CONFLICT",
        message: "Kunde hat zwischenzeitlich operative Daten erhalten — Löschen nicht möglich.",
        details: conflict,
      });
      return;
    }

    if (fkConflict) {
      res.status(409).json({
        error: "CONFLICT",
        message: "Kunde kann nicht gelöscht werden, weil noch verknüpfte Daten existieren. Bitte Anonymisierung verwenden.",
      });
      return;
    }

    await auditService.customerHardDeleted(req.user!.id, id, snapshot, req.ip);

    birthdaysCache.invalidateAll();

    res.json({ success: true, message: `Kunde "${customer.name}" wurde gelöscht` });
  })
);

export default router;
