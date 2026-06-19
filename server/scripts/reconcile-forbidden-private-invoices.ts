/**
 * Task #1354 — Bereits ausgestellte, VERBOTENE Privat-/Selbstzahler-Rechnungen
 * (19 % USt) für NICHT-selbstzahlende Kunden aufspüren und (optional)
 * GoBD-konform dokument-seitig stornieren.
 *
 * Problem
 * -------
 * Task #1353 verhindert NUR die NEU-Entstehung einer verbotenen 19 %-Privat-
 * rechnung für einen Pflegekassen-Kunden ohne `acceptsPrivatePayment`
 * (SSoT-Gate `isPrivatePaymentAllowed`). BEREITS ausgestellte Rechnungen — der
 * konkrete Jungnickel-/AOK-Fall (Antje Jungnickel, RE-2026-0105) — bleiben im
 * Bestand und werden vom Code-Fix NICHT rückwirkend korrigiert.
 *
 * Dieses Skript findet ausgestellte, nicht-stornierte Privat-Rechnungen
 * (`invoices.billing_type = 'selbstzahler'` ODER `vat_rate = 19`), deren KUNDE
 * laut SSoT-Gate gar keinen Privat-Anteil bekommen darf
 * (`isPrivatePaymentAllowed({billingType, acceptsPrivatePayment}) === false`).
 *
 * Erkennung (SSoT)
 * ----------------
 * Die „Darf dieser Kunde privat zahlen?"-Frage wird ausschließlich über
 * `isPrivatePaymentAllowed` aus
 * `shared/domain/budget-selbstzahler-validator.ts` beantwortet — DERSELBE
 * Gate, der seit #1353 alle Schreibpfade (Consumption/Rebook/Reservierung/
 * Import/Rechnungssplit) absichert. Keine parallele Formel.
 *
 * Storno-Pfad (--apply)
 * ---------------------
 * Die Korrektur ist rein DOKUMENT-Ebene (analog zum Phantom-Topf-Reconcile,
 * Task #1016):
 *   - eine Stornorechnung (alle Beträge negiert, Line-Items 1:1 negiert) wird
 *     angelegt (kein Hard-Delete, GoBD),
 *   - die Originalrechnung wechselt auf Status `storniert`,
 *   - ein `invoice_cancelled`-Audit-Eintrag wird geschrieben.
 *
 * WICHTIG: Es wird BEWUSST KEINE Budget-Reversierung pro Termin ausgeführt
 * (anders als der Cascade-Storno der `PATCH /api/billing/:id/status`-Route).
 * Die Privat-Rechnung teilt sich i.d.R. denselben Termin mit der LEBENDEN
 * §45b-Geschwister-Rechnung (Jungnickel: Termin 1184 trägt §45b-Konsumption
 * auf der korrekten Kassenrechnung UND die Privat-Konsumption auf dieser
 * verbotenen Rechnung). Ein „alle Konsumptionen des Termins stornieren" würde
 * fälschlich die noch lebende §45b-Konsumption der korrekten Rechnung
 * zurückbuchen. Die Ledger-Korrektur der überflüssigen `private`-Konsumption
 * ist NICHT Teil dieses Dokument-Stornos (siehe Hinweis am Ende der Ausgabe).
 *
 * Sicherheit / GoBD
 * -----------------
 *   - Trockenlauf ist Default; `--apply` schreibt erst nach explizitem Opt-in.
 *   - `--apply` erfordert `--user=<superadmin-id>` (Audit-Attribution, nur
 *     Superadmins) UND `--reason="…"` (≥10 Zeichen, landet im Audit-Log).
 *   - Reiner Append-Pfad: kein DELETE/UPDATE außer dem Status-Wechsel der
 *     Originalrechnung auf `storniert` (= regulärer Storno-Trail).
 *   - Storno-PDF wird in der OBJECT-STORAGE der LAUFENDEN Umgebung persistiert.
 *     ⇒ Dieses Skript MUSS in der PRODUKTIONS-Umgebung laufen (Prod-DB +
 *     Prod-Object-Storage), nicht aus einer Dev-Sandbox heraus.
 *
 * Aufruf
 * ------
 *   - Trockenlauf (alle):  tsx server/scripts/reconcile-forbidden-private-invoices.ts
 *   - Einzelne Kunden:     tsx server/scripts/reconcile-forbidden-private-invoices.ts --customer=92
 *   - Einzelne Rechnung:   tsx server/scripts/reconcile-forbidden-private-invoices.ts --invoice=106
 *   - Scharf:              tsx server/scripts/reconcile-forbidden-private-invoices.ts --apply \
 *                            --user=<superadmin-id> --reason="Verbotene Privatrechnung #1354"
 *
 * Exit-Code: 0 = keine verbotene Privat-Rechnung gefunden, 1 = mindestens eine
 * gefunden. `--apply` ändert den Exit-Code nicht.
 */

import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "../lib/db";
import {
  customers,
  invoices as invoicesTable,
  users,
  type Invoice,
  type InvoiceLineItem,
} from "@shared/schema";
import { isPrivatePaymentAllowed } from "@shared/domain/budget-selbstzahler-validator";
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
  invoiceIds: number[];
  userId?: number;
  reason?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (p: string) => argv.find((a) => a.startsWith(p))?.split("=")[1];
  const apply = argv.includes("--apply");
  const parseIdList = (raw?: string): number[] => {
    const out: number[] = [];
    if (raw) {
      for (const idStr of raw.split(",")) {
        const n = parseInt(idStr.trim(), 10);
        if (!Number.isNaN(n)) out.push(n);
      }
    }
    return out;
  };
  const userArg = get("--user=");
  const userId = userArg ? parseInt(userArg, 10) : undefined;
  return {
    apply,
    customerIds: parseIdList(get("--customer=")),
    invoiceIds: parseIdList(get("--invoice=")),
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
        `Storno verbotener Privatrechnungen ist (analog Task #1016) auf Superadmins beschränkt.`,
    );
  }
}

export interface ForbiddenPrivateInvoiceFinding {
  invoiceId: number;
  invoiceNumber: string;
  customerId: number;
  customerName: string;
  customerBillingType: string;
  acceptsPrivatePayment: boolean;
  invoiceBillingType: string;
  vatRate: number | null;
  status: string;
  grossAmountCents: number;
  billingRunId: string | null;
}

export interface ForbiddenPrivateReconcileSummary {
  apply: boolean;
  candidatesScanned: number;
  findings: ForbiddenPrivateInvoiceFinding[];
  stornoedCount: number;
}

/**
 * Lädt nicht-stornierte, ausgestellte Privat-Rechnungen (eigener
 * `billing_type='selbstzahler'` ODER 19 % USt) inkl. Kunden-Stammflags für die
 * SSoT-Gate-Auswertung.
 */
async function loadCandidateInvoices(args: Args): Promise<ForbiddenPrivateInvoiceFinding[]> {
  const whereParts = [
    ne(invoicesTable.invoiceType, "stornorechnung"),
    ne(invoicesTable.status, "storniert"),
  ];
  if (args.customerIds.length > 0) {
    whereParts.push(inArray(invoicesTable.customerId, args.customerIds));
  }
  if (args.invoiceIds.length > 0) {
    whereParts.push(inArray(invoicesTable.id, args.invoiceIds));
  }

  const rows = await db
    .select({
      id: invoicesTable.id,
      invoiceNumber: invoicesTable.invoiceNumber,
      customerId: invoicesTable.customerId,
      invoiceBillingType: invoicesTable.billingType,
      vatRate: invoicesTable.vatRate,
      status: invoicesTable.status,
      grossAmountCents: invoicesTable.grossAmountCents,
      billingRunId: invoicesTable.billingRunId,
      customerName: customers.name,
      customerBillingType: customers.billingType,
      acceptsPrivatePayment: customers.acceptsPrivatePayment,
    })
    .from(invoicesTable)
    .innerJoin(customers, eq(customers.id, invoicesTable.customerId))
    .where(and(...whereParts));

  return rows.map((r) => ({
    invoiceId: r.id,
    invoiceNumber: r.invoiceNumber,
    customerId: r.customerId,
    customerName: r.customerName ?? "",
    customerBillingType: r.customerBillingType,
    acceptsPrivatePayment: r.acceptsPrivatePayment,
    invoiceBillingType: r.invoiceBillingType,
    vatRate: r.vatRate,
    status: r.status,
    grossAmountCents: r.grossAmountCents,
    billingRunId: r.billingRunId,
  }));
}

/**
 * Eine Rechnung ist eine VERBOTENE Privatrechnung, wenn sie selbst privat ist
 * (eigener billing_type='selbstzahler' ODER 19 % USt) UND der Kunde laut
 * SSoT-Gate keinen Privat-Anteil erhalten darf.
 */
function isForbiddenPrivateInvoice(f: ForbiddenPrivateInvoiceFinding): boolean {
  // Eine Rechnung ist „privat/besteuert", wenn sie eigenen Selbstzahler-
  // billing_type trägt ODER überhaupt USt ausweist (Kassen-Töpfe sind 0 %
  // steuerbefreit; der Privatsatz ist STANDARD_VAT_RATE_BP = 1900 = 19 %, in
  // Basispunkten gespeichert — daher > 0, nicht === 19).
  const invoiceIsPrivate =
    f.invoiceBillingType === "selbstzahler" || (f.vatRate ?? 0) > 0;
  if (!invoiceIsPrivate) return false;
  const allowed = isPrivatePaymentAllowed({
    billingType: f.customerBillingType,
    acceptsPrivatePayment: f.acceptsPrivatePayment,
  });
  return !allowed;
}

/**
 * Storniert EINE Rechnung dokument-seitig (Stornorechnung + Status
 * `storniert`). KEINE Budget-Reversierung (siehe Datei-Header).
 */
async function stornoInvoiceDocumentOnly(
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

export async function reconcileForbiddenPrivateInvoices(
  args: Args,
): Promise<ForbiddenPrivateReconcileSummary> {
  const candidates = await loadCandidateInvoices(args);
  const findings = candidates.filter(isForbiddenPrivateInvoice);

  let stornoedCount = 0;
  if (args.apply && args.userId !== undefined) {
    for (const f of findings) {
      const { stornoInvoice } = await withAudit(async (tx, audit) => {
        const result = await stornoInvoiceDocumentOnly(tx, f.invoiceId, args.userId!);
        audit.record({
          userId: args.userId!,
          action: "invoice_cancelled",
          entityType: "invoice",
          entityId: f.invoiceId,
          metadata: {
            task: "#1354",
            reason: args.reason,
            originalInvoiceNumber: f.invoiceNumber,
            stornoInvoiceId: result.stornoInvoice.id,
            stornoInvoiceNumber: result.stornoInvoice.invoiceNumber,
            customerId: f.customerId,
            customerBillingType: f.customerBillingType,
            acceptsPrivatePayment: f.acceptsPrivatePayment,
            grossAmountCents: f.grossAmountCents,
            forbiddenPrivateInvoice: true,
            ...(f.billingRunId ? { billingRunId: f.billingRunId } : {}),
          },
        });
        return result;
      });

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

  console.log(`\n=== Verbotene-Privatrechnungs-Reconcile · Task #1354 ===`);
  console.log(`Modus:    ${args.apply ? "SCHARF (--apply)" : "Trockenlauf (read-only)"}`);
  console.log(`Kunden:   ${args.customerIds.length > 0 ? args.customerIds.join(", ") : "ALLE"}`);
  if (args.invoiceIds.length > 0) console.log(`Rechnungen: ${args.invoiceIds.join(", ")}`);
  if (args.userId !== undefined) console.log(`Superadmin: ${args.userId}`);
  if (args.reason) console.log(`Begründung: ${args.reason}`);

  const summary = await reconcileForbiddenPrivateInvoices(args);

  console.log(`\nGeprüfte Privat-Kandidaten: ${summary.candidatesScanned}`);
  console.log(`Verbotene Privatrechnungen gefunden: ${summary.findings.length}\n`);

  let total = 0;
  for (const f of summary.findings) {
    total += f.grossAmountCents;
    console.log(
      `  Rechnung ${f.invoiceNumber} [${f.status}] · Kunde #${f.customerId} ${f.customerName}` +
        `\n    Kunde: billingType=${f.customerBillingType}, acceptsPrivatePayment=${f.acceptsPrivatePayment}` +
        `\n    Rechnung: billingType=${f.invoiceBillingType}, USt=${f.vatRate ?? "—"} · Brutto ${eur(f.grossAmountCents)}` +
        (f.billingRunId ? `\n    Abrechnungslauf: ${f.billingRunId}` : ""),
    );
  }
  console.log(`\nSumme Brutto der verbotenen Privatrechnungen: ${eur(total)}`);

  if (args.apply) {
    console.log(`\nStornierte Rechnungen: ${summary.stornoedCount}`);
    console.log(
      "\nHinweis: Dies war ein reiner DOKUMENT-Storno. Die überflüssige " +
        "`private`-Konsumption im Budget-Ledger wurde BEWUSST nicht angefasst " +
        "(geteilter Termin mit der lebenden §45b-Kassenrechnung). Eine etwaige " +
        "Ledger-Bereinigung ist separat zu bewerten.",
    );
  } else if (summary.findings.length > 0) {
    console.log(
      '\nHinweis: Trockenlauf — keine Änderungen geschrieben.' +
        '\n  Scharf stornieren mit: --apply --user=<superadmin-id> --reason="…"' +
        '\n  WICHTIG: Nur in der PRODUKTIONS-Umgebung ausführen (Prod-Object-Storage für das Storno-PDF).',
    );
  } else {
    console.log("\n✓ Keine verbotenen Privatrechnungen im Bestand.");
  }

  process.exit(summary.findings.length === 0 ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fehler:", err);
    process.exit(1);
  });
}
