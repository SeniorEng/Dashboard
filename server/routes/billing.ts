import { Router, type Response } from "express";
import { requireAuth, requireAdmin, requireWageDataAccess, requireSuperAdmin } from "../middleware/auth";
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
import { classifyBillingEligibility } from "@shared/domain/billing-eligibility";
import { INVOICE_STATUS_TRANSITIONS, isAllowedInvoiceStatusTransition } from "@shared/domain/invoice-status";
import { buildInvoiceExportFilename, dedupeExportFilenames, buildSpeakingInvoiceFilename, buildSpeakingKassenBundleFilename, buildContentDisposition, type SpeakingInvoiceDocumentKind } from "@shared/domain/invoice-export-filename";
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
} from "@shared/schema";
import type { Invoice, CompanySettings, InsertDocumentDelivery, InvoiceRenderSnapshot, InvoiceRenderCompanySnapshot } from "@shared/schema";
import { INVOICE_RENDER_COMPANY_SNAPSHOT_KEYS } from "@shared/schema";
import type { BillingCustomerItem, BillingInvoicePreview, BlockingDraftInvoice, DiscardDraftsResponse, BulkDeleteResultItem, BulkDeleteResponse, BulkStatusResultItem, BulkStatusResponse, RepairPdfsResultItem, RepairPdfsResponse } from "@shared/api";
import { documentDeliveries } from "@shared/schema";
import { computeDataHash } from "../services/signature-integrity";
import { parseObjectPath, getPrivateDir } from "../lib/object-storage-helpers";
import { eq, and, gte, lte, lt, isNull, inArray, ne, notInArray, or, desc, sql } from "drizzle-orm";
import { z } from "zod";
import { fromError } from "zod-validation-error";
import { formatDateForDisplay, formatDateISO, todayISO, parseTimestamp } from "@shared/utils/datetime";
import { storage } from "../storage";
import { qontoStorage } from "../storage/qonto";
import { classifyPaymentDifference } from "@shared/domain/qonto/payment-difference";
import { db } from "../lib/db";
import { monthlyServiceRecordsRepo, appointmentsRepo } from "../repos";
import {
  updateInvoiceStatusTx,
  getInvoiceForUpdateTx,
} from "../storage/billing-storage";
import { stornoInvoiceCascade } from "../services/invoice-storno";
import { readBillingPipeline } from "../storage/billing/pipeline-reader";
import { isStorniertInvoice } from "@shared/domain/billing-pipeline";
import { readBillingEconomics } from "../storage/billing/economics-reader";
import { readBillingTermine } from "../storage/billing/termine-reader";
import { auditService } from "../services/audit";
import { withAudit } from "../lib/with-audit";
import { readTestFaults, readTestFailInvoicePdfIds } from "../lib/test-fault-injector";
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
    storedInvoicePdfContainsLeistungsnachweis,
  } from "../services/invoice-pdf-orchestrator";
import { ChromiumUnavailableError } from "../services/pdf-generator";
import { getBlockingDraftInvoices, getDocumentationCoverageByCustomer, getOpenAppointmentCountByCustomer, getUnbilledSignedAppointmentFactsByCustomer, type UnbilledSignedFacts } from "../services/invoice-data";
import { buildInvoiceDraft, generateInvoiceCore } from "../services/invoice-calc";
import { reduceInvoice45bToPaidAmount } from "../services/invoice-45b-reduction";
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

// Task #1349 — Erkennt einen *vorübergehenden* Object-Storage-Zugriffsfehler
// (Speicher-Identität/Auth gerade nicht verfügbar, z.B. "could not read token
// from /tmp/replidentity" / "failed to get signing authority" oder der
// Storage-Sidecar 127.0.0.1:1106 ist nicht erreichbar). Das ist KEIN fehlendes
// Objekt — ein fehlendes Objekt liefert `null` (file.exists() → false) — sondern
// ein transienter Infrastruktur-Fehler, der sich nach einem Republish / in
// wenigen Minuten von selbst behebt. Das bereits gespeicherte PDF ist sicher,
// nur der Lesezugriff scheitert gerade. Rückgabe: ein retryable 503er mit
// klarer deutscher Meldung, oder `null`, wenn der Fehler nicht in diese Klasse
// fällt (dann greift die bestehende Render-/Not-Found-Klassifikation).
const STORAGE_ACCESS_ERROR_PATTERNS: RegExp[] = [
  /replidentity/i,
  /signing authority/i,
  /could not read token/i,
  /failed to get signing/i,
  /127\.0\.0\.1:1106/i,
  /sidecar/i,
  /external_account/i,
  /token_url/i,
  /could not (refresh|load) .*token/i,
  /getUniverseDomain/i,
];

function collectErrorText(err: unknown, depth = 0): string {
  if (err === null || err === undefined || depth > 5) return "";
  if (typeof err === "string") return err;
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    return `${err.message} ${collectErrorText(cause, depth + 1)}`;
  }
  if (typeof err === "object") {
    const obj = err as Record<string, unknown>;
    const parts = [obj.message, obj.error, obj.cause]
      .map((part) => collectErrorText(part, depth + 1))
      .filter(Boolean);
    return parts.join(" ");
  }
  return String(err);
}

function classifyStorageAccessError(err: unknown, subject: string): AppError | null {
  const haystack = collectErrorText(err);
  if (STORAGE_ACCESS_ERROR_PATTERNS.some((re) => re.test(haystack))) {
    return new AppError(
      503,
      "STORAGE_UNAVAILABLE",
      `${subject}: Der Dokumentenspeicher ist vorübergehend nicht erreichbar — bitte in wenigen Minuten erneut versuchen. Das PDF ist sicher gespeichert.`,
    );
  }
  return null;
}

// Task #1349 — Reiner Cache-Lesepfad (Objekt liegt bereits in Object Storage):
// Hier wird NICHT gerendert. Ein fehlendes Objekt liefert `null`, daher ist
// JEDER geworfene Fehler ein Speicher-Zugriffs-/Identitätsproblem → 503
// retryable. `subject` benennt das Artefakt für die Meldung.
function storageReadUnavailable(subject: string): AppError {
  return new AppError(
    503,
    "STORAGE_UNAVAILABLE",
    `${subject}: Der Dokumentenspeicher ist vorübergehend nicht erreichbar — bitte in wenigen Minuten erneut versuchen. Das PDF ist sicher gespeichert.`,
  );
}

router.get("/", asyncHandler("Rechnungen konnten nicht geladen werden", async (req, res) => {
  const filters: { year?: number; month?: number; customerId?: number; status?: string; insuranceProviderId?: number; dateFrom?: string; dateTo?: string } = {};
  if (req.query.year) filters.year = Number(req.query.year);
  if (req.query.month) filters.month = Number(req.query.month);
  if (req.query.customerId) filters.customerId = Number(req.query.customerId);
  if (req.query.status) filters.status = String(req.query.status);
  if (req.query.insuranceProviderId) {
    const ipid = Number(req.query.insuranceProviderId);
    if (Number.isFinite(ipid) && ipid > 0) filters.insuranceProviderId = ipid;
  }
  // Task #1317: Optionaler von–bis-Datumsbereich (ISO yyyy-mm-dd). Nur
  // wohlgeformte Werte werden durchgereicht — ungültige Eingaben werden
  // still ignoriert (Filter wirkt dann nicht), nie als 400.
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  if (typeof req.query.dateFrom === "string" && isoDate.test(req.query.dateFrom)) {
    filters.dateFrom = req.query.dateFrom;
  }
  if (typeof req.query.dateTo === "string" && isoDate.test(req.query.dateTo)) {
    filters.dateTo = req.query.dateTo;
  }
  const invoices = await storage.getInvoices(filters);

  // Task #1822: Teilzahlungs-Rechnungen mit dem bereits eingegangenen Betrag und
  // dem offenen Rest anreichern — aus DERSELBEN SSoT wie der Status-Schreibpfad
  // (`getInvoicePaymentTotals` summiert alle gebundenen Zahlungen,
  // `classifyPaymentDifference` rechnet Brutto − Skonto − gezahlt). Mehrere
  // Teilüberweisungen ergeben so denselben Restbetrag wie beim Statuswechsel.
  const partialIds = invoices.filter(inv => inv.status === "teilweise_bezahlt").map(inv => inv.id);
  if (partialIds.length > 0) {
    const totals = await qontoStorage.getInvoicePaymentTotals(partialIds);
    const enriched = invoices.map(inv => {
      if (inv.status !== "teilweise_bezahlt") return inv;
      const t = totals.get(inv.id) ?? { paidCents: 0, skontoCents: 0 };
      const cls = classifyPaymentDifference({
        invoiceGrossCents: inv.grossAmountCents,
        paidCents: t.paidCents,
        skontoCents: t.skontoCents,
      });
      return { ...inv, paidCents: t.paidCents, openAmountCents: cls.differenceCents };
    });
    res.json(enriched);
    return;
  }

  res.json(invoices);
}));

// Task #1710/#1859 — Rechnungen, die für die manuelle (Mehrfach-)Zuordnung zu
// einer Qonto-Zahlung offen sind: JEDE Rechnung, die noch nicht mit einer echten
// Bank-Zahlung abgeglichen ist. Das umfasst `versendet` UND `avis_erhalten`
// (importiertes, aber noch nicht mit einer Zahlung abgeglichenes Avis). Entwurf,
// bezahlt und storniert fallen raus; Gutschriften (`stornorechnung`) ebenso über
// das geteilte Storno-Prädikat. „Beansprucht" = 1:1-Match ODER Mitglied eines an
// eine Transaktion gebundenen Avis (getClaimedInvoiceIds, SSoT). Verhindert, dass
// dieselbe Rechnung zwei Zahlungen zufällt.
router.get("/open-for-match", asyncHandler("Offene Rechnungen konnten nicht geladen werden", async (_req, res) => {
  const candidates = (await storage.getInvoices({ statuses: ["versendet", "avis_erhalten"] }))
    .filter(inv => !isStorniertInvoice({ status: inv.status, invoiceType: inv.invoiceType }));
  const claimed = await qontoStorage.getClaimedInvoiceIds(db, candidates.map(inv => inv.id));
  res.json(candidates.filter(inv => !claimed.has(inv.id)));
}));

// Task #1405 — Abrechnungs-Pipeline-Board (SSoT-Reader). Liefert den
// vollständigen Monats-Lebenszyklus (Offen → … → Bezahlt) als Stufen-Aggregat
// inkl. Side-Badges und €-Konservierung. `date` (ISO yyyy-mm-dd) ist optional
// und steuert nur den Aging-Stichtag (Default: heute).
router.get("/pipeline", asyncHandler("Abrechnungs-Pipeline konnte nicht geladen werden", async (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    throw badRequest("Jahr ist erforderlich (2020–2100).");
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw badRequest("Monat ist erforderlich (1–12).");
  }
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  const asOfDate = typeof req.query.date === "string" && isoDate.test(req.query.date)
    ? req.query.date
    : todayISO();
  const result = await readBillingPipeline(year, month, asOfDate);
  res.json(result);
}));

// Task #1473 — Wirtschaftlicher Überblick (READ-ONLY): billing-scoped
// Aggregation der Economics-SSoT (Monat/Jahr + optional Mitarbeiter:in + Kasse).
// Headline-KPIs und Zeilen stammen aus DEMSELBEN buildEconomics-Aufruf, sodass
// Σ(Zeilen) === Headline gilt. Reine Sicht — keine Mutation.
router.get("/economics", requireWageDataAccess, asyncHandler("Wirtschaftlicher Überblick konnte nicht geladen werden", async (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    throw badRequest("Jahr ist erforderlich (2020–2100).");
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw badRequest("Monat ist erforderlich (1–12).");
  }
  const employeeId = req.query.employeeId !== undefined ? Number(req.query.employeeId) : undefined;
  if (employeeId !== undefined && (!Number.isInteger(employeeId) || employeeId <= 0)) {
    throw badRequest("Ungültige Mitarbeiter-ID.");
  }
  const insuranceProviderId = req.query.insuranceProviderId !== undefined ? Number(req.query.insuranceProviderId) : undefined;
  if (insuranceProviderId !== undefined && (!Number.isInteger(insuranceProviderId) || insuranceProviderId <= 0)) {
    throw badRequest("Ungültige Kassen-ID.");
  }
  const result = await readBillingEconomics(year, month, { employeeId, insuranceProviderId });
  res.json(result);
}));

// Task #1473 — „Termine End-to-End"-Liste (READ-ONLY): Termine des Monats pro
// Mitarbeiter:in gruppiert, Stufe über die Pipeline-SSoT (vor Rechnung) bzw. den
// Rechnungsstatus (nach Rechnung). Side-States gehören nicht in die Liste.
router.get("/termine", asyncHandler("Termine konnten nicht geladen werden", async (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    throw badRequest("Jahr ist erforderlich (2020–2100).");
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw badRequest("Monat ist erforderlich (1–12).");
  }
  const employeeId = req.query.employeeId !== undefined ? Number(req.query.employeeId) : undefined;
  if (employeeId !== undefined && (!Number.isInteger(employeeId) || employeeId <= 0)) {
    throw badRequest("Ungültige Mitarbeiter-ID.");
  }
  const insuranceProviderId = req.query.insuranceProviderId !== undefined ? Number(req.query.insuranceProviderId) : undefined;
  if (insuranceProviderId !== undefined && (!Number.isInteger(insuranceProviderId) || insuranceProviderId <= 0)) {
    throw badRequest("Ungültige Kassen-ID.");
  }
  const result = await readBillingTermine(year, month, { employeeId, insuranceProviderId });
  res.json(result);
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
    status: monthlyServiceRecords.status,
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
  // Task #1625 — dokumentierte-vs-abgedeckte Termine pro Kunde aus der EINEN
  // gemeinsamen Berechnung (`getDocumentationCoverageByCustomer`). Dieselbe
  // Quelle nutzt der optionale Skip in `POST /generate-all`, damit Anzeige
  // (Hinweis + „überspringen"-Zähler) und Server-Skip nie auseinanderdriften.
  // Task #1743 — zusätzlich pro Kunde die Anzahl der im Monat noch OFFENEN
  // (geplanten) Termine. Nutzt DIESELBE „offener Termin"-SSoT
  // (`FINAL_APPOINTMENT_STATUSES`) wie die Monatsabschluss-Readiness, damit
  // „bereit zum Abrechnen" (keine offenen Termine) und Monatsabschluss nicht
  // auseinanderdriften. Das Frontend gruppiert die Karte „Noch zu erstellen"
  // danach in „Bereit zum Abrechnen" (0 offen) und „Noch offene Termine" (>0).
  // Task #1317: Optionaler von–bis-Datumsbereich (ISO yyyy-mm-dd) — nur
  // wohlgeformte Werte zählen. Ist er gesetzt, verengen sowohl der
  // Eligibility-Filter (unten) ALS AUCH die „noch offene Termine"-Zählung den
  // Scope auf dieses Fenster, damit die Gruppierung „bereit vs. offen" exakt
  // zum gefilterten Bereich passt.
  const isoDateRe = /^\d{4}-\d{2}-\d{2}$/;
  const dateFromQ = typeof req.query.dateFrom === "string" && isoDateRe.test(req.query.dateFrom) ? req.query.dateFrom : undefined;
  const dateToQ = typeof req.query.dateTo === "string" && isoDateRe.test(req.query.dateTo) ? req.query.dateTo : undefined;

  const [coverageByCustomer, openByCustomer] = await Promise.all([
    getDocumentationCoverageByCustomer(uniqueCustomerIds, year, month),
    getOpenAppointmentCountByCustomer(uniqueCustomerIds, year, month, { dateFrom: dateFromQ, dateTo: dateToQ }),
  ]);

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

  // dateFromQ/dateToQ oben geparst (Scope für Counter + Eligibility identisch).
  const candidateIds = filteredCustomerRows.map(c => c.id);

  // Task #1790 — Termin-genaue „noch offene, signierte Termine?"-Fakten je Kunde
  // aus DER EINEN SSoT (`getUnbilledSignedAppointmentFactsByCustomer`). Geteilt
  // mit dem no-date-range-Filter unten UND dem Skip in `POST /generate-all`, und
  // dient zugleich als Faktenquelle für `classifyBillingEligibility` (Step 2),
  // sodass es keine zweite Kopie der „signiert & noch nicht abgerechnet"-Regel
  // mehr gibt.
  const unbilledFacts = await getUnbilledSignedAppointmentFactsByCustomer(candidateIds, year, month);

  if (candidateIds.length > 0 && (dateFromQ || dateToQ)) {
    // Task #1317: Mit Datumsbereich erlaubt die Massenerstellung Teil-
    // Abrechnung innerhalb des Monats. Der grobe „hat irgendeine Rechnung im
    // Monat"-Ausschluss würde einen Kunden mit Teil-Rechnung fälschlich aus
    // dem Counter werfen. Stattdessen: berechtigt ist, wer im gewählten
    // Bereich mindestens einen dokumentierten Termin hat, der noch nicht
    // abgerechnet ist (Termin-Ebene = dieselbe Idempotenz wie generate-all).
    const rangeConds = [
      inArray(appointments.customerId, candidateIds),
      eq(appointments.status, "completed"),
      appointmentsRepo.activeOnly(),
    ];
    if (dateFromQ) rangeConds.push(gte(appointments.date, dateFromQ));
    if (dateToQ) rangeConds.push(lte(appointments.date, dateToQ));
    const rangeAppts = await appointmentsRepo.selectColumnsFrom({
      id: appointments.id,
      customerId: appointments.customerId,
    }).where(and(...rangeConds));

    const invoicedRows = await db.select({ appointmentId: invoiceLineItems.appointmentId })
      .from(invoiceLineItems)
      .innerJoin(invoicesTable, eq(invoiceLineItems.invoiceId, invoicesTable.id))
      .where(and(
        inArray(invoicesTable.customerId, candidateIds),
        eq(invoicesTable.billingYear, year),
        eq(invoicesTable.billingMonth, month),
        ne(invoicesTable.status, "storniert"),
        ne(invoicesTable.invoiceType, "stornorechnung"),
      ));
    const invoicedApptIds = new Set(invoicedRows.map(r => r.appointmentId));

    const eligibleByRange = new Set<number>();
    for (const a of rangeAppts) {
      if (a.customerId != null && !invoicedApptIds.has(a.id)) eligibleByRange.add(a.customerId);
    }
    filteredCustomerRows = filteredCustomerRows.filter(c => eligibleByRange.has(c.id));
  } else if (candidateIds.length > 0) {
    // Task #1790: Ohne Datumsbereich Termin-genau statt kunde-grob. Der frühere
    // grobe „hat irgendeine aktive Rechnung im Monat → ausschließen"-Filter
    // (Task #996) machte spät signierte Nachzügler-Termine unsichtbar: Sobald
    // eine erste Rechnung existierte, verschwand der Kunde komplett aus der
    // Liste, auch wenn danach weitere Termine unterschrieben wurden.
    //
    // Ausgeschlossen wird jetzt NUR der vollständig abgerechnete Kunde: es gab
    // (strikt) signierte Termine, aber keiner ist mehr offen
    // (`signedAppointmentCount > 0 && unbilledAppointmentCount === 0`). Weil
    // `unbilled = signiert − abgerechnet`, tritt „signiert>0 & unbilled=0" genau
    // dann ein, wenn ALLE signierten Termine bereits abgerechnet sind (es also
    // eine Rechnung gibt) — kein separater „hat Rechnung?"-Query nötig.
    // Signatur-blockierte Kunden (kein strikt signierter Termin ⇒ signiert=0)
    // bleiben in der Liste, damit sie weiterhin als „blocked" sichtbar sind
    // (Bestandsverhalten, Task #1776).
    filteredCustomerRows = filteredCustomerRows.filter(c => {
      const facts = unbilledFacts.get(c.id);
      const signed = facts?.signedAppointmentCount ?? 0;
      const unbilled = facts?.unbilledAppointmentCount ?? 0;
      return !(signed > 0 && unbilled === 0);
    });
  }

  // Task #1774 — Abrechnungs-Berechtigung pro Kunde aus DERSELBEN SSoT, die auch
  // `buildInvoiceDraft` nutzt (`classifyBillingEligibility`). Die Anzeige darf
  // NICHT allein anhand „keine offenen Termine" gruppieren — das kassen-/zahler-
  // abhängige Unterschrifts-Gate (Pflegekasse verlangt Kundenunterschrift =
  // `completed`, reine `employee_signed`-LNs genügen NICHT) muss mitentscheiden.
  // Wir spiegeln die Fakten des Generate-Pfads: LN-Status je Kunde, Termine unter
  // strikt-signierten LNs und davon die noch nicht abgerechneten. Keine zweite
  // Kopie der Regel — nur Faktenbeschaffung + `classifyBillingEligibility`.
  const finalIds = filteredCustomerRows.map(c => c.id);
  const billingTypeById = new Map(customerRows.map(c => [c.id, c.billingType]));

  // LN-Status je Kunde (loser Filter completed/employee_signed reicht: der
  // strikte Signatur-Filter in der SSoT ist eine Teilmenge davon).
  const statusesByCustomer = new Map<number, string[]>();
  for (const r of signedRecords) {
    if (!finalIds.includes(r.customerId)) continue;
    const arr = statusesByCustomer.get(r.customerId) ?? [];
    arr.push(r.status);
    statusesByCustomer.set(r.customerId, arr);
  }

  // Termin-Fakten (signiert / noch nicht abgerechnet) je Kunde aus DER EINEN
  // SSoT `unbilledFacts` (oben berechnet) — keine zweite Kopie der Regel mehr.
  const eligibleCustomers: BillingCustomerItem[] = filteredCustomerRows.map(c => {
    const facts = unbilledFacts.get(c.id);
    const { status, reason } = classifyBillingEligibility({
      billingType: c.billingType,
      serviceRecordStatuses: statusesByCustomer.get(c.id) ?? [],
      signedAppointmentCount: facts?.signedAppointmentCount ?? 0,
      unbilledAppointmentCount: facts?.unbilledAppointmentCount ?? 0,
    });
    return {
      ...c,
      completedAppointments: coverageByCustomer.get(c.id)?.completedAppointments ?? 0,
      coveredAppointments: coverageByCustomer.get(c.id)?.coveredAppointments ?? 0,
      openAppointments: openByCustomer.get(c.id) ?? 0,
      eligibility: { status, reason },
      // Task #1813 — Termin-Fakten für die „Nachberechnung"-Kennzeichnung aus
      // DERSELBEN SSoT (`unbilledFacts`), die auch die Eligibilität speist.
      signedAppointmentCount: facts?.signedAppointmentCount ?? 0,
      unbilledAppointmentCount: facts?.unbilledAppointmentCount ?? 0,
    };
  });

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
  // Task #1320: optionaler von–bis-Datumsfilter (analog `POST /generate`),
  // damit die Einzel-Vorschau dasselbe Fenster zeigt, das der nachfolgende
  // Generierungslauf abrechnet.
  const previewIsoDateRe = /^\d{4}-\d{2}-\d{2}$/;
  const previewDateFrom = typeof req.query.dateFrom === "string" && previewIsoDateRe.test(req.query.dateFrom) ? req.query.dateFrom : undefined;
  const previewDateTo = typeof req.query.dateTo === "string" && previewIsoDateRe.test(req.query.dateTo) ? req.query.dateTo : undefined;
  const draft = await buildInvoiceDraft({ customerId, billingMonth: month, billingYear: year, dateFrom: previewDateFrom, dateTo: previewDateTo });
  const response: BillingInvoicePreview = {
    serviceRecordCount: draft.signedRecordCount,
    coveredAppointments: draft.apptIds.length,
    completedAppointments: draft.completedAppointmentsInPeriod,
    // Task #1813 — Termine, die bereits in einer früheren Rechnung des Zeitraums
    // abgerechnet wurden (neutraler „N bereits abgerechnet"-Wert; ersetzt die
    // mehrdeutige Doku-Lücken-Ableitung, die Nachberechnungen als Warnung zeigte).
    alreadyBilledAppointments: draft.alreadyBilledAppointmentCount,
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

// Task #1376 — Sammel-Löschen: löscht ausschließlich Entwürfe (GoBD).
// Finalisierte Rechnungen (versendet/avis_erhalten/bezahlt/storniert) und
// Storno-Belege werden defensiv per WHERE-Guard übersprungen und im Ergebnis
// als "skipped" gemeldet — niemals hart gelöscht (die werden storniert).
router.post("/bulk-delete", asyncHandler("Rechnungen konnten nicht gelöscht werden", async (req, res) => {
  const parsed = z.object({
    invoiceIds: z.array(z.number().int().positive()).min(1).max(200),
  }).safeParse(req.body);
  if (!parsed.success) {
    throw badRequest(fromError(parsed.error).toString());
  }
  const { invoiceIds } = parsed.data;
  const uniqueIds = Array.from(new Set(invoiceIds));

  const { results, deletedNumbers } = await withAudit(async (tx, audit) => {
    const items: BulkDeleteResultItem[] = [];
    const numbers: string[] = [];
    for (const id of uniqueIds) {
      // Guard: nur Entwurf + kein Storno-Beleg. Trifft der Guard nicht zu
      // (finalisiert/storniert/bereits weg), löscht das DELETE nichts → skip.
      const deleted = await tx.delete(invoicesTable)
        .where(and(
          eq(invoicesTable.id, id),
          eq(invoicesTable.status, "entwurf"),
          ne(invoicesTable.invoiceType, "stornorechnung"),
        ))
        .returning({ id: invoicesTable.id, invoiceNumber: invoicesTable.invoiceNumber, grossAmountCents: invoicesTable.grossAmountCents, billingRunId: invoicesTable.billingRunId });
      if (deleted.length === 0) {
        items.push({ invoiceId: id, invoiceNumber: null, status: "skipped", reason: "Nur Entwürfe können gelöscht werden." });
        continue;
      }
      numbers.push(deleted[0].invoiceNumber);
      items.push({ invoiceId: id, invoiceNumber: deleted[0].invoiceNumber, status: "deleted" });
      audit.record({
        userId: req.user!.id,
        action: "invoice_draft_discarded",
        entityType: "invoice",
        entityId: id,
        metadata: {
          invoiceNumber: deleted[0].invoiceNumber,
          grossAmountCents: deleted[0].grossAmountCents,
          billingRunId: deleted[0].billingRunId,
          reason: "bulk_delete",
        },
        ipAddress: req.ip,
      });
    }
    return { results: items, deletedNumbers: numbers };
  }, { faults: readTestFaults(req) });

  const deleted = results.filter((r) => r.status === "deleted").length;
  const response: BulkDeleteResponse = {
    summary: { deleted, skipped: results.length - deleted, total: results.length },
    invoiceNumbers: deletedNumbers,
    results,
  };
  res.json(response);
}));

// Task #1376 — Sammel-Statuswechsel auf "entwurf"/"versendet"/"avis_erhalten"/
// "bezahlt". "storniert" ist NICHT erlaubt (Sammel-Storno ist eine separate
// Aufgabe und erfordert die Cascade-Logik aus `PATCH /:id/status`). Pro Rechnung
// gilt dieselbe Übergangs-SSoT wie der Einzel-Statuswechsel; ungültige Übergänge
// werden übersprungen und gemeldet. Audit analog zum Einzelpfad.
// Task #1434: "entwurf" ist als Sammel-Ziel erlaubt — setzt versehentlich als
// versendet markierte Rechnungen zurück (nur "versendet" → "entwurf" laut SSoT;
// alle anderen Quellstatus werden als ungültiger Übergang übersprungen).
router.post("/bulk-status", asyncHandler("Status konnte nicht aktualisiert werden", async (req, res) => {
  const parsed = z.object({
    invoiceIds: z.array(z.number().int().positive()).min(1).max(200),
    status: z.enum(["entwurf", "versendet", "avis_erhalten", "bezahlt"]),
  }).safeParse(req.body);
  if (!parsed.success) {
    throw badRequest(fromError(parsed.error).toString());
  }
  const { invoiceIds, status } = parsed.data;
  const uniqueIds = Array.from(new Set(invoiceIds));

  const results = await withAudit(async (tx, audit) => {
    const items: BulkStatusResultItem[] = [];
    for (const id of uniqueIds) {
      // Re-Read mit FOR UPDATE: serialisiert parallele Statuswechsel und liest
      // den tatsächlichen Ist-Status (Race-Schutz, wie der Einzelpfad).
      const locked = await getInvoiceForUpdateTx(tx, id);
      if (!locked) {
        items.push({ invoiceId: id, invoiceNumber: "", status: "skipped", reason: "Rechnung nicht gefunden." });
        continue;
      }
      if (!isAllowedInvoiceStatusTransition(locked.status, status)) {
        items.push({ invoiceId: id, invoiceNumber: locked.invoiceNumber, status: "skipped", reason: `Übergang von "${locked.status}" nicht erlaubt.` });
        continue;
      }
      await updateInvoiceStatusTx(tx, id, status, req.user!.id);
      audit.record({
        userId: req.user!.id,
        action: "invoice_status_changed",
        entityType: "invoice",
        entityId: id,
        metadata: {
          invoiceNumber: locked.invoiceNumber,
          previousStatus: locked.status,
          newStatus: status,
          reason: "bulk_status",
        },
        ipAddress: req.ip,
      });
      items.push({ invoiceId: id, invoiceNumber: locked.invoiceNumber, status: "updated" });
    }
    return items;
  }, { faults: readTestFaults(req) });

  const updated = results.filter((r) => r.status === "updated").length;
  const response: BulkStatusResponse = {
    summary: { updated, skipped: results.length - updated, total: results.length },
    results,
  };
  res.json(response);
}));

// Task #1834 — Sammel-Reparatur der als „PDF-Fehler"/„PDF…" markierten
// Rechnungen. Ersetzt das manuelle Einzel-Anklicken jeder betroffenen Rechnung.
// Nutzt exakt dieselbe „braucht PDF?"-Auswahl wie der Boot-Backfill
// (`pdfPath IS NULL`, bei Pflegekassen zusätzlich `leistungsnachweisPath IS NULL`,
// Stornorechnungen ausgenommen) und denselben Self-Heal-Pfad `persistInvoicePdf`
// — KEINE zweite Render-/Persist-Logik. Verarbeitung in einem beschränkten Block
// pro Request (kein Timeout bei großem Rückstand); der Client ruft wiederholt
// auf, solange `remaining > 0`. Optional auf eine ID-Liste (aktuelle Auswahl)
// einschränkbar. Rendering läuft (wie in `persistInvoicePdf`) außerhalb der
// DB-Transaktion.
const REPAIR_PDFS_MAX_PER_REQUEST = 25;
router.post("/repair-pdfs", asyncHandler("PDFs konnten nicht repariert werden", async (req, res) => {
  const parsed = z.object({
    invoiceIds: z.array(z.number().int().positive()).max(1000).optional(),
  }).safeParse(req.body);
  if (!parsed.success) {
    throw badRequest(fromError(parsed.error).toString());
  }
  const restrictIds = parsed.data.invoiceIds
    ? Array.from(new Set(parsed.data.invoiceIds))
    : null;

  // Dieselbe Selektions-Bedingung wie `backfillInvoicePdfs` (Boot-Backfill).
  const needsPdf = and(
    ne(invoicesTable.invoiceType, "stornorechnung"),
    or(
      isNull(invoicesTable.pdfPath),
      and(
        isNull(invoicesTable.leistungsnachweisPath),
        sql`${invoicesTable.billingType} IN ('pflegekasse_privat', 'pflegekasse_gesetzlich')`,
      ),
    ),
  );
  const whereClause = restrictIds && restrictIds.length > 0
    ? and(needsPdf, inArray(invoicesTable.id, restrictIds))
    : needsPdf;

  // Gesamt-Rückstand ermitteln (für den Fortschritts-Nenner) und den nächsten
  // Block abholen.
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(invoicesTable)
    .where(whereClause);

  const rows = await db.select({
    id: invoicesTable.id,
    invoiceNumber: invoicesTable.invoiceNumber,
  })
    .from(invoicesTable)
    .where(whereClause)
    .orderBy(invoicesTable.id)
    .limit(REPAIR_PDFS_MAX_PER_REQUEST);

  const results: RepairPdfsResultItem[] = [];
  for (const row of rows) {
    try {
      await persistInvoicePdf(row.id);
      results.push({ invoiceId: row.id, invoiceNumber: row.invoiceNumber, status: "repaired" });
    } catch (err) {
      const reason = err instanceof ChromiumUnavailableError
        ? "PDF-Engine (Chromium) ist nicht verfügbar."
        : (err instanceof Error ? err.message : String(err));
      log(`repair-pdfs: Rechnung #${row.id} (${row.invoiceNumber}) fehlgeschlagen: ${err}`, "billing");
      results.push({ invoiceId: row.id, invoiceNumber: row.invoiceNumber, status: "failed", reason });
      // Bei fehlendem Chromium hat jeder weitere Versuch in diesem Block keinen
      // Sinn — Rest abbrechen, der Client meldet den Fehler.
      if (err instanceof ChromiumUnavailableError) break;
    }
  }

  const repaired = results.filter((r) => r.status === "repaired").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const remaining = Math.max(0, total - repaired);
  const response: RepairPdfsResponse = {
    summary: { repaired, failed, remaining, total },
    results,
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
  const { sendEmail, buildEmailLayout, buildLogoInlineAttachment, EMAIL_LOGO_SRC } = await import("../services/email-service");
  const companyName = companySettings.companyName || "SeniorenEngel";
  // Task #1102: Logo wird einmal vor der Schleife als Inline-Anhang (cid:)
  // geladen, statt als data:-URI ins HTML eingebettet — Gmail/Outlook
  // entfernen data:-Bilder, cid:-Inline-Anhänge werden zuverlässig angezeigt.
  const logoAttachment = await buildLogoInlineAttachment(companySettings.logoUrl);
  const resolvedLogo = logoAttachment ? EMAIL_LOGO_SRC : null;
  const logoAttachments = logoAttachment ? [logoAttachment] : [];

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
            ...logoAttachments,
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
                ...logoAttachments,
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
  type Pair = {
    invoiceNumber: string;
    customerVorname?: string | null;
    customerNachname?: string | null;
    customerName?: string | null;
    invoicePdf: Buffer;
    lnPdf: Buffer | null;
    appendLn: boolean;
  };
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
    pairs.push({
      invoiceNumber: inv.invoiceNumber,
      customerVorname: inv.customerVorname,
      customerNachname: inv.customerNachname,
      customerName: inv.customerName,
      invoicePdf,
      lnPdf,
      appendLn,
    });
  }

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
    res.setHeader("Content-Disposition", buildContentDisposition(
      buildSpeakingKassenBundleFilename({ providerName, year, month, extension: "pdf" }),
      "inline",
    ));
    return res.send(bytes);
  }

  // format === "zip"
  const archiver = (await import("archiver")).default;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", buildContentDisposition(
    buildSpeakingKassenBundleFilename({ providerName, year, month, extension: "zip" }),
    "attachment",
  ));
  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.on("error", (err: Error) => {
    console.error("[billing/bundle-by-payer] archive error:", err);
    if (!res.headersSent) res.status(500);
    res.end();
  });
  archive.pipe(res);
  // Task #1700 — Sprechende, filesystem-sichere und innerhalb des Archivs
  // kollisionsfreie Eintrags-Namen (analog zu den drei Einzel-Downloads):
  // `Rechnungsnummer - Nachname, Vorname - Dokumentart.pdf`. Erst alle Namen
  // in Reihenfolge (Rechnung, optional LN je Paar) bauen, dann gemeinsam
  // de-duplizieren, damit ein `-2`-Suffix Rechnung UND LN korrekt trennt.
  const entries: Array<{ pdf: Buffer; name: string }> = [];
  for (const p of pairs) {
    entries.push({
      pdf: p.invoicePdf,
      name: buildSpeakingInvoiceFilename({
        invoiceNumber: p.invoiceNumber,
        vorname: p.customerVorname,
        nachname: p.customerNachname,
        customerName: p.customerName,
        kind: "invoice",
      }),
    });
    if (p.lnPdf && p.appendLn) {
      entries.push({
        pdf: p.lnPdf,
        name: buildSpeakingInvoiceFilename({
          invoiceNumber: p.invoiceNumber,
          vorname: p.customerVorname,
          nachname: p.customerNachname,
          customerName: p.customerName,
          kind: "leistungsnachweis",
        }),
      });
    }
  }
  const dedupedEntryNames = dedupeExportFilenames(entries.map((e) => e.name));
  entries.forEach((e, i) => {
    archive.append(e.pdf, { name: dedupedEntryNames[i] });
  });
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

// Task #1785 P4 — §45b-Kürzung: Superadmin reduziert EINE ausgestellte
// §45b-Rechnung auf den tatsächlich von der Kasse gezahlten Betrag (Y). Der
// Überhang (X−Y) wird in EINEN Ziel-Topf umgebucht. GoBD-konform als Storno +
// §45b-Reset + Neu-Buchung + Re-Rechnung (SSoT `reduceInvoice45bToPaidAmount`).
const reduce45bSchema = z.object({
  paidCents: z.number().int("Der gezahlte Betrag muss in ganzen Cent angegeben werden.").positive("Der gezahlte Betrag muss größer als 0 sein."),
  targetPot: z.enum(["umwandlung_45a", "ersatzpflege_39_42a", "private"]),
});
router.post("/:id/reduce-45b", requireSuperAdmin, asyncHandler("§45b-Kürzung fehlgeschlagen", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  const parsed = reduce45bSchema.safeParse(req.body);
  if (!parsed.success) {
    throw badRequest(fromError(parsed.error).toString());
  }
  const result = await reduceInvoice45bToPaidAmount({
    rootInvoiceId: id,
    paidCents: parsed.data.paidCents,
    targetPot: parsed.data.targetPot,
    actor: { userId: req.user!.id, isSuperAdmin: req.user!.isSuperAdmin, ipAddress: req.ip },
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

  // Task #1284/#1376 — Lebenszyklus Entwurf → Versendet → Avis erhalten →
  // Bezahlt (+Storniert). Erlaubte Übergänge liegen zentral in
  // @shared/domain/invoice-status (SSoT, geteilt mit dem Sammel-Statuswechsel
  // `POST /billing/bulk-status`).
  if (!isAllowedInvoiceStatusTransition(currentStatus, status)) {
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
    // oder keine). Die Storno-Logik selbst lebt als SSoT in
    // `stornoInvoiceCascade` (server/services/invoice-storno.ts) und wird auch
    // vom GoBD-Reparatur-Skript (Task #1651) genutzt.
    const { mainStornoInvoice, updatedOriginal, cascadeStornoIds } = await withAudit(
      async (tx, audit) =>
        stornoInvoiceCascade(tx, audit, {
          rootInvoiceId: id,
          cascadeRun: !!cascadeRun,
          userId: req.user!.id,
          ipAddress: req.ip,
        }),
      { faults: readTestFaults(req) },
    );

    // Task #577: Storno-PDF im Hintergrund persistieren — analog zum normalen
    // Rechnungs-Erstanlage-Pfad (siehe generateInvoiceCore / Task #544).
    // Ohne diesen Aufruf bleibt `pdf_path` der Stornorechnung NULL, was
    // E-Mail-/E-POST-Versand blockiert. (Prod-IDs 5/6/7/9 sind das Erbe
    // dieses Defekts und werden via Startup-Migration nachgezogen.)
    schedulePdfPersistInBackground(mainStornoInvoice.id);
    // Task #759: Auch die Geschwister-Stornos brauchen ihre PDFs.
    for (const sid of cascadeStornoIds) {
      schedulePdfPersistInBackground(sid);
    }

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

// Task #1696 — Sprechenden Datei-Namen (Rechnungsnummer - Nachname, Vorname -
// Dokumentart) als Content-Disposition setzen. Kundenname aus dem Stammdaten-
// Vor-/Nachnamen (wie „Leistungsempfänger" im LN), NICHT der Kassen-Empfänger.
function setSpeakingPdfDisposition(
  res: Response,
  invoice: { invoiceNumber: string; customerVorname?: string | null; customerNachname?: string | null; customerName?: string | null },
  kind: SpeakingInvoiceDocumentKind,
): void {
  const filename = buildSpeakingInvoiceFilename({
    invoiceNumber: invoice.invoiceNumber,
    vorname: invoice.customerVorname,
    nachname: invoice.customerNachname,
    customerName: invoice.customerName,
    kind,
  });
  res.setHeader("Content-Disposition", buildContentDisposition(filename, "inline"));
}

router.get("/:id/pdf", asyncHandler("PDF konnte nicht erzeugt werden — bitte in wenigen Minuten erneut versuchen oder den Support kontaktieren.", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  const invoice = await storage.getInvoice(id);
  if (!invoice) throw notFound("Rechnung nicht gefunden");

  // T01/PDF-Hash: Wenn die Rechnung bereits einen persistierten PDF-Pfad hat,
  // liefere die hashstabilen Bytes direkt aus Object Storage aus.
  // Task #1349: Ein geworfener Fehler beim reinen Cache-Lesen bedeutet, dass der
  // Speicher gerade nicht erreichbar ist (fehlendes Objekt → null), daher 503.
  let cached: Buffer | null;
  try {
    cached = await loadInvoicePdfFromStorage(invoice);
  } catch (err) {
    console.error(`[billing/pdf] Speicher-Zugriff für Rechnung ${id} fehlgeschlagen:`, err);
    throw storageReadUnavailable(`Rechnungs-PDF ${invoice.invoiceNumber}`);
  }
  if (cached) {
    res.setHeader("Content-Type", "application/pdf");
    setSpeakingPdfDisposition(res, invoice, "invoice");
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
  const subject = `Rechnungs-PDF ${invoice.invoiceNumber}`;
  let fresh: Buffer | null;
  try {
    await persistInvoicePdf(id);
    const refreshed = await storage.getInvoice(id);
    fresh = refreshed ? await loadInvoicePdfFromStorage(refreshed) : null;
  } catch (err) {
    console.error(`[billing/pdf] PDF-Persistierung für Rechnung ${id} fehlgeschlagen:`, err);
    // Task #1349: Transienter Speicher-Zugriffsfehler → 503 retryable; sonst
    // die bestehende Render-Klassifikation (Chromium 503 / Timeout 504 / 404).
    throw classifyStorageAccessError(err, subject) ?? classifyPdfRenderError(err, subject);
  }
  if (!fresh) {
    throw notFound("PDF konnte nicht aus dem Speicher gelesen werden — bitte erneut versuchen.");
  }
  res.setHeader("Content-Type", "application/pdf");
  setSpeakingPdfDisposition(res, invoice, "invoice");
  res.send(fresh);
}));

router.get("/:id/leistungsnachweis", asyncHandler("Leistungsnachweis konnte nicht erzeugt werden — bitte in wenigen Minuten erneut versuchen oder den Support kontaktieren.", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  const invoice = await storage.getInvoice(id);
  if (!invoice) throw notFound("Rechnung nicht gefunden");

  // Task #521: Wenn der LN bereits in Object Storage liegt, direkt
  // ausliefern (kein Puppeteer-Round-Trip).
  // Task #1349: Cache-Lesefehler = Speicher vorübergehend nicht erreichbar → 503.
  let cachedLn: Buffer | null;
  try {
    cachedLn = await loadLeistungsnachweisPdfFromStorage(invoice);
  } catch (err) {
    console.error(`[billing/leistungsnachweis] Speicher-Zugriff für Rechnung ${id} fehlgeschlagen:`, err);
    throw storageReadUnavailable(`Leistungsnachweis ${invoice.invoiceNumber}`);
  }
  if (cachedLn) {
    res.setHeader("Content-Type", "application/pdf");
    setSpeakingPdfDisposition(res, invoice, "leistungsnachweis");
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
    let fresh: Buffer | null;
    try {
      await persistInvoicePdf(id);
      const refreshed = await storage.getInvoice(id);
      fresh = refreshed ? await loadLeistungsnachweisPdfFromStorage(refreshed) : null;
    } catch (err) {
      console.error(`[billing/leistungsnachweis] LN-Persistierung für Rechnung ${id} fehlgeschlagen:`, err);
      // Task #1349: Transienter Speicher-Zugriffsfehler → 503 retryable; sonst
      // die bestehende Render-Klassifikation (Chromium 503 / Timeout 504 / 404).
      const subject = `Leistungsnachweis ${invoice.invoiceNumber}`;
      throw classifyStorageAccessError(err, subject) ?? classifyPdfRenderError(err, subject);
    }
    if (fresh) {
      res.setHeader("Content-Type", "application/pdf");
      setSpeakingPdfDisposition(res, invoice, "leistungsnachweis");
      res.send(fresh);
      return;
    }
  }

  // Selbstzahler-Fallback: on-the-fly rendern ohne Persistenz (kein LN-Cache).
  const buffer = await renderLeistungsnachweisOnTheFly(invoice);

  res.setHeader("Content-Type", "application/pdf");
  setSpeakingPdfDisposition(res, invoice, "leistungsnachweis");
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

  const { sendEmail, buildEmailLayout, buildLogoInlineAttachment, EMAIL_LOGO_SRC } = await import("../services/email-service");
  const companyName = companySettings.companyName || "SeniorenEngel";
  // Task #1102: Logo als Inline-Anhang (cid:) statt data:-URI — wird von
  // Gmail/Outlook zuverlässig angezeigt. Einmal laden, in alle Mails einbetten.
  const logoAttachment = await buildLogoInlineAttachment(companySettings.logoUrl);
  const resolvedLogo = logoAttachment ? EMAIL_LOGO_SRC : null;
  const logoAttachments = logoAttachment ? [logoAttachment] : [];

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
        ...logoAttachments,
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
            ...logoAttachments,
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
  setSpeakingPdfDisposition(res, invoice, "bundle");
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

  // Task #533/#1403: Manuelles Markieren ist explizit ein Workaround, solange
  // der TI-Anschluss fehlt. Es gilt einheitlich für alle Entwurfs-Rechnungen,
  // die NICHT real per E-Mail versendet werden — also Pflegekassen (gesetzlich
  // + privat) UND Selbstzahler. Selbstzahler haben keinen eigenen „Versendet"-
  // Spezial-Pfad mehr, sie laufen genau wie Privat-Kassen über dieses Endpoint.
  // Andere/unbekannte Rechnungstypen bleiben ausgeschlossen, damit das Endpoint
  // nicht als Generalumgehung benutzt werden kann.
  const isManualMarkType = invoice.billingType === "pflegekasse_gesetzlich"
    || invoice.billingType === "pflegekasse_privat"
    || invoice.billingType === "selbstzahler";
  if (!isManualMarkType) {
    throw badRequest("Manuelles Markieren ist nur für Pflegekassen- und Selbstzahler-Rechnungen vorgesehen.");
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

  type ResultStatus = "marked_sent" | "skipped" | "error";
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

      // Task #1403: Alle bulk-verarbeiteten Entwürfe (Pflegekassen gesetzlich +
      // privat UND Selbstzahler) werden einheitlich manuell „als versendet
      // markiert" — kein realer E-Mail-Versand, kein Selbstzahler-Spezial-Pfad.
      // Nur unbekannte Rechnungstypen werden übersprungen.
      const isMarkSentType = invoice.billingType === "pflegekasse_gesetzlich"
        || invoice.billingType === "pflegekasse_privat"
        || invoice.billingType === "selbstzahler";

      if (!isMarkSentType) {
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
          action: "invoice_marked_sent_manually",
          entityType: "invoice",
          entityId: invoiceId,
          metadata: {
            invoiceNumber: invoice.invoiceNumber,
            customerId: invoice.customerId,
            billingType: invoice.billingType,
            oldStatus: invoice.status,
            newStatus: "versendet",
            source: "bulk_send",
            reason: "manual_mark_sent_no_ti",
          },
          ipAddress: req.ip,
        });
      }, { faults: readTestFaults(req) });

      results.push({
        invoiceId,
        invoiceNumber: invoice.invoiceNumber,
        customerId: invoice.customerId,
        billingType: invoice.billingType,
        status: "marked_sent",
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

  const markedSent = results.filter(r => r.status === "marked_sent").length;
  const skipped = results.filter(r => r.status === "skipped").length;
  const errors = results.filter(r => r.status === "error").length;

  res.json({
    summary: { total: results.length, markedSent, skipped, errors },
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
  // BP-3 — invoice-zielgenauer Render-Fault (nur NODE_ENV=test, sonst leer).
  const failInvoicePdfIds = readTestFailInvoicePdfIds(req);
  for (const inv of drafts) {
    try {
      if (failInvoicePdfIds.has(inv.id)) {
        throw classifyPdfRenderError(
          new Error(`Test-Fault: erzwungener Render-Fehler für Rechnung ${inv.invoiceNumber}`),
          `Rechnungs-PDF ${inv.invoiceNumber}`,
        );
      }
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
    try {
      schedulePdfPersistInBackground(inv.id);
      await withAudit(async (tx, audit) => {
        await updateInvoiceStatusTx(tx, inv.id, "versendet", req.user!.id);
        await tx.update(invoicesTable)
          .set({ sentAt: new Date() })
          .where(eq(invoicesTable.id, inv.id));
        // Task #1403: Sammeldruck markiert ALLE enthaltenen Entwürfe einheitlich
        // manuell als versendet (Pflegekassen + Selbstzahler) — kein realer
        // E-Mail-Versand, kein Selbstzahler-Spezial-Pfad.
        audit.record({
          userId: req.user!.id,
          action: "invoice_marked_sent_manually",
          entityType: "invoice",
          entityId: inv.id,
          metadata: {
            invoiceNumber: inv.invoiceNumber,
            customerId: inv.customerId,
            billingType: inv.billingType,
            oldStatus: inv.status,
            newStatus: "versendet",
            source: "bulk_print",
            reason: "manual_mark_sent_no_ti",
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
  res.setHeader("Content-Disposition", buildContentDisposition(fileName, "attachment"));
  res.setHeader("X-Bulk-Print-Summary", encodeURIComponent(JSON.stringify(summary)));
  res.send(outputBuffer);
}));

// Task #1473 — Sammeldruck-VORSCHAU (READ-ONLY): bündelt dieselben Rechnungen
// eines Monats wie /bulk-print (Rechnung + optional Leistungsnachweis je
// Rechnung), führt aber KEINE Status-Mutation aus — KEIN „versendet", KEIN
// sentAt, KEIN Audit-Mark. Phase 1 (PDF-Beschaffung) ist identisch mit
// /bulk-print; Phase 2 (Mark-Sent) entfällt bewusst.
//   - groupByPayer=false → ein zusammengeführtes Gesamt-PDF (application/pdf)
//   - groupByPayer=true  → ZIP mit einem PDF je Krankenkasse
//   - includeLeistungsnachweise=false → keine LN anhängen (nur Rechnungs-PDFs)
// Die Zusammenfassung kommt im `X-Bulk-Print-Summary`-Header (marked=0).
router.post("/bulk-print-preview", asyncHandler("Sammeldruck-Vorschau konnte nicht erstellt werden", async (req, res) => {
  const parsed = z.object({
    billingMonth: z.number().int().min(1).max(12),
    billingYear: z.number().int().min(2000).max(2100),
    insuranceProviderId: z.number().int().positive().optional(),
    groupByPayer: z.boolean().optional().default(false),
    includeLeistungsnachweise: z.boolean().optional().default(true),
    // Task #1630: Optionale Auswahl konkreter Rechnungen. Wenn gesetzt, wird
    // genau diese (auf druckbare Entwürfe gefilterte) Menge gedruckt statt aller
    // Monats-Entwürfe. Ohne IDs bleibt das bisherige Monats-Verhalten
    // unverändert (Sammeldruck-Button). Grenzen wie bei den anderen
    // Bulk-Endpoints.
    invoiceIds: z.array(z.number().int().positive()).min(1).max(200).optional(),
  }).safeParse(req.body);
  if (!parsed.success) throw badRequest(fromError(parsed.error).toString());
  const { billingMonth, billingYear, insuranceProviderId, groupByPayer, includeLeistungsnachweise, invoiceIds } = parsed.data;

  type PreviewInvoice = Awaited<ReturnType<typeof storage.getInvoices>>[number];
  const hasIds = !!invoiceIds && invoiceIds.length > 0;
  let targets: PreviewInvoice[];
  if (hasIds) {
    // Task #1631 — Auswahl-basierter Druck: genau die übergebenen Rechnungen.
    // ANDERS als der Monats-Sammeldruck ist die Auswahl NICHT auf Entwürfe
    // beschränkt: auch bereits versendete/bezahlte Rechnungen dürfen als
    // read-only Nachdruck-/Archiv-Bündel gedruckt werden (kein Statuswechsel,
    // kein Re-Seal der versiegelten Originale — siehe Phase 1 unten). Reine
    // Stornorechnungen bleiben ausgeschlossen (wie in allen Bündel-Routen).
    const uniqueIds = Array.from(new Set(invoiceIds!));
    const loaded = await Promise.all(uniqueIds.map((id) => storage.getInvoice(id)));
    targets = loaded
      .filter((inv): inv is PreviewInvoice => inv !== undefined && inv !== null)
      .filter(inv => inv.invoiceType !== "stornorechnung")
      .sort((a, b) => a.invoiceNumber.localeCompare(b.invoiceNumber));
  } else {
    // Monats-Sammeldruck (ohne Auswahl): weiterhin nur Entwürfe des Monats.
    const allDrafts = await storage.getInvoices({
      year: billingYear,
      month: billingMonth,
      status: "entwurf",
      insuranceProviderId,
    });
    targets = allDrafts
      .filter(inv => inv.invoiceType !== "stornorechnung")
      .sort((a, b) => a.invoiceNumber.localeCompare(b.invoiceNumber));
  }

  if (targets.length === 0) {
    throw notFound(
      hasIds
        ? "Keine druckbaren Rechnungen in der Auswahl gefunden."
        : `Keine Entwurfs-Rechnungen für ${String(billingMonth).padStart(2, "0")}/${billingYear} gefunden.`,
    );
  }

  // Krankenkassen-Zuordnung je Kunde (für groupByPayer + Dateinamen).
  const customerIds = Array.from(new Set(targets.map(d => d.customerId)));
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

  type PreviewResultEntry = {
    invoiceId: number;
    invoiceNumber: string;
    customerId: number;
    status: "printed" | "error";
    message?: string;
  };
  const results: PreviewResultEntry[] = [];

  // Phase 1 — PDFs beschaffen (kein State-Change), identisch zu /bulk-print.
  type DraftInvoice = Awaited<ReturnType<typeof storage.getInvoices>>[number];
  type RenderedPreview = {
    invoice: DraftInvoice;
    invoicePdf: Buffer;
    lnPdf: Buffer | null;
    appendLn: boolean;
    payerKey: string;
    payerLabel: string;
  };
  const rendered: RenderedPreview[] = [];
  const failInvoicePdfIds = readTestFailInvoicePdfIds(req);
  // Task #1631 — versendete/bezahlte Rechnungen liefern read-only die
  // versiegelten Bytes bzw. bei kundenadressierten (gemergten) Rechnungen einen
  // frischen invoice-only Re-Render (identisch zum /single-pdf-export-Muster);
  // dafür werden die Company-Settings einmalig geladen. Kein Re-Seal.
  const companySettings = await getCachedCompanySettings();
  for (const inv of targets) {
    try {
      if (failInvoicePdfIds.has(inv.id)) {
        throw classifyPdfRenderError(
          new Error(`Test-Fault: erzwungener Render-Fehler für Rechnung ${inv.invoiceNumber}`),
          `Rechnungs-PDF ${inv.invoiceNumber}`,
        );
      }
      const isDraft = inv.status === "entwurf";
      let invoicePdf: Buffer | null;
      let lnPdf: Buffer | null = null;
      let appendLn: boolean;
      if (isDraft) {
        // Entwürfe: bisheriges Verhalten — fehlende PDFs werden persistiert
        // und der separat gecachte LN nur angehängt, wenn er nicht bereits im
        // Rechnungs-PDF steckt (shouldAppendStandaloneLeistungsnachweis).
        invoicePdf = await loadInvoicePdfFromStorage(inv);
        lnPdf = includeLeistungsnachweise ? await loadLeistungsnachweisPdfFromStorage(inv) : null;
        const isPflegekasse = inv.billingType === "pflegekasse_gesetzlich" || inv.billingType === "pflegekasse_privat";
        let persistError: unknown = null;
        if (!invoicePdf || (includeLeistungsnachweise && !lnPdf && isPflegekasse)) {
          try {
            await persistInvoicePdf(inv.id);
          } catch (err) {
            persistError = err;
            console.error(`[billing/bulk-print-preview] PDF-Persistierung für Rechnung ${inv.id} fehlgeschlagen:`, err);
          }
          const refreshed = await storage.getInvoice(inv.id);
          if (refreshed) {
            invoicePdf = await loadInvoicePdfFromStorage(refreshed) ?? invoicePdf;
            if (includeLeistungsnachweise) {
              lnPdf = await loadLeistungsnachweisPdfFromStorage(refreshed) ?? lnPdf;
            }
          }
        }
        if (!invoicePdf) {
          throw classifyPdfRenderError(persistError, `Rechnungs-PDF ${inv.invoiceNumber}`);
        }
        appendLn = includeLeistungsnachweise && await shouldAppendStandaloneLeistungsnachweis(inv);
        if (includeLeistungsnachweise && !lnPdf && appendLn) {
          try {
            lnPdf = await renderLeistungsnachweisOnTheFly(inv);
          } catch (err) {
            throw classifyPdfRenderError(err, `Leistungsnachweis ${inv.invoiceNumber}`);
          }
        }
      } else {
        // Task #1631 — Versendete/bezahlte Rechnung: KEIN Statuswechsel, KEIN
        // Re-Seal. Rechnungs-Bytes wie in /single-pdf-export beschaffen:
        //   - LN-freies versiegeltes PDF (Kasse gesetzlich / Selbstzahler):
        //     Bytes 1:1 (Cache-Miss → einmalig nachpersistieren).
        //   - kundenadressiert (gemergt: privat / rechnungAnKunde / Beihilfe):
        //     invoice-only frisch re-rendern aus dem versiegelten Snapshot.
        // Danach ist invoicePdf garantiert LN-frei → der standalone LN wird —
        // wenn angefordert — separat angehängt (einheitlich für alle Typen).
        const containsLn = await storedInvoicePdfContainsLeistungsnachweis(inv);
        if (!containsLn) {
          invoicePdf = await loadInvoicePdfFromStorage(inv);
          if (!invoicePdf) {
            let persistError: unknown = null;
            try {
              await persistInvoicePdf(inv.id);
            } catch (err) {
              persistError = err;
              console.error(`[billing/bulk-print-preview] PDF-Persistierung für versendete Rechnung ${inv.id} fehlgeschlagen:`, err);
            }
            const refreshed = await storage.getInvoice(inv.id);
            if (refreshed) invoicePdf = await loadInvoicePdfFromStorage(refreshed);
            if (!invoicePdf) throw classifyPdfRenderError(persistError, `Rechnungs-PDF ${inv.invoiceNumber}`);
          }
        } else {
          const snapshot = (inv.renderSnapshot ?? null) as InvoiceRenderSnapshot | null;
          try {
            const built = await buildInvoicePdfBytes(inv, companySettings, { snapshot, invoiceOnly: true });
            invoicePdf = built.pdf;
          } catch (err) {
            throw classifyPdfRenderError(err, `Rechnungs-PDF ${inv.invoiceNumber}`);
          }
        }
        appendLn = includeLeistungsnachweise;
        if (includeLeistungsnachweise) {
          lnPdf = await loadLeistungsnachweisPdfFromStorage(inv);
          if (!lnPdf) {
            try {
              lnPdf = await renderLeistungsnachweisOnTheFly(inv);
            } catch (err) {
              throw classifyPdfRenderError(err, `Leistungsnachweis ${inv.invoiceNumber}`);
            }
          }
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
      console.error(`[billing/bulk-print-preview] Render für Rechnung ${inv.id} fehlgeschlagen:`, err);
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
      "BULK_PRINT_PREVIEW_RENDER_FAILED",
      "Keine der Entwurfs-Rechnungen konnte für die Sammeldruck-Vorschau gerendert werden.",
    );
  }

  const monthSlug = `${String(billingMonth).padStart(2, "0")}-${billingYear}`;
  let outputBuffer: Buffer;
  let contentType: string;
  let fileName: string;

  if (groupByPayer) {
    const groups = new Map<string, { label: string; pairs: RenderedPreview[] }>();
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
      archive.append(mergedGroup, { name: `Sammeldruck-Vorschau-${slug}-${monthSlug}.pdf` });
    }
    await archive.finalize();
    await done;
    outputBuffer = Buffer.concat(chunks);
    contentType = "application/zip";
    fileName = `Sammeldruck-Vorschau-${monthSlug}.zip`;
  } else {
    const flat: Buffer[] = [];
    for (const r of rendered) {
      flat.push(r.invoicePdf);
      if (r.lnPdf && r.appendLn) flat.push(r.lnPdf);
    }
    outputBuffer = await combinePdfBuffers(flat);
    contentType = "application/pdf";
    fileName = `Sammeldruck-Vorschau-${monthSlug}.pdf`;
  }

  // READ-ONLY: keine Status-Mutation. Alle erfolgreich gerenderten Rechnungen
  // gelten als „printed"; marked bleibt 0.
  for (const r of rendered) {
    results.push({
      invoiceId: r.invoice.id,
      invoiceNumber: r.invoice.invoiceNumber,
      customerId: r.invoice.customerId,
      status: "printed",
    });
  }

  const errors = results.filter(r => r.status === "error").length;
  const summary = {
    total: targets.length,
    printed: rendered.length,
    marked: 0,
    errors,
    groupedByPayer: groupByPayer,
    results,
  };
  log(
    `bulk-print-preview done month=${billingMonth}/${billingYear} total=${targets.length} printed=${rendered.length} errors=${errors} groupByPayer=${groupByPayer} includeLN=${includeLeistungsnachweise} userId=${req.user?.id ?? "?"}`,
    "billing",
  );

  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", buildContentDisposition(fileName, "attachment"));
  res.setHeader("X-Bulk-Print-Summary", encodeURIComponent(JSON.stringify(summary)));
  res.send(outputBuffer);
}));

// Task #1695 — Einzel-PDF-Export (ehem. „Lexware-Export"). Der Admin wählt
// Rechnungen (per IDs und/oder Zeitraum) und lädt ein ZIP, in dem JEDE Rechnung
// eine eigene PDF mit lesbarem Dateinamen (`Rechnungsnummer_Kunde_Datum.pdf`)
// ist. Über `includeLeistungsnachweise` wird je Rechnung der zugehörige
// Leistungsnachweis in DIESELBE Einzel-PDF gemergt (eine Datei je Rechnung).
// Dies ist die „Einzeln (ZIP)"-Variante des konsolidierten „Drucken"-Menüs;
// die „Zusammengefasst"-Variante bleibt `/bulk-print-preview`.
//
// READ-ONLY / status-neutral — ANDERS als /bulk-print:
//   - KEINE Status-Änderung (kein „versendet"), KEIN sentAt, KEIN Audit-Mark.
//   - KEINE DB-Mutation; die versiegelten Originale (`pdf_path`/`pdf_hash`)
//     werden NIE angefasst, kein Re-Seal.
//
// Invoice-only-Beschaffung pro Rechnung (verzweigt über
// `storedInvoicePdfContainsLeistungsnachweis`):
//   - FALSE (Kasse gesetzlich / Selbstzahler): versiegeltes PDF ist bereits
//     LN-frei → Bytes 1:1 ausliefern (kein Re-Render).
//   - TRUE (kundenadressiert: privat / rechnungAnKunde / Beihilfe): versiegeltes
//     PDF ist Rechnung+LN gemergt → frisch invoice-only RE-RENDERN
//     (`buildInvoicePdfBytes(..., { invoiceOnly:true })`), NIE per Seiten-Strip.
//     Diese Bytes sind Wegwerf-Export-Kopien (Zeitstempel ≠ versiegelter Hash —
//     erwartet, der Export wird NICHT auf Hash-Reproduktion geprüft).
// Danach ist das Rechnungs-PDF garantiert LN-frei; bei
// `includeLeistungsnachweise` wird der LN (gleiche Beschaffung wie in
// `/bulk-print-preview`: Storage-Cache → On-the-fly-Render) je Rechnung
// angehängt.
//
// Stornorechnungen: wie in den Bündel-Routen (reine Stornos ausgeschlossen).
// Render läuft AUSSERHALB jeder db.transaction/withAudit (Pool-Starvation,
// Arch-Test no-render-inside-transaction).
router.post("/single-pdf-export", asyncHandler("Einzel-PDF-Export konnte nicht erstellt werden", async (req, res) => {
  const parsed = z.object({
    invoiceIds: z.array(z.number().int().positive()).optional(),
    billingMonth: z.number().int().min(1).max(12).optional(),
    billingYear: z.number().int().min(2000).max(2100).optional(),
    insuranceProviderId: z.number().int().positive().optional(),
    includeLeistungsnachweise: z.boolean().optional().default(false),
  }).safeParse(req.body);
  if (!parsed.success) throw badRequest(fromError(parsed.error).toString());
  const { invoiceIds, billingMonth, billingYear, insuranceProviderId, includeLeistungsnachweise } = parsed.data;

  // Rechnungen entweder über explizite IDs oder über einen Zeitraum (Monat/Jahr,
  // optional Kassen-Filter) auswählen. Mindestens eine Quelle ist erforderlich.
  const hasIds = !!invoiceIds && invoiceIds.length > 0;
  const hasPeriod = billingMonth !== undefined && billingYear !== undefined;
  if (!hasIds && !hasPeriod) {
    throw badRequest("Bitte Rechnungs-IDs oder einen Zeitraum (Monat und Jahr) angeben.");
  }

  type ExportInvoice = Awaited<ReturnType<typeof storage.getInvoices>>[number];
  let candidates: ExportInvoice[] = [];
  if (hasIds) {
    const loaded = await Promise.all(invoiceIds!.map((id) => storage.getInvoice(id)));
    candidates = loaded.filter((inv): inv is ExportInvoice => inv !== undefined && inv !== null);
  } else {
    candidates = await storage.getInvoices({ year: billingYear, month: billingMonth, insuranceProviderId });
  }

  // Reine Stornorechnungen wie in /bundle-by-payer ausschließen (kein
  // Storno-Beleg im Buchhaltungs-Export); stabil nach Rechnungsnummer sortiert.
  const invoices = candidates
    .filter((inv) => inv.invoiceType !== "stornorechnung")
    .sort((a, b) => a.invoiceNumber.localeCompare(b.invoiceNumber));

  if (invoices.length === 0) {
    throw notFound("Keine exportierbaren Rechnungen für die Auswahl gefunden.");
  }

  const companySettings = await getCachedCompanySettings();

  type ResultEntry = {
    invoiceId: number;
    invoiceNumber: string;
    customerId: number;
    status: "exported" | "error";
    message?: string;
  };
  const results: ResultEntry[] = [];

  // Phase 1 — Einzel-PDF-Bytes je Rechnung beschaffen (KEIN State-Change). Das
  // Rechnungs-PDF ist stets LN-frei; bei `includeLeistungsnachweise` wird der
  // zugehörige LN in DIESELBE Einzel-PDF gemergt.
  type Rendered = { invoice: ExportInvoice; pdf: Buffer };
  const rendered: Rendered[] = [];
  for (const inv of invoices) {
    try {
      const containsLn = await storedInvoicePdfContainsLeistungsnachweis(inv);
      let invoicePdf: Buffer | null = null;
      if (!containsLn) {
        // Versiegeltes PDF ist bereits LN-frei → 1:1 ausliefern. Cache-Miss →
        // einmalig nachpersistieren (idempotent, mutex-serialisiert) und erneut
        // aus Storage lesen (verbatim auf dem versiegelten Key).
        invoicePdf = await loadInvoicePdfFromStorage(inv);
        if (!invoicePdf) {
          let persistError: unknown = null;
          try {
            await persistInvoicePdf(inv.id);
          } catch (err) {
            persistError = err;
            console.error(`[billing/single-pdf-export] PDF-Persistierung für Rechnung ${inv.id} fehlgeschlagen:`, err);
          }
          const refreshed = await storage.getInvoice(inv.id);
          if (refreshed) invoicePdf = await loadInvoicePdfFromStorage(refreshed);
          if (!invoicePdf) throw classifyPdfRenderError(persistError, `Rechnungs-PDF ${inv.invoiceNumber}`);
        }
      } else {
        // Kundenadressiert (gemergt) → invoice-only frisch re-rendern aus dem
        // versiegelten Render-Snapshot (GoBD-reproduzierbar, Wegwerf-Kopie).
        const snapshot = (inv.renderSnapshot ?? null) as InvoiceRenderSnapshot | null;
        try {
          const built = await buildInvoicePdfBytes(inv, companySettings, { snapshot, invoiceOnly: true });
          invoicePdf = built.pdf;
        } catch (err) {
          throw classifyPdfRenderError(err, `Rechnungs-PDF ${inv.invoiceNumber}`);
        }
      }

      // „+ Leistungsnachweise": LN je Rechnung beschaffen (gleiche Beschaffung
      // wie /bulk-print-preview: versiegelter Storage-Cache → On-the-fly-Render)
      // und in DIESELBE Einzel-PDF hinter die Rechnung mergen. Das Rechnungs-PDF
      // ist hier garantiert LN-frei (siehe oben), daher unbedingt anhängen.
      let pdf = invoicePdf;
      if (includeLeistungsnachweise) {
        let lnPdf = await loadLeistungsnachweisPdfFromStorage(inv);
        if (!lnPdf) {
          try {
            lnPdf = await renderLeistungsnachweisOnTheFly(inv);
          } catch (err) {
            throw classifyPdfRenderError(err, `Leistungsnachweis ${inv.invoiceNumber}`);
          }
        }
        pdf = await combinePdfBuffers([invoicePdf, lnPdf]);
      }
      rendered.push({ invoice: inv, pdf });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unbekannter Fehler";
      console.error(`[billing/single-pdf-export] Export für Rechnung ${inv.id} fehlgeschlagen:`, err);
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
      "Keine der ausgewählten Rechnungen konnte für den Einzel-PDF-Export gerendert werden.",
      "SINGLE_PDF_EXPORT_RENDER_FAILED",
    );
  }

  // Phase 2 — ZIP bauen (eine PDF pro Rechnung). Lesbare Dateinamen,
  // kollisionsfrei innerhalb des Archivs.
  const baseNames = rendered.map((r) => buildInvoiceExportFilename({
    invoiceNumber: r.invoice.invoiceNumber,
    customerName: r.invoice.customerName,
    date: formatDateISO(r.invoice.sentAt ?? r.invoice.createdAt),
  }));
  const fileNames = dedupeExportFilenames(baseNames);

  const archiver = (await import("archiver")).default;
  const archive = archiver("zip", { zlib: { level: 6 } });
  const chunks: Buffer[] = [];
  archive.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    archive.on("end", () => resolve());
    archive.on("error", (err: Error) => reject(err));
  });
  rendered.forEach((r, i) => {
    archive.append(r.pdf, { name: fileNames[i] });
    results.push({
      invoiceId: r.invoice.id,
      invoiceNumber: r.invoice.invoiceNumber,
      customerId: r.invoice.customerId,
      status: "exported",
    });
  });
  await archive.finalize();
  await done;
  const outputBuffer = Buffer.concat(chunks);

  const errors = results.filter((r) => r.status === "error").length;
  const summary = {
    total: invoices.length,
    exported: rendered.length,
    errors,
    results,
  };
  log(
    `single-pdf-export done total=${invoices.length} exported=${rendered.length} errors=${errors} withLn=${includeLeistungsnachweise} userId=${req.user?.id ?? "?"}`,
    "billing",
  );

  const zipName = hasPeriod && !hasIds
    ? `Rechnungen-${String(billingMonth).padStart(2, "0")}-${billingYear}.zip`
    : `Rechnungen-${todayISO()}.zip`;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", buildContentDisposition(zipName, "attachment"));
  res.setHeader("X-Single-Pdf-Export-Summary", encodeURIComponent(JSON.stringify(summary)));
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
    // Task #1317: Optionaler von–bis-Datumsbereich (ISO yyyy-mm-dd). Engt die
    // Massenerstellung auf Termine innerhalb des Bereichs ein (Teil-Abrechnung
    // innerhalb des Monats). Leer = ganzer Monat (Bestandsverhalten).
    dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    // Task #1771: Wenn gesetzt, werden NUR Kunden ohne offene (geplante) Termine
    // abgerechnet („Bereit zum Abrechnen") — Kunden mit noch offenen Terminen
    // werden als „übersprungen" gemeldet. Nutzt DIESELBE „offene Termine"-SSoT
    // (getOpenAppointmentCountByCustomer, FINAL_APPOINTMENT_STATUSES) wie
    // /eligible-customers und die Karten-Gruppierung „Bereit zum Abrechnen" —
    // keine zweite Berechnung. Weggelassen/false = alle berechtigten Kunden.
    readyOnly: z.boolean().optional(),
  }).safeParse(req.body);
  if (!parsed.success) throw badRequest(fromError(parsed.error).toString());
  const { billingMonth, billingYear, insuranceProviderId, dateFrom, dateTo, readyOnly } = parsed.data;
  const hasDateRange = !!(dateFrom || dateTo);
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
    status: monthlyServiceRecords.status,
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

  // Task #1771: Wenn `readyOnly` gesetzt ist, werden NUR Kunden ohne offene
  // (geplante) Termine abgerechnet — Kunden mit noch offenen Terminen werden aus
  // der Erstellung genommen und als „übersprungen" gemeldet. Nutzt DIESELBE
  // „offene Termine"-SSoT (getOpenAppointmentCountByCustomer,
  // FINAL_APPOINTMENT_STATUSES) mit demselben Datumsbereich wie
  // /eligible-customers und die Karten-Gruppierung „Bereit zum Abrechnen" —
  // keine zweite Berechnung, damit Dialog-Auswahl und Liste nie divergieren.
  let openSkippedIds: number[] = [];
  if (readyOnly && customerIds.length > 0) {
    const openByCustomer = await getOpenAppointmentCountByCustomer(
      customerIds,
      billingYear,
      billingMonth,
      { dateFrom, dateTo },
    );
    openSkippedIds = customerIds.filter((id) => (openByCustomer.get(id) ?? 0) > 0);
    const skipSet = new Set(openSkippedIds);
    customerIds = customerIds.filter((id) => !skipSet.has(id));
  }

  // Task #1779: Signatur-blockierte Pflegekasse-Kunden VOR dem
  // `generateInvoiceCore`-Lauf herausnehmen und als „übersprungen" (nicht als
  // „Fehler") melden. Solche Kunden haben keine offenen Termine mehr (sie
  // werden also nicht schon von `openSkippedIds` erfasst), warten aber noch auf
  // die Kundenunterschrift — ihr Leistungsnachweis ist nur `employee_signed`.
  // Ohne diese Vorab-Aussortierung liefen sie in `generateInvoiceCore` in den
  // 400-Signatur-Block und erschienen im Ergebnis-Dialog rot als „Fehler",
  // obwohl es das erwartete Unterschrifts-Gate ist. Eligibilität kommt aus
  // DERSELBEN SSoT (`classifyBillingEligibility`) wie in `/eligible-customers`.
  let signatureSkippedIds: number[] = [];
  if (customerIds.length > 0) {
    const statusesByCustomer = new Map<number, string[]>();
    for (const r of signedRecords) {
      if (!customerIds.includes(r.customerId)) continue;
      const arr = statusesByCustomer.get(r.customerId) ?? [];
      arr.push(r.status);
      statusesByCustomer.set(r.customerId, arr);
    }
    const billingTypeRows = await db.select({
      id: customersTable.id,
      billingType: customersTable.billingType,
    })
      .from(customersTable)
      .where(inArray(customersTable.id, customerIds));
    const billingTypeById = new Map(billingTypeRows.map((c) => [c.id, c.billingType]));
    signatureSkippedIds = customerIds.filter((id) => {
      const { reason } = classifyBillingEligibility({
        billingType: billingTypeById.get(id) ?? null,
        serviceRecordStatuses: statusesByCustomer.get(id) ?? [],
        // Nur der Signatur-Grund (`signedRecordCount === 0`) wird hier vorab
        // ausgefiltert; die übrigen Fakten sind für diese Verzweigung
        // irrelevant und werden vom Generate-Pfad selbst behandelt.
        signedAppointmentCount: 1,
        unbilledAppointmentCount: 1,
      });
      return reason === "customer_signature_required";
    });
    const sigSkipSet = new Set(signatureSkippedIds);
    customerIds = customerIds.filter((id) => !sigSkipSet.has(id));
  }

  log(
    `generate-all start month=${billingMonth}/${billingYear} eligibleCustomers=${customerIds.length}${insuranceProviderId ? ` insuranceProviderId=${insuranceProviderId}` : ""}${readyOnly ? ` readyOnly=1 openSkipped=${openSkippedIds.length}` : ""}${signatureSkippedIds.length > 0 ? ` sigSkipped=${signatureSkippedIds.length}` : ""} userId=${userId ?? "?"}`,
    "billing",
  );

  // Task #1790 — Ohne Datumsbereich Termin-genaue Idempotenz statt grober
  // „hat irgendeine Rechnung im Monat"-Skip. EINE SSoT mit
  // `/eligible-customers` (`getUnbilledSignedAppointmentFactsByCustomer`), damit
  // die Liste („N noch zu erstellen") und die Massenerstellung nie divergieren:
  // ein Kunde mit spät signierten Nachzügler-Terminen wird nicht mehr
  // fälschlich übersprungen, nur weil bereits eine frühere Rechnung existiert.
  let unbilledFactsByCustomer = new Map<number, UnbilledSignedFacts>();
  if (!hasDateRange && customerIds.length > 0) {
    unbilledFactsByCustomer = await getUnbilledSignedAppointmentFactsByCustomer(customerIds, billingYear, billingMonth);
  }

  const results: Array<{
    customerId: number;
    status: "created" | "skipped" | "error";
    invoiceCount?: number;
    message?: string;
  }> = [];

  // Task #1771: übersprungene Kunden mit noch offenen Terminen in die
  // Summary/Ergebnisliste aufnehmen, damit der Admin sieht, wer nicht
  // abgerechnet wurde.
  for (const customerId of openSkippedIds) {
    results.push({ customerId, status: "skipped", message: "Noch offene Termine" });
  }

  // Task #1779: Signatur-blockierte Kunden als „übersprungen" mit klarem Grund
  // melden — nicht als Fehler.
  for (const customerId of signatureSkippedIds) {
    results.push({ customerId, status: "skipped", message: "Wartet auf Kundenunterschrift" });
  }

  for (const customerId of customerIds) {
    try {
      // Idempotenz: Termin-genau statt kunde-grob.
      // Task #1317: Mit Datumsbereich ist Teil-Abrechnung gewollt — der grobe
      // „hat irgendeine Rechnung im Monat"-Skip würde den zweiten Bereich
      // blockieren. Wir überspringen den Vor-Skip dann und überlassen die
      // Idempotenz der Termin-Ebene in `buildInvoiceDraft` (bereits
      // abgerechnete Termine fallen raus → „bereits abgerechnet" = Skip).
      // Task #1790: Ohne Datumsbereich NICHT mehr grob „hat irgendeine aktive
      // Rechnung → skip" (das übersprang Kunden mit spät signierten Nachzügler-
      // Terminen). Stattdessen nur skippen, wenn KEIN dokumentierter, signierter,
      // noch nicht abgerechneter Termin mehr offen ist — dieselbe SSoT wie
      // `/eligible-customers`.
      if (!hasDateRange) {
        const facts = unbilledFactsByCustomer.get(customerId);
        if (!facts || facts.unbilledAppointmentCount === 0) {
          results.push({ customerId, status: "skipped", message: "Bereits abgerechnet" });
          continue;
        }
      }

      // Direkter In-Process-Aufruf der Kern-Logik — kein HTTP-Self-Call,
      // kein Cookie-Forwarding, kein Host-Header-SSRF-Risiko.
      try {
        const result = await generateInvoiceCore(
          { customerId, billingMonth, billingYear, dateFrom, dateTo },
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
            // Task #1074 — Pflegekasse-Kunde mit nur mitarbeiter-signiertem LN ist
            // (noch) nicht abrechenbar → Skip, kein harter Fehler in der Massenerstellung.
            || msg.includes("vom Kunden unterschrieben sein")
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
