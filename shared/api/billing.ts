import type { InvoicePotKey } from "../domain/budget-invoice-split";
import type { BillingEligibilityStatus, BillingBlockReason } from "../domain/billing-eligibility";

export interface BillingCustomerItem {
  id: number;
  name: string;
  vorname: string | null;
  nachname: string | null;
  billingType: string;
  status: string;
  // Task #576: Partial-Signing-Sichtbarkeit im „Neue Rechnung
  // erstellen"-Dropdown. `completedAppointments` = Anzahl dokumentierter
  // Termine (`status = 'completed'`) im gewählten Monat,
  // `coveredAppointments` = Anzahl davon, die durch einen aktiven LN
  // abgedeckt sind. Differenz > 0 deutet auf Partial-Signing hin
  // (Hinweis im UI, dass evtl. ein zweiter LN nötig ist).
  completedAppointments: number;
  coveredAppointments: number;
  // Task #1743: Anzahl der im gewählten Monat noch OFFENEN (geplanten) Termine
  // dieses Kunden — abgeleitet aus der `FINAL_APPOINTMENT_STATUSES`-SSoT (nicht
  // completed/cancelled/customer_no_show). Das Frontend gruppiert die Karte
  // „Noch zu erstellen" danach in „Bereit zum Abrechnen" (=0) und „Noch offene
  // Termine" (>0); der Kunde bleibt in beiden Fällen sichtbar.
  openAppointments: number;
  // Task #1774: Abrechnungs-Berechtigung aus DERSELBEN SSoT
  // (`classifyBillingEligibility` in `shared/domain/billing-eligibility.ts`), die
  // auch der Erstellungs-Pfad (`buildInvoiceDraft`) nutzt. `status` = "eligible"
  // (tatsächlich abrechenbar) oder "blocked"; `reason` nennt den maschinen-
  // lesbaren Grund (insb. `customer_signature_required`, wenn bei Pflegekasse nur
  // eine Mitarbeiter-Unterschrift, aber keine Kundenunterschrift vorliegt). Das
  // Frontend hält damit „Bereit zum Abrechnen" wahrheitsgemäß (nur eligible) und
  // weist unterschrifts-blockierte Kunden separat aus — ohne zweite Reiferegel.
  eligibility: {
    status: BillingEligibilityStatus;
    reason: BillingBlockReason | null;
  };
  // Task #1813 — Termin-Fakten für die „Nachberechnung"-Kennzeichnung
  // (spät unterschriebene Nachzügler). `signedAppointmentCount` = Termine unter
  // signierten LNs (bereits abgerechnete + noch offene), `unbilledAppointmentCount`
  // = davon noch nicht abgerechnet. Aus DERSELBEN SSoT
  // (`getUnbilledSignedAppointmentFactsByCustomer`), die der Server bereits für
  // die Eligibilität nutzt — die Liste konsumiert sie über den gemeinsamen
  // Helper `isLateSignedFollowUp`/`lateSignedFollowUpCount`.
  signedAppointmentCount: number;
  unbilledAppointmentCount: number;
}

export interface InvoiceItem {
  id: number;
  invoiceNumber: string;
  customerId: number;
  billingType: string;
  invoiceType: string;
  billingMonth: number;
  billingYear: number;
  recipientName: string;
  // Task #533: Kunden-Name (Vor-/Nachname) zusätzlich zur Empfängerzeile —
  // wird auf der Rechnungs-Karte angezeigt, damit der Kundenbezug auch bei
  // Pflegekassen-Rechnungen (Empfänger = Kasse) auf den ersten Blick sichtbar ist.
  customerName: string;
  customerVorname: string | null;
  customerNachname: string | null;
  netAmountCents: number;
  vatAmountCents: number;
  grossAmountCents: number;
  vatRate: number | null;
  status: string;
  // Task #533: Versanddatum für Listenanzeige (Badge „Versendet seit ...").
  sentAt: string | null;
  // Task #1412: Fälligkeitsdatum (ISO yyyy-mm-dd). Anker für das Selbstzahler-/
  // Privat-Aging in der „Zahlung ausstehend"-Gruppe der Rechnungsliste (mirror
  // des Pipeline-Reader-Aging). Wird bereits roh vom Listen-Endpunkt geliefert,
  // hier nur typisiert.
  dueDate: string | null;
  // Task #546: PDF-Persistierungs-Status. `pdfPath` ist NULL solange das
  // Hintergrund-Rendering läuft (oder fehlgeschlagen ist); `createdAt` dient
  // dem Frontend zur Unterscheidung zwischen „noch in Arbeit" und „Fehler".
  pdfPath: string | null;
  createdAt: string;
  // Task #759: Rechnungs-Split pro Budget-Topf. `billingRunId` gruppiert
  // alle Geschwister-Rechnungen eines Multi-Pot-Laufs (uuid). `budgetType`
  // identifiziert den konkreten Topf (NULL = Selbstzahler oder Single-Pot-
  // Bestand vor #759).
  billingRunId: string | null;
  budgetType: string | null;
  // Task #1822: Nur im Zustand `teilweise_bezahlt` gesetzt. `paidCents` = Σ der
  // bereits eingegangenen, gebundenen Zahlungen; `openAmountCents` = offener Rest
  // (Brutto − Skonto − gezahlt). Beide stammen aus derselben SSoT wie der
  // Status-Schreibpfad (`getInvoicePaymentTotals` + `classifyPaymentDifference`),
  // damit Anzeige und Buchung nie auseinanderlaufen. Sonst undefined.
  paidCents?: number;
  openAmountCents?: number;
}

interface InvoiceLineItem {
  id: number;
  appointmentDate: string;
  serviceDescription: string;
  serviceCode: string | null;
  startTime: string | null;
  endTime: string | null;
  durationMinutes: number;
  // Task #572: Anzeige-Menge + Einheit, damit das Frontend dieselbe Quelle
  // wie PDF und ZUGFeRD nutzt (verhindert km-Drift „Menge × Satz ≠ Summe").
  // NULL für historische Zeilen vor Task #561 — der Frontend-Helper
  // `renderLineItemQuantity` fällt dann auf `durationMinutes` zurück.
  quantityRaw: number | null;
  quantityUnit: "hours" | "km" | null;
  totalCents: number;
  unitPriceCents: number;
  employeeName: string | null;
}

export interface InvoiceDetail extends InvoiceItem {
  lineItems: InvoiceLineItem[];
  // Task #522: Drift-Indikatoren — true, wenn die Live-Daten nicht mehr zum
  // Fingerprint des persistierten Rechnungs- bzw. Leistungsnachweis-PDFs passen.
  pdfDrift?: boolean;
  leistungsnachweisDrift?: boolean;
}

export interface DeliveryRecord {
  id: number;
  deliveryMethod: string;
  status: string;
  recipientEmail: string | null;
  recipientName: string | null;
  recipientAddress: string | null;
  documentFileNames: string | null;
  sentAt: string | null;
  createdAt: string;
  errorMessage: string | null;
  letterxpressLetterId: string | null;
}

// Task #750: Vorschau im „Neue Rechnung erstellen"-Dialog. Wird vom selben
// Helper berechnet (`buildInvoiceDraft`) wie `POST /billing/generate`,
// damit angezeigte Werte und finale Rechnungssumme nicht driften können.
export interface BillingInvoicePreview {
  // Anzahl unterschriebener Leistungsnachweise im Zeitraum.
  serviceRecordCount: number;
  // Termine, die tatsächlich abgerechnet werden (nach Filter „bereits abgerechnet").
  coveredAppointments: number;
  // Dokumentierte Termine (`status = 'completed'`) im Monat — Sekundärwert
  // für den Partial-Signing-Hinweis im UI.
  completedAppointments: number;
  // Task #1813 — Termine, die bereits in einer früheren Rechnung dieses
  // Zeitraums abgerechnet wurden. Neutraler „N bereits abgerechnet"-Wert; er
  // ERSETZT die bisherige mehrdeutige Ableitung
  // (`completedAppointments − coveredAppointments`), die spät unterschriebene
  // Nachzügler-Termine fälschlich als amber „unvollständig dokumentiert"
  // erscheinen ließ. Der amber-Hinweis feuert jetzt nur noch für wirklich
  // un-/unterdokumentierte Termine (`completed − covered − alreadyBilled > 0`).
  alreadyBilledAppointments: number;
  // Brutto-Summe über alle entstehenden Folge-Rechnungen
  // (bei Budget-Split: Kasse + Privat).
  totalCents: number;
  // True, wenn der Generate-Aufruf in mehrere Folge-Rechnungen aufspaltet.
  splitInvoices: boolean;
  // Task #1010: Die tatsächlich betroffenen Budget-Töpfe bei einem Split,
  // sortiert nach `POT_ORDER` — eine Folge-Rechnung pro Eintrag. Leer, wenn
  // kein Split entsteht. Erlaubt dem UI, den Hinweis exakt zu beschriften
  // (z.B. „§45b + §45a") und „Privat" nur bei echtem Selbstzahler-Anteil.
  splitPots: InvoicePotKey[];
  // Task #1869: Dokumentierte Termine des Zeitraums, die NICHT in dieser
  // Rechnung landen — mit maschinenlesbarem Grund und Datum. So kann der Dialog
  // bei einer Null-/Teil-Summe konkret benennen, WARUM Termine nicht abgerechnet
  // werden (insb. fehlende Kundenunterschrift bei Pflegekasse vs. bereits
  // abgerechnet) und welche Leistungsnachweise noch unterschrieben werden müssen.
  // Nur `customer_signature_required`/`not_signed` (fehlende Unterschrift) und
  // `already_billed` treten hier auf; abgeleitet aus DERSELBEN Eligibilitäts-SSoT
  // wie der Erstellungs-Pfad — keine zweite Reiferegel.
  excludedAppointments: BillingExcludedAppointment[];
}

// Task #1869: Ein nicht abgerechneter dokumentierter Termin samt Grund. `date`
// = ISO yyyy-mm-dd des Termins; `reason` reicht der Vorschau die maschinen-
// lesbare Block-Ursache durch (siehe `BILLING_BLOCK_SHORT_LABELS` für die
// knappen Anzeige-Labels), damit Dialog und Kundenzeile denselben Wortlaut
// verwenden.
export interface BillingExcludedAppointment {
  date: string;
  reason: BillingBlockReason;
}

export interface GenerateInvoiceResponse {
  splitInvoices?: boolean;
  invoices?: { id: number }[];
  message?: string;
}

// Task #817: Verwaiste Entwurfs-Rechnungen, die die Termine eines Zeitraums
// blockieren (status = 'entwurf', kein Storno). Sie verhindern eine neue
// Rechnung, obwohl sie nie finalisiert wurden — der Dialog bietet sie zum
// Verwerfen an.
export interface BlockingDraftInvoice {
  id: number;
  invoiceNumber: string;
  grossAmountCents: number;
  billingRunId: string | null;
  createdAt: string;
}

// Task #817: Antwort des Verwerfen-Endpunkts. `discarded` = Anzahl gelöschter
// Entwürfe, `invoiceNumbers` für die Audit-/UI-Bestätigung.
export interface DiscardDraftsResponse {
  discarded: number;
  invoiceNumbers: string[];
}

// Task #1376 — Sammel-Löschen (nur Entwürfe). `status: "deleted"` für tatsächlich
// gelöschte Entwürfe, `"skipped"` (mit `reason`) für finalisierte/Storno-Belege,
// die per GoBD nicht hart gelöscht werden dürfen.
export interface BulkDeleteResultItem {
  invoiceId: number;
  invoiceNumber: string | null;
  status: "deleted" | "skipped";
  reason?: string;
}
export interface BulkDeleteResponse {
  summary: { deleted: number; skipped: number; total: number };
  invoiceNumbers: string[];
  results: BulkDeleteResultItem[];
}

// Task #1376 — Sammel-Statuswechsel (versendet/avis_erhalten/bezahlt). Pro
// Rechnung gilt dieselbe Übergangs-SSoT wie beim Einzel-Statuswechsel;
// ungültige Übergänge werden als `"skipped"` mit `reason` gemeldet.
export interface BulkStatusResultItem {
  invoiceId: number;
  invoiceNumber: string;
  status: "updated" | "skipped";
  reason?: string;
}
export interface BulkStatusResponse {
  summary: { updated: number; skipped: number; total: number };
  results: BulkStatusResultItem[];
}

// Task #1834 — Sammel-Reparatur der „PDF-Fehler"-Rechnungen (fehlender
// `pdfPath`, bei Pflegekassen zusätzlich fehlender `leistungsnachweisPath`).
// Verarbeitet pro Aufruf einen beschränkten Block; `remaining` sagt dem Client,
// ob noch ein weiterer Block ansteht (großer Rückstand → Client ruft erneut auf).
export interface RepairPdfsResultItem {
  invoiceId: number;
  invoiceNumber: string | null;
  status: "repaired" | "failed";
  reason?: string;
}
export interface RepairPdfsResponse {
  summary: { repaired: number; failed: number; remaining: number; total: number };
  results: RepairPdfsResultItem[];
}

export interface SendInvoiceResponse {
  message: string;
  invoice?: InvoiceItem;
  results?: { invoiceId: number; status: string; recipientEmail: string; customerCopy?: boolean }[];
}

export interface BatchSendInvoiceResponse {
  message: string;
  summary: { sent: number; errors: number; skipped: number; total: number };
  results: { invoiceId: number; invoiceNumber: string; status: string; error?: string; recipientEmail?: string }[];
}

// Task #534/#1403: Typenübergreifender Bulk-Versand. ALLE Entwürfe
// (Pflegekassen gesetzlich + privat UND Selbstzahler) werden einheitlich
// manuell als „versendet" markiert (kein TI-Anschluss, kein realer
// E-Mail-Versand). Selbstzahler haben keinen eigenen „versendet"-Spezial-Pfad
// mehr; daher kennt die Antwort nur noch `markedSent` (kein `sent`).
// Krankenkassen-Filter: Liste der Pflegekassen, die im gewählten Monat/Jahr
// mindestens eine Rechnung haben. Wird im Filter-Dropdown der
// Abrechnungs-Seite angezeigt.
export interface PayerSummary {
  insuranceProviderId: number;
  name: string;
}

export interface BulkSendInvoiceResponse {
  summary: {
    total: number;
    markedSent: number;
    skipped: number;
    errors: number;
  };
  results: Array<{
    invoiceId: number;
    invoiceNumber: string;
    customerId: number;
    billingType: string;
    status: "marked_sent" | "skipped" | "error";
    message?: string;
  }>;
}

// Task #996: Sammeldruck — Zusammenfassung, die der binäre `/billing/bulk-print`
// Download im `X-Bulk-Print-Summary`-Header (URL-encodiertes JSON) mitliefert.
// Der eigentliche Payload ist die PDF/ZIP-Datei; diese Struktur beschreibt nur
// das Ergebnis je Rechnung (gedruckt + als versendet markiert oder Fehler).
export interface BulkPrintSummary {
  total: number;
  printed: number;
  marked: number;
  errors: number;
  groupedByPayer: boolean;
  results: Array<{
    invoiceId: number;
    invoiceNumber: string;
    customerId: number;
    status: "printed" | "error";
    message?: string;
  }>;
}

// Task #1695 — Einzel-PDF-Export (ehem. „Lexware-Export"): Zusammenfassung, die
// der binäre `/billing/single-pdf-export` ZIP-Download im
// `X-Single-Pdf-Export-Summary`-Header (URL-encodiertes JSON) mitliefert. Je
// Rechnung genau eine PDF (optional inkl. Leistungsnachweis). READ-ONLY — KEIN
// Status-/Markierungs-Feld (anders als BulkPrintSummary: kein `marked`), da der
// Export NICHTS mutiert.
export interface SinglePdfExportSummary {
  total: number;
  exported: number;
  errors: number;
  results: Array<{
    invoiceId: number;
    invoiceNumber: string;
    customerId: number;
    status: "exported" | "error";
    message?: string;
  }>;
}
