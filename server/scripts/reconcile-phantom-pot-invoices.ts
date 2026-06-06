/**
 * Task #1016 — Bereits ausgestellte überflüssige Phantom-Topf-Rechnungen
 * aufspüren und (optional) GoBD-konform stornieren.
 *
 * Problem
 * -------
 * Task #1012 verhindert NUR die NEU-Entstehung überflüssiger Folge-Rechnungen
 * aus einem Budget-Topf, dessen Konsumption ausschließlich aus stornierten
 * `budget_transactions` besteht (z.B. die §45a-Phantom-Aufteilung im
 * Egon-Uhlig-Fall). BEREITS ausgestellte Rechnungen bleiben jedoch im Bestand.
 *
 * Dieses Skript findet pot-spezifische Rechnungen (`invoices.budget_type` ist
 * gesetzt, nicht storniert, keine Stornorechnung), deren zugeordneter Topf für
 * die Rechnungs-Termine VOLLSTÄNDIG storniert ist — es GAB Konsumption in
 * diesem Topf, aber netto bleibt keine lebende Konsumption mehr. Eine solche
 * Rechnung repräsentiert einen Topf, der real (netto) gar nicht belegt ist.
 *
 * Erkennung (SSoT)
 * ----------------
 * Pro Kandidaten-Rechnung werden die Termin-IDs aus den Line-Items gelesen und
 * `isPotEntirelyReversed(consumptions, reversals, potKey)` aus
 * `shared/domain/budget-invoice-split.ts` ausgewertet — DERSELBE Storno-Begriff
 * (verknüpfte UND NOTE-basierte Waisen-Stornos), den auch der Live-Rechnungs-
 * Split (`getBudgetSplitForAppointments`) verwendet.
 *
 * Storno-Pfad (--apply)
 * ---------------------
 * Für eine Phantom-Topf-Rechnung ist der Budget-Ledger BEREITS korrekt (der
 * Topf ist ja schon vollständig storniert — genau deshalb ist die Rechnung
 * phantom). Die Korrektur ist daher rein DOKUMENT-Ebene:
 *   - eine Stornorechnung (alle Beträge negiert, Line-Items 1:1 negiert) wird
 *     angelegt (kein Hard-Delete, GoBD),
 *   - die Originalrechnung wechselt auf Status `storniert`,
 *   - ein `invoice_cancelled`-Audit-Eintrag wird geschrieben.
 *
 * WICHTIG: Es wird BEWUSST KEINE Budget-Reversierung pro Termin ausgeführt
 * (anders als der Cascade-Storno der `PATCH /api/billing/:id/status`-Route).
 * Die Rechnungs-Termine teilen sich i.d.R. denselben Termin mit der LEBENDEN
 * §45b-Geschwister-Rechnung; ein „alle Konsumptionen des Termins stornieren"
 * würde fälschlich die noch lebende §45b-Konsumption zurückbuchen. Da der
 * Phantom-Topf bereits netto-null ist, ist nichts (mehr) zu reversieren.
 * Geschwister-Rechnungen anderer Töpfe (z.B. §45b) bleiben unangetastet.
 *
 * Sicherheit / GoBD
 * -----------------
 *   - Trockenlauf ist Default; `--apply` schreibt erst nach explizitem Opt-in.
 *   - `--apply` erfordert `--user=<superadmin-id>` (Audit-Attribution, nur
 *     Superadmins) UND `--reason="…"` (≥10 Zeichen, landet im Audit-Log).
 *   - Reiner Append-Pfad: kein DELETE/UPDATE außer dem Status-Wechsel der
 *     Originalrechnung auf `storniert` (= regulärer Storno-Trail).
 *
 * Aufruf
 * ------
 *   - Trockenlauf (alle):  tsx server/scripts/reconcile-phantom-pot-invoices.ts
 *   - Einzelne Kunden:     tsx server/scripts/reconcile-phantom-pot-invoices.ts --customer=39,95
 *   - Scharf:              tsx server/scripts/reconcile-phantom-pot-invoices.ts --apply \
 *                            --user=<superadmin-id> --reason="Phantom-Topf-Rechnung #1016"
 *
 * Exit-Code: 0 = keine Phantom-Topf-Rechnung gefunden, 1 = mindestens eine
 * gefunden (Skript-/CI-freundliches Signal). `--apply` ändert den Exit-Code nicht.
 */

import { and, eq, inArray, ne, or } from "drizzle-orm";
import { db } from "../lib/db";
import {
  appointments,
  budgetTransactions,
  customers,
  invoices as invoicesTable,
  invoiceLineItems,
  users,
  type Invoice,
  type InvoiceLineItem,
} from "@shared/schema";
import {
  isPotEntirelyReversed,
  toPotKey,
  POT_DISPLAY_LABELS,
  type InvoicePotKey,
  type SplitConsumptionRow,
  type SplitReversalRow,
} from "@shared/domain/budget-invoice-split";
import { withAudit } from "../lib/with-audit";
import {
  createInvoiceTx,
  getInvoiceForUpdateTx,
  getInvoiceLineItemsTx,
  getNextInvoiceNumberTx,
  updateInvoiceStatusTx,
} from "../storage/billing-storage";
import { getCachedCompanySettings } from "../services/cache";
import { schedulePdfPersistInBackground, persistInvoicePdf } from "../services/invoice-pdf-orchestrator";
import { todayISO, addDays } from "@shared/utils/datetime";
import type { Tx } from "../lib/db";

interface Args {
  apply: boolean;
  customerIds: number[];
  userId?: number;
  reason?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (p: string) => argv.find((a) => a.startsWith(p))?.split("=")[1];
  const apply = argv.includes("--apply");
  const customerArg = get("--customer=");
  const customerIds: number[] = [];
  if (customerArg) {
    for (const idStr of customerArg.split(",")) {
      const n = parseInt(idStr.trim(), 10);
      if (!Number.isNaN(n)) customerIds.push(n);
    }
  }
  const userArg = get("--user=");
  const userId = userArg ? parseInt(userArg, 10) : undefined;
  return {
    apply,
    customerIds,
    userId: userId !== undefined && Number.isFinite(userId) ? userId : undefined,
    reason: get("--reason="),
  };
}

async function assertSuperadminOrThrow(userId: number): Promise<void> {
  const [row] = await db
    .select({ id: users.id, isSuperAdmin: users.isSuperAdmin, isActive: users.isActive, displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw new Error(`--user=${userId}: User existiert nicht`);
  if (!row.isActive) throw new Error(`--user=${userId} (${row.displayName}) ist inaktiv`);
  if (!row.isSuperAdmin) {
    throw new Error(
      `--user=${userId} (${row.displayName}) ist kein Superadmin. ` +
        `Phantom-Topf-Rechnungs-Stornos sind Task #1016 explizit auf Superadmins beschränkt.`,
    );
  }
}

export interface PhantomInvoiceFinding {
  invoiceId: number;
  invoiceNumber: string;
  customerId: number;
  budgetType: string;
  potKey: InvoicePotKey;
  status: string;
  grossAmountCents: number;
  billingRunId: string | null;
  appointmentIds: number[];
  /** Σ |Betrag| der (stornierten) Konsumptionen dieses Topfes. */
  reversedConsumptionCents: number;
}

export interface PhantomReconcileSummary {
  apply: boolean;
  candidatesScanned: number;
  findings: PhantomInvoiceFinding[];
  stornoedCount: number;
}

/** Lädt die zu prüfenden pot-spezifischen, nicht-stornierten Rechnungen. */
async function loadCandidateInvoices(customerIds: number[]) {
  const whereParts = [
    // Nur pot-spezifische Rechnungen (Selbstzahler/Bestand haben budget_type NULL).
    ne(invoicesTable.invoiceType, "stornorechnung"),
    ne(invoicesTable.status, "storniert"),
  ];
  if (customerIds.length > 0) {
    whereParts.push(inArray(invoicesTable.customerId, customerIds));
  }
  const rows = await db
    .select({
      id: invoicesTable.id,
      invoiceNumber: invoicesTable.invoiceNumber,
      customerId: invoicesTable.customerId,
      budgetType: invoicesTable.budgetType,
      status: invoicesTable.status,
      grossAmountCents: invoicesTable.grossAmountCents,
      billingRunId: invoicesTable.billingRunId,
    })
    .from(invoicesTable)
    .where(and(...whereParts));
  // budget_type IS NOT NULL erst hier filtern (drizzle isNotNull spart Boilerplate,
  // aber wir wollen den potKey sauber typisieren).
  return rows.filter((r): r is typeof r & { budgetType: string } => r.budgetType != null);
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
 * Termine — dieselbe Quelle/Form wie `getBudgetSplitForAppointments`.
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
 * Storniert EINE Phantom-Topf-Rechnung dokument-seitig (Stornorechnung +
 * Status `storniert`). KEINE Budget-Reversierung (siehe Datei-Header).
 */
async function stornoPhantomInvoice(
  tx: Tx,
  originalId: number,
  userId: number,
): Promise<{ stornoInvoice: Invoice; original: Invoice }> {
  const locked = await getInvoiceForUpdateTx(tx, originalId);
  if (!locked) throw new Error(`Rechnung #${originalId} nicht gefunden`);
  if (locked.status === "storniert") {
    throw new Error(`Rechnung #${originalId} wurde bereits storniert.`);
  }
  if (locked.invoiceType === "stornorechnung") {
    throw new Error(`Rechnung #${originalId} ist eine Stornorechnung und kann nicht erneut storniert werden.`);
  }

  const number = await getNextInvoiceNumberTx(tx, locked.billingYear);
  const lineItems = await getInvoiceLineItemsTx(tx, originalId);

  const companySettings = await getCachedCompanySettings();
  const dueDays = companySettings?.invoiceDefaultDueDays ?? 30;
  const dueDateIso = addDays(todayISO(), dueDays);

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
    status: "entwurf",
    stornierteRechnungId: originalId,
    dueDate: dueDateIso,
    buyerReference: locked.buyerReference ?? null,
    assignmentDeclarationDate: locked.assignmentDeclarationDate ?? null,
    assignmentDeclarationRef: locked.assignmentDeclarationRef ?? null,
    // Topf-Zuordnung der Originalrechnung spiegeln, damit der Storno-Trail
    // denselben Topf trägt.
    budgetType: locked.budgetType,
    billingRunId: locked.billingRunId,
  };

  const stornoLineItems = lineItems.map((item: InvoiceLineItem) => ({
    appointmentId: item.appointmentId,
    appointmentDate: item.appointmentDate,
    serviceDescription: item.serviceDescription,
    serviceCode: item.serviceCode,
    startTime: item.startTime,
    endTime: item.endTime,
    durationMinutes: item.durationMinutes,
    quantityRaw: item.quantityRaw,
    quantityUnit: item.quantityUnit,
    unitPriceCents: item.unitPriceCents,
    totalCents: -item.totalCents,
    employeeName: item.employeeName,
    appointmentNotes: item.appointmentNotes || null,
    serviceDetails: item.serviceDetails || null,
  }));

  const created = await createInvoiceTx(tx, stornoData, stornoLineItems, userId);
  const original = await updateInvoiceStatusTx(tx, originalId, "storniert", userId);

  return { stornoInvoice: created, original };
}

export async function reconcilePhantomPotInvoices(args: Args): Promise<PhantomReconcileSummary> {
  const candidates = await loadCandidateInvoices(args.customerIds);
  const findings: PhantomInvoiceFinding[] = [];

  for (const inv of candidates) {
    const potKey = toPotKey(inv.budgetType);
    const apptIds = await loadAppointmentIdsForInvoice(inv.id);
    if (apptIds.length === 0) continue; // keine Termin-Bindung → nicht bewertbar

    const { consumptions, reversals } = await loadLedgerForAppointments(inv.customerId, apptIds);
    if (!isPotEntirelyReversed(consumptions, reversals, potKey)) continue;

    const reversedConsumptionCents = consumptions
      .filter((c) => toPotKey(c.budgetType) === potKey)
      .reduce((s, c) => s + Math.abs(c.amountCents), 0);

    findings.push({
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      customerId: inv.customerId,
      budgetType: inv.budgetType,
      potKey,
      status: inv.status,
      grossAmountCents: inv.grossAmountCents,
      billingRunId: inv.billingRunId,
      appointmentIds: apptIds,
      reversedConsumptionCents,
    });
  }

  let stornoedCount = 0;
  if (args.apply && args.userId !== undefined) {
    for (const f of findings) {
      const { stornoInvoice } = await withAudit(async (tx, audit) => {
        const result = await stornoPhantomInvoice(tx, f.invoiceId, args.userId!);
        audit.record({
          userId: args.userId!,
          action: "invoice_cancelled",
          entityType: "invoice",
          entityId: f.invoiceId,
          metadata: {
            task: "#1016",
            reason: args.reason,
            originalInvoiceNumber: f.invoiceNumber,
            stornoInvoiceId: result.stornoInvoice.id,
            stornoInvoiceNumber: result.stornoInvoice.invoiceNumber,
            customerId: f.customerId,
            budgetType: f.budgetType,
            grossAmountCents: f.grossAmountCents,
            phantomPot: true,
            ...(f.billingRunId ? { billingRunId: f.billingRunId } : {}),
          },
        });
        return result;
      });

      // Storno-PDF persistieren (analog Route). Best-effort: synchron, damit das
      // Skript nicht vor Abschluss des Hintergrund-Jobs endet.
      try {
        await persistInvoicePdf(stornoInvoice.id);
      } catch (err) {
        console.error(`  ! PDF-Persistierung für Storno #${stornoInvoice.id} fehlgeschlagen (wird on-demand nachgezogen):`, err);
        schedulePdfPersistInBackground(stornoInvoice.id);
      }
      stornoedCount++;
    }
  }

  return {
    apply: args.apply,
    candidatesScanned: candidates.length,
    findings,
    stornoedCount,
  };
}

function eur(cents: number): string {
  return `${(cents / 100).toFixed(2)} €`;
}

async function main() {
  const args = parseArgs();

  if (args.apply) {
    if (args.userId === undefined) {
      console.error("Fehler: --apply erfordert --user=<superadmin-id> für GoBD-Audit-Attribution.");
      process.exit(1);
    }
    if (!args.reason || args.reason.length < 10) {
      console.error('Fehler: --apply erfordert --reason="..." (≥10 Zeichen Begründung für den Audit-Log).');
      process.exit(1);
    }
    await assertSuperadminOrThrow(args.userId);
  }

  console.log(`\n=== Phantom-Topf-Rechnungs-Reconcile · Task #1016 ===`);
  console.log(`Modus:    ${args.apply ? "SCHARF (--apply)" : "Trockenlauf (read-only)"}`);
  console.log(`Kunden:   ${args.customerIds.length > 0 ? args.customerIds.join(", ") : "ALLE"}`);
  if (args.userId !== undefined) console.log(`Superadmin: ${args.userId}`);
  if (args.reason) console.log(`Begründung: ${args.reason}`);

  const summary = await reconcilePhantomPotInvoices(args);

  // Kundennamen für die Ausgabe.
  const cids = Array.from(new Set(summary.findings.map((f) => f.customerId)));
  const names = new Map<number, string>();
  if (cids.length > 0) {
    const rows = await db
      .select({ id: customers.id, name: customers.name })
      .from(customers)
      .where(inArray(customers.id, cids));
    for (const r of rows) names.set(r.id, r.name ?? "");
  }

  console.log(`\nGeprüfte pot-spezifische Rechnungen: ${summary.candidatesScanned}`);
  console.log(`Phantom-Topf-Rechnungen gefunden:    ${summary.findings.length}\n`);

  let total = 0;
  for (const f of summary.findings) {
    total += f.grossAmountCents;
    console.log(
      `  Rechnung ${f.invoiceNumber} [${f.status}] · Kunde #${f.customerId} ${names.get(f.customerId) ?? ""}` +
        `\n    Topf: ${POT_DISPLAY_LABELS[f.potKey]} (${f.budgetType}) · Brutto ${eur(f.grossAmountCents)}` +
        ` · stornierter Topf-Verbrauch ${eur(f.reversedConsumptionCents)}` +
        `\n    Termine: ${f.appointmentIds.join(", ")}` +
        (f.billingRunId ? `\n    Abrechnungslauf: ${f.billingRunId}` : ""),
    );
  }
  console.log(`\nSumme Brutto der Phantom-Rechnungen: ${eur(total)}`);

  if (args.apply) {
    console.log(`\nStornierte Rechnungen: ${summary.stornoedCount}`);
  } else if (summary.findings.length > 0) {
    console.log(
      '\nHinweis: Trockenlauf — keine Änderungen geschrieben.' +
        '\n  Scharf stornieren mit: --apply --user=<superadmin-id> --reason="…"',
    );
  } else {
    console.log("\n✓ Keine überflüssigen Phantom-Topf-Rechnungen im Bestand.");
  }

  process.exit(summary.findings.length === 0 ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fehler:", err);
    process.exit(1);
  });
}
