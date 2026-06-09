/**
 * Task #1097 — Historische Kassen-Rechnungen mit FALSCHEM §-Paragraphen aufspüren.
 *
 * Problem
 * -------
 * Vor Task #1094 wurden Single-Pot-Kassenrechnungen, die ausschließlich aus
 * EINEM Nicht-§45b-Topf bestanden (§45a Umwandlungsanspruch ODER §§39/42a
 * Verhinderungspflege), mit `invoices.budget_type = NULL` versiegelt. Der
 * PDF-/ZUGFeRD-Renderer fällt bei fehlendem `budget_type` auf die
 * §45b-Formulierung zurück (siehe `getBillingTypeNote`/`getBudgettopfLabel` in
 * `server/lib/pdf-generator.ts` und die Notes in `server/lib/zugferd.ts`).
 * Für eine reine §45a- oder §§39/42a-Rechnung ist das rechtlich FALSCH.
 *
 * Wir haben Bestandsrechnungen BEWUSST NICHT nachträglich neu versiegelt
 * (GoBD-Byte-Stabilität — ein Re-Render reproduziert den versiegelten
 * `pdf_hash` ohnehin nicht). Der Betrieb braucht aber Sichtbarkeit, WELCHE
 * bereits ausgestellten Rechnungen betroffen sind, um pro Fall zu entscheiden
 * (z.B. Storno + Neuausstellung).
 *
 * Erkennung (read-only)
 * ---------------------
 * Kandidaten = Rechnungen mit `budget_type IS NULL`, Pflegekassen-Abrechnung
 * (`billing_type IN ('pflegekasse_gesetzlich','pflegekasse_privat')`), KEINE
 * Stornorechnung, nicht storniert, nicht soft-deleted.
 *
 * Pro Kandidat werden die Termin-IDs aus den Line-Items gelesen und der
 * LEBENDE Budget-Split der zugehörigen Konsumptionen rekonstruiert — über
 * `buildBudgetSplitFromLedger` aus `shared/domain/budget-invoice-split.ts`,
 * also exakt dieselbe Storno-bereinigte SSoT, die auch der Live-Rechnungs-Split
 * (`getBudgetSplitForAppointments`) verwendet (verknüpfte UND NOTE-basierte
 * Waisen-Stornos werden ausgeschlossen).
 *
 * Eine Rechnung wird als BETROFFEN gemeldet, wenn die lebenden Konsumptionen
 * GENAU EINEN Kasse-Topf belegen und dieser Topf NICHT §45b ist
 * (also `umwandlung_45a` oder `ersatzpflege_39_42a`). Ein eventueller
 * Privatanteil daneben ändert nichts — die ganze Single-Pot-Rechnung trägt im
 * Renderer die falsche §45b-Formulierung.
 *
 * Nicht betroffen / übersprungen:
 *   - Single-Pot §45b → §45b-Fallback ist korrekt.
 *   - Mehrere Kasse-Töpfe → wäre historisch nie als `budget_type=NULL`
 *     entstanden (Mehrtopf erzeugt je Topf eine eigene Rechnung); falls doch
 *     gefunden, separat als „mehrdeutig" gezählt, nicht als eindeutig falsch.
 *   - Nur Privat-/Selbstzahler-Anteil → kein Kassen-Paragraph.
 *   - Keine lebende Konsumption / keine Termin-Bindung → nicht bewertbar.
 *
 * Sicherheit / GoBD
 * -----------------
 * Reiner Lesepfad. KEINE Schreiboperation, kein `--apply`. Produktionssicher.
 *
 * Aufruf
 * ------
 *   - Alle Kunden:    tsx server/scripts/report-wrong-paragraph-kasse-invoices.ts
 *   - Einzelne:       tsx server/scripts/report-wrong-paragraph-kasse-invoices.ts --customer=39,95
 *   - Inkl. Entwürfe: tsx server/scripts/report-wrong-paragraph-kasse-invoices.ts --include-drafts
 *   - JSON-Ausgabe:   tsx server/scripts/report-wrong-paragraph-kasse-invoices.ts --json
 *
 * Standardmäßig werden Entwürfe (`status='entwurf'`) ausgeblendet, da diese vor
 * dem Versand ohnehin neu (jetzt korrekt) gerendert werden. `--include-drafts`
 * nimmt sie zur Vollständigkeit mit auf (separat markiert).
 *
 * Exit-Code: 0 = keine betroffene Rechnung gefunden, 1 = mindestens eine
 * gefunden (Skript-/CI-freundliches Signal).
 */

import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
// invoices has no soft-delete column; cancellations are modeled via status='storniert'.
import { db } from "../lib/db";
import {
  budgetTransactions,
  customers,
  invoices as invoicesTable,
  invoiceLineItems,
} from "@shared/schema";
import {
  buildBudgetSplitFromLedger,
  isPrivatePot,
  POT_DISPLAY_LABELS,
  type InvoicePotKey,
  type SplitConsumptionRow,
  type SplitReversalRow,
} from "@shared/domain/budget-invoice-split";

const PFLEGEKASSE_BILLING_TYPES = ["pflegekasse_gesetzlich", "pflegekasse_privat"] as const;

interface Args {
  customerIds: number[];
  includeDrafts: boolean;
  json: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (p: string) => argv.find((a) => a.startsWith(p))?.split("=")[1];
  const customerArg = get("--customer=");
  const customerIds: number[] = [];
  if (customerArg) {
    for (const idStr of customerArg.split(",")) {
      const n = parseInt(idStr.trim(), 10);
      if (!Number.isNaN(n)) customerIds.push(n);
    }
  }
  return {
    customerIds,
    includeDrafts: argv.includes("--include-drafts"),
    json: argv.includes("--json"),
  };
}

export interface WrongParagraphFinding {
  invoiceId: number;
  invoiceNumber: string;
  customerId: number;
  customerName: string;
  billingType: string;
  status: string;
  isDraft: boolean;
  billingMonth: number;
  billingYear: number;
  grossAmountCents: number;
  /** Der EINE lebende Kasse-Topf, der real belegt ist (§45a oder §39/42a). */
  actualPotKey: InvoicePotKey;
  /** Σ lebende Konsumption (in Cent) im tatsächlichen Topf. */
  actualPotConsumptionCents: number;
  /** Σ lebender Privatanteil (in Cent), falls vorhanden. */
  privateConsumptionCents: number;
  appointmentIds: number[];
}

export interface WrongParagraphSummary {
  candidatesScanned: number;
  findings: WrongParagraphFinding[];
  /** Kandidaten mit mehreren lebenden Kasse-Töpfen (mehrdeutig, nicht eindeutig falsch). */
  ambiguousMultiPotCount: number;
}

/** Lädt die zu prüfenden Pflegekassen-Rechnungen mit `budget_type IS NULL`. */
async function loadCandidateInvoices(args: Args) {
  const whereParts = [
    isNull(invoicesTable.budgetType),
    ne(invoicesTable.invoiceType, "stornorechnung"),
    ne(invoicesTable.status, "storniert"),
    inArray(invoicesTable.billingType, [...PFLEGEKASSE_BILLING_TYPES]),
  ];
  if (!args.includeDrafts) {
    whereParts.push(ne(invoicesTable.status, "entwurf"));
  }
  if (args.customerIds.length > 0) {
    whereParts.push(inArray(invoicesTable.customerId, args.customerIds));
  }
  return db
    .select({
      id: invoicesTable.id,
      invoiceNumber: invoicesTable.invoiceNumber,
      customerId: invoicesTable.customerId,
      billingType: invoicesTable.billingType,
      status: invoicesTable.status,
      billingMonth: invoicesTable.billingMonth,
      billingYear: invoicesTable.billingYear,
      grossAmountCents: invoicesTable.grossAmountCents,
    })
    .from(invoicesTable)
    .where(and(...whereParts));
}

async function loadAppointmentIdsForInvoice(invoiceId: number): Promise<number[]> {
  const rows = await db
    .select({ appointmentId: invoiceLineItems.appointmentId })
    .from(invoiceLineItems)
    .where(eq(invoiceLineItems.invoiceId, invoiceId));
  return Array.from(
    new Set(rows.map((r) => r.appointmentId).filter((id): id is number => id != null)),
  );
}

/**
 * Lädt Konsumptions- und Reversal-Zeilen eines Kunden für die übergebenen
 * Termine — dieselbe Quelle/Form wie `getBudgetSplitForAppointments` und
 * `reconcile-phantom-pot-invoices.ts`.
 */
async function loadLedgerForAppointments(
  customerId: number,
  apptIds: number[],
): Promise<{ consumptions: SplitConsumptionRow[]; reversals: SplitReversalRow[] }> {
  if (apptIds.length === 0) return { consumptions: [], reversals: [] };

  const txns = await db
    .select({
      id: budgetTransactions.id,
      appointmentId: budgetTransactions.appointmentId,
      budgetType: budgetTransactions.budgetType,
      amountCents: budgetTransactions.amountCents,
    })
    .from(budgetTransactions)
    .where(
      and(
        eq(budgetTransactions.customerId, customerId),
        inArray(budgetTransactions.appointmentId, apptIds),
        eq(budgetTransactions.transactionType, "consumption"),
      ),
    );

  const consumptionIds = txns.map((t) => t.id);
  const reversalRows = consumptionIds.length === 0
    ? []
    : await db
        .select({
          reversedTransactionId: budgetTransactions.reversedTransactionId,
          notes: budgetTransactions.notes,
        })
        .from(budgetTransactions)
        .where(
          and(
            eq(budgetTransactions.customerId, customerId),
            eq(budgetTransactions.transactionType, "reversal"),
            or(
              inArray(budgetTransactions.reversedTransactionId, consumptionIds),
              inArray(budgetTransactions.appointmentId, apptIds),
            ),
          ),
        );

  return { consumptions: txns, reversals: reversalRows };
}

/**
 * Aggregiert den lebenden (Storno-bereinigten) Budget-Split über ALLE Termine
 * der Rechnung zu Σ-Cents je Pot.
 */
function aggregateLivePots(
  consumptions: SplitConsumptionRow[],
  reversals: SplitReversalRow[],
): Map<InvoicePotKey, number> {
  const perAppt = buildBudgetSplitFromLedger(consumptions, reversals);
  const totals = new Map<InvoicePotKey, number>();
  for (const split of perAppt.values()) {
    for (const [pot, cents] of Object.entries(split.cents) as [InvoicePotKey, number][]) {
      if (!cents) continue;
      totals.set(pot, (totals.get(pot) ?? 0) + cents);
    }
  }
  return totals;
}

export async function reportWrongParagraphKasseInvoices(args: Args): Promise<WrongParagraphSummary> {
  const candidates = await loadCandidateInvoices(args);

  // Kundennamen vorab laden.
  const cids = Array.from(new Set(candidates.map((c) => c.customerId)));
  const names = new Map<number, string>();
  if (cids.length > 0) {
    const rows = await db
      .select({ id: customers.id, name: customers.name })
      .from(customers)
      .where(inArray(customers.id, cids));
    for (const r of rows) names.set(r.id, r.name ?? "");
  }

  const findings: WrongParagraphFinding[] = [];
  let ambiguousMultiPotCount = 0;

  for (const inv of candidates) {
    const apptIds = await loadAppointmentIdsForInvoice(inv.id);
    if (apptIds.length === 0) continue; // keine Termin-Bindung → nicht bewertbar

    const { consumptions, reversals } = await loadLedgerForAppointments(inv.customerId, apptIds);
    const livePots = aggregateLivePots(consumptions, reversals);

    const kassePots = Array.from(livePots.entries()).filter(([pot]) => !isPrivatePot(pot));
    if (kassePots.length === 0) continue; // nur Privat / keine lebende Kasse-Konsumption

    if (kassePots.length > 1) {
      ambiguousMultiPotCount++;
      continue; // mehrere Kasse-Töpfe → nicht eindeutig falsch
    }

    const [actualPotKey, actualPotConsumptionCents] = kassePots[0];
    // Single-Pot §45b → §45b-Fallback im Renderer ist korrekt → nicht betroffen.
    if (actualPotKey === "entlastungsbetrag_45b") continue;

    findings.push({
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      customerId: inv.customerId,
      customerName: names.get(inv.customerId) ?? "",
      billingType: inv.billingType,
      status: inv.status,
      isDraft: inv.status === "entwurf",
      billingMonth: inv.billingMonth,
      billingYear: inv.billingYear,
      grossAmountCents: inv.grossAmountCents,
      actualPotKey,
      actualPotConsumptionCents,
      privateConsumptionCents: livePots.get("private") ?? 0,
      appointmentIds: apptIds,
    });
  }

  return { candidatesScanned: candidates.length, findings, ambiguousMultiPotCount };
}

function eur(cents: number): string {
  return `${(cents / 100).toFixed(2)} €`;
}

async function main() {
  const args = parseArgs();
  const summary = await reportWrongParagraphKasseInvoices(args);

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    process.exit(summary.findings.length === 0 ? 0 : 1);
  }

  console.log(`\n=== Falsche §-Paragraphen in Bestands-Kassenrechnungen · Task #1097 ===`);
  console.log(`Modus:    Trockenlauf (read-only)`);
  console.log(`Kunden:   ${args.customerIds.length > 0 ? args.customerIds.join(", ") : "ALLE"}`);
  console.log(`Entwürfe: ${args.includeDrafts ? "inkludiert" : "ausgeblendet (Standard)"}`);

  console.log(`\nGeprüfte budget_type=NULL Kassenrechnungen: ${summary.candidatesScanned}`);
  console.log(`Betroffene Rechnungen (falscher Paragraph):  ${summary.findings.length}`);
  if (summary.ambiguousMultiPotCount > 0) {
    console.log(`Mehrdeutig (mehrere Kasse-Töpfe, übersprungen): ${summary.ambiguousMultiPotCount}`);
  }

  if (summary.findings.length === 0) {
    console.log("\n✓ Keine Bestandsrechnung mit falschem §-Paragraphen gefunden.");
    process.exit(0);
  }

  // Gruppiert nach Kunde, dann Periode (Jahr/Monat).
  const byCustomer = new Map<number, WrongParagraphFinding[]>();
  for (const f of summary.findings) {
    const list = byCustomer.get(f.customerId) ?? [];
    list.push(f);
    byCustomer.set(f.customerId, list);
  }

  let total = 0;
  for (const customerId of Array.from(byCustomer.keys()).sort((a, b) => a - b)) {
    const list = byCustomer.get(customerId)!;
    list.sort((a, b) =>
      a.billingYear - b.billingYear || a.billingMonth - b.billingMonth || a.invoiceId - b.invoiceId,
    );
    console.log(`\nKunde #${customerId} ${list[0].customerName}`);
    for (const f of list) {
      total += f.grossAmountCents;
      const period = `${f.billingYear}-${String(f.billingMonth).padStart(2, "0")}`;
      const draftTag = f.isDraft ? " [ENTWURF]" : "";
      const privTag = f.privateConsumptionCents > 0
        ? ` (+ Privatanteil ${eur(f.privateConsumptionCents)})`
        : "";
      console.log(
        `  ${period} · Rechnung ${f.invoiceNumber} [${f.status}]${draftTag} · Brutto ${eur(f.grossAmountCents)}` +
          `\n    Gerendert als: §45b (Fallback, FALSCH)` +
          `\n    Tatsächlicher Topf: ${POT_DISPLAY_LABELS[f.actualPotKey]} · Verbrauch ${eur(f.actualPotConsumptionCents)}${privTag}` +
          `\n    Termine: ${f.appointmentIds.join(", ")}`,
      );
    }
  }

  console.log(`\nSumme Brutto der betroffenen Rechnungen: ${eur(total)}`);
  console.log(
    "\nHinweis: Read-only. Bestandsrechnungen wurden bewusst NICHT neu versiegelt" +
      "\n  (GoBD-Byte-Stabilität). Bitte pro Fall entscheiden (z.B. Storno + Neuausstellung).",
  );

  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fehler:", err);
    process.exit(1);
  });
}
