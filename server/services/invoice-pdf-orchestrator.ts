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
  import { DEFAULT_ZUGFERD_PROFILE, type ZugferdProfileId } from "../lib/zugferd";
  import { computeDataHash } from "./signature-integrity";
  import { objectStorageClient } from "../replit_integrations/object_storage/objectStorage";
  import { parseObjectPath, getPrivateDir, buildInvoicePdfObjectKey, assertInvoicePdfWriteKeyAllowed, isObjectStorageConfigured } from "../lib/object-storage-helpers";
  import { eq, and, inArray, sql } from "drizzle-orm";
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
  import { normalizePdfDeterminism } from "../lib/pdf-determinism";

  // Task #995 — Effektive Seitenränder pro Dokumenttyp. Das HTML setzt
  // `@page{margin:0}`; die Ränder (inkl. reserviertem Bottom-Margin für den
  // wiederholten Puppeteer-Footer) kommen hier über page.pdf({margin}).
  // Task #1064 — Werte leben jetzt als SSoT in `shared/domain/document-page-geometry.ts`,
  // damit die On-Screen-Vorschau (Client) und das PDF (Server) dieselben Ränder
  // verwenden und nicht auseinanderdriften können.
  import { INVOICE_PDF_MARGIN, LEISTUNGSNACHWEIS_PDF_MARGIN } from "@shared/domain/document-page-geometry";

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
  // Ohne Object Storage (z.B. GitHub-Actions-CI ohne Sidecar) gibt es kein Ziel
  // für das PDF. Das Hintergrund-Persistieren würde nur eine DB-Transaktion +
  // Puppeteer-Render starten, an der Bucket-Anbindung scheitern und mit 3×30s-
  // Retries den Connection-Pool leersaugen — und damit unbeteiligte Requests
  // (Session-Validierung, Kundenanlage) in 15s-Connect-Timeouts laufen lassen.
  if (!isObjectStorageConfigured()) return;
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

  // Task #1083 — Positions-Aggregationsmodus. Liegt ein Snapshot vor (Re-Render
  // einer versiegelten Rechnung: Integritäts-Verifier / Self-Heal / Send-Cache-
  // Miss), wird der damals versiegelte Modus reproduziert: explizit gesetztes
  // `snapshot.lineAggregation`, sonst `"per_appointment"` für Bestände, die VOR
  // der Kumulierung versiegelt wurden (byte-stabile PDF-/XML-Reproduktion).
  // Ohne Snapshot (Erst-Persist / Draft-Vorschau) wird kumuliert gerendert und
  // über `persistInvoicePdfInner` als `"cumulative"` im Snapshot versiegelt.
  pdfData.lineAggregation = options?.snapshot
    ? (options.snapshot.lineAggregation ?? "per_appointment")
    : "cumulative";

  // Task #1098 — Pro-Zeilen-Betrag (BT-131, `LineTotalAmount`) im ZUGFeRD-XML.
  // Liegt ein Snapshot vor (Re-Render einer versiegelten Rechnung), wird der
  // damals versiegelte Zustand reproduziert: nur Rechnungen mit
  // `snapshot.includeLineTotalAmount === true` re-rendern MIT BT-131; Bestände
  // ohne dieses Flag bleiben OHNE BT-131 (byte-stabile XML-Reproduktion). Ohne
  // Snapshot (Erst-Persist / Draft-Vorschau) wird BT-131 emittiert und über
  // `persistInvoicePdfInner` als `true` im Snapshot versiegelt.
  pdfData.includeLineTotalAmount = options?.snapshot
    ? options.snapshot.includeLineTotalAmount === true
    : true;

  // Task #1105 — Korrekte Header-Settlement-Aufschlüsselung (BG-16/BG-23) im
  // eingebetteten ZUGFeRD-XML. Liegt ein Snapshot vor (Re-Render), wird der
  // versiegelte Zustand reproduziert: nur Rechnungen mit
  // `snapshot.strictSettlement === true` re-rendern MIT der korrekten
  // Aufschlüsselung; Bestände ohne dieses Flag bleiben OHNE (byte-stabile
  // XML-Reproduktion gegen `invoices.zugferd_xml`). Ohne Snapshot
  // (Erst-Persist / Draft-Vorschau) wird die korrekte Aufschlüsselung emittiert
  // und über `persistInvoicePdfInner` als `true` im Snapshot versiegelt.
  pdfData.strictSettlement = options?.snapshot
    ? options.snapshot.strictSettlement === true
    : true;

  // Task #1106 — XMP-Namespace-Reparatur (PDF/A-3b). Orthogonal zu
  // `strictSettlement` (XML-Header): nur Rechnungen mit
  // `snapshot.includeConformantSettlement === true` re-rendern mit repariertem
  // XMP; Bestände ohne das Flag behalten das fehlerhafte Original-XMP
  // (byte-stabile PDF-Reproduktion gegen `pdf_hash`). Ohne Snapshot
  // (Erst-Persist / Draft-Vorschau) wird repariert und über
  // `persistInvoicePdfInner` als `true` im Snapshot versiegelt.
  pdfData.includeConformantSettlement = options?.snapshot
    ? options.snapshot.includeConformantSettlement === true
    : true;

  // Task #593: Wenn ein Render-Snapshot vorliegt (Verifier-Re-Render-Pfad),
  // werden die Kunden-Stammfelder daraus gelesen statt aus der Live-Tabelle.
  // Damit reproduziert die Re-Render-XML auch dann byte-genau die persistierte
  // XML, wenn parallel der Kunde mutiert wurde (oder wenn eine spätere
  // Stammdaten-Änderung den Bestand nicht überschreiben darf — GoBD).
  let customerSnapshot: InvoiceRenderSnapshot["customer"];
  if (options?.snapshot) {
    customerSnapshot = options.snapshot.customer;
    // Task #1074 — Re-Render baut den Kundennamen KONSEQUENT aus dem Snapshot
    // (GoBD-eingefroren), unabhängig davon, wie `invoice` geladen wurde. Der
    // Snapshot-Name == versiegelter Wert ⇒ byte-stabil; spätere Namens-
    // änderungen am Kunden erzeugen keine falsch-positive Drift mehr.
    if (customerSnapshot.name) pdfData.customerName = customerSnapshot.name;
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
): Promise<{ pdf: Buffer; xml: string | null; leistungsnachweisPdf: Buffer | null; pdfDataFingerprint: string; leistungsnachweisDataFingerprint: string | null; customerSnapshot: InvoiceRenderSnapshot["customer"]; invoiceSnapshot: NonNullable<InvoiceRenderSnapshot["invoice"]>; pdfCreationDate: string; zugferdProfile: ZugferdProfileId; usedStrictMode: boolean; strictModeReason: string | null }> {
  const { pdfData, isCustomerInvoice, isPflegekasseInvoice, customerSnapshot, invoiceSnapshot } = await buildInvoicePdfData(invoice, companySettings, options);

  // Task #1073 — ZUGFeRD-Profil pro Rechnung einfrieren (GoBD-Byte-Determinismus).
  // Liegt ein Snapshot vor (Re-Render: Integritäts-Verifier / Self-Heal / Send-
  // Cache-Miss einer bereits versiegelten Rechnung), wird das damals versiegelte
  // Profil reproduziert: explizit gesetztes `snapshot.profile`, sonst `"basic"`
  // für Bestände, die VOR der EN-16931-Umstellung versiegelt wurden. Ohne
  // Snapshot (Erst-Persist / Draft-Vorschau) wird das aktuelle Default-Profil
  // (EN 16931) verwendet und über `persistInvoicePdfInner` im Snapshot versiegelt.
  const zugferdProfile: ZugferdProfileId = options?.snapshot
    ? (options.snapshot.profile ?? "basic")
    : DEFAULT_ZUGFERD_PROFILE;

  // Task #1047 — eingefrorener Erzeugungszeitpunkt. Liegt ein Snapshot mit
  // `pdfCreationDate` vor (Re-Render-Pfad: Integritäts-Verifier / Clobbered-PDF-
  // Restore), wird exakt dieser Wert wiederverwendet, sonst beim Erst-Persist
  // EINMAL erzeugt und über `persistInvoicePdfInner` im Snapshot versiegelt.
  // Beide Render-Artefakte (Rechnung + LN) teilen denselben Wert, damit sie
  // gemeinsam byte-genau reproduzierbar sind. `idSeed` = Rechnungsnummer macht
  // die XRef-Stream-`/ID` deterministisch.
  const pdfCreationDate = options?.snapshot?.pdfCreationDate ?? new Date().toISOString();
  const detOpts = { creationDate: pdfCreationDate, idSeed: invoice.invoiceNumber };

  const { generateInvoiceHtml, generateLeistungsnachweisHtml, generatePdf, buildInvoiceFooterTemplate, buildLeistungsnachweisFooterTemplate } = await import("../lib/pdf-generator");
  const { embedZugferdXml } = await import("../lib/zugferd");

  const html = generateInvoiceHtml(pdfData);
  const { buffer } = await generatePdf(html, { footerHtml: buildInvoiceFooterTemplate(pdfData), margin: INVOICE_PDF_MARGIN });
  const { pdf: zugferdRaw, xml: zugferdXml, usedStrictMode, strictModeReason } = await embedZugferdXml(buffer, pdfData, { creationDate: pdfCreationDate, profile: zugferdProfile });
  // Task #1047 — finale Metadaten-Normalisierung (XMP-Zeitstempel + Datei-/ID).
  const zugferdBuffer = normalizePdfDeterminism(zugferdRaw, detOpts);
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
    // Task #1047 — LN-PDF (reines Chromium-PDF) ebenfalls deterministisch machen.
    leistungsnachweisPdf = normalizePdfDeterminism(lnPdfBuf, detOpts);
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
    // Task #1052 — pdf-lib stempelt beim `save()` einer FRISCH erzeugten
    // PDFDocument die Info-`/CreationDate` und `/ModDate` mit der Wall-Clock
    // (`new Date()`). Bei Default-`useObjectStreams` landen diese Tokens
    // KOMPRIMIERT im Object-Stream und sind damit für `normalizePdfDeterminism`
    // (reine Plaintext-Regex) unsichtbar — das Merge-PDF driftete daher byte-weise
    // von Render zu Render und reproduzierte den versiegelten `pdf_hash` nicht.
    // Fix: dieselbe eingefrorene `pdfCreationDate` wie alle übrigen Render-
    // Artefakte in die Info-Daten schreiben, damit der Merge byte-genau
    // reproduzierbar ist (die kopierten Seiten selbst tragen keine eigenen
    // Zeitstempel, die Info-Daten sind die einzige Drift-Quelle).
    const frozenMergeDate = new Date(pdfCreationDate);
    merged.setCreationDate(frozenMergeDate);
    merged.setModificationDate(frozenMergeDate);
    return { pdf: Buffer.from(await merged.save()), xml: zugferdXml, leistungsnachweisPdf, pdfDataFingerprint, leistungsnachweisDataFingerprint, customerSnapshot, invoiceSnapshot, pdfCreationDate, zugferdProfile, usedStrictMode, strictModeReason };
  }
  return { pdf: zugferdBuffer, xml: zugferdXml, leistungsnachweisPdf, pdfDataFingerprint, leistungsnachweisDataFingerprint, customerSnapshot, invoiceSnapshot, pdfCreationDate, zugferdProfile, usedStrictMode, strictModeReason };
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
  // Task #1047 — auch der LN-only-Backfill wird deterministisch normalisiert.
  // Liegt der eingefrorene Erzeugungszeitpunkt im Snapshot vor (Rechnungen ab
  // #1047), reproduziert das Re-Render byte-genau; ältere Bestände ohne
  // `pdfCreationDate` bekommen einen frischen Zeitpunkt (nicht byte-stabil,
  // akzeptiert — siehe Task-Beschreibung).
  const lnCreationDate = snapshot?.pdfCreationDate ?? new Date().toISOString();
  const normalizedLn = normalizePdfDeterminism(lnPdf, { creationDate: lnCreationDate, idSeed: invoice.invoiceNumber });
  return { pdf: normalizedLn, fingerprint: computeLeistungsnachweisFingerprint(pdfData) };
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
  // SSoT-Kurzschluss (auch für die synchronen GET-/pdf/-Aufrufer): Ohne
  // konfiguriertes Object Storage kann kein PDF persistiert werden — kein
  // Render, keine offene Transaktion, kein Pool-Druck. Lokal/Replit/Prod ist
  // der Bucket immer gesetzt, also ein No-op nur in der CI ohne Sidecar.
  if (!isObjectStorageConfigured()) return Promise.resolve();
  const existing = persistInvoicePdfInFlight.get(invoiceId);
  if (existing) return existing;
  const p = persistInvoicePdfInner(invoiceId).finally(() => {
    persistInvoicePdfInFlight.delete(invoiceId);
  });
  persistInvoicePdfInFlight.set(invoiceId, p);
  return p;
}

async function persistInvoicePdfInner(invoiceId: number): Promise<void> {
  // Task #1074 — Mehr-Instanz-Rennschutz: Ein DB-seitiger Advisory-Lock auf die
  // Rechnungs-ID serialisiert Lock + Re-Check + Render + Write über ALLE
  // Server-Instanzen hinweg (der in-process-Mutex `persistInvoicePdfInFlight`
  // schützt nur EINEN Prozess). Der xact-Lock wird bei Commit/Rollback
  // automatisch freigegeben. Nach Lock-Erwerb wird die Rechnung FRISCH gelesen:
  // Hat eine andere Instanz inzwischen persistiert (`pdfPath` gesetzt), ist der
  // Re-Check ein No-op — kein Doppel-Render, kein Hash-/Blob-Auseinanderlaufen.
  await db.transaction(async (tx) => {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`invoice_pdf_${invoiceId}`})::int8)`);
  const invoice = await storage.getInvoice(invoiceId);
  if (!invoice) return;
  const companySettings = await getCachedCompanySettings();
  if (!companySettings) return;

  const isPflegekasseInvoice = invoice.billingType === "pflegekasse_privat"
    || invoice.billingType === "pflegekasse_gesetzlich";

  // Task #1066 — Self-Heal: Ein bereits gesetzter Pfad, dessen Object-Storage-
  // Objekt fehlt (z.B. nach der Legacy-Key-Space-Migration oder einem gelöschten
  // Bucket-Objekt), wird wie ein fehlendes Artefakt behandelt und aus dem
  // eingefrorenen Render-Snapshot neu gerendert. Für Rechnungen ab #1047 ist das
  // byte-genau reproduzierbar; ältere Bestände bekommen einen frischen
  // Erzeugungszeitpunkt — die geänderte Versiegelung wird dann per Audit-Log
  // dokumentiert (NIEMALS still).
  const invoicePdfObjectMissing = await storedObjectIsMissing(invoice.pdfPath);
  const lnObjectMissing = isPflegekasseInvoice
    && await storedObjectIsMissing(invoice.leistungsnachweisPath ?? null);

  const needsInvoicePdf = !invoice.pdfPath || invoicePdfObjectMissing;
  const needsLeistungsnachweis = isPflegekasseInvoice
    && (!invoice.leistungsnachweisPath || lnObjectMissing);
  if (!needsInvoicePdf && !needsLeistungsnachweis) return;

  // Recovery = ein bereits versiegelter Pfad zeigt ins Leere (Self-Heal), im
  // Gegensatz zur Erstanlage (Pfad noch nie gesetzt).
  const isInvoiceRecovery = !!invoice.pdfPath && invoicePdfObjectMissing;
  const isLnRecovery = !!invoice.leistungsnachweisPath && lnObjectMissing;

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
    // Voll-Build: Invoice + XML + optional LN. Bei Recovery (Self-Heal) wird der
    // eingefrorene Render-Snapshot durchgereicht, damit das Re-Render die
    // versiegelten Bytes byte-genau reproduziert (Rechnungen ab #1047). Bei der
    // Erstanlage ist `renderSnapshot` null → Live-Render wie bisher.
    const { pdf: pdfBytes, xml: zugferdXml, leistungsnachweisPdf, pdfDataFingerprint, leistungsnachweisDataFingerprint, customerSnapshot, invoiceSnapshot, pdfCreationDate, zugferdProfile, usedStrictMode, strictModeReason } =
      await buildInvoicePdfBytes(invoice, companySettings, { snapshot: (invoice.renderSnapshot ?? null) as InvoiceRenderSnapshot | null });
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
    if (isInvoiceRecovery) {
      // Self-Heal eines bereits versiegelten PDFs: den `pdf_hash` nur dann
      // ändern, wenn die neu gerenderten Bytes tatsächlich abweichen (Pre-#1047-
      // Bestand ohne eingefrorenen Erzeugungszeitpunkt). Die geänderte
      // Versiegelung wird per Audit-Log dokumentiert — niemals still. Der
      // Inhalts-Fingerprint bleibt unangetastet (bereits versiegelt).
      if (invoice.pdfHash && invoice.pdfHash !== pdfHash) {
        updateData.pdfHash = pdfHash;
        await logPdfReseal(invoice, "invoice", invoice.pdfHash, pdfHash);
      } else if (!invoice.pdfHash) {
        updateData.pdfHash = pdfHash;
      }
    } else {
      updateData.pdfHash = pdfHash;
      updateData.pdfDataFingerprint = pdfDataFingerprint;
    }
    // Tier-A3: ZUGFeRD-XML nur beim ersten Schreiben (GoBD-Immutabilität).
    if (zugferdXml && !invoice.zugferdXml) {
      updateData.zugferdXml = zugferdXml;
      // Task #1073 — Non-Strict-Versiegelung dokumentieren statt still
      // schlucken. node-zugferd konnte die XSD-Strict-Validierung nicht
      // ausführen (fehlende `xsd-schema-validator`/Java-Runtime) ODER das XML
      // bestand sie nicht; in beiden Fällen wurde die XML im Non-Strict-Pfad
      // versiegelt. Die rechtsverbindliche EN-16931-/PDF-A-3-Konformitätsprüfung
      // übernimmt das externe Validierungs-Gate (`scripts/validate-erechnung.ts`
      // / CI). Wir hard-rejecten hier bewusst NICHT, da das den gesamten
      // Rechnungslauf in Umgebungen ohne Java-Runtime blockieren würde.
      if (!usedStrictMode) {
        await logZugferdNonStrictSeal(invoice, zugferdProfile, strictModeReason);
      }
    }
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
        // Task #1047: eingefrorener PDF-Erzeugungszeitpunkt — ermöglicht das
        // byte-genaue Re-Render (Integritäts-Verifier / Clobbered-PDF-Restore).
        pdfCreationDate,
        // Task #1073: eingefrorenes ZUGFeRD-Profil — das Re-Render reproduziert
        // das eingebettete XML mit exakt diesem Profil (byte-genau).
        profile: zugferdProfile,
        // Task #1083: eingefrorener Positions-Aggregationsmodus. Neu erzeugte
        // Rechnungen werden kumuliert versiegelt; das Re-Render reproduziert
        // PDF + ZUGFeRD-XML byte-genau (Integritäts-Verifier).
        lineAggregation: "cumulative",
        // Task #1098: eingefrorenes BT-131-Flag. Neu erzeugte Rechnungen werden
        // MIT Pro-Zeilen-Betrag (`LineTotalAmount`) versiegelt; das Re-Render
        // reproduziert das eingebettete EN-16931-XML byte-genau.
        includeLineTotalAmount: true,
        // Task #1105: eingefrorenes Settlement-Flag. Neu erzeugte Rechnungen
        // werden mit der korrekten Header-USt-/Zahlungs-Aufschlüsselung (BG-16/
        // BG-23) versiegelt (XSD-strict-konform); das Re-Render reproduziert das
        // eingebettete EN-16931-XML byte-genau.
        strictSettlement: true,
        // Task #1106: eingefrorenes XMP-Reparatur-Flag (PDF/A-3b). Neu erzeugte
        // Rechnungen werden mit repariertem XMP-Namespace versiegelt; das
        // Re-Render reproduziert das PDF byte-genau.
        includeConformantSettlement: true,
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
      if (isLnRecovery) {
        if (invoice.leistungsnachweisHash && invoice.leistungsnachweisHash !== lnHash) {
          updateData.leistungsnachweisHash = lnHash;
          await logPdfReseal(invoice, "leistungsnachweis", invoice.leistungsnachweisHash, lnHash);
        } else if (!invoice.leistungsnachweisHash) {
          updateData.leistungsnachweisHash = lnHash;
        }
      } else {
        updateData.leistungsnachweisHash = lnHash;
        if (leistungsnachweisDataFingerprint) {
          updateData.leistungsnachweisDataFingerprint = leistungsnachweisDataFingerprint;
        }
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
      if (isLnRecovery) {
        if (invoice.leistungsnachweisHash && invoice.leistungsnachweisHash !== lnHash) {
          updateData.leistungsnachweisHash = lnHash;
          await logPdfReseal(invoice, "leistungsnachweis", invoice.leistungsnachweisHash, lnHash);
        } else if (!invoice.leistungsnachweisHash) {
          updateData.leistungsnachweisHash = lnHash;
        }
      } else {
        updateData.leistungsnachweisHash = lnHash;
        updateData.leistungsnachweisDataFingerprint = ln.fingerprint;
      }
    }
  }

  if (Object.keys(updateData).length === 0) return;
  await tx.update(invoicesTable)
    .set(updateData)
    .where(eq(invoicesTable.id, invoiceId));
  });
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
      // Task #1073 — den On-Demand-Send-Render mit dem versiegelten Profil
      // erzeugen, damit das eingebettete XML dem in `zugferd_xml` versiegelten
      // entspricht. Bestände ohne Snapshot-Profil = vor der EN-16931-Umstellung
      // versiegeltes BASIC.
      const sendSnapshot = (invoice.renderSnapshot ?? null) as InvoiceRenderSnapshot | null;
      const sendProfile: ZugferdProfileId = sendSnapshot ? (sendSnapshot.profile ?? "basic") : DEFAULT_ZUGFERD_PROFILE;
      const { pdf: zugferdBuffer } = await embedZugferdXml(rendered, pdfData, { strict: opts.strictZugferd === true, testFaults: opts.testFaults, profile: sendProfile });
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

function resolveStorageFileFromPath(pdfPath: string) {
  let entityId = pdfPath;
  if (entityId.startsWith("/objects/")) entityId = entityId.slice("/objects/".length);
  let entityDir = getPrivateDir();
  if (!entityDir.endsWith("/")) entityDir = `${entityDir}/`;
  const fullPath = `${entityDir}${entityId}`;
  const { bucketName, objectName } = parseObjectPath(fullPath);
  return objectStorageClient.bucket(bucketName).file(objectName);
}

async function loadStoredPdfByPath(pdfPath: string | null): Promise<Buffer | null> {
  if (!pdfPath) return null;
  const file = resolveStorageFileFromPath(pdfPath);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [contents] = await file.download();
  return Buffer.from(contents);
}

/**
 * Task #1066 — True, wenn ein gesetzter `pdf_path` ins Leere zeigt (das
 * Object-Storage-Objekt fehlt). Tritt nach einer Umgebungs-Key-Space-Migration
 * (Legacy-Bare-Pfade → `_nonprod/…`) oder bei einem versehentlich gelöschten/
 * überschriebenen Bucket-Objekt auf. Der Self-Heal-Pfad rendert das Artefakt
 * dann aus dem eingefrorenen Render-Snapshot neu, statt einen 404 auszuliefern.
 */
async function storedObjectIsMissing(pdfPath: string | null): Promise<boolean> {
  if (!pdfPath) return false;
  const [exists] = await resolveStorageFileFromPath(pdfPath).exists();
  return !exists;
}

/**
 * Task #1066 — Dokumentiert eine geänderte PDF-Versiegelung im Audit-Log, wenn
 * ein Self-Heal-Re-Render eines bereits versiegelten Artefakts (Rechnungs-PDF
 * oder Leistungsnachweis) andere Bytes erzeugt als der gespeicherte Hash. Das
 * passiert nur bei Pre-#1047-Bestand ohne eingefrorenen Erzeugungszeitpunkt —
 * die Inhalts-Daten sind identisch, nur Metadaten (Erzeugungsdatum) driften.
 * Audit-Fehler dürfen die Recovery NICHT abbrechen (best effort).
 */
async function logPdfReseal(
  invoice: Invoice,
  artifact: "invoice" | "leistungsnachweis",
  oldHash: string,
  newHash: string,
): Promise<void> {
  try {
    await auditService.log(
      invoice.createdByUserId ?? 0,
      "invoice_pdf_reseal_on_recovery",
      "invoice",
      invoice.id,
      {
        invoiceNumber: invoice.invoiceNumber,
        artifact,
        oldHash,
        newHash,
        reason:
          "Object-Storage-Objekt fehlte; PDF aus eingefrorenem Render-Snapshot neu gerendert. Pre-#1047-Bestand ohne versiegelten Erzeugungszeitpunkt — geänderte Versiegelung (nur Metadaten/Erzeugungsdatum, Inhalt unverändert).",
      },
    );
  } catch (auditErr) {
    console.error(
      `[invoice-pdf-orchestrator] Audit-Log für PDF-Reseal (Rechnung ${invoice.id}, ${artifact}) konnte nicht geschrieben werden:`,
      auditErr,
    );
  }
}

/**
 * Task #1073 — dokumentiert die erstmalige Versiegelung einer ZUGFeRD-XML, die
 * NICHT durch die node-zugferd-XSD-Strict-Validierung lief. FRÜHER fiel der
 * Code still vom Strict- auf den Non-Strict-Pfad zurück (z.B. weil
 * `xsd-schema-validator`/Java in der Umgebung fehlt). Jetzt wird jede
 * Non-Strict-Versiegelung mit Profil + Grund im Audit-Log festgehalten, damit
 * im Nachhinein nachvollziehbar ist, welche Rechnung ohne library-seitige
 * Schema-Validierung versiegelt wurde. Die verbindliche EN-16931-/PDF-A-3-
 * Konformitätsprüfung läuft separat im externen Validierungs-Gate
 * (`scripts/validate-erechnung.ts` / CI).
 */
async function logZugferdNonStrictSeal(
  invoice: Invoice,
  profile: ZugferdProfileId,
  strictModeReason: string | null,
): Promise<void> {
  try {
    await auditService.log(
      invoice.createdByUserId ?? 0,
      "invoice_zugferd_nonstrict_seal",
      "invoice",
      invoice.id,
      {
        invoiceNumber: invoice.invoiceNumber,
        profile,
        strictModeReason: strictModeReason ?? "unbekannt",
        reason:
          "ZUGFeRD-XML im Non-Strict-Modus versiegelt — node-zugferd-XSD-Strict-Validierung nicht ausgeführt bzw. nicht bestanden. Verbindliche EN-16931-/PDF-A-3-Konformität wird vom externen Validierungs-Gate (scripts/validate-erechnung.ts / CI) geprüft.",
      },
    );
  } catch (auditErr) {
    console.error(
      `[invoice-pdf-orchestrator] Audit-Log für ZUGFeRD-Non-Strict-Versiegelung (Rechnung ${invoice.id}) konnte nicht geschrieben werden:`,
      auditErr,
    );
  }
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
