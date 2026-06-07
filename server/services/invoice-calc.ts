import { badRequest, notFound } from "../lib/errors";
import { splitLineItemsAcrossPots, POT_ORDER, type InvoicePotKey, type BudgetSplitForAppointment } from "@shared/domain/budget-invoice-split";
import type { BudgetType } from "@shared/domain/budgets";
import { resolveBudgetRecipient } from "../storage/budget-recipients";
import { randomUUID } from "crypto";
import { appointments, invoices as invoicesTable, type Invoice } from "@shared/schema";
import { eq, and, gte, lt, ne } from "drizzle-orm";
import { z } from "zod";
import { todayISO, addDays } from "@shared/utils/datetime";
import { STANDARD_VAT_RATE_BP } from "@shared/domain/invoice-vat";
import { storage } from "../storage";
import { db } from "../lib/db";
import { appointmentsRepo } from "../repos";
import { getNextInvoiceNumberTx, createInvoiceTx } from "../storage/billing-storage";
import { withAudit } from "../lib/with-audit";
import { readTestFaults } from "../lib/test-fault-injector";
import { getCachedCompanySettings } from "./cache";
import { schedulePdfPersistInBackground } from "./invoice-pdf-orchestrator";
import { getAlreadyInvoicedAppointmentIds, getServiceRecordsForPeriod, getAppointmentIdsFromServiceRecords, buildLineItemsFromAppointments, getBudgetSplitForAppointments, getInsuranceData, findNetZeroBilledAppointments } from "./invoice-data";
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
): Map<InvoicePotKey, BuildLineItem[]> {
  const shares = splitLineItemsAcrossPots(lineItems, budgetSplit, {
    fallbackPot: "private",
  });
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

export async function buildInvoiceDraft(input: {
  customerId: number;
  billingMonth: number;
  billingYear: number;
}): Promise<InvoiceDraft> {
  const { customerId, billingMonth, billingYear } = input;

  const customer = await storage.getCustomer(customerId);
  if (!customer) throw notFound("Kunde nicht gefunden");

  // Task #562 — Fälligkeit (BT-9): zentral aus den Firmenstammdaten.
  const companySettingsForInvoice = await getCachedCompanySettings();
  const dueDays = companySettingsForInvoice?.invoiceDefaultDueDays ?? 30;
  const invoiceIssueIso = todayISO();
  const invoiceDueDateIso = addDays(invoiceIssueIso, dueDays);

  // Task #562 — Käuferreferenz (BT-10) für Pflegekassen.
  const insuranceInfo = await getInsuranceData(customerId);
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

  const signedRecords = serviceRecords.filter(sr =>
    sr.status === "completed" || sr.status === "employee_signed"
  );
  if (signedRecords.length === 0) {
    throw badRequest("Der Leistungsnachweis wurde noch nicht unterschrieben. Bitte lassen Sie den Leistungsnachweis zuerst vom Mitarbeiter unterschreiben.");
  }

  const serviceRecordIds = signedRecords.map(sr => sr.id);
  const allApptIds = await getAppointmentIdsFromServiceRecords(serviceRecordIds);
  if (allApptIds.length === 0) {
    throw badRequest("Der Leistungsnachweis enthält keine Termine.");
  }

  const alreadyInvoicedIds = await getAlreadyInvoicedAppointmentIds(customerId, billingYear, billingMonth);

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

  const apptIds = alreadyInvoicedIds.length > 0
    ? allApptIds.filter(id => !alreadyInvoicedIds.includes(id))
    : allApptIds;
  if (apptIds.length === 0) {
    throw badRequest("Alle Termine aus dem Leistungsnachweis wurden bereits abgerechnet.");
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
  const completedRows = await appointmentsRepo.selectColumnsFrom({ id: appointments.id })
    .where(and(
      eq(appointments.customerId, customerId),
      eq(appointments.status, "completed"),
      appointmentsRepo.activeOnly(),
      gte(appointments.date, periodStartStr),
      lt(appointments.date, periodEndStr),
    ));
  const completedAppointmentsInPeriod = completedRows.length;

  // Task #759 — Variant C: Pot-Split jetzt **immer** rechnen. Wenn nur ein
  // Pot belegt ist, fällt der Generator auf den Legacy-Single-Invoice-Pfad
  // zurück (Bestandskunden ohne Mehrtopf-Konfiguration sehen 0 Verhaltens-
  // änderung).
  const budgetSplit = await getBudgetSplitForAppointments(customerId, apptIds);
  const { lineItems: allLineItems, totalNetCents: singleNetCents, totalVatCents: singleVatCents } =
    await buildLineItemsFromAppointments(apptIds, customerId, billingType);

  const potItems = splitLineItemsByPot(allLineItems, budgetSplit);

  // Selbstzahler-Kunden: Konsumption schreibt keinen Pot, alle Items
  // landen via fallbackPot=`"private"` in einem Eintrag → derselbe
  // Single-Invoice-Pfad wie vor #759, billingType=`selbstzahler`.
  // Reine Kassen-Kunden ohne acceptsPrivatePayment: identisch — nur ein
  // Kasse-Pot belegt (z.B. `entlastungsbetrag_45b`) → 1 Rechnung.
  const hasPrivateShare = potItems.has("private");
  const needsBudgetSplit = potItems.size > 1;

  if (!needsBudgetSplit) {
    // Wenn der einzige belegte Pot „private" ist (z.B. Kassen-Kunde mit
    // §45b-Limit = 0 und acceptsPrivatePayment → alle Kosten landen privat),
    // muss die Single-Invoice genauso wie der Privat-Anteil eines Mehrtopf-
    // Splits als Selbstzahler-Rechnung mit 19% USt ausgewiesen werden.
    // `buildLineItemsFromAppointments` rechnete die USt mit dem Kunden-
    // billingType (USt-befreit) → 0; deshalb hier auf den Privat-Satz
    // umrechnen (spiegelt den Split-Pfad, Aggregat-Rundung wie dort).
    const singlePotIsPrivate = hasPrivateShare && potItems.size === 1;
    const reclassifyToSelbstzahler = singlePotIsPrivate && billingType !== "selbstzahler";
    const effectiveVatCents = reclassifyToSelbstzahler
      ? Math.round((singleNetCents * STANDARD_VAT_RATE_BP) / 10000)
      : singleVatCents;
    return {
      customer,
      customerName,
      customerAddress,
      billingType,
      signedRecordCount: signedRecords.length,
      apptIds,
      alreadyInvoicedIds,
      completedAppointmentsInPeriod,
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

  // Multi-Pot — Σ Netto + Σ USt über alle Folge-Rechnungen.
  // Kasse-Pots VAT 0, Privat-Pot VAT 19% (spiegelt Bestand vor #759 + den
  // Insert-Pfad in `generateInvoiceCore`).
  let totalNet = 0;
  let totalVat = 0;
  const legacyKasseItems: BuildLineItem[] = [];
  const legacyPrivateItems: BuildLineItem[] = [];
  for (const [pot, items] of potItems) {
    const net = items.reduce((s, i) => s + i.totalCents, 0);
    totalNet += net;
    if (pot === "private") {
      totalVat += Math.round((net * STANDARD_VAT_RATE_BP) / 10000);
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
export async function generateInvoiceCore(
  input: { customerId: number; billingMonth: number; billingYear: number },
  ctx: { userId: number; ipAddress?: string; testFaults: Set<string> },
): Promise<GenerateInvoiceResult> {
  const { customerId, billingMonth, billingYear } = input;
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
  let draft = await buildInvoiceDraft({ customerId, billingMonth, billingYear });

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
      draft = await buildInvoiceDraft({ customerId, billingMonth, billingYear });
    }
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
    const asOfIso = todayISO();

    const splitResult = await withAudit(async (tx, audit) => {
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

  let invoice: Invoice;
  let invoiceNumber: string;
  try {
    ({ invoice, invoiceNumber } = await withAudit(async (tx, audit) => {
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
