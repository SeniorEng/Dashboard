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
import { appointmentsRepo, monthlyServiceRecordsRepo, customersRepo, prospectsRepo, tasksRepo } from "../../../repos";
import { softDeleteCustomerWithCascade } from "../../../services/customer-deletion-service";
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

  const openAppts = await appointmentsRepo.selectColumnsFrom({ id: appointments.id })
    .where(and(
      eq(appointments.customerId, id),
      appointmentsRepo.activeOnly(),
      sql`${appointments.status} NOT IN ('completed', 'cancelled')`,
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

  const allAppointments = await appointmentsRepo.selectColumnsFrom({
    id: appointments.id,
    date: appointments.date,
    status: appointments.status,
  })
    .where(and(
      eq(appointments.customerId, id),
      lte(appointments.date, contractEnd),
      appointmentsRepo.activeOnly(),
      ne(appointments.status, "cancelled"),
    ));

  const undocumented = allAppointments.filter(a => a.status !== "completed");
  const allDocumented = undocumented.length === 0;

  const futureAppointments = await appointmentsRepo.selectColumnsFrom({
    id: appointments.id,
    date: appointments.date,
    status: appointments.status,
  })
    .where(and(
      eq(appointments.customerId, id),
      sql`${appointments.date} > ${contractEnd}`,
      appointmentsRepo.activeOnly(),
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
    const records = await monthlyServiceRecordsRepo.selectColumnsFrom({ id: monthlyServiceRecords.id, status: monthlyServiceRecords.status })
      .where(and(
        eq(monthlyServiceRecords.customerId, id),
        eq(monthlyServiceRecords.year, y),
        eq(monthlyServiceRecords.month, m),
        monthlyServiceRecordsRepo.activeOnly(),
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

  const appointmentsBeforeEnd = await appointmentsRepo.selectColumnsFrom({ id: appointments.id, date: appointments.date, status: appointments.status })
    .where(and(
      eq(appointments.customerId, id),
      lte(appointments.date, contractEnd),
      appointmentsRepo.activeOnly(),
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
    const records = await monthlyServiceRecordsRepo.selectColumnsFrom({ id: monthlyServiceRecords.id })
      .where(and(
        eq(monthlyServiceRecords.customerId, id),
        eq(monthlyServiceRecords.year, y),
        eq(monthlyServiceRecords.month, m),
        monthlyServiceRecordsRepo.activeOnly(),
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
  const [apptRows] = await appointmentsRepo.selectColumnsFrom({ c: sql<number>`count(*)::int` }, executor)
    .where(and(eq(appointments.customerId, id), appointmentsRepo.activeOnly()));

  const [serviceRows] = await monthlyServiceRecordsRepo.selectColumnsFrom({ c: sql<number>`count(*)::int` }, executor)
    .where(and(eq(monthlyServiceRecords.customerId, id), monthlyServiceRecordsRepo.activeOnly()));

  const [invoiceRows] = await executor
    .select({ c: sql<number>`count(*)::int` })
    .from(invoicesTable)
    .where(eq(invoicesTable.customerId, id));

  const [mergeRows] = await customersRepo.selectColumnsFrom({ c: sql<number>`count(*)::int` }, executor)
    .where(and(eq(customers.mergedIntoCustomerId, id), customersRepo.activeOnly()));

  const [prospectRows] = await prospectsRepo.selectColumnsFrom({ c: sql<number>`count(*)::int` }, executor)
    .where(and(eq(prospects.convertedCustomerId, id), prospectsRepo.activeOnly()));

  const [taskRows] = await tasksRepo.selectColumnsFrom({ c: sql<number>`count(*)::int` }, executor)
    .where(and(eq(tasks.customerId, id), tasksRepo.activeOnly()));

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
  // Task #448: Default-Pfad ist soft (Kunde + Children werden soft-gelöscht und
  // pro Child ein Audit-Eintrag mit parentDeletionId geschrieben). Echter
  // Hard-Delete bleibt nur als Admin-Eskalation hinter Flag + Compliance-Signoff.
  hardDelete: z.boolean().optional().default(false),
  complianceOfficerSignoff: z.string().max(1000, "Begründung darf maximal 1000 Zeichen haben").optional(),
}).refine(
  (data) => !data.hardDelete || (data.complianceOfficerSignoff?.trim().length ?? 0) >= 10,
  {
    message: "Compliance-Officer-Signoff (≥10 Zeichen) ist für echten Hard-Delete erforderlich",
    path: ["complianceOfficerSignoff"],
  },
);

router.delete(
  "/customers/:id",
  requireSuperAdmin,
  asyncHandler("Löschen fehlgeschlagen", async (req: Request, res: Response) => {
    const id = requireIntParam(req.params.id, res);
    if (id === null) return;

    const { reason, confirmName, hardDelete, complianceOfficerSignoff } = hardDeleteSchema.parse(req.body);

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
    };

    // Task #448:
    //   - Default-Pfad (`hardDelete=false`): Soft-Cascade-Routine soft-löscht
    //     Kunden + alle abhängigen Datensätze, schreibt pro Child einen Audit-
    //     Eintrag mit `parentDeletionId`. Kein 409 wegen offener Daten — die
    //     Soft-Löschung kann immer ausgeführt werden.
    //   - Hard-Delete (`hardDelete=true`): zusätzlich Compliance-Officer-Signoff
    //     erforderlich. Erst Soft-Cascade (für vollständige Audit-Spur), danach
    //     `tx.delete(customers)` für die echte Entfernung; FK-Cascade räumt
    //     Resttabellen ohne `deletedAt` (z.B. customer_contacts) auf.
    type CascadeResult = Awaited<ReturnType<typeof softDeleteCustomerWithCascade>>;
    type TxResult =
      | { kind: "conflict"; conflict: { ready: boolean; checks: Array<{ key: string; label: string; count: number; met: boolean }> } }
      | { kind: "ok"; cascade: CascadeResult };
    let txOutcome: TxResult | null = null;
    let fkConflict = false;

    try {
      txOutcome = await db.transaction(async (tx): Promise<TxResult> => {
        // Lock the customer row to serialize concurrent deletes / writes
        // against this customer for the duration of the transaction.
        const lockResult = await tx.execute(
          sql`SELECT id FROM customers WHERE id = ${id} FOR UPDATE`
        );
        if (lockResult.rows.length === 0) {
          return { kind: "conflict", conflict: { ready: false, checks: [] } };
        }

        if (hardDelete) {
          // Readiness-Recheck nur für echten Hard-Delete: FK-Cascades dürfen
          // hier keine operativen Daten zerstören (Termine/Rechnungen etc.).
          const recheck = await computeHardDeleteReadiness(id, tx);
          if (!recheck.ready) {
            return { kind: "conflict", conflict: recheck };
          }
        }

        const cascade = await softDeleteCustomerWithCascade({
          tx,
          customerId: id,
          userId: req.user!.id,
          ipAddress: req.ip,
          reason,
          snapshot,
          hardDelete,
          complianceOfficerSignoff: complianceOfficerSignoff ?? null,
        });

        if (hardDelete) {
          // Echte SQL-Löschung — FK-Cascade entfernt Resttabellen ohne
          // `deletedAt` (customer_contacts, customer_needs_assessments,
          // customer_assignment_history, customer_insurance_history,
          // customer_budget_preferences, …). Audit-Spur ist über
          // `softDeleteCustomerWithCascade` bereits persistiert.
          await tx.delete(customers).where(eq(customers.id, id));
        }

        return { kind: "ok", cascade };
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "23503") {
        fkConflict = true;
      } else {
        throw err;
      }
    }

    if (txOutcome?.kind === "conflict") {
      res.status(409).json({
        error: "CONFLICT",
        message: "Kunde hat zwischenzeitlich operative Daten erhalten — Hard-Delete nicht möglich.",
        details: txOutcome.conflict,
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

    birthdaysCache.invalidateAll();

    const cascade = txOutcome?.kind === "ok" ? txOutcome.cascade : null;
    res.json({
      success: true,
      message: hardDelete
        ? `Kunde "${customer.name}" wurde dauerhaft gelöscht`
        : `Kunde "${customer.name}" wurde gelöscht`,
      audit: cascade
        ? { parentDeletionId: cascade.parentAuditId, childAudits: cascade.childAudits, perTable: cascade.perTable }
        : null,
    });
  })
);

export default router;
