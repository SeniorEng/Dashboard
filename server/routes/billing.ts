import { Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { AppError, asyncHandler, badRequest, notFound } from "../lib/errors";
import { log } from "../lib/log";
import { requireIntParam } from "../lib/params";
import { formatPhoneForDisplay } from "@shared/utils/phone";
import { computeNoShowCharge, type CancellationPolicyType } from "@shared/domain/cancellation-policy";
import { quantizeKm, computeKmLineTotalCents } from "@shared/domain/invoice-line-items";
import {
  splitLineItemsAcrossPots,
  sumSharesByPot,
  POT_ORDER,
  type InvoicePotKey,
  type BudgetSplitForAppointment,
} from "@shared/domain/budget-invoice-split";
import { BUDGET_TYPE_LABELS, type BudgetType } from "@shared/domain/budgets";
import { resolveBudgetRecipient } from "../storage/budget-recipients";
import { randomUUID } from "crypto";
import {
  createInvoiceSchema,
  updateInvoiceStatusSchema,
  appointments,
  appointmentServices as appointmentServicesTable,
  services as servicesTable,
  users,
  userRoles,
  customers as customersTable,
  customerInsuranceHistory,
  insuranceProviders,
  invoices as invoicesTable,
  invoiceLineItems,
  monthlyServiceRecords,
  serviceRecordAppointments,
  customerServicePrices,
  budgetTransactions,
} from "@shared/schema";
import type { Invoice, InvoiceLineItem, CompanySettings, InsertDocumentDelivery, InvoiceRenderSnapshot, InvoiceRenderCompanySnapshot } from "@shared/schema";
import { INVOICE_RENDER_COMPANY_SNAPSHOT_KEYS } from "@shared/schema";
import type { BillingCustomerItem, BillingInvoicePreview, BlockingDraftInvoice, DiscardDraftsResponse } from "@shared/api";
import { documentDeliveries } from "@shared/schema";
import { computeDataHash } from "../services/signature-integrity";
import { budgetLedgerStorage } from "../storage/budget-ledger";
import { objectStorageClient } from "../replit_integrations/object_storage/objectStorage";
import { parseObjectPath, getPrivateDir } from "../lib/object-storage-helpers";
import { eq, and, gte, lte, lt, isNull, inArray, ne, notInArray, or, desc, sql } from "drizzle-orm";
import { z } from "zod";
import { fromError } from "zod-validation-error";
import { formatDateForDisplay, formatDateISO, todayISO, parseTimestamp, addDays } from "@shared/utils/datetime";
import { storage } from "../storage";
import { db } from "../lib/db";
import { monthlyServiceRecordsRepo, appointmentsRepo, customerServicePricesRepo } from "../repos";
import {
  getNextInvoiceNumberTx,
  createInvoiceTx,
  updateInvoiceStatusTx,
  getInvoiceLineItemsTx,
  getInvoiceForUpdateTx,
} from "../storage/billing-storage";
import { auditService } from "../services/audit";
import { withAudit } from "../lib/with-audit";
import { readTestFaults } from "../lib/test-fault-injector";
import { deliveryStorage } from "../storage/deliveries";
import type { InvoicePdfData } from "../lib/pdf-generator";
import {
  computeInvoicePdfFingerprint,
  computeLeistungsnachweisFingerprint,
} from "../lib/invoice-pdf-fingerprint";
import { getCachedCompanySettings } from "../services/cache";
import { recordPdfCacheSend } from "../lib/pdf-cache-stats";
import { sendInvoiceCopyByPost, combinePdfBuffers } from "../services/document-delivery";
import {
    schedulePdfPersistInBackground,
    buildPdfData,
    buildInvoicePdfBytes,
    computeLiveInvoiceFingerprints,
    persistInvoicePdf,
    loadInvoicePdfFromStorage,
    loadLeistungsnachweisPdfFromStorage,
    loadOrRenderSendablePdfs,
    renderLeistungsnachweisOnTheFly,
    shouldAppendStandaloneLeistungsnachweis,
  } from "../services/invoice-pdf-orchestrator";
import { ChromiumUnavailableError } from "../services/pdf-generator";
import { getBlockingDraftInvoices } from "../services/invoice-data";
import { buildInvoiceDraft, generateInvoiceCore } from "../services/invoice-calc";
import {
  MONTH_NAMES_DE,
  loadInsuranceForSend,
  detectHasParagraph39,
  applyCustomerPdfRecipient,
  doubleBeihilfePdfs,
  buildCustomerPostAddress,
} from "../services/invoice-delivery";

const router = Router();
router.use(requireAuth);
router.use(requireAdmin);

// Task #1066 — Übersetzt einen PDF-Render-/Persist-Fehler in eine konkrete,
// für den Admin verwertbare Fehlermeldung (statt eines generischen 500ers).
// Drei Klassen: Chromium nicht verfügbar (503), Render-Timeout (504) und
// fehlendes/nicht ladbares Object (404). `subject` benennt das betroffene
// Artefakt (z.B. "Rechnungs-PDF RE-2026-0007").
function classifyPdfRenderError(err: unknown, subject: string): AppError {
  if (err instanceof ChromiumUnavailableError) {
    return new AppError(
      503,
      "PDF_ENGINE_UNAVAILABLE",
      `${subject} konnte nicht erzeugt werden: Die PDF-Engine (Chromium) ist auf diesem Server nicht verfügbar. Bitte den Support kontaktieren.`,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/Timeout|überschritt/i.test(message)) {
    return new AppError(
      504,
      "PDF_RENDER_TIMEOUT",
      `${subject} konnte nicht erzeugt werden: Die PDF-Erstellung hat das Zeitlimit überschritten. Bitte in wenigen Minuten erneut versuchen.`,
    );
  }
  return notFound(
    `${subject} konnte nicht geladen werden — die PDF-Datei fehlt und konnte nicht neu erzeugt werden. Bitte erneut versuchen oder den Support kontaktieren.`,
  );
}

router.get("/", asyncHandler("Rechnungen konnten nicht geladen werden", async (req, res) => {
  const filters: { year?: number; month?: number; customerId?: number; status?: string; insuranceProviderId?: number } = {};
  if (req.query.year) filters.year = Number(req.query.year);
  if (req.query.month) filters.month = Number(req.query.month);
  if (req.query.customerId) filters.customerId = Number(req.query.customerId);
  if (req.query.status) filters.status = String(req.query.status);
  if (req.query.insuranceProviderId) {
    const ipid = Number(req.query.insuranceProviderId);
    if (Number.isFinite(ipid) && ipid > 0) filters.insuranceProviderId = ipid;
  }
  const invoices = await storage.getInvoices(filters);
  res.json(invoices);
}));

// Krankenkassen-Filter — liefert die Liste der Pflegekassen, die im
// gewählten Monat/Jahr mindestens eine Rechnung haben (für das
// Dropdown auf der Abrechnungsseite). Selbstzahler-Rechnungen tauchen
// hier bewusst nicht auf, weil Selbstzahler-Kunden keine Kasse
// hinterlegt haben — der „Alle"-Eintrag im Frontend deckt diese ab.
router.get("/payers", asyncHandler("Krankenkassen-Liste konnte nicht geladen werden", async (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  if (!year || !month || month < 1 || month > 12) {
    throw badRequest("Monat und Jahr sind erforderlich.");
  }
  const rows = await db
    .select({
      insuranceProviderId: insuranceProviders.id,
      name: insuranceProviders.name,
      invoiceCount: sql<number>`COUNT(DISTINCT ${invoicesTable.id})::int`,
    })
    .from(invoicesTable)
    .innerJoin(
      customerInsuranceHistory,
      and(
        eq(customerInsuranceHistory.customerId, invoicesTable.customerId),
        isNull(customerInsuranceHistory.validTo),
      ),
    )
    .innerJoin(insuranceProviders, eq(insuranceProviders.id, customerInsuranceHistory.insuranceProviderId))
    .where(and(eq(invoicesTable.billingYear, year), eq(invoicesTable.billingMonth, month)))
    .groupBy(insuranceProviders.id, insuranceProviders.name)
    .orderBy(insuranceProviders.name);
  res.json(rows);
}));

router.get("/eligible-customers", asyncHandler("Berechtigte Kunden konnten nicht geladen werden", async (req, res) => {
  const month = Number(req.query.month);
  const year = Number(req.query.year);
  if (!month || !year || month < 1 || month > 12) {
    throw badRequest("Monat und Jahr sind erforderlich.");
  }

  const signedRecords = await monthlyServiceRecordsRepo.selectColumnsFrom({
    id: monthlyServiceRecords.id,
    customerId: monthlyServiceRecords.customerId,
  })
    .where(and(
      eq(monthlyServiceRecords.year, year),
      eq(monthlyServiceRecords.month, month),
      or(
        eq(monthlyServiceRecords.status, "completed"),
        eq(monthlyServiceRecords.status, "employee_signed")
      ),
      monthlyServiceRecordsRepo.activeOnly()
    ));

  const uniqueCustomerIds = Array.from(new Set(signedRecords.map(r => r.customerId)));

  if (uniqueCustomerIds.length === 0) {
    return res.json([]);
  }

  // Task #576: Partial-Signing-Sichtbarkeit — pro Kunden zählen wir die
  // im Monat dokumentierten Termine (`completed`) vs. die durch
  // aktive LNs abgedeckten Termine. Liegt eine Lücke vor, kann das
  // Frontend einen Hinweis anzeigen ("3 von 5 Terminen erfasst"),
  // sodass Admins sehen, ob noch ein zweiter LN nötig ist.
  const mm = String(month).padStart(2, "0");
  const periodStartStr = `${year}-${mm}-01`;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const periodEndStr = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;

  const completedRows = await appointmentsRepo.selectColumnsFrom({
    customerId: appointments.customerId,
    count: sql<number>`COUNT(*)::int`,
  })
    .where(and(
      inArray(appointments.customerId, uniqueCustomerIds),
      eq(appointments.status, "completed"),
      appointmentsRepo.activeOnly(),
      gte(appointments.date, periodStartStr),
      lt(appointments.date, periodEndStr),
    ))
    .groupBy(appointments.customerId);
  const completedByCustomer = new Map(completedRows.map(r => [r.customerId, Number(r.count)]));

  const allActiveSrIds = signedRecords.map(r => r.id);
  const coveredRows = allActiveSrIds.length > 0
    ? await db.select({
        customerId: appointments.customerId,
        count: sql<number>`COUNT(DISTINCT ${serviceRecordAppointments.appointmentId})::int`,
      })
        .from(serviceRecordAppointments)
        .innerJoin(appointments, eq(serviceRecordAppointments.appointmentId, appointments.id))
        .where(and(
          inArray(serviceRecordAppointments.serviceRecordId, allActiveSrIds),
          inArray(appointments.customerId, uniqueCustomerIds),
        ))
        .groupBy(appointments.customerId)
    : [];
  const coveredByCustomer = new Map(coveredRows.map(r => [r.customerId, Number(r.count)]));

  const customerRows = await db.select({
    id: customersTable.id,
    name: customersTable.name,
    vorname: customersTable.vorname,
    nachname: customersTable.nachname,
    billingType: customersTable.billingType,
    status: customersTable.status,
  })
    .from(customersTable)
    .where(inArray(customersTable.id, uniqueCustomerIds));

  // Krankenkassen-Filter: schränkt die berechtigten Kunden auf die
  // gewählte Kasse ein. Wirkt damit auch auf den „Alle offenen
  // erstellen (N)"-Counter im Frontend.
  let filteredCustomerRows = customerRows;
  const insuranceProviderIdQ = req.query.insuranceProviderId ? Number(req.query.insuranceProviderId) : NaN;
  if (Number.isFinite(insuranceProviderIdQ) && insuranceProviderIdQ > 0) {
    const matching = await db.select({ customerId: customerInsuranceHistory.customerId })
      .from(customerInsuranceHistory)
      .where(and(
        inArray(customerInsuranceHistory.customerId, uniqueCustomerIds),
        isNull(customerInsuranceHistory.validTo),
        eq(customerInsuranceHistory.insuranceProviderId, insuranceProviderIdQ),
      ));
    const allowed = new Set(matching.map(r => r.customerId));
    filteredCustomerRows = customerRows.filter(c => allowed.has(c.id));
  }

  // Task #996: Kunden mit bereits existierender aktiver (nicht stornierter)
  // Rechnung für diesen Monat ausschließen — spiegelt die Idempotenz-Prüfung
  // aus `POST /generate-all` (hasActive), damit der „Alle offenen erstellen
  // (N)"-Counter exakt die Kunden zählt, für die die Massenerstellung
  // tatsächlich eine Rechnung anlegt (und nicht überspringt).
  const candidateIds = filteredCustomerRows.map(c => c.id);
  if (candidateIds.length > 0) {
    const existingInvoices = await db.select({
      customerId: invoicesTable.customerId,
    })
      .from(invoicesTable)
      .where(and(
        inArray(invoicesTable.customerId, candidateIds),
        eq(invoicesTable.billingYear, year),
        eq(invoicesTable.billingMonth, month),
        ne(invoicesTable.status, "storniert"),
        ne(invoicesTable.invoiceType, "stornorechnung"),
      ));
    const alreadyInvoiced = new Set(existingInvoices.map(r => r.customerId));
    filteredCustomerRows = filteredCustomerRows.filter(c => !alreadyInvoiced.has(c.id));
  }

  const eligibleCustomers: BillingCustomerItem[] = filteredCustomerRows.map(c => ({
    ...c,
    completedAppointments: completedByCustomer.get(c.id) ?? 0,
    coveredAppointments: coveredByCustomer.get(c.id) ?? 0,
  }));

  res.json(eligibleCustomers);
}));

// Task #750: Vorschau-Block für „Neue Rechnung erstellen"-Dialog.
// Liefert exakt die Werte, die der nachfolgende `POST /generate` schreiben
// würde — Anzahl signierter LNs, abgerechnete Termine (nach Filter
// „bereits abgerechnet"), dokumentierte Termine im Monat (Partial-Signing-
// Hinweis) und Brutto-Summe über alle entstehenden Folge-Rechnungen
// (Kassen-/Privatanteil bei Split). Persistiert nichts.
router.get("/preview", asyncHandler("Vorschau konnte nicht erstellt werden", async (req, res) => {
  const customerId = parseInt(String(req.query.customerId ?? ""), 10);
  const month = parseInt(String(req.query.month ?? ""), 10);
  const year = parseInt(String(req.query.year ?? ""), 10);
  if (!Number.isFinite(customerId) || customerId <= 0
    || !Number.isFinite(month) || month < 1 || month > 12
    || !Number.isFinite(year) || year < 2000 || year > 2100) {
    throw badRequest("Ungültige Parameter — customerId, month (1-12) und year sind erforderlich.");
  }
  const draft = await buildInvoiceDraft({ customerId, billingMonth: month, billingYear: year });
  const response: BillingInvoicePreview = {
    serviceRecordCount: draft.signedRecordCount,
    coveredAppointments: draft.apptIds.length,
    completedAppointments: draft.completedAppointmentsInPeriod,
    totalCents: draft.grossAmountCents,
    splitInvoices: draft.needsBudgetSplit,
    // Task #1010: Töpfe der erzeugten Folge-Rechnungen — nach POT_ORDER
    // sortiert, damit der Vorschau-Hinweis exakt benennt, was der
    // Generierungslauf erzeugt (keine Drift Vorschau ↔ Rechnung).
    splitPots: draft.needsBudgetSplit
      ? [...draft.potItems.keys()].sort(
          (a, b) => POT_ORDER.indexOf(a) - POT_ORDER.indexOf(b),
        )
      : [],
  };
  res.json(response);
}));

// Task #817: Listet verwaiste/blockierende Entwurfs-Rechnungen für einen
// Zeitraum. Der Dialog ruft dies auf, wenn die Vorschau „Alle Termine …
// bereits abgerechnet" meldet, um dem Admin eine konkrete Verwerfen-Aktion
// anzubieten. Persistiert nichts.
router.get("/blocking-drafts", asyncHandler("Blockierende Entwürfe konnten nicht ermittelt werden", async (req, res) => {
  const customerId = parseInt(String(req.query.customerId ?? ""), 10);
  const month = parseInt(String(req.query.month ?? ""), 10);
  const year = parseInt(String(req.query.year ?? ""), 10);
  if (!Number.isFinite(customerId) || customerId <= 0
    || !Number.isFinite(month) || month < 1 || month > 12
    || !Number.isFinite(year) || year < 2000 || year > 2100) {
    throw badRequest("Ungültige Parameter — customerId, month (1-12) und year sind erforderlich.");
  }
  const rows = await getBlockingDraftInvoices(customerId, year, month);
  const response: BlockingDraftInvoice[] = rows.map((r) => ({
    id: r.id,
    invoiceNumber: r.invoiceNumber,
    grossAmountCents: r.grossAmountCents,
    billingRunId: r.billingRunId,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
  }));
  res.json(response);
}));

// Task #817: Verwirft verwaiste Entwurfs-Rechnungen, die die Termine eines
// Zeitraums blockieren. GoBD-konform: NUR `status = 'entwurf'`-Rechnungen
// (nie festgeschrieben) werden gelöscht — finalisierte (versendet/bezahlt)
// und Storno-Rechnungen bleiben unberührt. Das Löschen kaskadiert die
// `invoice_line_items` (FK `ON DELETE CASCADE`) und gibt damit die Termine
// wieder frei. Jeder gelöschte Entwurf wird einzeln im Audit-Log
// dokumentiert, damit die Rechnungsnummern-Lücke nachvollziehbar bleibt.
router.post("/discard-drafts", asyncHandler("Entwürfe konnten nicht verworfen werden", async (req, res) => {
  const parsed = z.object({
    customerId: z.number().int().positive(),
    month: z.number().int().min(1).max(12),
    year: z.number().int().min(2000).max(2100),
    invoiceIds: z.array(z.number().int().positive()).optional(),
  }).safeParse(req.body);
  if (!parsed.success) {
    throw badRequest(fromError(parsed.error).toString());
  }
  const { customerId, month, year, invoiceIds } = parsed.data;

  // Kandidaten serverseitig auf genau diesen Kunden/Zeitraum + Entwurf-Status
  // einschränken. Ein optional übergebenes `invoiceIds` filtert nur innerhalb
  // dieser Menge — es kann NIE eine fremde/finalisierte Rechnung erfassen.
  const candidates = await getBlockingDraftInvoices(customerId, year, month);
  const scoped = invoiceIds && invoiceIds.length > 0
    ? candidates.filter((c) => invoiceIds.includes(c.id))
    : candidates;

  if (scoped.length === 0) {
    throw badRequest("Keine verwaisten Entwurfs-Rechnungen zum Verwerfen gefunden.");
  }

  const discardedNumbers = await withAudit(async (tx, audit) => {
    const numbers: string[] = [];
    for (const draft of scoped) {
      // Defensiv erneut auf Entwurf + kein Storno scopen (Race-Schutz):
      // Wenn der Entwurf zwischenzeitlich versendet/storniert wurde, löscht
      // dieses DELETE nichts und wird übersprungen.
      const deleted = await tx.delete(invoicesTable)
        .where(and(
          eq(invoicesTable.id, draft.id),
          eq(invoicesTable.customerId, customerId),
          eq(invoicesTable.billingYear, year),
          eq(invoicesTable.billingMonth, month),
          eq(invoicesTable.status, "entwurf"),
          ne(invoicesTable.invoiceType, "stornorechnung"),
        ))
        .returning({ id: invoicesTable.id, invoiceNumber: invoicesTable.invoiceNumber });
      if (deleted.length === 0) continue;
      numbers.push(deleted[0].invoiceNumber);
      audit.record({
        userId: req.user!.id,
        action: "invoice_draft_discarded",
        entityType: "invoice",
        entityId: draft.id,
        metadata: {
          invoiceNumber: deleted[0].invoiceNumber,
          customerId,
          billingMonth: month,
          billingYear: year,
          billingRunId: draft.billingRunId,
          grossAmountCents: draft.grossAmountCents,
          reason: "orphaned_draft_blocking_billing",
        },
        ipAddress: req.ip,
      });
    }
    return numbers;
  }, { faults: readTestFaults(req) });

  const response: DiscardDraftsResponse = {
    discarded: discardedNumbers.length,
    invoiceNumbers: discardedNumbers,
  };
  res.json(response);
}));

router.post("/send-batch", asyncHandler("Stapelversand fehlgeschlagen", async (req, res) => {
  const parsed = z.object({
    invoiceIds: z.array(z.number().int().positive()).min(1).max(50),
  }).safeParse(req.body);

  if (!parsed.success) {
    throw badRequest(fromError(parsed.error).toString());
  }

  const { invoiceIds } = parsed.data;
  const results: { invoiceId: number; invoiceNumber: string; status: string; error?: string; recipientEmail?: string }[] = [];

  const companySettings = await getCachedCompanySettings();
  if (!companySettings) throw badRequest("Firmendaten nicht konfiguriert.");

  // Task #552: Renderer-Imports werden bei Bedarf in `loadOrRenderSendablePdfs`
  // nachgeladen — beim Cache-Hit muss Puppeteer nicht angefasst werden.
  // Task #553: `ZugferdEmbedError` wird hier eager geladen, damit der
  // catch-Block unten typisiert prüfen kann.
  const { ZugferdEmbedError } = await import("../lib/zugferd");
  const { sendEmail, buildEmailLayout } = await import("../services/email-service");
  const { resolveLogoToDataUrl } = await import("../services/logo-resolver");
  const companyName = companySettings.companyName || "SeniorenEngel";
  const resolvedLogo = await resolveLogoToDataUrl(companySettings.logoUrl);

  for (const invoiceId of invoiceIds) {
    try {
      const invoice = await storage.getInvoice(invoiceId);
      if (!invoice) {
        results.push({ invoiceId, invoiceNumber: "", status: "error", error: "Rechnung nicht gefunden" });
        continue;
      }
      if (invoice.status !== "entwurf") {
        results.push({ invoiceId, invoiceNumber: invoice.invoiceNumber, status: "skipped", error: `Status: ${invoice.status}` });
        continue;
      }
      if (invoice.billingType !== "pflegekasse_gesetzlich" && invoice.billingType !== "pflegekasse_privat") {
        results.push({ invoiceId, invoiceNumber: invoice.invoiceNumber, status: "skipped", error: "Nicht an Pflegekasse" });
        continue;
      }

      const cust = await db.select().from(customersTable).where(eq(customersTable.id, invoice.customerId)).limit(1);
      if (!cust.length) {
        results.push({ invoiceId, invoiceNumber: invoice.invoiceNumber, status: "error", error: "Kunde nicht gefunden" });
        continue;
      }

      const isPrivatBilling = invoice.billingType === "pflegekasse_privat";
      const isBeihilfe = isPrivatBilling && cust[0].beihilfeBerechtigt;
      const isKostenerstattung = invoice.billingType === "pflegekasse_gesetzlich" && cust[0].rechnungAnKunde;
      const sendToCustomer = isPrivatBilling || isKostenerstattung;

      const { insHist, provider: prov } = await loadInsuranceForSend(invoice.customerId);

      if (!insHist.length) {
        results.push({ invoiceId, invoiceNumber: invoice.invoiceNumber, status: "error", error: "Keine Pflegekassenzuordnung" });
        continue;
      }

      let recipientEmail: string | null = null;
      let recipientName = "";
      let hasParagraph39 = false;

      if (sendToCustomer) {
        if (!cust[0].email) {
          results.push({ invoiceId, invoiceNumber: invoice.invoiceNumber, status: "error", error: "Keine E-Mail beim Kunden hinterlegt" });
          continue;
        }
        recipientEmail = cust[0].email;
        recipientName = [cust[0].vorname, cust[0].nachname].filter(Boolean).join(" ") || cust[0].name;
      } else {
        if (!prov.length || !prov[0].emailInvoiceEnabled) {
          results.push({ invoiceId, invoiceNumber: invoice.invoiceNumber, status: "error", error: "E-Mail-Versand nicht aktiviert" });
          continue;
        }

        hasParagraph39 = await detectHasParagraph39(invoiceId);

        recipientEmail = hasParagraph39 ? (prov[0].emailVerhinderungspflege || prov[0].email) : prov[0].email;
        recipientName = prov[0].name;
      }

      if (!recipientEmail) {
        results.push({ invoiceId, invoiceNumber: invoice.invoiceNumber, status: "error", error: sendToCustomer ? "Keine E-Mail beim Kunden" : "Keine E-Mail bei Pflegekasse" });
        continue;
      }

      const lineItems = await storage.getInvoiceLineItems(invoiceId);

      const pdfData = buildPdfData(invoice, lineItems, companySettings);
      applyCustomerPdfRecipient(pdfData, cust[0], { isBeihilfe, isKostenerstattung });

      // Task #552: PDF-Cache (pdfPath / leistungsnachweisPath) zuerst lesen;
      // on-demand-Render nur bei Cache-Miss. Cache-Miss triggert Hintergrund-
      // Persist, damit Folge-Sends Cache-Hits sind.
      // Task #553: Strict-Mode im Send-Pfad — beim Cache-Miss-Render wird
      // ein ZUGFeRD-Embedding-Failure als typisierter Fehler propagiert,
      // damit keine nicht-konforme Rechnung verschickt wird.
      let zugferdBuffer: Buffer;
      let lnPdf: Buffer;
      try {
        const rendered = await loadOrRenderSendablePdfs(
          invoice,
          pdfData,
          { isCustomerInvoice: sendToCustomer, strictZugferd: true, testFaults: readTestFaults(req) },
        );
        zugferdBuffer = rendered.invoicePdf;
        lnPdf = rendered.lnPdf;
      } catch (zugErr) {
        if (zugErr instanceof ZugferdEmbedError) {
          await auditService.log(
            req.user!.id,
            "invoice_zugferd_embed_failed",
            "invoice",
            invoiceId,
            {
              invoiceNumber: invoice.invoiceNumber,
              customerId: invoice.customerId,
              reason: zugErr.reason.slice(0, 500),
              batchSend: true,
            },
            req.ip,
          );
          results.push({
            invoiceId,
            invoiceNumber: invoice.invoiceNumber,
            status: "error",
            error: `ZUGFeRD-Einbettung fehlgeschlagen: ${zugErr.reason}. Rechnung wurde NICHT versendet.`,
          });
          continue;
        }
        throw zugErr;
      }

      let finalInvoicePdf: Buffer = zugferdBuffer;
      let finalLnPdf: Buffer = lnPdf;

      if (isBeihilfe) {
        const doubled = await doubleBeihilfePdfs(zugferdBuffer, lnPdf);
        finalInvoicePdf = doubled.invoicePdf;
        finalLnPdf = doubled.lnPdf;
      }

      const monthName = MONTH_NAMES_DE[(invoice.billingMonth - 1)] || String(invoice.billingMonth);
      const customerFullName = [cust[0].vorname, cust[0].nachname].filter(Boolean).join(" ") || cust[0].name;
      const versNr = insHist[0].versichertennummer || invoice.versichertennummer || "";

      const subject = `Rechnung ${invoice.invoiceNumber} — ${customerFullName}${versNr ? ` (${versNr})` : ""} — ${monthName} ${invoice.billingYear} — ${companyName}`;
      let bodyContent = "";
      if (sendToCustomer) {
        bodyContent = `
          <p>Sehr geehrte/r ${cust[0].vorname || ""} ${cust[0].nachname || ""},</p>
          <p>anbei erhalten Sie die Rechnung <strong>${invoice.invoiceNumber}</strong> sowie den zugehörigen Leistungsnachweis
          für den Leistungszeitraum <strong>${monthName} ${invoice.billingYear}</strong>.</p>
          ${isBeihilfe ? `<p><strong>Hinweis:</strong> Anbei erhalten Sie Ihre Rechnung und den Leistungsnachweis in doppelter Ausfertigung — bitte reichen Sie je ein Exemplar bei Ihrer privaten Pflegekasse und Ihrer Beihilfestelle ein.</p>` : ""}
          ${isKostenerstattung ? `<p><strong>Hinweis:</strong> Bitte begleichen Sie die Rechnung und reichen Sie diese zusammen mit dem Leistungsnachweis im Rahmen des Kostenerstattungsverfahrens bei Ihrer Pflegekasse zur Erstattung des Entlastungsbetrags nach § 45b SGB XI ein.</p>` : ""}
          <p>Bei Rückfragen stehen wir Ihnen gerne zur Verfügung.</p>
          <p>Mit freundlichen Grüßen<br/>${companyName}</p>
        `;
      } else {
        bodyContent = `
          <p>Sehr geehrte Damen und Herren,</p>
          <p>anbei erhalten Sie die Rechnung <strong>${invoice.invoiceNumber}</strong> sowie den zugehörigen Leistungsnachweis
          für <strong>${customerFullName}</strong>${versNr ? ` (Versichertennr. ${versNr})` : ""}
          für den Leistungszeitraum <strong>${monthName} ${invoice.billingYear}</strong>.</p>
          <p>Bei Rückfragen stehen wir Ihnen gerne zur Verfügung.</p>
          <p>Mit freundlichen Grüßen<br/>${companyName}</p>
        `;
      }
      const html = buildEmailLayout(companyName, resolvedLogo, bodyContent);

      const fileNames = `[${invoice.invoiceNumber}] ${invoice.invoiceNumber}.pdf, LN-${invoice.invoiceNumber}.pdf`;

      try {
        await sendEmail(companySettings, {
          to: recipientEmail,
          subject,
          html,
          attachments: [
            { filename: `${invoice.invoiceNumber}.pdf`, content: finalInvoicePdf, contentType: "application/pdf" },
            { filename: `LN-${invoice.invoiceNumber}.pdf`, content: finalLnPdf, contentType: "application/pdf" },
          ],
        });

        await withAudit(async (tx, audit) => {
          await updateInvoiceStatusTx(tx, invoiceId, "versendet", req.user!.id);
          audit.record({
            userId: req.user!.id,
            action: "invoice_sent",
            entityType: "invoice",
            entityId: invoiceId,
            metadata: {
              invoiceNumber: invoice.invoiceNumber,
              recipientEmail,
              customerId: invoice.customerId,
              insuranceProviderId: prov.length ? prov[0].id : null,
              hasParagraph39,
              batchSend: true,
              isPrivatBilling,
              isBeihilfe,
            },
            ipAddress: req.ip,
          });
        }, { faults: readTestFaults(req) });

        await deliveryStorage.createDelivery({
          customerId: invoice.customerId,
          deliveryMethod: "email",
          status: "sent",
          recipientEmail,
          recipientName: recipientName || (prov.length ? prov[0].name : ""),
          documentFileNames: fileNames,
          sentAt: new Date(),
          createdByUserId: req.user!.id,
        });

        results.push({ invoiceId, invoiceNumber: invoice.invoiceNumber, status: "sent", recipientEmail });
      } catch (sendErr: unknown) {
        const errMsg = sendErr instanceof Error ? sendErr.message : "Unbekannter Fehler";
        await deliveryStorage.createDelivery({
          customerId: invoice.customerId,
          deliveryMethod: "email",
          status: "error",
          recipientEmail,
          recipientName: recipientName || (prov.length ? prov[0].name : ""),
          documentFileNames: fileNames,
          errorMessage: errMsg,
          createdByUserId: req.user!.id,
        });
        results.push({ invoiceId, invoiceNumber: invoice.invoiceNumber, status: "error", error: errMsg });
        continue;
      }

      if (cust[0].receivesMonthlyInvoice) {
        const deliveryMethod = cust[0].documentDeliveryMethod || "email";
        const copyFileNames = `[${invoice.invoiceNumber}] Kopie: ${invoice.invoiceNumber}.pdf, LN-${invoice.invoiceNumber}.pdf`;
        try {
          if (deliveryMethod === "email" && !cust[0].email) {
            await deliveryStorage.createDelivery({
              customerId: invoice.customerId,
              deliveryMethod: "email",
              status: "error",
              recipientName: customerFullName,
              documentFileNames: copyFileNames,
              errorMessage: "Keine E-Mail-Adresse beim Kunden hinterlegt",
              createdByUserId: req.user!.id,
            });
          } else if (deliveryMethod === "email" && cust[0].email) {
            const customerSubject = `Rechnungskopie ${invoice.invoiceNumber} — ${monthName} ${invoice.billingYear}`;
            const customerBody = `
              <p>Sehr geehrte/r ${cust[0].vorname || ""} ${cust[0].nachname || ""},</p>
              <p>anbei erhalten Sie eine Kopie der Rechnung <strong>${invoice.invoiceNumber}</strong>
              für den Leistungszeitraum <strong>${monthName} ${invoice.billingYear}</strong>,
              die an Ihre Pflegekasse gesendet wurde.</p>
              <p>Mit freundlichen Grüßen<br/>${companyName}</p>
            `;
            const customerHtml = buildEmailLayout(companyName, resolvedLogo, customerBody);
            await sendEmail(companySettings, {
              to: cust[0].email,
              subject: customerSubject,
              html: customerHtml,
              attachments: [
                { filename: `${invoice.invoiceNumber}.pdf`, content: zugferdBuffer, contentType: "application/pdf" },
                { filename: `LN-${invoice.invoiceNumber}.pdf`, content: lnPdf, contentType: "application/pdf" },
              ],
            });
            await deliveryStorage.createDelivery({
              customerId: invoice.customerId,
              deliveryMethod: "email",
              status: "sent",
              recipientEmail: cust[0].email,
              recipientName: customerFullName,
              documentFileNames: copyFileNames,
              sentAt: new Date(),
              createdByUserId: req.user!.id,
            });
          } else if (deliveryMethod === "post") {
            const customerAddress = buildCustomerPostAddress(cust[0]);
            const { letterId } = await sendInvoiceCopyByPost(companySettings, {
              customer: cust[0],
              invoicePdf: zugferdBuffer,
              leistungsnachweisPdf: lnPdf,
              invoiceNumber: invoice.invoiceNumber,
              monthName,
              year: invoice.billingYear,
            });
            await deliveryStorage.createDelivery({
              customerId: invoice.customerId,
              deliveryMethod: "post",
              status: "sent",
              recipientName: customerFullName,
              recipientAddress: customerAddress,
              documentFileNames: copyFileNames,
              sentAt: new Date(),
              letterxpressLetterId: letterId,
              createdByUserId: req.user!.id,
            });
          }
        } catch (copyErr: unknown) {
          const copyErrMsg = copyErr instanceof Error ? copyErr.message : "Unbekannter Fehler";
          console.error("Kundenkopie fehlgeschlagen:", copyErrMsg);
          await deliveryStorage.createDelivery({
            customerId: invoice.customerId,
            deliveryMethod: deliveryMethod,
            status: "error",
            recipientEmail: cust[0].email || null,
            recipientName: customerFullName,
            documentFileNames: copyFileNames,
            errorMessage: copyErrMsg,
            createdByUserId: req.user!.id,
          }).catch(() => {});
        }
      }
    } catch (error: unknown) {
      const inv = await storage.getInvoice(invoiceId).catch(() => null);
      results.push({ invoiceId, invoiceNumber: inv?.invoiceNumber || "", status: "error", error: error instanceof Error ? error.message : "Unbekannter Fehler" });
    }
  }

  const sentCount = results.filter(r => r.status === "sent").length;
  const errorCount = results.filter(r => r.status === "error").length;
  const skippedCount = results.filter(r => r.status === "skipped").length;

  res.json({
    message: `${sentCount} versendet, ${errorCount} Fehler, ${skippedCount} übersprungen`,
    results,
    summary: { sent: sentCount, errors: errorCount, skipped: skippedCount, total: invoiceIds.length },
  });
}));

router.get("/deliveries/:invoiceId", asyncHandler("Versandhistorie konnte nicht geladen werden", async (req, res) => {
  const invoiceId = requireIntParam(req.params.invoiceId, res);
  if (invoiceId === null) return;
  const invoice = await storage.getInvoice(invoiceId);
  if (!invoice) throw notFound("Rechnung nicht gefunden");
  const prefix = `[${invoice.invoiceNumber}]`;
  const deliveries = await db.select()
    .from(documentDeliveries)
    .where(eq(documentDeliveries.customerId, invoice.customerId))
    .orderBy(desc(documentDeliveries.createdAt));
  const invoiceDeliveries = deliveries.filter(d =>
    d.documentFileNames?.startsWith(prefix)
  );
  res.json(invoiceDeliveries);
}));

// Task #1044 — MUSS vor `router.get("/:id")` stehen: sonst fängt die
// param-Route den statischen Pfad `/bundle-by-payer` ab (id="bundle-by-payer"
// → 400 "Ungültiger Parameter") und die Route ist tot.
router.get("/bundle-by-payer", asyncHandler("Krankenkassen-Bündel konnte nicht erzeugt werden — bitte erneut versuchen.", async (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  const insuranceProviderId = Number(req.query.insuranceProviderId);
  const format = String(req.query.format ?? "zip").toLowerCase();
  if (!year || !month || month < 1 || month > 12) {
    throw badRequest("Monat und Jahr sind erforderlich.");
  }
  if (!Number.isFinite(insuranceProviderId) || insuranceProviderId <= 0) {
    throw badRequest("insuranceProviderId ist erforderlich.");
  }
  if (format !== "zip" && format !== "pdf") {
    throw badRequest("format muss 'zip' oder 'pdf' sein.");
  }

  const provider = await db.select({ name: insuranceProviders.name })
    .from(insuranceProviders)
    .where(eq(insuranceProviders.id, insuranceProviderId));
  if (provider.length === 0) throw notFound("Krankenkasse nicht gefunden");
  const providerName = provider[0].name;

  const allInvoices = await storage.getInvoices({ year, month, insuranceProviderId });
  // Stornierte Rechnungen und reine Stornorechnungen fliegen aus dem
  // Druck-Bündel raus — der Admin will den postalischen Stapel für die
  // Kasse drucken, nicht Storno-Belege.
  const printable = allInvoices
    .filter(inv => inv.status !== "storniert" && inv.invoiceType !== "stornorechnung")
    .sort((a, b) => a.invoiceNumber.localeCompare(b.invoiceNumber));

  if (printable.length === 0) {
    throw notFound(`Keine druckbaren Rechnungen für ${providerName} in ${String(month).padStart(2, "0")}/${year} gefunden.`);
  }

  // Pro Rechnung: Rechnungs-PDF + LN-PDF beschaffen (gleiche Logik wie /:id/bundle).
  // Task #1039 — `appendLn` steuert, ob der separat gecachte Standalone-LN
  // zusätzlich angehängt wird. Bei kundenadressierten Rechnungen ist der LN
  // bereits im Rechnungs-PDF einmontiert → nicht doppelt anhängen.
  type Pair = { invoiceNumber: string; invoicePdf: Buffer; lnPdf: Buffer | null; appendLn: boolean };
  const pairs: Pair[] = [];
  for (const inv of printable) {
    let invoicePdf = await loadInvoicePdfFromStorage(inv);
    let lnPdf = await loadLeistungsnachweisPdfFromStorage(inv);
    const isPflegekasse = inv.billingType === "pflegekasse_gesetzlich" || inv.billingType === "pflegekasse_privat";
    let persistError: unknown = null;
    if (!invoicePdf || (!lnPdf && isPflegekasse)) {
      try {
        await persistInvoicePdf(inv.id);
      } catch (err) {
        persistError = err;
        console.error(`[billing/bundle-by-payer] PDF-Persistierung für Rechnung ${inv.id} fehlgeschlagen:`, err);
      }
      const refreshed = await storage.getInvoice(inv.id);
      if (refreshed) {
        invoicePdf = await loadInvoicePdfFromStorage(refreshed) ?? invoicePdf;
        lnPdf = await loadLeistungsnachweisPdfFromStorage(refreshed) ?? lnPdf;
      }
    }
    if (!invoicePdf) {
      // Task #1068 — konkrete Ursache (Chromium/Timeout/Object fehlt) melden,
      // statt eines generischen „konnte nicht geladen werden".
      throw classifyPdfRenderError(persistError, `Rechnungs-PDF ${inv.invoiceNumber}`);
    }
    const appendLn = await shouldAppendStandaloneLeistungsnachweis(inv);
    if (!lnPdf && appendLn) {
      try {
        lnPdf = await renderLeistungsnachweisOnTheFly(inv);
      } catch (err) {
        console.error(`[billing/bundle-by-payer] LN-On-the-fly für Rechnung ${inv.id} fehlgeschlagen:`, err);
        // Task #1068 — konkrete Ursache statt generisch melden.
        throw classifyPdfRenderError(err, `Leistungsnachweis ${inv.invoiceNumber}`);
      }
    }
    pairs.push({ invoiceNumber: inv.invoiceNumber, invoicePdf, lnPdf, appendLn });
  }

  const safeProviderSlug = providerName.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "Kasse";
  const baseFileName = `Buendel-${safeProviderSlug}-${String(month).padStart(2, "0")}-${year}`;

  if (format === "pdf") {
    const { PDFDocument } = await import("pdf-lib");
    const merged = await PDFDocument.create();
    for (const p of pairs) {
      const inv = await PDFDocument.load(p.invoicePdf);
      const ip = await merged.copyPages(inv, inv.getPageIndices());
      ip.forEach(pg => merged.addPage(pg));
      if (p.lnPdf && p.appendLn) {
        const ln = await PDFDocument.load(p.lnPdf);
        const lp = await merged.copyPages(ln, ln.getPageIndices());
        lp.forEach(pg => merged.addPage(pg));
      }
    }
    const bytes = Buffer.from(await merged.save());
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${baseFileName}.pdf"`);
    return res.send(bytes);
  }

  // format === "zip"
  const archiver = (await import("archiver")).default;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${baseFileName}.zip"`);
  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.on("error", (err: Error) => {
    console.error("[billing/bundle-by-payer] archive error:", err);
    if (!res.headersSent) res.status(500);
    res.end();
  });
  archive.pipe(res);
  for (const p of pairs) {
    archive.append(p.invoicePdf, { name: `${p.invoiceNumber}-Rechnung.pdf` });
    if (p.lnPdf && p.appendLn) {
      archive.append(p.lnPdf, { name: `${p.invoiceNumber}-Leistungsnachweis.pdf` });
    }
  }
  await archive.finalize();
}));

router.get("/:id", asyncHandler("Rechnung konnte nicht geladen werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  const invoice = await storage.getInvoice(id);
  if (!invoice) throw notFound("Rechnung nicht gefunden");
  const lineItems = await storage.getInvoiceLineItems(id);

  // Task #522: Drift-Indikator — vergleicht den gespeicherten Fingerprint
  // mit dem Live-Fingerprint aus den aktuellen Stamm-/Termin-/Unterschrifts-
  // daten. Drift = die zugrundeliegenden Daten wurden NACH der PDF-Erstellung
  // verändert (Rechnung muss storniert + neu erzeugt werden, GoBD).
  let pdfDrift = false;
  let leistungsnachweisDrift = false;
  if (invoice.pdfDataFingerprint || invoice.leistungsnachweisDataFingerprint) {
    try {
      const live = await computeLiveInvoiceFingerprints(invoice);
      if (invoice.pdfDataFingerprint && live.pdfFingerprint && invoice.pdfDataFingerprint !== live.pdfFingerprint) {
        pdfDrift = true;
      }
      if (
        invoice.leistungsnachweisDataFingerprint &&
        live.leistungsnachweisFingerprint &&
        invoice.leistungsnachweisDataFingerprint !== live.leistungsnachweisFingerprint
      ) {
        leistungsnachweisDrift = true;
      }
    } catch (err) {
      console.error(`[billing/${id}] Drift-Check fehlgeschlagen:`, err);
    }
  }

  res.json({ ...invoice, lineItems, pdfDrift, leistungsnachweisDrift });
}));

// Task #533: Dünner HTTP-Wrapper um generateInvoiceCore (siehe oben).
router.post("/generate", asyncHandler("Rechnung konnte nicht erstellt werden", async (req, res) => {
  const parsed = createInvoiceSchema.safeParse(req.body);
  if (!parsed.success) {
    throw badRequest(fromError(parsed.error).toString());
  }
  const result = await generateInvoiceCore(parsed.data, {
    userId: req.user!.id,
    ipAddress: req.ip,
    testFaults: readTestFaults(req),
  });
  res.json(result);
}));


router.patch("/:id/status", asyncHandler("Status konnte nicht aktualisiert werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  const parsed = updateInvoiceStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    throw badRequest(fromError(parsed.error).toString());
  }

  const invoice = await storage.getInvoice(id);
  if (!invoice) throw notFound("Rechnung nicht gefunden");

  const { status, cascadeRun } = parsed.data;
  const currentStatus = invoice.status;

  const allowedTransitions: Record<string, string[]> = {
    entwurf: ["versendet", "storniert"],
    versendet: ["bezahlt", "storniert"],
    bezahlt: ["storniert"],
    storniert: [],
  };

  if (!allowedTransitions[currentStatus]?.includes(status)) {
    throw badRequest(`Statuswechsel von "${currentStatus}" zu "${status}" ist nicht erlaubt.`);
  }

  let updated: Invoice;
  if (status === "storniert") {
    if (invoice.invoiceType === "stornorechnung") {
      throw badRequest("Stornorechnungen können nicht erneut storniert werden.");
    }

    // Task #759 — Cascade-Storno: ein PATCH storniert alle Geschwister-
    // Rechnungen einer billing_run_id in EINER Transaktion. So bleibt der
    // Topf-Split atomar konsistent (entweder ALLE Rechnungen storniert
    // oder keine).
    const { stornoInvoice, invoiceNumber, updatedOriginal, cascadeIds } = await withAudit(async (tx, audit) => {
      const performStorno = async (originalId: number): Promise<{ stornoInvoice: Invoice; invoiceNumber: string; updatedOriginal: Invoice }> => {
      // Re-Read mit FOR UPDATE: serialisiert parallele Stornos derselben
      // Originalrechnung. Ohne Lock würden zwei PATCHs den alten Status sehen
      // und beide eine Stornorechnung erzeugen.
      const locked = await getInvoiceForUpdateTx(tx, originalId);
      if (!locked) throw notFound("Rechnung nicht gefunden");
      if (locked.status === "storniert") {
        throw badRequest("Diese Rechnung wurde bereits storniert.");
      }
      if (locked.invoiceType === "stornorechnung") {
        throw badRequest("Stornorechnungen können nicht erneut storniert werden.");
      }

      const number = await getNextInvoiceNumberTx(tx, locked.billingYear);
      const lineItems = await getInvoiceLineItemsTx(tx, originalId);

      // Task #562 — Fälligkeit auch für Storno-Inserts (außerhalb von
      // generateInvoiceCore): companySettings + Default 30 Tage.
      const stornoCompanySettings = await getCachedCompanySettings();
      const stornoDueDays = stornoCompanySettings?.invoiceDefaultDueDays ?? 30;
      const stornoDueDateIso = addDays(todayISO(), stornoDueDays);

      const stornoData = {
        invoiceNumber: number,
        customerId: locked.customerId,
        billingType: locked.billingType,
        invoiceType: "stornorechnung",
        billingMonth: locked.billingMonth,
        billingYear: locked.billingYear,
        recipientName: locked.recipientName,
        recipientAddress: locked.recipientAddress,
        customerName: locked.customerName,
        insuranceProviderName: locked.insuranceProviderName,
        insuranceIkNummer: locked.insuranceIkNummer,
        versichertennummer: locked.versichertennummer,
        pflegegrad: locked.pflegegrad,
        netAmountCents: -locked.netAmountCents,
        vatAmountCents: -locked.vatAmountCents,
        grossAmountCents: -locked.grossAmountCents,
        vatRate: locked.vatRate,
        // T10/BL-12: Stornorechnung startet als Entwurf, nicht als versendet —
        // der Versand-Pfad setzt status erst nach erfolgreicher Zustellung.
        status: "entwurf",
        stornierteRechnungId: id,
        // Task #562 — Storno-Rechnung spiegelt die Pflichtfelder der
        // Originalrechnung. Fälligkeit wird auf das aktuelle Datum + N Tage
        // gesetzt, damit eine Storno-Korrektur kein abgelaufenes Ziel trägt.
        dueDate: stornoDueDateIso,
        buyerReference: locked.buyerReference ?? null,
        assignmentDeclarationDate: locked.assignmentDeclarationDate ?? null,
        assignmentDeclarationRef: locked.assignmentDeclarationRef ?? null,
      };

      const stornoLineItems = lineItems.map((item: InvoiceLineItem) => ({
        appointmentId: item.appointmentId,
        appointmentDate: item.appointmentDate,
        serviceDescription: item.serviceDescription,
        serviceCode: item.serviceCode,
        startTime: item.startTime,
        endTime: item.endTime,
        durationMinutes: item.durationMinutes,
        // Task #561: Menge/Einheit der Originalrechnung 1:1 übernehmen.
        // Für historische Original-Lines (vor Task #561) sind beide Felder
        // NULL — Storno bleibt damit konsistent zur Original-Anzeige.
        quantityRaw: item.quantityRaw,
        quantityUnit: item.quantityUnit,
        unitPriceCents: item.unitPriceCents,
        totalCents: -item.totalCents,
        employeeName: item.employeeName,
        appointmentNotes: item.appointmentNotes || null,
        serviceDetails: item.serviceDetails || null,
      }));

      const created = await createInvoiceTx(tx, stornoData, stornoLineItems, req.user!.id);
      const original = await updateInvoiceStatusTx(tx, originalId, status, req.user!.id);

      // Task #576: Storno darf den zugehörigen Leistungsnachweis NIE
      // soft-löschen. Der frühere T05/K3-Pfad hat bei Partial-Signing
      // (LN deckt nur N von M dokumentierten Terminen ab) den gesamten LN
      // entfernt — Folge: der Kunde verschwand aus `/eligible-customers`
      // (Filter `activeOnly()`), und „Neue Rechnung erstellen" zeigte ihn
      // nicht mehr an. Re-Abrechnung derselben Termine (BF-5.3) und
      // Nachberechnung neu hinzukommender Termine sind beide weiterhin
      // möglich, ohne den LN anzufassen: `buildLineItemsFromAppointments`
      // schließt stornierte Termine über `status='storniert'` /
      // `invoiceType='stornorechnung'` aus. Ein evtl. nötiger neuer LN
      // für zusätzliche dokumentierte Termine wird vom Mitarbeiter
      // bewusst angelegt — automatischer LN-Reset ist nicht GoBD-konform
      // und war die Ursache für die verschwundenen Kunden (Prod-IDs
      // 108/117, 22.05.2026).

      // T04/K2: Storno-Reversal — alle §45b/Privat-Budget-Transaktionen der
      // Original-Rechnungs-Termine werden in derselben Transaktion zurückgebucht,
      // damit der §45b-Topf wieder als verfügbar angezeigt wird.
      const apptIdsForReversal = Array.from(
        new Set(
          lineItems
            .map((it: InvoiceLineItem) => it.appointmentId)
            .filter((v): v is number => typeof v === "number"),
        ),
      );
      for (const apptId of apptIdsForReversal) {
        const txs = await tx.select()
          .from(budgetTransactions)
          .where(and(
            eq(budgetTransactions.appointmentId, apptId),
            eq(budgetTransactions.transactionType, "consumption"),
          ));
        for (const t of txs) {
          await budgetLedgerStorage.reverseBudgetTransaction(t.id, req.user!.id, tx);
        }
      }

      audit.record({
        userId: req.user!.id,
        action: "invoice_cancelled",
        entityType: "invoice",
        entityId: originalId,
        metadata: {
          originalInvoiceNumber: locked.invoiceNumber,
          stornoInvoiceId: created.id,
          stornoInvoiceNumber: number,
          customerId: locked.customerId,
          grossAmountCents: locked.grossAmountCents,
          oldStatus: locked.status,
          newStatus: status,
          ...(locked.billingRunId ? { billingRunId: locked.billingRunId } : {}),
        },
        ipAddress: req.ip,
      });

      return { stornoInvoice: created, invoiceNumber: number, updatedOriginal: original };
      };

      // 1) Haupt-Rechnung stornieren.
      const main = await performStorno(id);

      // 2) Optional: Cascade über billing_run_id-Geschwister.
      const cascadeStornoIds: number[] = [];
      if (cascadeRun && invoice.billingRunId) {
        const siblings = await tx.select({ id: invoicesTable.id })
          .from(invoicesTable)
          .where(and(
            eq(invoicesTable.billingRunId, invoice.billingRunId),
            ne(invoicesTable.id, id),
            ne(invoicesTable.status, "storniert"),
            ne(invoicesTable.invoiceType, "stornorechnung"),
          ));
        for (const s of siblings) {
          const r = await performStorno(s.id);
          cascadeStornoIds.push(r.stornoInvoice.id);
        }
      }

      return {
        stornoInvoice: main.stornoInvoice,
        invoiceNumber: main.invoiceNumber,
        updatedOriginal: main.updatedOriginal,
        cascadeIds: cascadeStornoIds,
      };
    }, { faults: readTestFaults(req) });

    // Task #577: Storno-PDF im Hintergrund persistieren — analog zum normalen
    // Rechnungs-Erstanlage-Pfad (siehe generateInvoiceCore / Task #544).
    // Ohne diesen Aufruf bleibt `pdf_path` der Stornorechnung NULL, was
    // E-Mail-/E-POST-Versand blockiert. (Prod-IDs 5/6/7/9 sind das Erbe
    // dieses Defekts und werden via Startup-Migration nachgezogen.)
    schedulePdfPersistInBackground(stornoInvoice.id);
    // Task #759: Auch die Geschwister-Stornos brauchen ihre PDFs.
    for (const sid of cascadeIds) {
      schedulePdfPersistInBackground(sid);
    }
    void invoiceNumber;

    updated = updatedOriginal;
  } else {
    updated = await withAudit(async (tx, audit) => {
      const u = await updateInvoiceStatusTx(tx, id, status, req.user!.id);
      audit.record({
        userId: req.user!.id,
        action: "invoice_status_changed",
        entityType: "invoice",
        entityId: id,
        metadata: {
          invoiceNumber: invoice.invoiceNumber,
          customerId: invoice.customerId,
          oldStatus: currentStatus,
          newStatus: status,
        },
        ipAddress: req.ip,
      });
      return u;
    }, { faults: readTestFaults(req) });
  }

  res.json(updated);
}));

router.get("/:id/pdf", asyncHandler("PDF konnte nicht erzeugt werden — bitte in wenigen Minuten erneut versuchen oder den Support kontaktieren.", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  const invoice = await storage.getInvoice(id);
  if (!invoice) throw notFound("Rechnung nicht gefunden");

  // T01/PDF-Hash: Wenn die Rechnung bereits einen persistierten PDF-Pfad hat,
  // liefere die hashstabilen Bytes direkt aus Object Storage aus.
  const cached = await loadInvoicePdfFromStorage(invoice);
  if (cached) {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${invoice.invoiceNumber}.pdf"`);
    // Task #522: Drift-Header — wenn die Live-Daten nicht mehr zum
    // gespeicherten Fingerprint passen, wird das PDF weiterhin GoBD-konform
    // aus dem Cache ausgeliefert, aber Aufrufer/UI bekommen den Hinweis.
    if (invoice.pdfDataFingerprint) {
      try {
        const live = await computeLiveInvoiceFingerprints(invoice);
        if (live.pdfFingerprint && live.pdfFingerprint !== invoice.pdfDataFingerprint) {
          res.setHeader("X-Pdf-Drift", "true");
        }
      } catch (err) {
        console.error(`[billing/pdf] Drift-Check für Rechnung ${id} fehlgeschlagen:`, err);
      }
    }
    res.send(cached);
    return;
  }

  // Task #521: Legacy-Rechnungen ohne persistiertes PDF — on-demand erzeugen,
  // persistieren und aus dem Cache ausliefern (Backfill-Effekt).
  try {
    await persistInvoicePdf(id);
  } catch (err) {
    console.error(`[billing/pdf] PDF-Persistierung für Rechnung ${id} fehlgeschlagen:`, err);
    throw err;
  }
  const refreshed = await storage.getInvoice(id);
  const fresh = refreshed ? await loadInvoicePdfFromStorage(refreshed) : null;
  if (!fresh) {
    throw notFound("PDF konnte nicht aus dem Speicher gelesen werden — bitte erneut versuchen.");
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${invoice.invoiceNumber}.pdf"`);
  res.send(fresh);
}));

router.get("/:id/leistungsnachweis", asyncHandler("Leistungsnachweis konnte nicht erzeugt werden — bitte in wenigen Minuten erneut versuchen oder den Support kontaktieren.", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  const invoice = await storage.getInvoice(id);
  if (!invoice) throw notFound("Rechnung nicht gefunden");

  // Task #521: Wenn der LN bereits in Object Storage liegt, direkt
  // ausliefern (kein Puppeteer-Round-Trip).
  const cachedLn = await loadLeistungsnachweisPdfFromStorage(invoice);
  if (cachedLn) {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="LN-${invoice.invoiceNumber}.pdf"`);
    // Task #522: Drift-Header für den Leistungsnachweis.
    if (invoice.leistungsnachweisDataFingerprint) {
      try {
        const live = await computeLiveInvoiceFingerprints(invoice);
        if (
          live.leistungsnachweisFingerprint &&
          live.leistungsnachweisFingerprint !== invoice.leistungsnachweisDataFingerprint
        ) {
          res.setHeader("X-Pdf-Drift", "true");
        }
      } catch (err) {
        console.error(`[billing/leistungsnachweis] Drift-Check für Rechnung ${id} fehlgeschlagen:`, err);
      }
    }
    res.send(cachedLn);
    return;
  }

  const isPflegekasseInvoice = invoice.billingType === "pflegekasse_privat"
    || invoice.billingType === "pflegekasse_gesetzlich";

  // Pflegekassen-Rechnungen: Beim Cache-Miss persistInvoicePdf aufrufen, damit
  // sowohl Rechnungs-PDF als auch LN-PDF gebackfillt werden, und dann aus dem
  // Storage ausliefern.
  if (isPflegekasseInvoice) {
    try {
      await persistInvoicePdf(id);
    } catch (err) {
      console.error(`[billing/leistungsnachweis] LN-Persistierung für Rechnung ${id} fehlgeschlagen:`, err);
      throw err;
    }
    const refreshed = await storage.getInvoice(id);
    const fresh = refreshed ? await loadLeistungsnachweisPdfFromStorage(refreshed) : null;
    if (fresh) {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="LN-${invoice.invoiceNumber}.pdf"`);
      res.send(fresh);
      return;
    }
  }

  // Selbstzahler-Fallback: on-the-fly rendern ohne Persistenz (kein LN-Cache).
  const buffer = await renderLeistungsnachweisOnTheFly(invoice);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="LN-${invoice.invoiceNumber}.pdf"`);
  res.send(buffer);
}));


router.post("/:id/send", asyncHandler("Rechnung konnte nicht versendet werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const invoice = await storage.getInvoice(id);
  if (!invoice) throw notFound("Rechnung nicht gefunden");

  if (invoice.status !== "entwurf") {
    throw badRequest(`Rechnung hat Status "${invoice.status}" — nur Entwürfe können versendet werden.`);
  }

  if (invoice.billingType !== "pflegekasse_gesetzlich" && invoice.billingType !== "pflegekasse_privat") {
    throw badRequest("Nur Rechnungen an Pflegekassen können über diese Funktion versendet werden.");
  }

  // _customer_ (cust) wird unten aus DB gelesen; rechnungAnKunde-Auswertung
  // erfolgt erst nach dem Customer-Lookup.

  // T06/BL-16: Hard-Block — Versand nur möglich, wenn für den
  // Abrechnungs-Zeitraum mindestens ein Leistungsnachweis vollständig
  // (employee + customer) signiert ist. Ohne Signaturen ist die Rechnung
  // gegenüber Kasse/Kunde nicht beweisbar — wir lehnen den Versand ab,
  // statt unsigniert zu versenden.
  const signedSrCount = await monthlyServiceRecordsRepo.selectColumnsFrom({ id: monthlyServiceRecords.id })
    .where(and(
      eq(monthlyServiceRecords.customerId, invoice.customerId),
      eq(monthlyServiceRecords.year, invoice.billingYear),
      eq(monthlyServiceRecords.month, invoice.billingMonth),
      monthlyServiceRecordsRepo.activeOnly(),
      inArray(monthlyServiceRecords.status, ["completed", "employee_signed"]),
    ));
  if (signedSrCount.length === 0) {
    throw badRequest(
      "Versand abgelehnt: Für diesen Abrechnungs-Zeitraum existiert kein vollständig unterschriebener Leistungsnachweis. Bitte zuerst Mitarbeiter- und Kundenunterschrift einholen.",
    );
  }

  const customer = await db.select().from(customersTable).where(eq(customersTable.id, invoice.customerId)).limit(1);
  if (!customer.length) throw notFound("Kunde nicht gefunden");
  const cust = customer[0];

  const isPrivatBilling = invoice.billingType === "pflegekasse_privat";
  const isBeihilfe = isPrivatBilling && cust.beihilfeBerechtigt;
  const isKostenerstattung = invoice.billingType === "pflegekasse_gesetzlich" && cust.rechnungAnKunde;
  const sendToCustomer = isPrivatBilling || isKostenerstattung;

  const { insHist: insHistory, provider } = await loadInsuranceForSend(invoice.customerId);

  if (!insHistory.length) throw badRequest("Keine aktive Pflegekassenzuordnung für diesen Kunden.");

  let recipientEmail: string | null = null;
  let recipientDisplayName = "";
  let hasParagraph39 = false;

  if (sendToCustomer) {
    if (!cust.email) throw badRequest("Keine E-Mail-Adresse beim Kunden hinterlegt.");
    recipientEmail = cust.email;
    recipientDisplayName = [cust.vorname, cust.nachname].filter(Boolean).join(" ") || cust.name;
  } else {
    if (!provider.length) throw notFound("Pflegekasse nicht gefunden");
    const ins = provider[0];
    if (!ins.emailInvoiceEnabled) {
      throw badRequest("E-Mail-Versand ist für diese Pflegekasse nicht aktiviert.");
    }

    hasParagraph39 = await detectHasParagraph39(id);

    recipientEmail = hasParagraph39 ? (ins.emailVerhinderungspflege || ins.email) : ins.email;
    recipientDisplayName = ins.name;
  }

  if (!recipientEmail) {
    throw badRequest(sendToCustomer ? "Keine E-Mail-Adresse beim Kunden hinterlegt." : "Keine E-Mail-Adresse bei der Pflegekasse hinterlegt.");
  }

  const lineItems = await storage.getInvoiceLineItems(id);

  const companySettings = await getCachedCompanySettings();
  if (!companySettings) throw badRequest("Firmendaten nicht konfiguriert.");

  const pdfData = buildPdfData(invoice, lineItems, companySettings);

  applyCustomerPdfRecipient(pdfData, cust, { isBeihilfe, isKostenerstattung });

  // Task #552: PDF-Cache (pdfPath / leistungsnachweisPath) zuerst lesen;
  // on-demand-Render nur bei Cache-Miss. Concurrent Send-Klicks werden über
  // den `persistInvoicePdf`-Mutex serialisiert.
  // Task #553: Strict-Mode im Send-Pfad — bei ZUGFeRD-Embedding-Fehler wird
  // die Rechnung NICHT als nicht-konformes PDF verschickt; stattdessen
  // Audit-Eintrag + HTTP 500 mit deutscher Fehlermeldung.
  const { ZugferdEmbedError } = await import("../lib/zugferd");
  let zugferdBuffer: Buffer;
  let lnPdf: Buffer;
  try {
    const rendered = await loadOrRenderSendablePdfs(
      invoice,
      pdfData,
      { isCustomerInvoice: sendToCustomer, strictZugferd: true, testFaults: readTestFaults(req) },
    );
    zugferdBuffer = rendered.invoicePdf;
    lnPdf = rendered.lnPdf;
  } catch (zugErr) {
    if (zugErr instanceof ZugferdEmbedError) {
      await auditService.log(
        req.user!.id,
        "invoice_zugferd_embed_failed",
        "invoice",
        id,
        {
          invoiceNumber: invoice.invoiceNumber,
          customerId: invoice.customerId,
          reason: zugErr.reason.slice(0, 500),
          batchSend: false,
        },
        req.ip,
      );
      throw new AppError(
        500,
        "SERVER_ERROR",
        `Rechnung konnte nicht versendet werden: ZUGFeRD-Einbettung fehlgeschlagen (${zugErr.reason}). Aus GoBD-Gründen wird keine nicht-konforme E-Rechnung verschickt — bitte den Support kontaktieren.`,
        "ZUGFeRD-Einbettung fehlgeschlagen",
      );
    }
    throw zugErr;
  }

  let finalInvoicePdf: Buffer = zugferdBuffer;
  let finalLnPdf: Buffer = lnPdf;

  if (isBeihilfe) {
    const doubled = await doubleBeihilfePdfs(zugferdBuffer, lnPdf);
    finalInvoicePdf = doubled.invoicePdf;
    finalLnPdf = doubled.lnPdf;
  }

  const { sendEmail, buildEmailLayout } = await import("../services/email-service");
  const { resolveLogoToDataUrl } = await import("../services/logo-resolver");
  const companyName = companySettings.companyName || "SeniorenEngel";
  const resolvedLogo = await resolveLogoToDataUrl(companySettings.logoUrl);

  const monthName = MONTH_NAMES_DE[(invoice.billingMonth - 1)] || String(invoice.billingMonth);
  const customerFullName = [cust.vorname, cust.nachname].filter(Boolean).join(" ") || cust.name;
  const versNr = insHistory[0].versichertennummer || invoice.versichertennummer || "";

  const subject = `Rechnung ${invoice.invoiceNumber} — ${customerFullName}${versNr ? ` (${versNr})` : ""} — ${monthName} ${invoice.billingYear} — ${companyName}`;
  let bodyContent = "";
  if (sendToCustomer) {
    bodyContent = `
      <p>Sehr geehrte/r ${cust.vorname || ""} ${cust.nachname || ""},</p>
      <p>anbei erhalten Sie die Rechnung <strong>${invoice.invoiceNumber}</strong> sowie den zugehörigen Leistungsnachweis
      für den Leistungszeitraum <strong>${monthName} ${invoice.billingYear}</strong>.</p>
      ${isBeihilfe ? `<p><strong>Hinweis:</strong> Anbei erhalten Sie Ihre Rechnung und den Leistungsnachweis in doppelter Ausfertigung — bitte reichen Sie je ein Exemplar bei Ihrer privaten Pflegekasse und Ihrer Beihilfestelle ein.</p>` : ""}
      ${isKostenerstattung ? `<p><strong>Hinweis:</strong> Bitte begleichen Sie die Rechnung und reichen Sie diese zusammen mit dem Leistungsnachweis im Rahmen des Kostenerstattungsverfahrens bei Ihrer Pflegekasse zur Erstattung des Entlastungsbetrags nach § 45b SGB XI ein.</p>` : ""}
      <p>Bei Rückfragen stehen wir Ihnen gerne zur Verfügung.</p>
      <p>Mit freundlichen Grüßen<br/>${companyName}</p>
    `;
  } else {
    bodyContent = `
      <p>Sehr geehrte Damen und Herren,</p>
      <p>anbei erhalten Sie die Rechnung <strong>${invoice.invoiceNumber}</strong> sowie den zugehörigen Leistungsnachweis
      für <strong>${customerFullName}</strong>${versNr ? ` (Versichertennr. ${versNr})` : ""} 
      für den Leistungszeitraum <strong>${monthName} ${invoice.billingYear}</strong>.</p>
      <p>Bei Rückfragen stehen wir Ihnen gerne zur Verfügung.</p>
      <p>Mit freundlichen Grüßen<br/>${companyName}</p>
    `;
  }

  const html = buildEmailLayout(companyName, resolvedLogo, bodyContent);

  const fileNames = `[${invoice.invoiceNumber}] ${invoice.invoiceNumber}.pdf, LN-${invoice.invoiceNumber}.pdf`;

  try {
    await sendEmail(companySettings, {
      to: recipientEmail,
      subject,
      html,
      attachments: [
        { filename: `${invoice.invoiceNumber}.pdf`, content: finalInvoicePdf, contentType: "application/pdf" },
        { filename: `LN-${invoice.invoiceNumber}.pdf`, content: finalLnPdf, contentType: "application/pdf" },
      ],
    });
  } catch (sendErr: unknown) {
    const errMsg = sendErr instanceof Error ? sendErr.message : "Unbekannter Fehler";
    await deliveryStorage.createDelivery({
      customerId: invoice.customerId,
      deliveryMethod: "email",
      status: "error",
      recipientEmail,
      recipientName: recipientDisplayName,
      documentFileNames: fileNames,
      errorMessage: errMsg,
      createdByUserId: req.user!.id,
    });
    throw sendErr;
  }

  const updated = await withAudit(async (tx, audit) => {
    const u = await updateInvoiceStatusTx(tx, id, "versendet", req.user!.id);
    audit.record({
      userId: req.user!.id,
      action: "invoice_sent",
      entityType: "invoice",
      entityId: id,
      metadata: {
        invoiceNumber: invoice.invoiceNumber,
        recipientEmail,
        customerId: invoice.customerId,
        insuranceProviderId: provider.length ? provider[0].id : null,
        insuranceProviderName: recipientDisplayName,
        hasParagraph39, isPrivatBilling, isBeihilfe, isKostenerstattung,
      },
      ipAddress: req.ip,
    });
    return u;
  }, { faults: readTestFaults(req) });

  await deliveryStorage.createDelivery({
    customerId: invoice.customerId,
    deliveryMethod: "email",
    status: "sent",
    recipientEmail,
    recipientName: recipientDisplayName,
    documentFileNames: fileNames,
    sentAt: new Date(),
    createdByUserId: req.user!.id,
  });

  const results: { invoiceId: number; status: string; recipientEmail: string; customerCopy?: boolean; letterxpressLetterId?: string }[] = [
    { invoiceId: id, status: "sent", recipientEmail },
  ];

  if (cust.receivesMonthlyInvoice) {
    const custDeliveryMethod = cust.documentDeliveryMethod || "email";
    const copyFileNames = `[${invoice.invoiceNumber}] Kopie: ${invoice.invoiceNumber}.pdf, LN-${invoice.invoiceNumber}.pdf`;
    try {
      if (custDeliveryMethod === "email" && !cust.email) {
        await deliveryStorage.createDelivery({
          customerId: invoice.customerId,
          deliveryMethod: "email",
          status: "error",
          recipientName: customerFullName,
          documentFileNames: copyFileNames,
          errorMessage: "Keine E-Mail-Adresse beim Kunden hinterlegt",
          createdByUserId: req.user!.id,
        });
        results.push({ invoiceId: id, status: "error", recipientEmail: "", customerCopy: true });
      } else if (custDeliveryMethod === "email" && cust.email) {
        const customerSubject = `Rechnungskopie ${invoice.invoiceNumber} — ${monthName} ${invoice.billingYear}`;
        const customerBody = `
          <p>Sehr geehrte/r ${cust.vorname || ""} ${cust.nachname || ""},</p>
          <p>anbei erhalten Sie eine Kopie der Rechnung <strong>${invoice.invoiceNumber}</strong> 
          für den Leistungszeitraum <strong>${monthName} ${invoice.billingYear}</strong>, 
          die an Ihre Pflegekasse gesendet wurde.</p>
          <p>Mit freundlichen Grüßen<br/>${companyName}</p>
        `;
        const customerHtml = buildEmailLayout(companyName, resolvedLogo, customerBody);

        await sendEmail(companySettings, {
          to: cust.email,
          subject: customerSubject,
          html: customerHtml,
          attachments: [
            { filename: `${invoice.invoiceNumber}.pdf`, content: zugferdBuffer, contentType: "application/pdf" },
            { filename: `LN-${invoice.invoiceNumber}.pdf`, content: lnPdf, contentType: "application/pdf" },
          ],
        });

        results.push({ invoiceId: id, status: "sent", recipientEmail: cust.email, customerCopy: true });

        await deliveryStorage.createDelivery({
          customerId: invoice.customerId,
          deliveryMethod: "email",
          status: "sent",
          recipientEmail: cust.email,
          recipientName: customerFullName,
          documentFileNames: copyFileNames,
          sentAt: new Date(),
          createdByUserId: req.user!.id,
        });
      } else if (custDeliveryMethod === "post") {
        const customerAddress = buildCustomerPostAddress(cust);
        const { letterId } = await sendInvoiceCopyByPost(companySettings, {
          customer: cust,
          invoicePdf: zugferdBuffer,
          leistungsnachweisPdf: lnPdf,
          invoiceNumber: invoice.invoiceNumber,
          monthName,
          year: invoice.billingYear,
        });
        await deliveryStorage.createDelivery({
          customerId: invoice.customerId,
          deliveryMethod: "post",
          status: "sent",
          recipientName: customerFullName,
          recipientAddress: customerAddress,
          documentFileNames: copyFileNames,
          sentAt: new Date(),
          letterxpressLetterId: letterId,
          createdByUserId: req.user!.id,
        });
        results.push({ invoiceId: id, status: "post_sent", recipientEmail: "", customerCopy: true, letterxpressLetterId: letterId });
      }
    } catch (copyError: unknown) {
      const copyErrMsg = copyError instanceof Error ? copyError.message : "Unbekannter Fehler";
      console.error("Kundenkopie konnte nicht gesendet werden:", copyErrMsg);
      await deliveryStorage.createDelivery({
        customerId: invoice.customerId,
        deliveryMethod: custDeliveryMethod,
        status: "error",
        recipientEmail: cust.email || null,
        recipientName: customerFullName,
        documentFileNames: copyFileNames,
        errorMessage: copyErrMsg,
        createdByUserId: req.user!.id,
      }).catch((deliveryLogErr: unknown) => {
        console.error(
          `[billing/send] Delivery-Log für Kundenkopie konnte nicht geschrieben werden (invoice ${id}):`,
          deliveryLogErr instanceof Error ? deliveryLogErr.message : deliveryLogErr,
        );
      });
      results.push({ invoiceId: id, status: "error", recipientEmail: cust.email || "", customerCopy: true });
    }
  }

  res.json({
    message: "Rechnung erfolgreich versendet",
    invoice: updated,
    results,
  });
}));

// Task #533: Gebündeltes PDF (Rechnung + Leistungsnachweis) für den Druck.
// Liefert beide Dokumente in einer PDF-Datei aus, ohne den GoBD-Cache der
// einzelnen PDFs zu verändern. Falls die PDFs noch nicht persistiert sind,
// werden sie über den bestehenden Backfill-Pfad erzeugt.
router.get("/:id/bundle", asyncHandler("Druck-Bündel konnte nicht erzeugt werden — bitte erneut versuchen.", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  const invoice = await storage.getInvoice(id);
  if (!invoice) throw notFound("Rechnung nicht gefunden");

  let invoicePdf = await loadInvoicePdfFromStorage(invoice);
  let lnPdf = await loadLeistungsnachweisPdfFromStorage(invoice);
  const isPflegekasse = invoice.billingType === "pflegekasse_gesetzlich" || invoice.billingType === "pflegekasse_privat";

  let persistError: unknown = null;
  if (!invoicePdf || (!lnPdf && isPflegekasse)) {
    try {
      await persistInvoicePdf(id);
    } catch (err) {
      persistError = err;
      console.error(`[billing/bundle] PDF-Persistierung für Rechnung ${id} fehlgeschlagen:`, err);
    }
    const refreshed = await storage.getInvoice(id);
    if (refreshed) {
      invoicePdf = await loadInvoicePdfFromStorage(refreshed) ?? invoicePdf;
      lnPdf = await loadLeistungsnachweisPdfFromStorage(refreshed) ?? lnPdf;
    }
  }

  if (!invoicePdf) {
    // Task #1066 — konkrete Ursache melden: Chromium fehlt (503), Render-Timeout
    // (504) oder Object endgültig nicht ladbar (404).
    throw classifyPdfRenderError(persistError, `Rechnungs-PDF ${invoice.invoiceNumber}`);
  }

  // Task #1039 — Für kundenadressierte Rechnungen (pflegekasse_privat sowie
  // gesetzlich mit rechnungAnKunde/Beihilfe) ist der Leistungsnachweis bereits
  // fest in das gespeicherte Rechnungs-PDF einmontiert. In diesem Fall darf der
  // separat gecachte Standalone-LN NICHT ein zweites Mal angehängt werden
  // (sonst doppelter LN, RE-2026-0034). Nur gesetzliche Kassen (ohne
  // Kostenerstattung) und Selbstzahler bekommen den LN hier separat angehängt.
  const appendStandaloneLn = await shouldAppendStandaloneLeistungsnachweis(invoice);

  // Selbstzahler/gesetzlich ohne LN-Cache: on-the-fly rendern, damit das Bündel
  // immer Rechnung + Leistungsnachweis enthält (kein Cache-Schreibe-Pfad).
  // Schlägt das fehl, brechen wir hart ab statt still nur die Rechnung
  // auszuliefern — sonst druckt der Admin unbemerkt ohne LN. Bei kunden-
  // adressierten Rechnungen ist der LN bereits im Rechnungs-PDF, daher kein
  // On-the-fly-Render nötig.
  if (!lnPdf && appendStandaloneLn) {
    try {
      lnPdf = await renderLeistungsnachweisOnTheFly(invoice);
    } catch (err) {
      console.error(`[billing/bundle] LN-On-the-fly-Render für Rechnung ${id} fehlgeschlagen:`, err);
      // Task #1066 — konkrete Ursache (Chromium/Timeout) statt generisch melden.
      throw classifyPdfRenderError(err, `Leistungsnachweis ${invoice.invoiceNumber}`);
    }
  }

  const { PDFDocument } = await import("pdf-lib");
  const merged = await PDFDocument.create();
  const invoiceDoc = await PDFDocument.load(invoicePdf);
  const ip = await merged.copyPages(invoiceDoc, invoiceDoc.getPageIndices());
  ip.forEach((p) => merged.addPage(p));
  if (lnPdf && appendStandaloneLn) {
    const lnDoc = await PDFDocument.load(lnPdf);
    const lp = await merged.copyPages(lnDoc, lnDoc.getPageIndices());
    lp.forEach((p) => merged.addPage(p));
  }
  const bytes = Buffer.from(await merged.save());
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="Bundle-${invoice.invoiceNumber}.pdf"`);
  res.send(bytes);
}));

// Krankenkassen-Bündel-Download — liefert für einen Monat + eine Pflegekasse
// alle Rechnungs- und Leistungsnachweis-PDFs gebündelt aus, entweder als
// ZIP-Archiv (pro Rechnung zwei Dateien) oder als ein zusammengeführtes
// PDF. Wie /:id/bundle berührt das den GoBD-Cache nicht zusätzlich:
// fehlende PDFs werden über `persistInvoicePdf` einmalig nachgezogen, der
// Leistungsnachweis wird sonst on-the-fly gerendert (kein Schreibe-Pfad).
// Task #533: Manuelles Markieren als „versendet" für Pflegekassen-Rechnungen,
// solange der TI-Versand fehlt. Audit-Log mit Hinweis auf den manuellen Pfad.
router.post("/:id/mark-sent", asyncHandler("Status konnte nicht aktualisiert werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  const invoice = await storage.getInvoice(id);
  if (!invoice) throw notFound("Rechnung nicht gefunden");

  if (invoice.status !== "entwurf") {
    throw badRequest(`Rechnung hat Status "${invoice.status}" — nur Entwürfe können manuell als versendet markiert werden.`);
  }

  // Task #533: Manuelles Markieren ist explizit ein Workaround, solange der
  // TI-Anschluss fehlt. Selbstzahler- und Privat-Rechnungen werden bereits
  // über `/:id/status` (Versand-Buttons) auf „versendet" gesetzt; das hier
  // ist ausdrücklich Pflegekassen-Versand. Server-seitige Einschränkung,
  // damit das Endpoint nicht als Generalumgehung benutzt werden kann.
  if (invoice.billingType !== "pflegekasse_gesetzlich" && invoice.billingType !== "pflegekasse_privat") {
    throw badRequest("Manuelles Markieren ist nur für Pflegekassen-Rechnungen vorgesehen. Selbstzahler-Rechnungen werden über den regulären Versand-Status verwaltet.");
  }

  // Task #552: PDF-Cache nach dem Status-Übergang im Hintergrund versiegeln.
  // `persistInvoicePdf` ist mutex-serialisiert + idempotent — bei vorhandenem
  // Cache no-op, sonst läuft der Render asynchron via setImmediate, ohne den
  // Mark-Sent-Request zu blockieren (mark-sent flippt nur den Status, der
  // Background-Backfill zieht den GoBD-Snapshot nach).
  schedulePdfPersistInBackground(id);

  const updated = await withAudit(async (tx, audit) => {
    const u = await updateInvoiceStatusTx(tx, id, "versendet", req.user!.id);
    await tx.update(invoicesTable)
      .set({ sentAt: new Date() })
      .where(eq(invoicesTable.id, id));
    audit.record({
      userId: req.user!.id,
      action: "invoice_marked_sent_manually",
      entityType: "invoice",
      entityId: id,
      metadata: {
        invoiceNumber: invoice.invoiceNumber,
        customerId: invoice.customerId,
        billingType: invoice.billingType,
        oldStatus: invoice.status,
        newStatus: "versendet",
        reason: "manual_mark_sent_no_ti",
      },
      ipAddress: req.ip,
    });
    return { ...u, sentAt: new Date() };
  }, { faults: readTestFaults(req) });

  res.json(updated);
}));

// Task #534: Typenübergreifender Bulk-Versand. Schließt die Lücke zwischen
// „Alle an Pflegekassen senden" (Email-Batch, nur gesetzlich) und den
// einzelnen Per-Row-Aktionen: setzt sequentiell für alle übergebenen
// Entwurfs-Rechnungen den Status auf „versendet" — Pflegekassen-Entwürfe
// via Mark-Sent (kein TI-Anschluss → manueller Pfad), Selbstzahler via
// regulärem Status-Update. Idempotent: bereits versendete/stornierte
// Rechnungen werden übersprungen, kein neuer Versandweg wird eingeführt.
router.post("/send-bulk", asyncHandler("Bulk-Versand fehlgeschlagen", async (req, res) => {
  const parsed = z.object({
    invoiceIds: z.array(z.number().int().positive()).min(1).max(200),
  }).safeParse(req.body);
  if (!parsed.success) throw badRequest(fromError(parsed.error).toString());
  const { invoiceIds } = parsed.data;

  type ResultStatus = "sent" | "marked_sent" | "skipped" | "error";
  const results: Array<{
    invoiceId: number;
    invoiceNumber: string;
    customerId: number;
    billingType: string;
    status: ResultStatus;
    message?: string;
  }> = [];

  for (const invoiceId of invoiceIds) {
    try {
      const invoice = await storage.getInvoice(invoiceId);
      if (!invoice) {
        results.push({
          invoiceId,
          invoiceNumber: "",
          customerId: 0,
          billingType: "",
          status: "skipped",
          message: "Rechnung nicht gefunden",
        });
        continue;
      }

      if (invoice.status !== "entwurf") {
        results.push({
          invoiceId,
          invoiceNumber: invoice.invoiceNumber,
          customerId: invoice.customerId,
          billingType: invoice.billingType,
          status: "skipped",
          message: `Status: ${invoice.status}`,
        });
        continue;
      }

      const isPflegekasse = invoice.billingType === "pflegekasse_gesetzlich"
        || invoice.billingType === "pflegekasse_privat";
      const isSelbstzahler = invoice.billingType === "selbstzahler";

      if (!isPflegekasse && !isSelbstzahler) {
        results.push({
          invoiceId,
          invoiceNumber: invoice.invoiceNumber,
          customerId: invoice.customerId,
          billingType: invoice.billingType,
          status: "skipped",
          message: "Unbekannter Rechnungstyp",
        });
        continue;
      }

      // Task #552: PDF-Cache nach dem Bulk-Status-Übergang im Hintergrund
      // versiegeln — mutex-serialisiert + idempotent. Kein synchrones
      // Blockieren auf Puppeteer; der Backfill zieht den GoBD-Snapshot nach.
      schedulePdfPersistInBackground(invoiceId);

      await withAudit(async (tx, audit) => {
        await updateInvoiceStatusTx(tx, invoiceId, "versendet", req.user!.id);
        await tx.update(invoicesTable)
          .set({ sentAt: new Date() })
          .where(eq(invoicesTable.id, invoiceId));
        audit.record({
          userId: req.user!.id,
          action: isPflegekasse ? "invoice_marked_sent_manually" : "invoice_status_changed",
          entityType: "invoice",
          entityId: invoiceId,
          metadata: {
            invoiceNumber: invoice.invoiceNumber,
            customerId: invoice.customerId,
            billingType: invoice.billingType,
            oldStatus: invoice.status,
            newStatus: "versendet",
            source: "bulk_send",
            ...(isPflegekasse ? { reason: "manual_mark_sent_no_ti" } : {}),
          },
          ipAddress: req.ip,
        });
      }, { faults: readTestFaults(req) });

      results.push({
        invoiceId,
        invoiceNumber: invoice.invoiceNumber,
        customerId: invoice.customerId,
        billingType: invoice.billingType,
        status: isPflegekasse ? "marked_sent" : "sent",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unbekannter Fehler";
      results.push({
        invoiceId,
        invoiceNumber: "",
        customerId: 0,
        billingType: "",
        status: "error",
        message: msg,
      });
    }
  }

  const sent = results.filter(r => r.status === "sent").length;
  const markedSent = results.filter(r => r.status === "marked_sent").length;
  const skipped = results.filter(r => r.status === "skipped").length;
  const errors = results.filter(r => r.status === "error").length;

  res.json({
    summary: { total: results.length, sent, markedSent, skipped, errors },
    results,
  });
}));

// Task #996: Sammeldruck — bündelt alle Entwurfs-Rechnungen eines Monats
// (Rechnung + Leistungsnachweis je Rechnung) in ein druckfertiges PDF und
// markiert die enthaltenen Rechnungen anschließend als „versendet".
//   - groupByPayer=false → ein zusammengeführtes Gesamt-PDF (application/pdf)
//   - groupByPayer=true  → ZIP mit einem PDF je Krankenkasse (Selbstzahler in
//     einem eigenen Bündel)
// Die PDF-Beschaffung nutzt exakt dieselben Helper wie /bundle-by-payer
// (Cache-Hit → on-demand-Render → Hintergrund-Persist), es wird KEIN neuer
// Render-Pfad eingeführt. Per-Rechnung-Fehler werden gesammelt und im
// `x-bulk-print-summary`-Header zurückgemeldet, sodass ein einzelner Fehler
// den Lauf nicht still verschluckt. Das Mark-Sent läuft über denselben Pfad
// wie /send-bulk (updateInvoiceStatusTx + Audit-Log).
router.post("/bulk-print", asyncHandler("Sammeldruck konnte nicht erstellt werden", async (req, res) => {
  const parsed = z.object({
    billingMonth: z.number().int().min(1).max(12),
    billingYear: z.number().int().min(2000).max(2100),
    insuranceProviderId: z.number().int().positive().optional(),
    groupByPayer: z.boolean().optional().default(false),
  }).safeParse(req.body);
  if (!parsed.success) throw badRequest(fromError(parsed.error).toString());
  const { billingMonth, billingYear, insuranceProviderId, groupByPayer } = parsed.data;

  // Entwurfs-Rechnungen des Monats laden (optional auf eine Kasse gefiltert).
  // Reine Stornorechnungen werden — wie im Druck-Bündel /bundle-by-payer —
  // ausgeschlossen; der Sammeldruck ist der monatliche Rechnungsstapel.
  const allDrafts = await storage.getInvoices({
    year: billingYear,
    month: billingMonth,
    status: "entwurf",
    insuranceProviderId,
  });
  const drafts = allDrafts
    .filter(inv => inv.invoiceType !== "stornorechnung")
    .sort((a, b) => a.invoiceNumber.localeCompare(b.invoiceNumber));

  if (drafts.length === 0) {
    throw notFound(
      `Keine Entwurfs-Rechnungen für ${String(billingMonth).padStart(2, "0")}/${billingYear} gefunden.`,
    );
  }

  // Krankenkassen-Zuordnung je Kunde (für groupByPayer + Dateinamen).
  const customerIds = Array.from(new Set(drafts.map(d => d.customerId)));
  const payerRows = await db.select({
    customerId: customerInsuranceHistory.customerId,
    providerId: insuranceProviders.id,
    providerName: insuranceProviders.name,
  })
    .from(customerInsuranceHistory)
    .innerJoin(insuranceProviders, eq(insuranceProviders.id, customerInsuranceHistory.insuranceProviderId))
    .where(and(
      inArray(customerInsuranceHistory.customerId, customerIds),
      isNull(customerInsuranceHistory.validTo),
    ));
  const payerByCustomer = new Map(payerRows.map(r => [r.customerId, { id: r.providerId, name: r.providerName }]));

  type ResultEntry = {
    invoiceId: number;
    invoiceNumber: string;
    customerId: number;
    status: "printed" | "error";
    message?: string;
  };
  const results: ResultEntry[] = [];

  // Phase 1 — PDFs beschaffen (kein State-Change). Fehler je Rechnung sammeln.
  type DraftInvoice = Awaited<ReturnType<typeof storage.getInvoices>>[number];
  type Rendered = {
    invoice: DraftInvoice;
    invoicePdf: Buffer;
    lnPdf: Buffer | null;
    // Task #1039 — bei kundenadressierten Rechnungen steckt der LN bereits im
    // Rechnungs-PDF; dann nicht doppelt anhängen.
    appendLn: boolean;
    payerKey: string;
    payerLabel: string;
  };
  const rendered: Rendered[] = [];
  for (const inv of drafts) {
    try {
      let invoicePdf = await loadInvoicePdfFromStorage(inv);
      let lnPdf = await loadLeistungsnachweisPdfFromStorage(inv);
      const isPflegekasse = inv.billingType === "pflegekasse_gesetzlich" || inv.billingType === "pflegekasse_privat";
      let persistError: unknown = null;
      if (!invoicePdf || (!lnPdf && isPflegekasse)) {
        try {
          await persistInvoicePdf(inv.id);
        } catch (err) {
          persistError = err;
          console.error(`[billing/bulk-print] PDF-Persistierung für Rechnung ${inv.id} fehlgeschlagen:`, err);
        }
        const refreshed = await storage.getInvoice(inv.id);
        if (refreshed) {
          invoicePdf = await loadInvoicePdfFromStorage(refreshed) ?? invoicePdf;
          lnPdf = await loadLeistungsnachweisPdfFromStorage(refreshed) ?? lnPdf;
        }
      }
      if (!invoicePdf) {
        // Task #1068 — konkrete Ursache (Chromium/Timeout/Object fehlt) statt
        // generisch melden, damit der gesammelte Fehler im
        // x-bulk-print-summary-Header verwertbar ist.
        throw classifyPdfRenderError(persistError, `Rechnungs-PDF ${inv.invoiceNumber}`);
      }
      const appendLn = await shouldAppendStandaloneLeistungsnachweis(inv);
      if (!lnPdf && appendLn) {
        try {
          lnPdf = await renderLeistungsnachweisOnTheFly(inv);
        } catch (err) {
          // Task #1068 — konkrete Ursache statt generisch melden.
          throw classifyPdfRenderError(err, `Leistungsnachweis ${inv.invoiceNumber}`);
        }
      }
      const payer = payerByCustomer.get(inv.customerId);
      rendered.push({
        invoice: inv,
        invoicePdf,
        lnPdf,
        appendLn,
        payerKey: payer ? `kasse-${payer.id}` : "selbstzahler",
        payerLabel: payer ? payer.name : "Selbstzahler",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unbekannter Fehler";
      console.error(`[billing/bulk-print] Render für Rechnung ${inv.id} fehlgeschlagen:`, err);
      results.push({
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        customerId: inv.customerId,
        status: "error",
        message: msg,
      });
    }
  }

  if (rendered.length === 0) {
    throw new AppError(
      500,
      "Keine der Entwurfs-Rechnungen konnte für den Sammeldruck gerendert werden.",
      "BULK_PRINT_RENDER_FAILED",
    );
  }

  // Output-Buffer ZUERST bauen (vor dem State-Change). Schlägt das Mergen
  // fehl, ist noch keine Rechnung als versendet markiert.
  const monthSlug = `${String(billingMonth).padStart(2, "0")}-${billingYear}`;
  let outputBuffer: Buffer;
  let contentType: string;
  let fileName: string;

  if (groupByPayer) {
    const groups = new Map<string, { label: string; pairs: Rendered[] }>();
    for (const r of rendered) {
      const g = groups.get(r.payerKey) ?? { label: r.payerLabel, pairs: [] };
      g.pairs.push(r);
      groups.set(r.payerKey, g);
    }
    const archiver = (await import("archiver")).default;
    const archive = archiver("zip", { zlib: { level: 6 } });
    const chunks: Buffer[] = [];
    archive.on("data", (c: Buffer) => chunks.push(c));
    const done = new Promise<void>((resolve, reject) => {
      archive.on("end", () => resolve());
      archive.on("error", (err: Error) => reject(err));
    });
    for (const [, g] of groups) {
      const flat: Buffer[] = [];
      for (const p of g.pairs) {
        flat.push(p.invoicePdf);
        if (p.lnPdf && p.appendLn) flat.push(p.lnPdf);
      }
      const mergedGroup = await combinePdfBuffers(flat);
      const slug = g.label.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "Kasse";
      archive.append(mergedGroup, { name: `Sammeldruck-${slug}-${monthSlug}.pdf` });
    }
    await archive.finalize();
    await done;
    outputBuffer = Buffer.concat(chunks);
    contentType = "application/zip";
    fileName = `Sammeldruck-${monthSlug}.zip`;
  } else {
    const flat: Buffer[] = [];
    for (const r of rendered) {
      flat.push(r.invoicePdf);
      if (r.lnPdf && r.appendLn) flat.push(r.lnPdf);
    }
    outputBuffer = await combinePdfBuffers(flat);
    contentType = "application/pdf";
    fileName = `Sammeldruck-${monthSlug}.pdf`;
  }

  // Phase 2 — enthaltene Rechnungen als „versendet" markieren (gleicher Pfad
  // wie /send-bulk: updateInvoiceStatusTx + sentAt + Audit-Log). Fehler je
  // Rechnung isolieren, damit ein einzelner Mark-Fehler den Lauf nicht kippt.
  let marked = 0;
  for (const r of rendered) {
    const inv = r.invoice;
    const isPflegekasse = inv.billingType === "pflegekasse_gesetzlich" || inv.billingType === "pflegekasse_privat";
    try {
      schedulePdfPersistInBackground(inv.id);
      await withAudit(async (tx, audit) => {
        await updateInvoiceStatusTx(tx, inv.id, "versendet", req.user!.id);
        await tx.update(invoicesTable)
          .set({ sentAt: new Date() })
          .where(eq(invoicesTable.id, inv.id));
        audit.record({
          userId: req.user!.id,
          action: isPflegekasse ? "invoice_marked_sent_manually" : "invoice_status_changed",
          entityType: "invoice",
          entityId: inv.id,
          metadata: {
            invoiceNumber: inv.invoiceNumber,
            customerId: inv.customerId,
            billingType: inv.billingType,
            oldStatus: inv.status,
            newStatus: "versendet",
            source: "bulk_print",
            ...(isPflegekasse ? { reason: "manual_mark_sent_no_ti" } : {}),
          },
          ipAddress: req.ip,
        });
      }, { faults: readTestFaults(req) });
      marked++;
      results.push({
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        customerId: inv.customerId,
        status: "printed",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unbekannter Fehler";
      console.error(`[billing/bulk-print] Mark-Sent für Rechnung ${inv.id} fehlgeschlagen:`, err);
      results.push({
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        customerId: inv.customerId,
        status: "error",
        message: `Im Druck enthalten, aber Markieren als versendet fehlgeschlagen: ${msg}`,
      });
    }
  }

  const errors = results.filter(r => r.status === "error").length;
  const summary = {
    total: drafts.length,
    printed: rendered.length,
    marked,
    errors,
    groupedByPayer: groupByPayer,
    results,
  };
  log(
    `bulk-print done month=${billingMonth}/${billingYear} total=${drafts.length} printed=${rendered.length} marked=${marked} errors=${errors} groupByPayer=${groupByPayer} userId=${req.user?.id ?? "?"}`,
    "billing",
  );

  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.setHeader("X-Bulk-Print-Summary", encodeURIComponent(JSON.stringify(summary)));
  res.send(outputBuffer);
}));

// Task #533: Massenerstellung — erzeugt für alle berechtigten Kunden des
// gewählten Monats sequenziell eine Rechnung. Idempotent: Kunden mit
// existierender Nicht-Storno-Rechnung im Monat werden übersprungen.
router.post("/generate-all", asyncHandler("Massenerstellung fehlgeschlagen", async (req, res) => {
  const parsed = z.object({
    billingMonth: z.number().int().min(1).max(12),
    billingYear: z.number().int().min(2000).max(2100),
    // Krankenkassen-Filter: scope-t die Massenerstellung auf Kunden mit
    // dieser aktiven Pflegekasse. Frontend übergibt das nur, wenn der
    // Kassen-Filter auf der Abrechnungsseite gesetzt ist.
    insuranceProviderId: z.number().int().positive().optional(),
  }).safeParse(req.body);
  if (!parsed.success) throw badRequest(fromError(parsed.error).toString());
  const { billingMonth, billingYear, insuranceProviderId } = parsed.data;
  // Task #586 — Strukturiertes Start-/Ende-Log + Voll-Stack im inneren
  // Catch, damit der nächste 500-Vorfall in Prod im Server-Log sofort
  // nachvollziehbar ist (Monat/Jahr, Customer-Count, created/skipped/errors,
  // Dauer). Vor #586 hatten wir bei einem leeren "HTTP 500:" im Toast nur
  // den blanken Express-Request-Log und keinen Kontext.
  const startedAt = Date.now();
  const userId = req.user?.id;

  // Berechtigte Kunden = Kunden mit signiertem Leistungsnachweis für den Monat.
  const signedRecords = await monthlyServiceRecordsRepo.selectColumnsFrom({
    customerId: monthlyServiceRecords.customerId,
  })
    .where(and(
      eq(monthlyServiceRecords.year, billingYear),
      eq(monthlyServiceRecords.month, billingMonth),
      or(
        eq(monthlyServiceRecords.status, "completed"),
        eq(monthlyServiceRecords.status, "employee_signed"),
      ),
      monthlyServiceRecordsRepo.activeOnly(),
    ));
  let customerIds = Array.from(new Set(signedRecords.map(r => r.customerId)));

  // Krankenkassen-Filter: schränkt die Massenerstellung auf Kunden mit der
  // gewählten aktiven Pflegekasse ein. Selbstzahler-Kunden haben keinen
  // History-Eintrag und werden dadurch automatisch ausgeschlossen.
  if (insuranceProviderId && customerIds.length > 0) {
    const matching = await db.select({ customerId: customerInsuranceHistory.customerId })
      .from(customerInsuranceHistory)
      .where(and(
        inArray(customerInsuranceHistory.customerId, customerIds),
        isNull(customerInsuranceHistory.validTo),
        eq(customerInsuranceHistory.insuranceProviderId, insuranceProviderId),
      ));
    const allowed = new Set(matching.map(r => r.customerId));
    customerIds = customerIds.filter(id => allowed.has(id));
  }

  log(
    `generate-all start month=${billingMonth}/${billingYear} eligibleCustomers=${customerIds.length}${insuranceProviderId ? ` insuranceProviderId=${insuranceProviderId}` : ""} userId=${userId ?? "?"}`,
    "billing",
  );

  const results: Array<{
    customerId: number;
    status: "created" | "skipped" | "error";
    invoiceCount?: number;
    message?: string;
  }> = [];

  for (const customerId of customerIds) {
    try {
      // Idempotenz: existiert bereits eine aktive (nicht stornierte)
      // Rechnung dieses Monats, überspringen.
      const existing = await storage.getInvoicesForCustomerMonth(customerId, billingYear, billingMonth);
      const hasActive = existing.some(inv => inv.status !== "storniert" && inv.invoiceType !== "stornorechnung");
      if (hasActive) {
        results.push({ customerId, status: "skipped", message: "Bereits abgerechnet" });
        continue;
      }

      // Direkter In-Process-Aufruf der Kern-Logik — kein HTTP-Self-Call,
      // kein Cookie-Forwarding, kein Host-Header-SSRF-Risiko.
      try {
        const result = await generateInvoiceCore(
          { customerId, billingMonth, billingYear },
          {
            userId: req.user!.id,
            ipAddress: req.ip,
            testFaults: readTestFaults(req),
          },
        );
        const count = "splitInvoices" in result && result.splitInvoices
          ? result.invoices.length
          : 1;
        results.push({ customerId, status: "created", invoiceCount: count });
      } catch (innerErr) {
        const msg = innerErr instanceof Error ? innerErr.message : "Unbekannter Fehler";
        // „Alle Termine ... bereits abgerechnet" / „Kein Leistungsnachweis"
        // / „nicht unterschrieben" werden als Skip gewertet, damit die
        // Massenerstellung idempotent bleibt und nicht jeder Kunde ohne
        // signierten LN als Fehler zählt.
        const isSkip = msg.includes("bereits abgerechnet")
            || msg.includes("noch nicht unterschrieben")
            || msg.includes("Kein Leistungsnachweis");
        if (isSkip) {
          results.push({ customerId, status: "skipped", message: msg });
        } else {
          // Task #586 — vollen Stack inkl. Kontext loggen, damit ein
          // unerwarteter Fehler in `generateInvoiceCore` im nächsten
          // Vorfall im Server-Log direkt rekonstruierbar ist.
          const stack = innerErr instanceof Error && innerErr.stack ? innerErr.stack : msg;
          log(
            `generate-all inner error customer=${customerId} month=${billingMonth}/${billingYear} userId=${userId ?? "?"}: ${msg}\n${stack}`,
            "billing",
          );
          results.push({ customerId, status: "error", message: msg });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unbekannter Fehler";
      results.push({ customerId, status: "error", message: msg });
    }
  }

  const created = results.filter(r => r.status === "created").length;
  const skipped = results.filter(r => r.status === "skipped").length;
  const errors = results.filter(r => r.status === "error").length;
  const durationMs = Date.now() - startedAt;
  const firstErrorMsg = results.find(r => r.status === "error")?.message;
  log(
    `generate-all done month=${billingMonth}/${billingYear} total=${results.length} created=${created} skipped=${skipped} errors=${errors} durationMs=${durationMs}${firstErrorMsg ? ` firstError=${JSON.stringify(firstErrorMsg)}` : ""}`,
    "billing",
  );

  res.json({
    summary: { total: results.length, created, skipped, errors },
    results,
  });
}));

export default router;
