/**
 * Cascade-Storno einer Rechnung — SSoT.
 *
 * Ersetzungs-Regel: Dieses Modul ERSETZT die zuvor inline im Route-Handler
 * `PATCH /api/billing/:id/status` (`server/routes/billing.ts`) definierte
 * `performStorno`-Closure inklusive der `billing_run_id`-Cascade. Die Logik ist
 * unverändert (zeichengleich) herausgezogen, damit AUCH das GoBD-Reparatur-
 * Skript `server/scripts/reconcile-billed-appointment-import-drift.ts` (Task
 * #1651) exakt denselben Storno-Pfad nutzt statt einer zweiten, driftenden
 * Kopie. Es gibt damit weiterhin GENAU EINE Storno-Implementierung.
 *
 * Ein Storno legt pro betroffener Rechnung eine `stornorechnung` (negierte
 * Beträge/Zeilen) an, setzt die Original-Rechnung auf `storniert` und bucht das
 * Budget der Rechnungs-Termine zurück (pot-bewusst bei `billing_run_id`-Splits).
 * Der aufrufende Kontext (`withAudit`-Transaktion) übergibt `tx` + `audit`; die
 * Storno-PDF-Persistierung im Hintergrund bleibt Sache des Aufrufers (er kennt
 * die zurückgegebenen Rechnungs-IDs).
 */

import { activeInvoiceCondition } from "../lib/appointment-invoiced";
import { and, eq, ne } from "drizzle-orm";
import { addDays, todayISO } from "@shared/utils/datetime";
import { toPotKey } from "@shared/domain/budget-invoice-split";
import type { Tx } from "../lib/db";
import type { TxAuditRecorder } from "../lib/with-audit";
import type { Invoice, InvoiceLineItem } from "@shared/schema";
import {
  invoices as invoicesTable,
  budgetTransactions,
} from "@shared/schema";
import {
  getNextInvoiceNumberTx,
  createInvoiceTx,
  updateInvoiceStatusTx,
  getInvoiceLineItemsTx,
  getInvoiceForUpdateTx,
} from "../storage/billing-storage";
import { budgetStorage } from "../storage/budget-storage";
import { getCachedCompanySettings } from "./cache";
import { badRequest, notFound } from "../lib/errors";

export interface StornoCascadeResult {
  /** Die zur Haupt-Rechnung erzeugte Stornorechnung. */
  mainStornoInvoice: Invoice;
  /** Nummer der Haupt-Stornorechnung. */
  mainStornoInvoiceNumber: string;
  /** Die auf `storniert` gesetzte Original-Haupt-Rechnung. */
  updatedOriginal: Invoice;
  /** IDs der zusätzlich (Cascade) erzeugten Geschwister-Stornorechnungen. */
  cascadeStornoIds: number[];
}

/**
 * Storniert `rootInvoiceId` und — bei gesetztem `billing_run_id` und
 * `cascadeRun` — alle noch aktiven Geschwister-Rechnungen desselben Laufs in
 * DERSELBEN Transaktion (atomarer Topf-Split). Muss innerhalb einer
 * `withAudit`-Transaktion aufgerufen werden.
 *
 * @param auditMetadataExtra Optionale Zusatz-Metadaten (z.B. `reason`/`batchId`
 *   aus dem Reparatur-Skript), die in JEDEN `invoice_cancelled`-Audit-Eintrag
 *   (Haupt- UND Geschwister-Storno) einfließen. Der HTTP-Route-Pfad übergibt
 *   dies nicht → identisches Audit-Verhalten wie zuvor.
 */
export async function stornoInvoiceCascade(
  tx: Tx,
  audit: TxAuditRecorder,
  opts: {
    rootInvoiceId: number;
    cascadeRun: boolean;
    userId: number;
    ipAddress?: string;
    auditMetadataExtra?: Record<string, unknown>;
  },
): Promise<StornoCascadeResult> {
  const { rootInvoiceId, cascadeRun, userId, ipAddress, auditMetadataExtra } = opts;

  const performStorno = async (
    originalId: number,
  ): Promise<{ stornoInvoice: Invoice; invoiceNumber: string; updatedOriginal: Invoice }> => {
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
      stornierteRechnungId: rootInvoiceId,
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

    const created = await createInvoiceTx(tx, stornoData, stornoLineItems, userId);
    const original = await updateInvoiceStatusTx(tx, originalId, "storniert", userId);

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

    // T04/K2: Storno-Reversal — die Budget-Transaktionen der Original-
    // Rechnungs-Termine werden in derselben Transaktion zurückgebucht,
    // damit der jeweilige Topf wieder als verfügbar angezeigt wird.
    //
    // Task #1377 — Pot-bewusster Storno: Bei einer per-Topf-Split-Rechnung
    // (`billingRunId` gesetzt) trägt EIN Termin Konsumptionen in mehreren
    // Töpfen (z.B. §45b + privat), die als getrennte Rechnungen pro Topf
    // ausgestellt sind. Der Storno EINER Topf-Rechnung darf deshalb nur die
    // Konsumptionen DIESES Topfes zurückbuchen — sonst entwertet er
    // stillschweigend den Verbrauch der noch lebenden Geschwister-Rechnung
    // im anderen Topf. Der Topf der Rechnung ergibt sich aus `budgetType`
    // (NULL = Selbstzahler-/Privat-Anteil, vgl. `toPotKey`).
    //
    // Bestands-/Single-Pot-Rechnungen (`billingRunId` NULL) verhalten sich
    // unverändert und buchen ALLE Konsumptionen der Termine zurück.
    const isPotSplitInvoice = locked.billingRunId != null;
    const invoicePotKey = toPotKey(locked.budgetType ?? "private");
    const apptIdsForReversal = Array.from(
      new Set(
        lineItems
          .map((it: InvoiceLineItem) => it.appointmentId)
          .filter((v): v is number => typeof v === "number"),
      ),
    );
    for (const apptId of apptIdsForReversal) {
      const txs = await tx
        .select()
        .from(budgetTransactions)
        .where(
          and(
            eq(budgetTransactions.appointmentId, apptId),
            eq(budgetTransactions.transactionType, "consumption"),
          ),
        );
      for (const t of txs) {
        if (isPotSplitInvoice && toPotKey(t.budgetType) !== invoicePotKey) {
          continue; // anderer Topf — Geschwister-Rechnung bleibt lebend
        }
        await budgetStorage.reverseBudgetTransaction(t.id, userId, tx);
      }
    }

    audit.record({
      userId,
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
        newStatus: "storniert",
        ...(locked.billingRunId ? { billingRunId: locked.billingRunId } : {}),
        ...(auditMetadataExtra ?? {}),
      },
      ipAddress,
    });

    return { stornoInvoice: created, invoiceNumber: number, updatedOriginal: original };
  };

  // 1) Haupt-Rechnung stornieren.
  const main = await performStorno(rootInvoiceId);

  // 2) Optional: Cascade über billing_run_id-Geschwister.
  const cascadeStornoIds: number[] = [];
  const root = main.updatedOriginal;
  if (cascadeRun && root.billingRunId) {
    const siblings = await tx
      .select({ id: invoicesTable.id })
      .from(invoicesTable)
      .where(
        and(
          eq(invoicesTable.billingRunId, root.billingRunId),
          ne(invoicesTable.id, rootInvoiceId),
          // „aktiv" aus DER EINEN SSoT statt handgeschrieben — die Kaskade darf
          // weder eine bereits stornierte Geschwister-Rechnung noch eine
          // Gutschrift erneut stornieren.
          activeInvoiceCondition(),
        ),
      );
    for (const s of siblings) {
      const r = await performStorno(s.id);
      cascadeStornoIds.push(r.stornoInvoice.id);
    }
  }

  return {
    mainStornoInvoice: main.stornoInvoice,
    mainStornoInvoiceNumber: main.invoiceNumber,
    updatedOriginal: main.updatedOriginal,
    cascadeStornoIds,
  };
}
