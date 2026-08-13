import { badRequest, notFound, AppError } from "../lib/errors";
import { splitLineItemsAcrossPots, POT_ORDER, type InvoicePotKey, type BudgetSplitForAppointment } from "@shared/domain/budget-invoice-split";
import { summarizePotAmounts } from "@shared/domain/invoice-amounts";
import { isPrivatePaymentAllowed } from "@shared/domain/budget-selbstzahler-validator";
import {
  BILLING_BLOCK_MESSAGES,
  isPflegekasseBillingType,
  isServiceRecordSignedForBilling,
} from "@shared/domain/billing-eligibility";
import type { BudgetType } from "@shared/domain/budgets";
import type { BillingExcludedAppointment } from "@shared/api/billing";
import { resolveBudgetRecipient } from "../storage/budget-recipients";
import { randomUUID } from "crypto";
import { appointments, invoices as invoicesTable, type Invoice } from "@shared/schema";
import { eq, and, gte, lt, lte, ne, inArray } from "drizzle-orm";
import { z } from "zod";
import { todayISO, addDays } from "@shared/utils/datetime";
import { billingPeriodAsOfISO } from "@shared/domain/insurance-period";
import { STANDARD_VAT_RATE_BP } from "@shared/domain/invoice-vat";
import { storage } from "../storage";
import { db } from "../lib/db";
import { appointmentsRepo } from "../repos";
import { getNextInvoiceNumberTx, createInvoiceTx } from "../storage/billing-storage";
import { withAudit } from "../lib/with-audit";
import { auditService } from "./audit";
import { readTestFaults } from "../lib/test-fault-injector";
import { getCachedCompanySettings } from "./cache";
import { schedulePdfPersistInBackground } from "./invoice-pdf-orchestrator";
import { getAlreadyInvoicedAppointmentIds, getServiceRecordsForPeriod, getAppointmentIdsFromServiceRecords, buildLineItemsFromAppointments, getBudgetSplitForAppointments, getInsuranceData, findNetZeroBilledAppointments, lockCustomerForBilling, assertAppointmentsNotYetInvoiced } from "./invoice-data";
import { rebookNetZeroAppointmentConsumption } from "../storage/budget/rebook-storage";
import type { BuildLineItem } from "./invoice-data";

/**
 * Wrapper um den pure shared-Helper. Bündelt Line-Items pro Pot und
 * verteilt Cent-Anteile mit Largest-Remainder-Rundung (Σ pro Termin =
 * `item.totalCents`, keine Drift).
 */
export function splitLineItemsByPot(
  lineItems: BuildLineItem[],
  budgetSplit: Map<number, BudgetSplitForAppointment>,
  options: { allowPrivatePot?: boolean } = {},
): Map<InvoicePotKey, BuildLineItem[]> {
  const shares = splitLineItemsAcrossPots(lineItems, budgetSplit, {
    fallbackPot: "private",
  });

  // Task #1353 — Backstop gegen verbotene Privatanteile. Reine Pflegekassen-
  // Kunden ohne `acceptsPrivatePayment` (kein Selbstzahler) dürfen NIE einen
  // privaten (Selbstzahler-)Anteil erhalten — weder über die `fallbackPot`-
  // Zuordnung (Termin ohne Budget-Mapping) noch über einen vom Split selbst
  // ermittelten Privat-Anteil. Entsteht hier dennoch ein Privatanteil, ist das
  // ein Fehler (z.B. ein „Rest", der nicht in die gesetzlichen Töpfe passt) und
  // MUSS laut blockieren (klare Sperre) statt still eine 19%-Privatrechnung
  // auszustellen (Jungnickel-/AOK-Fall). Das Gate ist dieselbe zentrale SSoT
  // wie auf dem Buchungs-/Rebook-Pfad (`isPrivatePaymentAllowed`).
  if (options.allowPrivatePot === false) {
    const forbiddenPrivateApptIds = [
      ...new Set(
        shares
          .filter((s) => s.potKey === "private" && s.totalCents !== 0)
          .map((s) => s.item.appointmentId),
      ),
    ];
    if (forbiddenPrivateApptIds.length > 0) {
      throw badRequest(
        `Rechnung kann nicht erstellt werden: Für die Termine ` +
        `${forbiddenPrivateApptIds.join(", ")} entstünde ein privater ` +
        `(Selbstzahler-)Anteil, obwohl dieser Kunde nicht privat zahlt. ` +
        `Eine Privatabrechnung ist hier nicht zulässig. Bitte prüfen Sie ` +
        `die Budget-Konfiguration und Buchungen für diesen Zeitraum.`,
      );
    }
  }

  const byPot = new Map<InvoicePotKey, BuildLineItem[]>();
  for (const share of shares) {
    const list = byPot.get(share.potKey) ?? [];
    list.push({ ...share.item, totalCents: share.totalCents });
    byPot.set(share.potKey, list);
  }
  return byPot;
}

export type GenerateInvoiceResult =
  | Invoice
  | { splitInvoices: true; invoices: Invoice[]; message: string };

/**
 * Task #1905 — Brutto-IST einer Termin-Menge für die ANZEIGE (Karte „Noch zu
 * erstellen"), gerechnet über exakt denselben Weg wie die echte Rechnung:
 * Zeilen-Bauer → Topf-Split → `summarizePotAmounts`. Damit entspricht die
 * angezeigte Ist-Zahl dem, was tatsächlich abgerechnet würde.
 *
 * Zwei bewusste Abweichungen vom Erstellungs-Pfad, beide weil dies ein reiner
 * Lesepfad über Termine ist, die (noch) NICHT abgerechnet werden:
 *  1. `allowPrivatePot: true` — der #1353-Backstop wirft beim Erstellen hart,
 *     wenn für einen reinen Kassen-Kunden ein Privatanteil entstünde. Hier darf
 *     eine Anzeige die Abrechnungsseite nicht abschießen.
 *  2. `privatePotIsTaxable` folgt derselben SSoT (`isPrivatePaymentAllowed`):
 *     ohne erlaubte Privatzahlung wird ein Privat-Topf NICHT besteuert — er
 *     stammt dann aus der fehlenden Buchung, nicht aus einem echten
 *     Privatanteil (siehe `summarizePotAmounts`).
 *
 * Fehlt ein Katalogpreis, wirft der Zeilen-Bauer — bewusst NICHT gefangen: ein
 * verschluckter Preis-Fehler würde hier eine zu kleine Geldsumme anzeigen, und
 * genau das darf eine Geld-Spalte nicht. Der Erstellungs-Pfad verhält sich
 * bereits so.
 */
export async function computeDocumentedGrossCents(args: {
  customerId: number;
  appointmentIds: number[];
  billingType: string;
  acceptsPrivatePayment: boolean | null | undefined;
}): Promise<number> {
  if (args.appointmentIds.length === 0) return 0;
  const { lineItems, totalNetCents, totalVatCents } =
    await buildLineItemsFromAppointments(args.appointmentIds, args.customerId, args.billingType);
  if (lineItems.length === 0) return 0;
  const budgetSplit = await getBudgetSplitForAppointments(args.customerId, args.appointmentIds);
  const privateAllowed = isPrivatePaymentAllowed({
    billingType: args.billingType,
    acceptsPrivatePayment: args.acceptsPrivatePayment ?? false,
  });
  const potItems = splitLineItemsByPot(lineItems, budgetSplit, { allowPrivatePot: true });
  return summarizePotAmounts({
    potItems,
    billingType: args.billingType,
    builderNetCents: totalNetCents,
    builderVatCents: totalVatCents,
    privatePotIsTaxable: privateAllowed,
  }).grossCents;
}

/**
 * Task #750: Pure read-only Helper, der dieselbe Build-Logik liefert wie
 * `generateInvoiceCore`, aber NICHTS persistiert — keine Rechnungsnummer,
 * keine Inserts, kein Audit-Log, kein PDF. Wird von `POST /billing/generate`
 * UND `GET /billing/preview` aufgerufen, damit Vorschau-Werte und finale
 * Rechnungssumme garantiert übereinstimmen.
 *
 * Wirft dieselben `badRequest`/`notFound`-Fehler wie `generateInvoiceCore`,
 * sodass die Vorschau bei „kein LN", „keine Termine" usw. einen klaren
 * Fehler zurückgibt (Frontend zeigt „Vorschau nicht verfügbar").
 */
export interface InvoiceDraft {
  customer: NonNullable<Awaited<ReturnType<typeof storage.getCustomer>>>;
  customerName: string;
  customerAddress: string;
  billingType: string;
  signedRecordCount: number;
  apptIds: number[];                       // nach Filter „bereits abgerechnet"
  alreadyInvoicedIds: number[];
  completedAppointmentsInPeriod: number;   // dokumentierte Termine im Monat (für Partial-Signing-Hinweis)
  // Task #1813 — Termine unter signierten LNs, die bereits in einer früheren
  // Rechnung dieses Zeitraums abgerechnet wurden (Nachberechnungs-Erkennung).
  // Ersetzt die bisherige mehrdeutige Ableitung
  // (`completedAppointmentsInPeriod − coveredAppointments`), die spät
  // unterschriebene Nachzügler fälschlich als „unvollständig dokumentiert"
  // erscheinen ließ.
  alreadyBilledAppointmentCount: number;
  // Task #1869 — Dokumentierte Termine des Zeitraums, die NICHT abgerechnet
  // werden, samt Grund + Datum (fehlende Kundenunterschrift vs. bereits
  // abgerechnet). Abgeleitet aus denselben Signatur-/Abgerechnet-Fakten wie die
  // Eligibilitäts-SSoT — rein erklärend, ändert nichts am Abrechnungs-Umfang.
  excludedAppointments: BillingExcludedAppointment[];
  insuranceInfo: Awaited<ReturnType<typeof getInsuranceData>>;
  // Task #759 — Variant C: Pot-Items sind die Wahrheits-Quelle. Wenn nur
  // ein Pot belegt ist, wird der Legacy-Single-Invoice-Pfad verwendet
  // (Bestand bleibt 1:1). Bei ≥2 Pots läuft die N-Invoice-Generierung.
  potItems: Map<InvoicePotKey, BuildLineItem[]>;
  needsBudgetSplit: boolean;               // potItems.size > 1
  hasPrivateShare: boolean;                // potItems.has("private")
  singlePotIsPrivate: boolean;             // Single-Pfad, einziger Pot = "private" → Selbstzahler-Rechnung (19% USt)
  lineItems: BuildLineItem[];              // Single-Pfad (alle Items, ungesplittet)
  kasseItems: BuildLineItem[];             // [DEPRECATED, kept for /preview]
  privateItems: BuildLineItem[];           // [DEPRECATED, kept for /preview]
  totalNetCents: number;                   // Netto-Summe über alle Folge-Rechnungen
  totalVatCents: number;                   // USt-Summe über alle Folge-Rechnungen
  grossAmountCents: number;                // Brutto-Summe über alle Folge-Rechnungen
  stornoRefsForInsert: number[] | null;
  defaultBuyerReference: string | null;
  invoiceDueDateIso: string;
}

/** Task #759 — pot-spezifischer Hinweis für invoices.notes. */
export function getPotInvoiceNote(potKey: InvoicePotKey): string {
  switch (potKey) {
    case "entlastungsbetrag_45b":
      return "Abrechnung des Entlastungsbetrags gem. § 45b SGB XI";
    case "umwandlung_45a":
      return "Abrechnung des Umwandlungsanspruchs gem. § 45a SGB XI";
    case "ersatzpflege_39_42a":
      return "Abrechnung der Verhinderungspflege gem. §§ 39 / 42a SGB XI";
    case "private":
      return "Privatzahlung — Anteil außerhalb des verfügbaren Budgets";
  }
}

export function isKassePot(potKey: InvoicePotKey): potKey is BudgetType {
  return potKey !== "private";
}

/**
 * Task #1094 — Bestimmt den Budget-Topf einer Single-Pot-Rechnung. Liefert den
 * Kasse-Topf (`entlastungsbetrag_45b` | `umwandlung_45a` | `ersatzpflege_39_42a`),
 * wenn genau ein Kasse-Pot belegt ist; `null`, wenn der einzige belegte Pot
 * der Selbstzahler-/Privat-Pot ist (`singlePotIsPrivate`) oder kein eindeutiger
 * Topf bestimmbar ist (keine belegten Pots / mehrere Pots). Wird genutzt, um
 * eine Single-Pot-Kassenrechnung mit ihrem echten Topf zu stempeln, statt sich
 * im Renderer still auf die §45b-Formulierung zurückfallen zu lassen.
 */
export function resolveSinglePotBudgetType(
  potItems: Map<InvoicePotKey, BuildLineItem[]>,
): BudgetType | null {
  if (potItems.size !== 1) return null;
  const [onlyPot] = potItems.keys();
  return isKassePot(onlyPot) ? onlyPot : null;
}

export async function buildInvoiceDraft(input: {
  customerId: number;
  billingMonth: number;
  billingYear: number;
  // Task #1317: Optionaler von–bis-Datumsbereich (ISO yyyy-mm-dd). Engt die
  // abzurechnenden Termine auf den Bereich ein (Teil-Abrechnung innerhalb des
  // Monats). Leer = ganzer Monat (Bestandsverhalten).
  dateFrom?: string;
  dateTo?: string;
  // Task #1881 — Modus. „preview" (Dialog-Vorschau) wirft NICHT mehr eine
  // generische badRequest-Meldung, wenn aktuell nichts abrechenbar ist, sondern
  // liefert eine strukturierte Antwort (excludedAppointments je Termin + Grund,
  // Summe 0 €) aus DENSELBEN Fakten. „generate" (Default) lehnt leere Läufe
  // weiterhin ab (keine leeren Rechnungen). Der Termin-genaue Ausschluss-Block
  // unten ist der einzige Ableitungspfad ⇒ Review ⇔ Generate bleiben spiegelbildlich.
  mode?: "generate" | "preview";
}): Promise<InvoiceDraft> {
  const { customerId, billingMonth, billingYear, dateFrom, dateTo, mode } = input;
  const isPreview = mode === "preview";

  const customer = await storage.getCustomer(customerId);
  if (!customer) throw notFound("Kunde nicht gefunden");

  // Task #562 — Fälligkeit (BT-9): zentral aus den Firmenstammdaten.
  const companySettingsForInvoice = await getCachedCompanySettings();
  const dueDays = companySettingsForInvoice?.invoiceDefaultDueDays ?? 30;
  const invoiceIssueIso = todayISO();
  const invoiceDueDateIso = addDays(invoiceIssueIso, dueDays);

  // Task #562 — Käuferreferenz (BT-10) für Pflegekassen.
  // Task #1893 — am Stichtag des Abrechnungszeitraums aufgelöst: Versicherten-
  // nummer, IK und Empfänger müssen zum abgerechneten Monat passen.
  const insuranceInfo = await getInsuranceData(
    customerId,
    billingPeriodAsOfISO(billingYear, billingMonth, dateTo),
  );
  const defaultBuyerReference =
    (customer.billingType === "pflegekasse_gesetzlich" ||
      customer.billingType === "pflegekasse_privat") &&
    insuranceInfo?.versichertennummer
      ? insuranceInfo.versichertennummer
      : null;

  const serviceRecords = await getServiceRecordsForPeriod(customerId, billingYear, billingMonth);
  if (serviceRecords.length === 0) {
    throw badRequest("Kein Leistungsnachweis für diesen Zeitraum vorhanden. Bitte erstellen Sie zuerst einen Leistungsnachweis im Bereich 'Nachweise'.");
  }

  // Task #1074 — Abrechnungs-Eligibilität nach billingType (GoBD/Kassen-Vorgabe):
  //  • Pflegekasse (gesetzlich/privat): NUR mit Kundenunterschrift abrechenbar
  //    (`status='completed'`). Ein nur mitarbeiter-signierter Leistungsnachweis
  //    (`employee_signed`) genügt NICHT — die Kasse verlangt den vom Kunden
  //    bestätigten Leistungsnachweis.
  //  • Selbstzahler: `employee_signed` bleibt zulässig (keine Kassen-Vorgabe),
  //    `completed` selbstverständlich ebenso.
  // Task #1456 — Signatur-Akzeptanz aus der gemeinsamen Eligibilitäts-SSoT
  // (`shared/domain/billing-eligibility.ts`). Dieselben Helfer/Meldungen nutzt
  // der Pre-Commit-Review, damit „eligible" im Review ⇔ akzeptiert hier gilt.
  const isPflegekasseBilling = isPflegekasseBillingType(customer.billingType);
  const signedRecords = serviceRecords.filter(sr =>
    isServiceRecordSignedForBilling(customer.billingType, sr.status)
  );
  if (signedRecords.length === 0 && !isPreview) {
    throw badRequest(
      isPflegekasseBilling
        ? BILLING_BLOCK_MESSAGES.customer_signature_required
        : BILLING_BLOCK_MESSAGES.not_signed,
    );
  }

  const serviceRecordIds = signedRecords.map(sr => sr.id);
  const allApptIds = await getAppointmentIdsFromServiceRecords(serviceRecordIds);
  if (allApptIds.length === 0 && !isPreview) {
    throw badRequest(BILLING_BLOCK_MESSAGES.no_appointments);
  }

  // Task #1892 PR-2 — ZEITRAUM-BLIND: gefragt wird „ist dieser Termin
  // ueberhaupt schon abgerechnet?", nicht „im Monat X?". Ein Termin auf einer
  // Rechnung eines anderen Abrechnungszeitraums war vorher unsichtbar und
  // wurde ein zweites Mal berechnet.
  const alreadyInvoicedIds = await getAlreadyInvoicedAppointmentIds(allApptIds);

  // Task #1813 — Termine unter den signierten LNs, die bereits auf einer
  // aktiven Rechnung liegen (seit #1892 PR-2 zeitraum-uebergreifend). Basis der
  // „Nachberechnung"-Erkennung und des neutralen „N bereits abgerechnet"-Werts
  // in der Vorschau (ersetzt die mehrdeutige Doku-Lücken-Ableitung).
  const alreadyBilledAppointmentCount = alreadyInvoicedIds.length > 0
    ? allApptIds.filter(id => alreadyInvoicedIds.includes(id)).length
    : 0;

  // T05/K3: Storno-then-rebill — bereits stornierte Original-Rechnungen
  // verlinken (Task #585).
  const stornoOriginalRows = await db.select({ id: invoicesTable.id })
    .from(invoicesTable)
    .where(and(
      eq(invoicesTable.customerId, customerId),
      eq(invoicesTable.billingYear, billingYear),
      eq(invoicesTable.billingMonth, billingMonth),
      eq(invoicesTable.status, "storniert"),
      ne(invoicesTable.invoiceType, "stornorechnung"),
    ));
  const referencedStornoInvoiceIds = stornoOriginalRows.map((r) => r.id);
  const stornoRefsForInsert: number[] | null =
    referencedStornoInvoiceIds.length > 0 ? referencedStornoInvoiceIds : null;

  let apptIds = alreadyInvoicedIds.length > 0
    ? allApptIds.filter(id => !alreadyInvoicedIds.includes(id))
    : allApptIds;
  if (apptIds.length === 0 && !isPreview) {
    throw badRequest(BILLING_BLOCK_MESSAGES.already_billed);
  }

  // Task #1317: Optionaler von–bis-Datumsbereich — engt die abzurechnenden
  // Termine auf den gewählten Bereich innerhalb des Monats ein. Beide Grenzen
  // unabhängig optional; leer = ganzer Monat (oben unverändert).
  if (dateFrom || dateTo) {
    const rangeConds = [
      inArray(appointments.id, apptIds),
      appointmentsRepo.activeOnly(),
    ];
    if (dateFrom) rangeConds.push(gte(appointments.date, dateFrom));
    if (dateTo) rangeConds.push(lte(appointments.date, dateTo));
    const inRangeRows = await appointmentsRepo.selectColumnsFrom({ id: appointments.id })
      .where(and(...rangeConds));
    const inRangeIds = new Set(inRangeRows.map(r => r.id));
    apptIds = apptIds.filter(id => inRangeIds.has(id));
    if (apptIds.length === 0 && !isPreview) {
      throw badRequest("Im gewählten Datumsbereich gibt es keine abrechenbaren Termine.");
    }
  }

  const billingType = customer.billingType || "selbstzahler";
  // Task #1033 — Kein stiller „Unbekannt"-Platzhalter: `customers.name` ist
  // NOT NULL und bei der Anlage pflichtvalidiert. Fehlt ausnahmsweise jeder
  // Name (leerer String + keine Vor-/Nachname-Splittung), wird die Erstellung
  // mit klarer Fehlermeldung abgebrochen statt einen irreführenden Namen auf
  // die Rechnung zu drucken.
  const customerName = customer.vorname && customer.nachname
    ? `${customer.vorname} ${customer.nachname}`
    : customer.name;
  if (!customerName) {
    throw badRequest(`Kunde #${customerId} hat keinen Namen hinterlegt — Rechnung kann nicht erstellt werden. Bitte ergänzen Sie die Kundenstammdaten.`);
  }
  const customerAddress = [customer.strasse, customer.nr].filter(Boolean).join(" ") +
    (customer.plz || customer.stadt ? `\n${customer.plz || ""} ${customer.stadt || ""}` : "");

  // Task #750: Anzahl dokumentierter Termine im Monat (für Partial-Signing-
  // Hinweis „N von X dokumentiert" im Vorschau-Block, konsistent mit
  // `/eligible-customers`).
  const mm = String(billingMonth).padStart(2, "0");
  const periodStartStr = `${billingYear}-${mm}-01`;
  const nextMonth = billingMonth === 12 ? 1 : billingMonth + 1;
  const nextYear = billingMonth === 12 ? billingYear + 1 : billingYear;
  const periodEndStr = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
  const completedRows = await appointmentsRepo.selectColumnsFrom({ id: appointments.id, date: appointments.date })
    .where(and(
      eq(appointments.customerId, customerId),
      eq(appointments.status, "completed"),
      // Task #1883/#1886 — Erstberatungen sind keine abrechenbaren Kundentermine und
      // dürfen den Unterabrechnungs-Guard NICHT auslösen (sie sind kundenlos und
      // haben nie einen LN). Regulär tragen sie `customer_id = NULL` und fallen schon
      // über den Customer-Filter raus; der Typ-Filter macht die #1886-Regel hier
      // explizit und guard-fest.
      ne(appointments.appointmentType, "Erstberatung"),
      appointmentsRepo.activeOnly(),
      gte(appointments.date, periodStartStr),
      lt(appointments.date, periodEndStr),
    ));
  const completedAppointmentsInPeriod = completedRows.length;

  // Task #1869 — Erklärung für eine Null-/Teil-Summe: WELCHE dokumentierten
  // Termine NICHT abgerechnet werden und WARUM. Zwei Ursachen werden benannt:
  //  • fehlende Unterschrift — Termine unter Leistungsnachweisen, die (noch)
  //    nicht abrechenbar signiert sind (bei Pflegekasse: keine Kundenunterschrift,
  //    nur `employee_signed` → `customer_signature_required`; sonst `not_signed`).
  //  • bereits abgerechnet — Termine, die schon in einer früheren Rechnung des
  //    Zeitraums enthalten sind (`already_billed`).
  // Grundlage sind DIESELBEN Signatur-/Abgerechnet-Fakten wie oben (kein zweiter
  // Ableitungspfad); rein erklärend — der Abrechnungs-Umfang bleibt unberührt.
  const billableApptIdSet = new Set(apptIds);
  // Task #1892 PR-2 — die Erklärungs-Menge muss WEITER tragen als die Sperre.
  // Die Sperre oben fragt nur die Termine unter den signierten LNs dieses
  // Zeitraums (`allApptIds`). Ein dokumentierter Termin, der bereits
  // abgerechnet ist, aber unter KEINEM abrechenbar-signierten LN dieses
  // Zeitraums liegt (z. B. nach einem Wechsel des `billingType`), fiele sonst
  // in den Signatur-Zweig unten — falscher Grund UND ein unnötiges
  // Confirm-Gate, weil `already_billed` als einziger Grund KEINE
  // `PartialBillingConfirmationRequiredError` auslöst. Deshalb hier eine
  // eigene, rein ERKLÄRENDE Abfrage über alle dokumentierten Termine des
  // Zeitraums. Der Abrechnungs-Umfang bleibt davon unberührt.
  const alreadyInvoicedIdSet = new Set(
    await getAlreadyInvoicedAppointmentIds(completedRows.map(r => r.id)),
  );
  const unsignedRecordIds = serviceRecords
    .filter(sr => !isServiceRecordSignedForBilling(customer.billingType, sr.status))
    .map(sr => sr.id);
  const awaitingSignatureApptIdSet = new Set(
    await getAppointmentIdsFromServiceRecords(unsignedRecordIds),
  );
  const missingSignatureReason: BillingExcludedAppointment["reason"] =
    isPflegekasseBilling ? "customer_signature_required" : "not_signed";
  // Task #1883 — Termine unter den ABRECHENBAR-signierten LNs (vor Datumsbereich).
  // Ein dokumentierter Termin, der hier NICHT enthalten ist, liegt unter gar keinem
  // (bzw. nur einem unsignierten) LN. Ein signierter Termin, der bloß per
  // Datumsbereich ausgeschlossen wird, ist hier enthalten → bewusst außerhalb, kein
  // stiller Verlust.
  const signedApptIdSet = new Set(allApptIds);
  const excludedAppointments: BillingExcludedAppointment[] = completedRows
    .filter(row => !billableApptIdSet.has(row.id))
    .map((row): BillingExcludedAppointment | null => {
      if (alreadyInvoicedIdSet.has(row.id)) {
        return { date: row.date, reason: "already_billed" };
      }
      if (awaitingSignatureApptIdSet.has(row.id)) {
        return { date: row.date, reason: missingSignatureReason };
      }
      // Task #1883 — completed-Termin ganz OHNE Leistungsnachweis (weder unter einem
      // signierten noch unter einem unsignierten LN). Fiel bisher STILL aus der
      // Rechnung (Kraft/Hentschel-Typ). Mit demselben „Unterschrift/LN fehlt"-Grund
      // erfassen, damit der Unterabrechnungs-Guard ihn sieht. Nur echte Nicht-LN-
      // Termine — datumsbereich-ausgeschlossene signierte Termine bleiben unmarkiert.
      if (!signedApptIdSet.has(row.id)) {
        return { date: row.date, reason: missingSignatureReason };
      }
      return null;
    })
    .filter((e): e is BillingExcludedAppointment => e !== null)
    .sort((a, b) => a.date.localeCompare(b.date));

  // Task #759 — Variant C: Pot-Split jetzt **immer** rechnen. Wenn nur ein
  // Pot belegt ist, fällt der Generator auf den Legacy-Single-Invoice-Pfad
  // zurück (Bestandskunden ohne Mehrtopf-Konfiguration sehen 0 Verhaltens-
  // änderung).
  const budgetSplit = await getBudgetSplitForAppointments(customerId, apptIds);
  const { lineItems: allLineItems, totalNetCents: singleNetCents, totalVatCents: singleVatCents } =
    await buildLineItemsFromAppointments(apptIds, customerId, billingType);

  const potItems = splitLineItemsByPot(allLineItems, budgetSplit, {
    // Task #1353 — Gate gegen verbotene Privatanteile (siehe
    // `splitLineItemsByPot`). Quelle ist dieselbe zentrale SSoT wie auf dem
    // Buchungs-/Rebook-Pfad: nur Selbstzahler oder `acceptsPrivatePayment`
    // dürfen einen privaten Anteil/Topf bekommen.
    allowPrivatePot: isPrivatePaymentAllowed({
      billingType: customer.billingType,
      acceptsPrivatePayment: customer.acceptsPrivatePayment,
    }),
  });

  // Selbstzahler-Kunden: Konsumption schreibt keinen Pot, alle Items
  // landen via fallbackPot=`"private"` in einem Eintrag → derselbe
  // Single-Invoice-Pfad wie vor #759, billingType=`selbstzahler`.
  // Reine Kassen-Kunden ohne acceptsPrivatePayment: identisch — nur ein
  // Kasse-Pot belegt (z.B. `entlastungsbetrag_45b`) → 1 Rechnung.
  // Task #1905 — Netto/USt/Brutto kommen aus DER EINEN Aggregation
  // `summarizePotAmounts` (oben), die auch die IST-Beträge der Karte „Noch zu
  // erstellen" speist. Die USt-Regel steht damit nur noch an einer Stelle.
  const amounts = summarizePotAmounts({
    potItems,
    billingType,
    builderNetCents: singleNetCents,
    builderVatCents: singleVatCents,
  });
  const { hasPrivateShare, needsBudgetSplit } = amounts;

  if (!needsBudgetSplit) {
    const { singlePotIsPrivate } = amounts;
    const effectiveVatCents = amounts.vatCents;
    return {
      customer,
      customerName,
      customerAddress,
      billingType,
      signedRecordCount: signedRecords.length,
      apptIds,
      alreadyInvoicedIds,
      completedAppointmentsInPeriod,
      alreadyBilledAppointmentCount,
      excludedAppointments,
      insuranceInfo,
      potItems,
      needsBudgetSplit: false,
      hasPrivateShare,
      singlePotIsPrivate,
      lineItems: allLineItems,
      kasseItems: [],
      privateItems: [],
      totalNetCents: singleNetCents,
      totalVatCents: effectiveVatCents,
      grossAmountCents: singleNetCents + effectiveVatCents,
      stornoRefsForInsert,
      defaultBuyerReference,
      invoiceDueDateIso,
    };
  }

  // Multi-Pot — Σ Netto + Σ USt über alle Folge-Rechnungen (Kasse-Pots 0 %,
  // Privat-Pot 19 %) kommen aus `summarizePotAmounts`; hier bleibt nur die
  // Aufteilung der Legacy-Item-Listen für `/preview`.
  const totalNet = amounts.netCents;
  const totalVat = amounts.vatCents;
  const legacyKasseItems: BuildLineItem[] = [];
  const legacyPrivateItems: BuildLineItem[] = [];
  for (const [pot, items] of potItems) {
    if (pot === "private") {
      legacyPrivateItems.push(...items);
    } else {
      legacyKasseItems.push(...items);
    }
  }

  return {
    customer,
    customerName,
    customerAddress,
    billingType,
    signedRecordCount: signedRecords.length,
    apptIds,
    alreadyInvoicedIds,
    completedAppointmentsInPeriod,
    alreadyBilledAppointmentCount,
    excludedAppointments,
    insuranceInfo,
    potItems,
    needsBudgetSplit: true,
    hasPrivateShare,
    singlePotIsPrivate: false,
    lineItems: allLineItems,
    kasseItems: legacyKasseItems,
    privateItems: legacyPrivateItems,
    totalNetCents: totalNet,
    totalVatCents: totalVat,
    grossAmountCents: totalNet + totalVat,
    stornoRefsForInsert,
    defaultBuyerReference,
    invoiceDueDateIso,
  };
}

// Task #533 / Security: Kern-Logik der Rechnungserstellung extrahiert,
// damit /generate-all die Logik direkt im selben Prozess aufrufen kann.
// Kein HTTP-Self-Call, kein Forwarden von Session-Cookies, kein
// Host-Header-SSRF-Risiko. /generate ist nur noch ein dünner Wrapper.
/**
 * Task #1883 — Guard gegen stille Unterabrechnung (Variante B, Confirm-to-proceed).
 * Wird geworfen, wenn beim Erstellen dokumentierte Termine mangels Kundenunterschrift
 * (nur `employee_signed`) ODER mangels Leistungsnachweis aus der Rechnung fielen und
 * die Teil-Abrechnung NICHT explizit bestätigt wurde. Trägt die betroffenen Termine,
 * damit `/generate` sie als 409 und `generate-all` sie als „übersprungen mit Ausweis"
 * melden kann — nichts fällt still.
 */
export class PartialBillingConfirmationRequiredError extends AppError {
  constructor(public excludedAppointments: BillingExcludedAppointment[]) {
    super(
      409,
      "PARTIAL_BILLING_CONFIRMATION_REQUIRED",
      `${excludedAppointments.length} dokumentierte${excludedAppointments.length === 1 ? "r Termin würde" : " Termine würden"} mangels Kundenunterschrift bzw. Leistungsnachweis nicht abgerechnet. Bitte die fehlenden Unterschriften/Leistungsnachweise einholen oder die Teil-Abrechnung des signierten Teils ausdrücklich bestätigen.`,
    );
    this.name = "PartialBillingConfirmationRequiredError";
  }
}

export async function generateInvoiceCore(
  input: { customerId: number; billingMonth: number; billingYear: number; dateFrom?: string; dateTo?: string; confirmPartial?: boolean },
  ctx: { userId: number; ipAddress?: string; testFaults: Set<string> },
): Promise<GenerateInvoiceResult> {
  const { customerId, billingMonth, billingYear, dateFrom, dateTo, confirmPartial } = input;
  // Lokales Shadow-`req`-Objekt, damit der unten kopierte Body unverändert
  // bleibt (`req.user!.id`, `req.ip`, `readTestFaults(req)` lesen weiterhin).
  const req = {
    user: { id: ctx.userId },
    ip: ctx.ipAddress,
    headers: {} as Record<string, string | string[] | undefined>,
  };
  // Faults sind bereits aus dem echten Request extrahiert — wir stellen
  // dem Body einen No-Op-Header-Bag zur Verfügung und überschreiben
  // readTestFaults-Aufrufe-Resultate über `ctx.testFaults` via Closure.
  const __testFaults = ctx.testFaults;
  const readTestFaults = (_: unknown): Set<string> => __testFaults;
  void readTestFaults; // wird unten verwendet

  // Task #750: gemeinsame Berechnung mit Preview — derselbe Helper, derselbe
  // Pfad. Verhindert Drift zwischen „Vorschau im Dialog" und finaler Rechnung.
  let draft = await buildInvoiceDraft({ customerId, billingMonth, billingYear, dateFrom, dateTo });

  // Task #1014: Netto-null-belegte Termine (alle Konsum-Buchungen storniert,
  // z.B. nach Rechnungs-Storno) werden bei der ERSTELLUNG — nicht in der
  // read-only Preview — frisch gebucht (GoBD-append-only Cascade). Sonst weist
  // die neue Rechnung einen Topf aus, den der Ledger weiter als verfügbar
  // führt → doppelte Topf-Belegung über zwei aktive Rechnungen. Nach der
  // Buchung den Draft neu bauen, damit der Split aus den Live-Zeilen kommt
  // (eine Quelle: die gebuchten Zeilen, garantiert deckungsgleich). Idempotent:
  // re-gebuchte Termine sind nicht mehr netto-null.
  const netZeroApptIds = await findNetZeroBilledAppointments(customerId, draft.apptIds);
  if (netZeroApptIds.length > 0) {
    const { rebookedAppointmentIds } = await rebookNetZeroAppointmentConsumption({
      customerId,
      appointmentIds: netZeroApptIds,
      userId: ctx.userId,
    });
    if (rebookedAppointmentIds.length > 0) {
      draft = await buildInvoiceDraft({ customerId, billingMonth, billingYear, dateFrom, dateTo });
    }
  }
  // Task #1883 — Guard gegen stille Unterabrechnung. Dokumentierte Termine, die
  // mangels Kundenunterschrift (nur `employee_signed`) ODER mangels Leistungsnachweis
  // NICHT auf die Rechnung kommen, dürfen nicht STILL fallen. Ohne explizites
  // `confirmPartial` bricht die Erstellung ab und meldet die betroffenen Termine
  // (Datum + Grund). `already_billed` (bewusst/bekannt) triggert NICHT. Eine SSoT:
  // dieselbe `excludedAppointments` wie Preview/`buildInvoiceDraft` — kein zweiter
  // Ausschluss-Begriff, insb. NICHT `isPartiallyDocumented` (das zählt
  // `employee_signed` als covered und verfehlte den 669-€-Fall).
  const silentlyDroppedAppointments = draft.excludedAppointments.filter(
    (e) => e.reason !== "already_billed",
  );
  if (silentlyDroppedAppointments.length > 0 && !confirmPartial) {
    throw new PartialBillingConfirmationRequiredError(silentlyDroppedAppointments);
  }

  const {
    customer,
    customerName,
    customerAddress,
    billingType,
    insuranceInfo,
    needsBudgetSplit,
    singlePotIsPrivate,
    potItems,
    lineItems,
    totalNetCents,
    totalVatCents,
    stornoRefsForInsert,
    defaultBuyerReference,
    invoiceDueDateIso,
  } = draft;

  if (needsBudgetSplit) {
    // Task #759 — Variant C: N-Invoice-Pfad mit gemeinsamer billingRunId.
    // Pro Pot eine eigene Rechnung mit pot-spezifischem Empfänger
    // (resolveBudgetRecipient), §-Notiz und Käuferreferenz.
    const billingRunId = randomUUID();
    // Task #1893 — Stichtag ist das ENDE des Abrechnungszeitraums, nicht „heute".
    // Vorher `todayISO()`: eine im Juli erstellte Juni-Rechnung löste damit sowohl
    // den Empfänger-Override als auch die Kasse gegen den Juli-Stand auf.
    const asOfIso = billingPeriodAsOfISO(billingYear, billingMonth, dateTo);

    const splitResult = await withAudit(async (tx, audit) => {
      // Nebenläufigkeit: erst den Kunden sperren, dann die Idempotenz IN der
      // Transaktion nachprüfen. Die Prüfung weiter oben (Zeile ~253) baut den
      // Entwurf, taugt aber nicht als Sperre — zwischen ihrem SELECT und diesem
      // INSERT lag ein offenes Fenster, in dem ein paralleler Lauf dieselben
      // Termine abrechnen konnte. Siehe `assertAppointmentsNotYetInvoiced`.
      await lockCustomerForBilling(tx, customerId);
      await assertAppointmentsNotYetInvoiced(tx, draft.apptIds);

      const createdInvoices: Invoice[] = [];
      // Deterministische Reihenfolge gemäß POT_ORDER — die Rechnungsnummern
      // folgen damit der gleichen Sortierung wie der Cascade.
      for (const pot of POT_ORDER) {
        const items = potItems.get(pot);
        if (!items || items.length === 0) continue;

        const isKasse = isKassePot(pot);
        // Empfänger: bei rechnungAnKunde adressiert der Generator alle
        // Kasse-Rechnungen weiterhin an den Kunden — der Resolver wird
        // umgangen, damit der Bestandskunde keine Verhaltens-Änderung sieht.
        let recipientName: string;
        let recipientAddress: string;
        let providerName: string | null = null;
        let ikNummer: string | null = null;
        let versichertennummer: string | null = null;
        let buyerReference: string | null = null;

        if (pot === "private") {
          recipientName = customerName;
          recipientAddress = customerAddress;
          if (insuranceInfo) {
            providerName = insuranceInfo.providerName;
            ikNummer = insuranceInfo.ikNummer;
            versichertennummer = insuranceInfo.versichertennummer;
          }
        } else if (isKasse && !customer.rechnungAnKunde) {
          const resolved = await resolveBudgetRecipient(customerId, pot, asOfIso);
          recipientName = resolved.recipientName;
          recipientAddress = resolved.recipientAddress ?? "";
          providerName = resolved.insuranceProviderName;
          ikNummer = resolved.ikNummer;
          versichertennummer = resolved.versichertennummer;
          buyerReference = defaultBuyerReference;
        } else {
          // Kasse-Pot + rechnungAnKunde → Kunde zahlt selbst, leitet zur
          // Pflegekasse weiter (Kostenerstattungsverfahren).
          recipientName = customerName;
          recipientAddress = customerAddress;
          if (insuranceInfo) {
            providerName = insuranceInfo.providerName;
            ikNummer = insuranceInfo.ikNummer;
            versichertennummer = insuranceInfo.versichertennummer;
          }
          buyerReference = defaultBuyerReference;
        }

        const netCents = items.reduce((s, i) => s + i.totalCents, 0);
        const vatCents = pot === "private" ? Math.round((netCents * STANDARD_VAT_RATE_BP) / 10000) : 0;
        const invoiceBillingType = pot === "private" ? "selbstzahler" : billingType;

        const invoiceNumber = await getNextInvoiceNumberTx(tx, billingYear);
        const invoiceData = {
          invoiceNumber,
          customerId,
          billingType: invoiceBillingType,
          invoiceType: "rechnung" as const,
          billingMonth,
          billingYear,
          recipientName,
          recipientAddress,
          customerName,
          insuranceProviderName: providerName,
          insuranceIkNummer: ikNummer,
          versichertennummer,
          pflegegrad: customer.pflegegrad || null,
          netAmountCents: netCents,
          vatAmountCents: vatCents,
          grossAmountCents: netCents + vatCents,
          vatRate: pot === "private" ? STANDARD_VAT_RATE_BP : 0,
          status: "entwurf",
          notes: getPotInvoiceNote(pot),
          // Pot-Marker + Lauf-Gruppierung für Cascade-Storno und Reporting.
          budgetType: pot === "private" ? null : pot,
          billingRunId,
          referencedStornoInvoiceIds: stornoRefsForInsert,
          dueDate: invoiceDueDateIso,
          buyerReference,
          assignmentDeclarationDate: null,
          assignmentDeclarationRef: null,
        };

        const invoice = await createInvoiceTx(tx, invoiceData, items as Record<string, unknown>[], req.user!.id);
        createdInvoices.push(invoice);

        audit.record({
          userId: req.user!.id,
          action: "invoice_created",
          entityType: "invoice",
          entityId: invoice.id,
          metadata: {
            invoiceNumber,
            customerId,
            billingType: invoiceBillingType,
            invoiceType: "rechnung",
            billingMonth,
            billingYear,
            grossAmountCents: netCents + vatCents,
            lineItemCount: items.length,
            budgetType: pot === "private" ? "private" : pot,
            billingRunId,
          },
          ipAddress: req.ip,
        });
      }
      return createdInvoices;
    }, { faults: readTestFaults(req) });

    // Task #544: PDF im Hintergrund persistieren (Bestand vor #759).
    for (const inv of splitResult) {
      schedulePdfPersistInBackground(inv.id);
    }

    if (splitResult.length === 1) {
      return splitResult[0];
    }
    return {
      splitInvoices: true as const,
      invoices: splitResult,
      message: `${splitResult.length} Rechnungen erstellt (1 Rechnung pro Budget-Topf, Lauf-ID ${billingRunId}).`,
    };
  }

  let recipientName = "";
  let recipientAddress = "";
  let insuranceProviderName = "";
  let insuranceIkNummer: string | null = "";
  let versichertennummer: string | null = "";

  if (billingType === "pflegekasse_gesetzlich" && !customer.rechnungAnKunde) {
    if (insuranceInfo) {
      const ins = insuranceInfo;
      recipientName = ins.empfaenger || ins.providerName;
      insuranceProviderName = ins.providerName;
      insuranceIkNummer = ins.ikNummer;
      versichertennummer = ins.versichertennummer;
      const addrParts: string[] = [];
      if (ins.empfaengerZeile2) addrParts.push(ins.empfaengerZeile2);
      if (ins.anschrift) {
        addrParts.push(ins.anschrift);
      } else if (ins.strasse) {
        addrParts.push([ins.strasse, ins.hausnummer].filter(Boolean).join(" "));
      }
      if (ins.plzOrt) {
        addrParts.push(ins.plzOrt);
      } else if (ins.plz || ins.stadt) {
        addrParts.push([ins.plz, ins.stadt].filter(Boolean).join(" "));
      }
      recipientAddress = addrParts.join("\n");
    } else {
      recipientName = customerName;
    }
  } else {
    recipientName = customerName;
    recipientAddress = customerAddress;

    if ((billingType === "pflegekasse_privat" || billingType === "pflegekasse_gesetzlich") && insuranceInfo) {
      insuranceProviderName = insuranceInfo.providerName;
      insuranceIkNummer = insuranceInfo.ikNummer;
      versichertennummer = insuranceInfo.versichertennummer;
    }
  }

  // Task #802: Einziger belegter Pot = „private" (z.B. Kasse-Kunde mit
  // §45b-Limit 0 + acceptsPrivatePayment) → Rechnung wird als Selbstzahler
  // mit 19% USt ausgewiesen, analog zum Privat-Anteil des Mehrtopf-Splits.
  // Empfänger/Versicherten-Metadaten bleiben über den Kunden-billingType
  // aufgelöst (siehe oben), nur der ausgewiesene Rechnungstyp + USt wechseln.
  const invoiceBillingType = singlePotIsPrivate ? "selbstzahler" : billingType;

  // Task #1094 — Den echten Budget-Topf der Single-Pot-Kassenrechnung
  // stempeln, damit der Renderer die pot-spezifische §-Notiz/Überschrift/
  // ZUGFeRD-Note verwendet, statt still auf die §45b-Formulierung
  // zurückzufallen. Selbstzahler-/Privat-Rechnungen (inkl. der
  // singlePotIsPrivate-Reklassifizierung) bleiben bewusst `budgetType=null`.
  const singlePotBudgetType = resolveSinglePotBudgetType(potItems);

  // Task #1094 — Lauter Invariant: Eine Kassen-Rechnung (pflegekasse_*) DARF
  // niemals ohne auflösbaren Budget-Topf versiegelt werden. Andernfalls würde
  // der Renderer still die §45b-Formulierung auf eine Rechnung stempeln, die
  // einen anderen Topf abrechnet (z.B. §45a allein) — rechtlich falsch, ohne
  // Fehler oder Feedback. Wir scheitern hier laut (Fehler + Audit-Trail), statt
  // uns auf den Render-Zeit-Fallback zu verlassen (der nur für versiegelte
  // Bestandsrechnungen mit `budgetType=null` reserviert bleibt).
  const isKasseInvoice =
    invoiceBillingType === "pflegekasse_gesetzlich" ||
    invoiceBillingType === "pflegekasse_privat";
  if (isKasseInvoice && !singlePotBudgetType) {
    await auditService.log(
      ctx.userId,
      "invoice_creation_pot_unresolved",
      "customer",
      customerId,
      {
        customerId,
        billingType: invoiceBillingType,
        billingMonth,
        billingYear,
        occupiedPots: Array.from(potItems.keys()),
      },
      ctx.ipAddress,
    );
    throw badRequest(
      `Rechnung kann nicht erstellt werden: Der Budget-Topf für die ` +
      `Kassenabrechnung (${customerName}, ${billingMonth}/${billingYear}) ` +
      `konnte nicht eindeutig bestimmt werden. Bitte prüfen Sie die ` +
      `Budget-Konfiguration und Buchungen für diesen Zeitraum.`,
    );
  }

  let invoice: Invoice;
  let invoiceNumber: string;
  try {
    ({ invoice, invoiceNumber } = await withAudit(async (tx, audit) => {
      // Siehe Split-Pfad oben: Kunden-Lock + autoritative Idempotenz-Prüfung
      // innerhalb der Transaktion. Beide Schreibpfade nutzen dieselben zwei
      // Funktionen — kein zweiter Sperr-Begriff.
      await lockCustomerForBilling(tx, customerId);
      await assertAppointmentsNotYetInvoiced(tx, draft.apptIds);

      const number = await getNextInvoiceNumberTx(tx, billingYear);
      const invoiceData = {
        invoiceNumber: number,
        customerId,
        billingType: invoiceBillingType,
        invoiceType: "rechnung",
        billingMonth,
        billingYear,
        recipientName,
        recipientAddress,
        customerName,
        insuranceProviderName: insuranceProviderName || null,
        insuranceIkNummer: insuranceIkNummer || null,
        versichertennummer: versichertennummer || null,
        pflegegrad: customer.pflegegrad || null,
        netAmountCents: totalNetCents,
        vatAmountCents: totalVatCents,
        grossAmountCents: totalNetCents + totalVatCents,
        vatRate: invoiceBillingType === "selbstzahler" ? STANDARD_VAT_RATE_BP : 0,
        status: "entwurf",
        // Task #1094 — echter Topf der Single-Pot-Kassenrechnung (null für
        // Selbstzahler/Privat). Damit greift der pot-spezifische Renderer
        // statt des §45b-Render-Zeit-Fallbacks (der nur Bestand mit NULL trifft).
        budgetType: singlePotBudgetType,
        referencedStornoInvoiceIds: stornoRefsForInsert,
        dueDate: invoiceDueDateIso,
        buyerReference: defaultBuyerReference,
        assignmentDeclarationDate: null,
        assignmentDeclarationRef: null,
      };
      const created = await createInvoiceTx(tx, invoiceData, lineItems as Record<string, unknown>[], req.user!.id);
      audit.record({
        userId: req.user!.id,
        action: "invoice_created",
        entityType: "invoice",
        entityId: created.id,
        metadata: {
          invoiceNumber: number,
          customerId,
          billingType: invoiceBillingType,
          invoiceType: "rechnung",
          billingMonth,
          billingYear,
          grossAmountCents: totalNetCents + totalVatCents,
          lineItemCount: lineItems.length,
          budgetType: singlePotBudgetType,
        },
        ipAddress: req.ip,
      });
      return { invoice: created, invoiceNumber: number };
    }, { faults: readTestFaults(req) }));
  } catch (err) {
    console.error("[billing/generate] Invoice insert failed.", {
      customerId,
      billingMonth,
      billingYear,
      lineItemCount: lineItems.length,
      sampleItem: lineItems[0] ? {
        appointmentDate: lineItems[0].appointmentDate,
        durationMinutes: lineItems[0].durationMinutes,
        unitPriceCents: lineItems[0].unitPriceCents,
        totalCents: lineItems[0].totalCents,
        serviceCode: lineItems[0].serviceCode,
      } : null,
    });
    throw err;
  }

  // Task #544: PDF im Hintergrund persistieren — der HTTP-Request darf nicht
  // auf Puppeteer warten. GET /:id/pdf erzeugt das PDF on-demand nach,
  // falls der Hintergrund-Render noch nicht durch ist.
  schedulePdfPersistInBackground(invoice.id);
  return invoice;
}
