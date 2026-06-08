import { formatPhoneForDisplay } from "@shared/utils/phone";
  import {
    users,
    userRoles,
    customers as customersTable,
    invoices as invoicesTable,
    monthlyServiceRecords,
    serviceRecordAppointments,
  } from "@shared/schema";
  import type { Invoice, InvoiceLineItem, CompanySettings, InvoiceRenderSnapshot, InvoiceRenderCompanySnapshot } from "@shared/schema";
  import { INVOICE_RENDER_COMPANY_SNAPSHOT_KEYS } from "@shared/schema";
  import { computeDataHash } from "./signature-integrity";
  import { objectStorageClient } from "../replit_integrations/object_storage/objectStorage";
  import { parseObjectPath, getPrivateDir, buildInvoicePdfObjectKey, assertInvoicePdfWriteKeyAllowed } from "../lib/object-storage-helpers";
  import { eq, and, inArray } from "drizzle-orm";
  import { formatDateForDisplay, formatDateISO, todayISO, parseTimestamp } from "@shared/utils/datetime";
  import { storage } from "../storage";
  import { db } from "../lib/db";
  import { monthlyServiceRecordsRepo } from "../repos";
  import { auditService } from "./audit";
  import type { InvoicePdfData } from "../lib/pdf-generator";
  import {
    computeInvoicePdfFingerprint,
    computeLeistungsnachweisFingerprint,
  } from "../lib/invoice-pdf-fingerprint";
  import { getCachedCompanySettings } from "./cache";
  import { recordPdfCacheSend } from "../lib/pdf-cache-stats";
  import { applyLeistungsnachweisCustomerAddress } from "../lib/customer-address-format";

  // Task #995 — Effektive Seitenränder pro Dokumenttyp. Das HTML setzt
  // `@page{margin:0}`; die Ränder (inkl. reserviertem Bottom-Margin für den
  // wiederholten Puppeteer-Footer) kommen hier über page.pdf({margin}).
  const INVOICE_PDF_MARGIN = { top: "20mm", right: "15mm", bottom: "20mm", left: "15mm" } as const;
  const LEISTUNGSNACHWEIS_PDF_MARGIN = { top: "15mm", right: "15mm", bottom: "18mm", left: "15mm" } as const;

  /**
 * Task #544: Feuert `persistInvoicePdf` im Hintergrund (Microtask), damit der
 * HTTP-Request „Rechnung erstellen" nicht durch einen langsamen Puppeteer-
 * Render-/Launch-Pfad blockiert wird. Fehler werden geloggt; das Rechnungs-
 * PDF wird beim nächsten /pdf- oder /leistungsnachweis-Abruf nachgezogen.
 *
 * Task #546: Wiederholt den Persist-Versuch bis zu BACKGROUND_PDF_MAX_ATTEMPTS
 * mit exponentiellem Backoff. Schlägt der letzte Versuch fehl, wird ein
 * Audit-Log-Eintrag (`invoice_pdf_persist_failed`) geschrieben, damit
 * Superadmins fehlerhafte PDFs nicht erst beim nächsten Druckauftrag bemerken.
 */
const BACKGROUND_PDF_MAX_ATTEMPTS = 3;
const BACKGROUND_PDF_RETRY_DELAY_MS = 30_000;

export function schedulePdfPersistInBackground(invoiceId: number): void {
  setImmediate(() => {
    void runPdfPersistWithRetry(invoiceId);
  });
}

async function runPdfPersistWithRetry(invoiceId: number): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= BACKGROUND_PDF_MAX_ATTEMPTS; attempt++) {
    try {
      await persistInvoicePdf(invoiceId);
      return;
    } catch (err) {
      lastError = err;
      console.error(
        `[billing/generate] Hintergrund-PDF-Persistierung für Rechnung ${invoiceId} (Versuch ${attempt}/${BACKGROUND_PDF_MAX_ATTEMPTS}) fehlgeschlagen:`,
        err,
      );
      if (attempt < BACKGROUND_PDF_MAX_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, BACKGROUND_PDF_RETRY_DELAY_MS * attempt),
        );
      }
    }
  }

  // Endgültiger Fehlschlag — Audit-Log-Eintrag schreiben, damit die UI
  // (Badge „PDF-Fehler") und Superadmins die betroffene Rechnung sehen.
  try {
    const invoice = await storage.getInvoice(invoiceId);
    if (!invoice) return;
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    await auditService.log(
      invoice.createdByUserId ?? 0,
      "invoice_pdf_persist_failed",
      "invoice",
      invoiceId,
      {
        invoiceNumber: invoice.invoiceNumber,
        attempts: BACKGROUND_PDF_MAX_ATTEMPTS,
        error: message.slice(0, 500),
      },
    );
  } catch (auditErr) {
    console.error(
      `[billing/generate] Audit-Log für PDF-Persist-Fehler (Rechnung ${invoiceId}) konnte nicht geschrieben werden:`,
      auditErr,
    );
  }
}

export function buildPdfData(invoice: Invoice, lineItems: InvoiceLineItem[], companySettings: CompanySettings): InvoicePdfData {
  return {
    companyName: companySettings.companyName || "",
    companyAddress: [
      [companySettings.strasse, companySettings.hausnummer].filter(Boolean).join(" "),
      [companySettings.plz, companySettings.stadt].filter(Boolean).join(" "),
    ].filter(Boolean).join(", "),
    companyPhone: formatPhoneForDisplay(companySettings.telefon || ""),
    companyEmail: companySettings.email || "",
    companyWebsite: companySettings.website ?? null,
    steuernummer: companySettings.steuernummer ?? null,
    ustId: companySettings.ustId ?? null,
    iban: companySettings.iban || "",
    bic: companySettings.bic || "",
    bankName: companySettings.bankName || "",
    bankAccountHolder: companySettings.bankAccountHolder ?? null,
    ikNummer: companySettings.ikNummer ?? null,
    geschaeftsfuehrer: companySettings.geschaeftsfuehrer ?? null,
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: invoice.sentAt ? formatDateForDisplay(formatDateISO(invoice.sentAt)) : formatDateForDisplay(todayISO()),
    invoiceDueDate: invoice.dueDate ? formatDateForDisplay(invoice.dueDate) : null,
    buyerReference: invoice.buyerReference ?? null,
    assignmentDeclarationDate: invoice.assignmentDeclarationDate ?? null,
    assignmentDeclarationRef: invoice.assignmentDeclarationRef ?? null,
    invoiceType: invoice.invoiceType,
    billingType: invoice.billingType,
    budgetType: invoice.budgetType ?? null,
    billingMonth: invoice.billingMonth,
    billingYear: invoice.billingYear,
    recipientName: invoice.recipientName,
    recipientAddress: invoice.recipientAddress ?? null,
    insuranceProviderName: invoice.insuranceProviderName ?? null,
    insuranceIkNummer: invoice.insuranceIkNummer ?? null,
    versichertennummer: invoice.versichertennummer ?? null,
    pflegegrad: invoice.pflegegrad ?? null,
    customerName: invoice.customerName || invoice.recipientName,
    customerAddress: invoice.recipientAddress || null,
    customerGeburtsdatum: null,
    lineItems: lineItems.map((item: InvoiceLineItem) => ({
      appointmentId: item.appointmentId ?? null,
      appointmentDate: item.appointmentDate,
      startTime: item.startTime ?? null,
      endTime: item.endTime ?? null,
      serviceDescription: item.serviceDescription,
      serviceCode: item.serviceCode || null,
      durationMinutes: item.durationMinutes,
      // Task #561: neue explizite Menge/Einheit. NULL für historische Zeilen
      // (PDF-Template fällt dann auf `durationMinutes` zurück).
      quantityRaw: item.quantityRaw ?? null,
      quantityUnit: (item.quantityUnit as "hours" | "km" | null) ?? null,
      unitPriceCents: item.unitPriceCents,
      totalCents: item.totalCents,
      employeeName: item.employeeName ?? null,
      appointmentNotes: item.appointmentNotes || null,
      serviceDetails: item.serviceDetails || null,
    })),
    netAmountCents: invoice.netAmountCents,
    vatAmountCents: invoice.vatAmountCents,
    grossAmountCents: invoice.grossAmountCents,
    vatRate: invoice.vatRate || 0,
    notes: invoice.notes ?? null,
  };
}

/**
 * Task #997 (#3) / Task #1001: Fail-closed Scope-Guard als reine, testbare
 * Funktion. Der Leistungsnachweis MUSS sich ausschließlich auf den Kunden
 * SEINER Rechnung beziehen. `enrichPdfDataWithSignatures` filtert die
 * Service-Records bereits per `customerId`; diese Assertion fängt jede künftige
 * Lockerung der Query ab, damit niemals fremde Kundendaten auf einen LN geraten.
 * Wirft, sobald ein Service-Record einem anderen Kunden gehört.
 */
export function assertServiceRecordsScopedToInvoice(
  serviceRecords: ReadonlyArray<{ id: number; customerId: number }>,
  invoiceCustomerId: number,
  invoiceNumber: string,
): void {
  const foreignRecord = serviceRecords.find(r => r.customerId !== invoiceCustomerId);
  if (foreignRecord) {
    throw new Error(
      `Leistungsnachweis-Scope verletzt: Service-Record #${foreignRecord.id} ` +
      `gehört Kunde ${foreignRecord.customerId}, Rechnung ${invoiceNumber} ` +
      `aber Kunde ${invoiceCustomerId}.`,
    );
  }
}

export async function enrichPdfDataWithSignatures(pdfData: InvoicePdfData, invoice: Invoice): Promise<void> {
  const serviceRecords = await monthlyServiceRecordsRepo.selectColumnsFrom({
    id: monthlyServiceRecords.id,
    employeeSignatureData: monthlyServiceRecords.employeeSignatureData,
    employeeSignedAt: monthlyServiceRecords.employeeSignedAt,
    employeeId: monthlyServiceRecords.employeeId,
    customerSignatureData: monthlyServiceRecords.customerSignatureData,
    customerSignedAt: monthlyServiceRecords.customerSignedAt,
    status: monthlyServiceRecords.status,
    recordType: monthlyServiceRecords.recordType,
    customerId: monthlyServiceRecords.customerId,
  })
    .where(and(
      eq(monthlyServiceRecords.customerId, invoice.customerId),
      eq(monthlyServiceRecords.year, invoice.billingYear),
      eq(monthlyServiceRecords.month, invoice.billingMonth),
      monthlyServiceRecordsRepo.activeOnly()
    ));

  // Task #997 (#3): Fail-closed. Der LN MUSS sich ausschließlich auf den Kunden
  // SEINER Rechnung beziehen. Die WHERE-Klausel filtert bereits per customerId;
  // diese Assertion fängt jede künftige Lockerung der Query ab, damit niemals
  // fremde Kundendaten auf einen LN geraten.
  assertServiceRecordsScopedToInvoice(serviceRecords, invoice.customerId, invoice.invoiceNumber);

  const signedRecords = serviceRecords.filter(r =>
    r.status === "completed" || r.status === "employee_signed"
  );

  // Task #997 (#3): Nur die Termine, die TATSÄCHLICH auf DIESER Rechnung
  // abgerechnet wurden, dürfen im LN erscheinen. Bei einem Multi-Topf-Split
  // (eine Rechnung pro budget_type) trägt jede Rechnung nur ihren Topf-Anteil;
  // die Signatur-Sektionen werden unten auf diese Termin-IDs eingeschränkt.
  const invoiceAppointmentIds = new Set(
    pdfData.lineItems
      .map(i => i.appointmentId)
      .filter((id): id is number => id != null),
  );

  if (signedRecords.length > 0) {
    const recordIds = signedRecords.map(r => r.id);
    const employeeIds = Array.from(new Set(signedRecords.map(r => r.employeeId)));

    const [employeeRows, recordAppointments, empRoles] = await Promise.all([
      db.select({ id: users.id, displayName: users.displayName })
        .from(users)
        .where(inArray(users.id, employeeIds)),
      db.select({
        serviceRecordId: serviceRecordAppointments.serviceRecordId,
        appointmentId: serviceRecordAppointments.appointmentId,
      })
        .from(serviceRecordAppointments)
        .where(inArray(serviceRecordAppointments.serviceRecordId, recordIds)),
      db.select({ userId: userRoles.userId, role: userRoles.role })
        .from(userRoles)
        .where(inArray(userRoles.userId, employeeIds)),
    ]);

    const employeeMap = new Map(employeeRows.map(e => [e.id, e.displayName]));

    const qualMap = new Map<string, string>();
    for (const emp of employeeRows) {
      const roles = empRoles.filter(r => r.userId === emp.id).map(r => r.role);
      let label = "";
      if (roles.includes("alltagsbegleitung")) {
        label = "Alltagsbegleiter/in";
      } else if (roles.includes("hauswirtschaft")) {
        label = "Hauswirtschafter/in";
      }
      if (label) {
        qualMap.set(emp.displayName, label);
      }
    }
    if (qualMap.size > 0) {
      pdfData.employeeQualifications = qualMap;
    }
    const appointmentsByRecord = new Map<number, number[]>();
    for (const ra of recordAppointments) {
      const existing = appointmentsByRecord.get(ra.serviceRecordId) ?? [];
      existing.push(ra.appointmentId);
      appointmentsByRecord.set(ra.serviceRecordId, existing);
    }

    pdfData.signatures = signedRecords.map(r => ({
      employeeSignatureData: r.employeeSignatureData,
      employeeSignedAt: r.employeeSignedAt ? formatDateForDisplay(formatDateISO(r.employeeSignedAt instanceof Date ? r.employeeSignedAt : parseTimestamp(r.employeeSignedAt))) : null,
      employeeName: employeeMap.get(r.employeeId) || null,
      customerSignatureData: r.customerSignatureData,
      customerSignedAt: r.customerSignedAt ? formatDateForDisplay(formatDateISO(r.customerSignedAt instanceof Date ? r.customerSignedAt : parseTimestamp(r.customerSignedAt))) : null,
      customerName: invoice.customerName || invoice.recipientName,
      appointmentIds: (appointmentsByRecord.get(r.id) ?? []).filter(id => invoiceAppointmentIds.has(id)),
      recordType: r.recordType,
    }));
  }

  if (!pdfData.employeeQualifications || pdfData.employeeQualifications.size === 0) {
    const employeeNamesFromItems = Array.from(new Set(pdfData.lineItems.map(i => i.employeeName).filter(Boolean))) as string[];
    if (employeeNamesFromItems.length > 0) {
      const empRows = await db.select({ id: users.id, displayName: users.displayName })
        .from(users)
        .where(inArray(users.displayName, employeeNamesFromItems));
      if (empRows.length > 0) {
        const roleRows = await db.select({ userId: userRoles.userId, role: userRoles.role })
          .from(userRoles)
          .where(inArray(userRoles.userId, empRows.map(e => e.id)));
        const qualMap = new Map<string, string>();
        for (const emp of empRows) {
          const roles = roleRows.filter(r => r.userId === emp.id).map(r => r.role);
          let label = "";
          if (roles.includes("alltagsbegleitung")) {
            label = "Alltagsbegleiter/in";
          } else if (roles.includes("hauswirtschaft")) {
            label = "Hauswirtschafter/in";
          }
          if (label) qualMap.set(emp.displayName, label);
        }
        if (qualMap.size > 0) pdfData.employeeQualifications = qualMap;
      }
    }
  }
}

// T01/PDF-Hash: Generiert die PDF-Bytes deterministisch (entspricht /pdf-Output),
// speichert sie in Object Storage und persistiert pdfPath + pdfHash.
// Wird nach jeder /generate-Invoice-Erstellung aufgerufen, damit /pdf später
// hashstabile Bytes ausliefert.
//
// Tier-A3: Liefert zusätzlich die ZUGFeRD-XML, die in `embedZugferdXml`
// generiert wurde, sodass `persistInvoicePdf` sie als rechtsverbindlichen
// E-Rechnungs-Inhalt in der Invoice-Zeile speichern kann.
// Task #521: Baut die PDF-Eingabedaten (pdfData) inkl. Kunden-Anschrift /
// Beihilfe-/Rechnung-an-Kunde-Logik. Wird sowohl für den Voll-Build als auch
// für reine LN-Renders verwendet (LN-only verzichtet auf den Invoice-Render).
export async function buildInvoicePdfData(
  invoice: Invoice,
  companySettings: CompanySettings,
  options?: { snapshot?: InvoiceRenderSnapshot | null },
): Promise<{
  pdfData: InvoicePdfData;
  isCustomerInvoice: boolean;
  isPflegekasseInvoice: boolean;
  customerSnapshot: InvoiceRenderSnapshot["customer"];
  invoiceSnapshot: NonNullable<InvoiceRenderSnapshot["invoice"]>;
}> {
  const lineItems = await storage.getInvoiceLineItems(invoice.id);
  // Task #1033 — Firmenstammdaten GoBD-konform einfrieren: liegt ein
  // Render-Snapshot vor (versendete/stornierte Rechnung), werden die
  // Company-Felder (Adresse, IBAN/BIC/Bank/Kontoinhaber, Steuernummer,
  // USt-ID, IK-Nr, Geschäftsführer) aus dem Snapshot gelesen statt aus der
  // Live-`company_settings`-Tabelle. So re-rendert eine bereits ausgestellte
  // Rechnung mit den zum Ausstellungszeitpunkt gültigen Werten, auch wenn
  // sich die Bankverbindung o.Ä. danach ändert. Entwürfe (kein Snapshot)
  // bleiben live. Post-#593-Snapshots == Live-Werte beim Erst-Persist, daher
  // bleibt die byte-genaue ZUGFeRD-/PDF-Integrität unberührt; Bestände ohne
  // Snapshot fallen sauber auf die Live-Settings zurück.
  const effectiveCompanySettings: CompanySettings = options?.snapshot?.companySettings
    ? { ...companySettings, ...options.snapshot.companySettings }
    : companySettings;
  const pdfData = buildPdfData(invoice, lineItems, effectiveCompanySettings);

  // Task #654 — Wenn ein Snapshot vorliegt, override das `invoiceDate`
  // (und `invoiceDueDate`) mit den damals tatsächlich verwendeten Werten.
  // Andernfalls produziert das Re-Render byte-anderes ZUGFeRD-XML, sobald
  // `invoice.sentAt` zwischen Erst-Persist und Re-Render gesetzt wird oder
  // sich `todayISO()` zwischen den beiden Renders ändert.
  if (options?.snapshot?.invoice) {
    pdfData.invoiceDate = options.snapshot.invoice.invoiceDate;
    pdfData.invoiceDueDate = options.snapshot.invoice.invoiceDueDate;
  }
  const invoiceSnapshot: NonNullable<InvoiceRenderSnapshot["invoice"]> = {
    invoiceDate: pdfData.invoiceDate,
    invoiceDueDate: pdfData.invoiceDueDate ?? null,
  };

  // Task #593: Wenn ein Render-Snapshot vorliegt (Verifier-Re-Render-Pfad),
  // werden die Kunden-Stammfelder daraus gelesen statt aus der Live-Tabelle.
  // Damit reproduziert die Re-Render-XML auch dann byte-genau die persistierte
  // XML, wenn parallel der Kunde mutiert wurde (oder wenn eine spätere
  // Stammdaten-Änderung den Bestand nicht überschreiben darf — GoBD).
  let customerSnapshot: InvoiceRenderSnapshot["customer"];
  if (options?.snapshot) {
    customerSnapshot = options.snapshot.customer;
  } else {
    const customerForInv = await db.select({
      geburtsdatum: customersTable.geburtsdatum,
      beihilfeBerechtigt: customersTable.beihilfeBerechtigt,
      rechnungAnKunde: customersTable.rechnungAnKunde,
      name: customersTable.name,
      vorname: customersTable.vorname,
      nachname: customersTable.nachname,
      strasse: customersTable.strasse,
      nr: customersTable.nr,
      plz: customersTable.plz,
      stadt: customersTable.stadt,
    })
      .from(customersTable)
      .where(eq(customersTable.id, invoice.customerId))
      .limit(1);
    const row = customerForInv[0];
    customerSnapshot = {
      geburtsdatum: (row?.geburtsdatum as string | null) ?? null,
      beihilfeBerechtigt: row?.beihilfeBerechtigt ?? null,
      rechnungAnKunde: row?.rechnungAnKunde ?? null,
      name: row?.name ?? null,
      vorname: row?.vorname ?? null,
      nachname: row?.nachname ?? null,
      strasse: row?.strasse ?? null,
      nr: row?.nr ?? null,
      plz: row?.plz ?? null,
      stadt: row?.stadt ?? null,
    };
  }

  const isCustomerInvoice = invoice.billingType === "pflegekasse_privat"
    || (invoice.billingType === "pflegekasse_gesetzlich" && customerSnapshot.rechnungAnKunde === true);
  const isPflegekasseInvoice = invoice.billingType === "pflegekasse_privat"
    || invoice.billingType === "pflegekasse_gesetzlich";
  if (customerSnapshot.geburtsdatum) pdfData.customerGeburtsdatum = customerSnapshot.geburtsdatum;
  if (customerSnapshot.beihilfeBerechtigt) pdfData.beihilfeBerechtigt = true;
  if (invoice.billingType === "pflegekasse_gesetzlich" && customerSnapshot.rechnungAnKunde) {
    pdfData.rechnungAnKunde = true;
    const c = customerSnapshot;
    const fullName = [c.vorname, c.nachname].filter(Boolean).join(" ") || (c.name ?? "");
    const addr = [c.strasse, c.nr].filter(Boolean).join(" ") +
      (c.plz || c.stadt ? `\n${c.plz || ""} ${c.stadt || ""}` : "");
    pdfData.recipientName = fullName;
    pdfData.recipientAddress = addr || pdfData.recipientAddress;
  }

  // Task #1041 — LN-Adress-Korrektur über die EINZIGE Quelle (siehe
  // `applyLeistungsnachweisCustomerAddress`). Persist-/Cache-/Bundle-Pfad und
  // On-Demand-Versand-Pfad teilen sich dieselbe Funktion, damit gecachtes und
  // frisch gerendertes LN-PDF nicht wieder auseinanderdriften. Wir leiten die
  // LN-Adresse strikt aus dem customerSnapshot (Stammadresse) ab: live für
  // Entwürfe, eingefroren via renderSnapshot für versendete/stornierte
  // Rechnungen (GoBD-konform — der Verifier reproduziert dieselben Bytes).
  applyLeistungsnachweisCustomerAddress(pdfData, customerSnapshot);

  return { pdfData, isCustomerInvoice, isPflegekasseInvoice, customerSnapshot, invoiceSnapshot };
}

export async function buildInvoicePdfBytes(
  invoice: Invoice,
  companySettings: CompanySettings,
  options?: { snapshot?: InvoiceRenderSnapshot | null },
): Promise<{ pdf: Buffer; xml: string | null; leistungsnachweisPdf: Buffer | null; pdfDataFingerprint: string; leistungsnachweisDataFingerprint: string | null; customerSnapshot: InvoiceRenderSnapshot["customer"]; invoiceSnapshot: NonNullable<InvoiceRenderSnapshot["invoice"]> }> {
  const { pdfData, isCustomerInvoice, isPflegekasseInvoice, customerSnapshot, invoiceSnapshot } = await buildInvoicePdfData(invoice, companySettings, options);

  const { generateInvoiceHtml, generateLeistungsnachweisHtml, generatePdf, buildInvoiceFooterTemplate, buildLeistungsnachweisFooterTemplate } = await import("../lib/pdf-generator");
  const { embedZugferdXml } = await import("../lib/zugferd");

  const html = generateInvoiceHtml(pdfData);
  const { buffer } = await generatePdf(html, { footerHtml: buildInvoiceFooterTemplate(pdfData), margin: INVOICE_PDF_MARGIN });
  const { pdf: zugferdBuffer, xml: zugferdXml } = await embedZugferdXml(buffer, pdfData);
  // Task #522: Fingerprint VOR der LN-Signatur-Anreicherung erfassen — der
  // Invoice-Fingerprint deckt nur die Rechnungs-Inhalte ab.
  const pdfDataFingerprint = computeInvoicePdfFingerprint(pdfData);

  // Task #521: Standalone-LN-PDF wird für ALLE Pflegekassen-Rechnungen
  // mit-erzeugt, damit es analog zum Rechnungs-PDF in Object Storage
  // gecached werden kann (verhindert Re-Render bei jedem /leistungsnachweis-Abruf).
  let leistungsnachweisPdf: Buffer | null = null;
  let leistungsnachweisDataFingerprint: string | null = null;
  if (isPflegekasseInvoice) {
    await enrichPdfDataWithSignatures(pdfData, invoice);
    const lnHtml = generateLeistungsnachweisHtml(pdfData);
    const { buffer: lnPdfBuf } = await generatePdf(lnHtml, { footerHtml: buildLeistungsnachweisFooterTemplate(pdfData), margin: LEISTUNGSNACHWEIS_PDF_MARGIN });
    leistungsnachweisPdf = lnPdfBuf;
    leistungsnachweisDataFingerprint = computeLeistungsnachweisFingerprint(pdfData);
  }

  if (isCustomerInvoice && leistungsnachweisPdf) {
    const { PDFDocument } = await import("pdf-lib");
    const merged = await PDFDocument.create();
    const invoiceDoc = await PDFDocument.load(zugferdBuffer);
    const lnDoc = await PDFDocument.load(leistungsnachweisPdf);
    const ip = await merged.copyPages(invoiceDoc, invoiceDoc.getPageIndices());
    ip.forEach((p) => merged.addPage(p));
    const lp = await merged.copyPages(lnDoc, lnDoc.getPageIndices());
    lp.forEach((p) => merged.addPage(p));
    // Task #997 (#4): Die Beihilfe-Zweitausfertigung (zweite Rechnung + zweiter
    // LN für die Beihilfestelle) darf NICHT für Stornorechnungen erzeugt werden
    // — ein Storno hebt die Rechnung auf und braucht keine Zweitschrift; das
    // Duplizieren führte zu doppelten LN-Seiten auf Storno-Dokumenten.
    if (pdfData.beihilfeBerechtigt && pdfData.invoiceType !== "stornorechnung") {
      const ip2 = await merged.copyPages(invoiceDoc, invoiceDoc.getPageIndices());
      ip2.forEach((p) => merged.addPage(p));
      const lp2 = await merged.copyPages(lnDoc, lnDoc.getPageIndices());
      lp2.forEach((p) => merged.addPage(p));
    }
    return { pdf: Buffer.from(await merged.save()), xml: zugferdXml, leistungsnachweisPdf, pdfDataFingerprint, leistungsnachweisDataFingerprint, customerSnapshot, invoiceSnapshot };
  }
  return { pdf: zugferdBuffer, xml: zugferdXml, leistungsnachweisPdf, pdfDataFingerprint, leistungsnachweisDataFingerprint, customerSnapshot, invoiceSnapshot };
}

// Task #521: LN-only Render — wird verwendet, wenn das Rechnungs-PDF bereits
// rechtsverbindlich in Object Storage liegt (GoBD-Immutabilität!), aber der
// Leistungsnachweis-Cache noch fehlt (z.B. Bestandsrechnungen vor Task #521).
async function renderLeistungsnachweisOnly(invoice: Invoice, companySettings: CompanySettings): Promise<{ pdf: Buffer; fingerprint: string } | null> {
  // Task #1033 — Snapshot durchreichen, damit der LN-Backfill einer bereits
  // ausgestellten Rechnung die zum Ausstellungszeitpunkt gültigen Firmen-/
  // Kundenstammdaten einfriert statt der Live-Werte (GoBD).
  const snapshot = (invoice.renderSnapshot ?? null) as InvoiceRenderSnapshot | null;
  const { pdfData, isPflegekasseInvoice } = await buildInvoicePdfData(invoice, companySettings, { snapshot });
  if (!isPflegekasseInvoice) return null;
  const { generateLeistungsnachweisHtml, generatePdf, buildLeistungsnachweisFooterTemplate } = await import("../lib/pdf-generator");
  await enrichPdfDataWithSignatures(pdfData, invoice);
  const lnHtml = generateLeistungsnachweisHtml(pdfData);
  const { buffer: lnPdf } = await generatePdf(lnHtml, { footerHtml: buildLeistungsnachweisFooterTemplate(pdfData), margin: LEISTUNGSNACHWEIS_PDF_MARGIN });
  return { pdf: lnPdf, fingerprint: computeLeistungsnachweisFingerprint(pdfData) };
}

/**
 * Task #522: Berechnet die Live-Fingerprints (Rechnung + Leistungsnachweis)
 * aus den aktuellen Stamm-/Termin-/Unterschriftsdaten — UNABHÄNGIG vom
 * gespeicherten Cache. Wird zum Drift-Vergleich aufgerufen.
 */
export async function computeLiveInvoiceFingerprints(invoice: Invoice): Promise<{
  pdfFingerprint: string;
  leistungsnachweisFingerprint: string | null;
}> {
  const companySettings = await getCachedCompanySettings();
  if (!companySettings) {
    return { pdfFingerprint: "", leistungsnachweisFingerprint: null };
  }
  const { pdfData, isPflegekasseInvoice } = await buildInvoicePdfData(invoice, companySettings);
  const pdfFingerprint = computeInvoicePdfFingerprint(pdfData);
  let leistungsnachweisFingerprint: string | null = null;
  if (isPflegekasseInvoice) {
    await enrichPdfDataWithSignatures(pdfData, invoice);
    leistungsnachweisFingerprint = computeLeistungsnachweisFingerprint(pdfData);
  }
  return { pdfFingerprint, leistungsnachweisFingerprint };
}

/**
 * Task #521: persistInvoicePdf ist GoBD-sicher:
 *   - Wenn die Rechnung bereits ein `pdf_path` hat, wird das Rechnungs-PDF
 *     (und `pdf_hash`/`zugferd_xml`) NIE überschrieben — auch nicht durch
 *     Backfill oder Cache-Miss-Hooks. Es wird ausschließlich der fehlende
 *     Leistungsnachweis nachgereicht (für Pflegekassen-Rechnungen).
 *   - Wenn die Rechnung noch kein `pdf_path` hat (Erstanlage), wird der
 *     Voll-Build durchgeführt: Invoice-PDF + ZUGFeRD-XML + (bei Pflegekasse)
 *     LN-PDF werden gemeinsam erzeugt und gespeichert.
 *   - Wenn schon alles gecached ist (pflegekasse_privat: pdf+ln, selbstzahler:
 *     pdf), ist die Funktion ein No-op.
 */
// Task #552: Mutex pro Rechnungs-ID, damit parallele Send-/Mark-Sent-Klicks
// nicht zweimal gleichzeitig denselben PDF-Render starten. Concurrent-Aufrufer
// erhalten denselben in-flight-Promise zurück (de-duped). Der Eintrag wird
// nach Abschluss (auch im Fehlerfall) wieder entfernt, damit ein
// fehlgeschlagener Render erneut versucht werden kann.
const persistInvoicePdfInFlight = new Map<number, Promise<void>>();

/**
 * Task #593 (Security-Härtung): Beim Persistieren des `renderSnapshot` MUSS
 * `companySettings` strikt allowlist-gefiltert werden — der vollständige
 * `getCachedCompanySettings()`-Return enthält entschlüsselte Secrets
 * (smtpPass, letterxpressApiKey, qontoSecretKey, whatsappAccessToken,
 * twilioAuthToken, …). Würden wir das gesamte Objekt nach `invoices.render_snapshot`
 * (JSONB) schreiben, hätten wir pro Rechnung eine Plaintext-Replik aller
 * Credentials — schwerer DSGVO-/GoBD-Verstoss. Wir kopieren ausschliesslich
 * die Felder, die `buildPdfData`/ZUGFeRD-XML tatsächlich liest
 * (siehe `INVOICE_RENDER_COMPANY_SNAPSHOT_KEYS`).
 */
function sanitizeCompanySettingsForSnapshot(
  settings: CompanySettings,
): InvoiceRenderCompanySnapshot {
  const src = settings as unknown as Record<string, unknown>;
  const out = {} as Record<string, unknown>;
  for (const key of INVOICE_RENDER_COMPANY_SNAPSHOT_KEYS) {
    const raw = src[key];
    out[key] = raw == null ? null : raw;
  }
  return out as unknown as InvoiceRenderCompanySnapshot;
}

export function persistInvoicePdf(invoiceId: number): Promise<void> {
  const existing = persistInvoicePdfInFlight.get(invoiceId);
  if (existing) return existing;
  const p = persistInvoicePdfInner(invoiceId).finally(() => {
    persistInvoicePdfInFlight.delete(invoiceId);
  });
  persistInvoicePdfInFlight.set(invoiceId, p);
  return p;
}

async function persistInvoicePdfInner(invoiceId: number): Promise<void> {
  const invoice = await storage.getInvoice(invoiceId);
  if (!invoice) return;
  const companySettings = await getCachedCompanySettings();
  if (!companySettings) return;

  const isPflegekasseInvoice = invoice.billingType === "pflegekasse_privat"
    || invoice.billingType === "pflegekasse_gesetzlich";
  const needsInvoicePdf = !invoice.pdfPath;
  const needsLeistungsnachweis = isPflegekasseInvoice && !invoice.leistungsnachweisPath;
  if (!needsInvoicePdf && !needsLeistungsnachweis) return;

  const safeNumber = invoice.invoiceNumber.replace(/[^a-z0-9_-]/gi, "_");
  const updateData: {
    pdfPath?: string;
    pdfHash?: string;
    pdfDataFingerprint?: string;
    zugferdXml?: string;
    renderSnapshot?: InvoiceRenderSnapshot;
    leistungsnachweisPath?: string;
    leistungsnachweisHash?: string;
    leistungsnachweisDataFingerprint?: string;
  } = {};

  if (needsInvoicePdf) {
    // Voll-Build (Erstanlage): Invoice + XML + optional LN.
    const { pdf: pdfBytes, xml: zugferdXml, leistungsnachweisPdf, pdfDataFingerprint, leistungsnachweisDataFingerprint, customerSnapshot, invoiceSnapshot } =
      await buildInvoicePdfBytes(invoice, companySettings);
    const pdfHash = computeDataHash(pdfBytes as unknown as string);
    const fileName = buildInvoicePdfObjectKey(safeNumber);
    assertInvoicePdfWriteKeyAllowed(fileName);
    const fullPath = `${getPrivateDir()}/${fileName}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    await objectStorageClient.bucket(bucketName).file(objectName).save(pdfBytes, {
      contentType: "application/pdf",
      metadata: { invoiceNumber: invoice.invoiceNumber, pdfHash },
    });
    updateData.pdfPath = `/objects/${fileName}`;
    updateData.pdfHash = pdfHash;
    updateData.pdfDataFingerprint = pdfDataFingerprint;
    // Tier-A3: ZUGFeRD-XML nur beim ersten Schreiben (GoBD-Immutabilität).
    if (zugferdXml && !invoice.zugferdXml) updateData.zugferdXml = zugferdXml;
    // Task #593: Render-Snapshot zusammen mit der erstmaligen XML-/PDF-
    // Persistierung schreiben. Idempotent: nur setzen, wenn die Rechnung
    // noch keinen Snapshot hat — historische Bestände bleiben unangetastet.
    if (!invoice.renderSnapshot) {
      updateData.renderSnapshot = {
        companySettings: sanitizeCompanySettingsForSnapshot(companySettings),
        customer: customerSnapshot,
        // Task #654: friert das Anzeige-Datum (de-DE) und das Fälligkeits-
        // datum ein, das beim Erst-Persist tatsächlich in `buildPdfData`
        // einging — sonst driftet `invoiceDate` beim Re-Render gegen das
        // bereits in `zugferd_xml` versiegelte XML, sobald `sentAt`
        // nachträglich gesetzt wird oder sich `todayISO()` ändert.
        invoice: invoiceSnapshot,
      };
    }
    if (leistungsnachweisPdf && needsLeistungsnachweis) {
      const lnHash = computeDataHash(leistungsnachweisPdf as unknown as string);
      const lnFileName = buildInvoicePdfObjectKey(safeNumber, { leistungsnachweis: true });
      assertInvoicePdfWriteKeyAllowed(lnFileName);
      const lnFullPath = `${getPrivateDir()}/${lnFileName}`;
      const { bucketName: lnBucket, objectName: lnObj } = parseObjectPath(lnFullPath);
      await objectStorageClient.bucket(lnBucket).file(lnObj).save(leistungsnachweisPdf, {
        contentType: "application/pdf",
        metadata: { invoiceNumber: invoice.invoiceNumber, leistungsnachweisHash: lnHash },
      });
      updateData.leistungsnachweisPath = `/objects/${lnFileName}`;
      updateData.leistungsnachweisHash = lnHash;
      if (leistungsnachweisDataFingerprint) {
        updateData.leistungsnachweisDataFingerprint = leistungsnachweisDataFingerprint;
      }
    }
  } else if (needsLeistungsnachweis) {
    // GoBD-sicher: Invoice-PDF bleibt unangetastet, nur LN-PDF wird erzeugt.
    const ln = await renderLeistungsnachweisOnly(invoice, companySettings);
    if (ln) {
      const lnHash = computeDataHash(ln.pdf as unknown as string);
      const lnFileName = buildInvoicePdfObjectKey(safeNumber, { leistungsnachweis: true });
      assertInvoicePdfWriteKeyAllowed(lnFileName);
      const lnFullPath = `${getPrivateDir()}/${lnFileName}`;
      const { bucketName: lnBucket, objectName: lnObj } = parseObjectPath(lnFullPath);
      await objectStorageClient.bucket(lnBucket).file(lnObj).save(ln.pdf, {
        contentType: "application/pdf",
        metadata: { invoiceNumber: invoice.invoiceNumber, leistungsnachweisHash: lnHash },
      });
      updateData.leistungsnachweisPath = `/objects/${lnFileName}`;
      updateData.leistungsnachweisHash = lnHash;
      updateData.leistungsnachweisDataFingerprint = ln.fingerprint;
    }
  }

  if (Object.keys(updateData).length === 0) return;
  await db.update(invoicesTable)
    .set(updateData)
    .where(eq(invoicesTable.id, invoiceId));
}

export async function loadInvoicePdfFromStorage(invoice: Invoice): Promise<Buffer | null> {
  return loadStoredPdfByPath(invoice.pdfPath);
}

export async function loadLeistungsnachweisPdfFromStorage(invoice: Invoice): Promise<Buffer | null> {
  return loadStoredPdfByPath(invoice.leistungsnachweisPath ?? null);
}

/**
 * Task #1039 — Liefert true, wenn das gespeicherte Rechnungs-PDF (`pdfPath`)
 * den Leistungsnachweis bereits einmontiert enthält. Das ist genau dann der
 * Fall, wenn die Rechnung kundenadressiert ist (`pflegekasse_privat` oder
 * `pflegekasse_gesetzlich` mit `rechnungAnKunde`/Beihilfe) — dann mergt
 * `buildInvoicePdfBytes` Rechnung + LN (bei Beihilfe Rechnung + LN + Rechnung
 * + LN) in das persistierte PDF.
 *
 * Gesetzliche Kassen-Rechnungen (ohne Kostenerstattung) und Selbstzahler
 * enthalten den LN NICHT im Rechnungs-PDF.
 */
export async function storedInvoicePdfContainsLeistungsnachweis(invoice: Invoice): Promise<boolean> {
  if (invoice.billingType === "pflegekasse_privat") return true;
  if (invoice.billingType === "pflegekasse_gesetzlich") {
    const rows = await db
      .select({ rechnungAnKunde: customersTable.rechnungAnKunde })
      .from(customersTable)
      .where(eq(customersTable.id, invoice.customerId))
      .limit(1);
    return rows[0]?.rechnungAnKunde === true;
  }
  return false;
}

/**
 * Task #1039 — Einzige Quelle der Wahrheit für die Bündel-/Sammeldruck-
 * Endpoints: Soll der separat gecachte Standalone-Leistungsnachweis zusätzlich
 * an das Rechnungs-PDF angehängt werden? Antwort = nur dann, wenn das
 * Rechnungs-PDF ihn nicht bereits enthält (sonst doppelter LN, RE-2026-0034).
 */
export async function shouldAppendStandaloneLeistungsnachweis(invoice: Invoice): Promise<boolean> {
  return !(await storedInvoicePdfContainsLeistungsnachweis(invoice));
}

/**
 * Task #552: Lädt für den Versand-Pfad die standalone Rechnungs- und LN-PDF-
 * Bytes. Reihenfolge:
 *   1. Cache-Hit: `pdfPath` (standalone zugferd-Invoice) + `leistungsnachweisPath`
 *      (standalone LN).
 *   2. Cache-Miss: Fehlende Teile werden on-demand gerendert und der
 *      Hintergrund-Persist (mit Mutex) angestoßen, damit der nächste Send
 *      wieder aus dem Cache liest.
 *
 * Wichtig: Für Kunden-Rechnungen (rechnungAnKunde / Beihilfe) enthält
 * `pdfPath` die GoBD-versiegelte, gemergte Rechnung+LN-Variante — die ist
 * für den Download (`/:id/pdf`) gedacht, NICHT für den Email-Versand, der
 * Rechnung und LN als separate Anhänge verschickt. Deshalb wird der
 * Invoice-Cache-Hit hier nur akzeptiert, wenn die Rechnung NICHT an den
 * Kunden adressiert ist (Standard-Pflegekassen-Versand). Beihilfe-/
 * Kostenerstattungs-Duplizierung erfolgt im Aufrufer auf den standalone
 * Buffers.
 */
export async function loadOrRenderSendablePdfs(
  invoice: Invoice,
  pdfData: InvoicePdfData,
  opts: { isCustomerInvoice: boolean; strictZugferd?: boolean; testFaults?: Set<string> },
): Promise<{ invoicePdf: Buffer; lnPdf: Buffer; cachedInvoice: boolean; cachedLn: boolean }> {
  const startedAt = Date.now();
  let invoicePdf: Buffer | null = null;
  if (!opts.isCustomerInvoice) {
    invoicePdf = await loadInvoicePdfFromStorage(invoice);
  }
  let lnPdf: Buffer | null = await loadLeistungsnachweisPdfFromStorage(invoice);
  const cachedInvoice = invoicePdf !== null;
  const cachedLn = lnPdf !== null;

  if (!invoicePdf || !lnPdf) {
    const { generateInvoiceHtml, generateLeistungsnachweisHtml, generatePdf, buildInvoiceFooterTemplate, buildLeistungsnachweisFooterTemplate } = await import("../lib/pdf-generator");
    if (!invoicePdf) {
      // Task #553: Im Send-Pfad MUSS Strict-Mode aktiv sein, damit ein
      // Embedding-Failure als typisierter `ZugferdEmbedError` propagiert
      // wird statt still ein nicht-konformes PDF zurückzuliefern.
      const { embedZugferdXml } = await import("../lib/zugferd");
      const invoiceHtml = generateInvoiceHtml(pdfData);
      const { buffer: rendered } = await generatePdf(invoiceHtml, { footerHtml: buildInvoiceFooterTemplate(pdfData), margin: INVOICE_PDF_MARGIN });
      const { pdf: zugferdBuffer } = await embedZugferdXml(rendered, pdfData, { strict: opts.strictZugferd === true, testFaults: opts.testFaults });
      invoicePdf = zugferdBuffer;
    }
    if (!lnPdf) {
      const lnHtml = generateLeistungsnachweisHtml(pdfData);
      const { buffer: rendered } = await generatePdf(lnHtml, { footerHtml: buildLeistungsnachweisFooterTemplate(pdfData), margin: LEISTUNGSNACHWEIS_PDF_MARGIN });
      lnPdf = rendered;
    }
    // Hintergrund-Persist (Mutex-serialisiert): beim nächsten Send hoffentlich
    // Cache-Hit. Fehler nicht eskalieren — der Send-Flow läuft mit den
    // gerade gerenderten Bytes weiter.
    schedulePdfPersistInBackground(invoice.id);
  }

  const durationMs = Date.now() - startedAt;
  recordPdfCacheSend({
    invoiceId: invoice.id,
    cachedInvoice,
    cachedLn,
    isCustomerInvoice: opts.isCustomerInvoice,
    durationMs,
    at: Date.now(),
  });
  console.log(
    `[billing/pdf-cache] invoice=${invoice.id} isCustomerInvoice=${opts.isCustomerInvoice} cachedInvoice=${cachedInvoice} cachedLeistungsnachweis=${cachedLn} durationMs=${durationMs}`,
  );

  return { invoicePdf, lnPdf, cachedInvoice, cachedLn };
}

async function loadStoredPdfByPath(pdfPath: string | null): Promise<Buffer | null> {
  if (!pdfPath) return null;
  let entityId = pdfPath;
  if (entityId.startsWith("/objects/")) entityId = entityId.slice("/objects/".length);
  let entityDir = getPrivateDir();
  if (!entityDir.endsWith("/")) entityDir = `${entityDir}/`;
  const fullPath = `${entityDir}${entityId}`;
  const { bucketName, objectName } = parseObjectPath(fullPath);
  const file = objectStorageClient.bucket(bucketName).file(objectName);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [contents] = await file.download();
  return Buffer.from(contents);
}

export async function renderLeistungsnachweisOnTheFly(invoice: Invoice): Promise<Buffer> {
  const lineItems = await storage.getInvoiceLineItems(invoice.id);
  const liveCompanySettings = await getCachedCompanySettings();
  const { generateLeistungsnachweisHtml, generatePdf, buildLeistungsnachweisFooterTemplate } = await import("../lib/pdf-generator");

  // Task #1033 — Firmenstammdaten einfrieren (siehe buildInvoicePdfData): für
  // versendete/stornierte Rechnungen mit Render-Snapshot werden die Company-
  // Felder aus dem Snapshot statt der Live-Tabelle gelesen.
  const snapshot = (invoice.renderSnapshot ?? null) as InvoiceRenderSnapshot | null;
  const companySettings = snapshot?.companySettings && liveCompanySettings
    ? { ...liveCompanySettings, ...snapshot.companySettings }
    : liveCompanySettings;

  const pdfData = buildPdfData(invoice, lineItems, companySettings);

  const customerForLN = await db.select({
    geburtsdatum: customersTable.geburtsdatum,
    rechnungAnKunde: customersTable.rechnungAnKunde,
  })
    .from(customersTable)
    .where(eq(customersTable.id, invoice.customerId))
    .limit(1);
  if (customerForLN.length > 0) {
    if (customerForLN[0].geburtsdatum) pdfData.customerGeburtsdatum = customerForLN[0].geburtsdatum;
    if (invoice.billingType === "pflegekasse_gesetzlich" && customerForLN[0].rechnungAnKunde) {
      pdfData.rechnungAnKunde = true;
    }
  }

  await enrichPdfDataWithSignatures(pdfData, invoice);

  const html = generateLeistungsnachweisHtml(pdfData);
  const { buffer } = await generatePdf(html, { footerHtml: buildLeistungsnachweisFooterTemplate(pdfData), margin: LEISTUNGSNACHWEIS_PDF_MARGIN });
  return buffer;
}
