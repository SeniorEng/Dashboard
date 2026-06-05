/**
 * Task #987 — Phantom-Storno-Erkennung im Budget-Ledger (`budget_transactions`).
 *
 * Hintergrund: Beim Excel-Import von Kunden-Historie sind verwaiste Storno-Zeilen
 * entstanden — Reversal-Buchungen mit `reversed_transaction_id IS NULL`, deren
 * `notes` aber "Storno von Transaktion #N" referenzieren. Wird dieselbe
 * Original-Buchung zusätzlich von einer regulären (verknüpften) Reversal-Zeile
 * storniert, ODER ist der referenzierte Konsum ein real geleisteter (gebuchter)
 * Termin, dann schreibt die verwaiste Reversal-Zeile denselben Verbrauch ein
 * zweites Mal gut: Der Netto-Saldo (`Σ amount_cents`, consumption negativ,
 * reversal positiv) wird zu niedrig, das Restguthaben zu hoch.
 *
 * Der Partial-Unique-Index `budget_transactions_reversal_unique_idx` greift nur
 * für Reversals mit GESETZTER Verknüpfung
 * (`WHERE transaction_type = 'reversal' AND reversed_transaction_id IS NOT NULL`)
 * und übersieht die NULL-Link-Waisen deshalb.
 *
 * Dieses Modul hält die REINE Logik (kein DB-/IO-Zugriff), damit Reconcile-
 * Skript, Schreib-Guard und Drift-/Architektur-Test denselben Code aufrufen
 * (SSoT, vgl. `tests/architecture/calculations-in-shared.test.ts`).
 */

/** Minimal-Sicht auf eine Ledger-Zeile, die für die Erkennung nötig ist. */
export interface PhantomLedgerRow {
  id: number;
  customerId: number;
  budgetType: string;
  transactionType: string;
  amountCents: number;
  appointmentId: number | null;
  reversedTransactionId: number | null;
  notes: string | null;
}

/**
 * Liest die referenzierte Original-Transaktions-ID aus der `notes`-Angabe eines
 * Stornos. Deckt alle im Bestand vorkommenden Varianten ab:
 *   - "Storno von Transaktion #114"
 *   - "Storno von Transaktion #69 (Umbuchung)"
 *   - "Storno (Termin-Edit) von Transaktion #33"
 *   - "Storno (Reconcile #116) von Transaktion #42"
 */
export function parseStornoReference(notes: string | null | undefined): number | null {
  if (!notes) return null;
  const m = notes.match(/Storno\b.*?Transaktion #(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Menge aller Original-IDs, die per VERKNÜPFTER (regulärer) Reversal-Zeile
 * storniert wurden (`reversed_transaction_id` gesetzt).
 */
export function findLinkedReversedConsumptionIds(rows: PhantomLedgerRow[]): Set<number> {
  const s = new Set<number>();
  for (const r of rows) {
    if (r.transactionType === "reversal" && r.reversedTransactionId != null) {
      s.add(r.reversedTransactionId);
    }
  }
  return s;
}

export interface PhantomDoubleStorno {
  orphanId: number;
  referencedConsumptionId: number;
  customerId: number;
  budgetType: string;
  amountCents: number;
}

/**
 * Drift-Detektor (Step 3): findet "verwaiste Reversal mit zugehöriger regulärer
 * Storno-Zeile" — also einen NULL-Link-Storno, dessen referenzierte
 * Original-Buchung ZUSÄTZLICH von einer verknüpften Reversal-Zeile storniert
 * wurde. Das ist die unzweifelhafte Doppel-Gutschrift und der Fall, der nie
 * mehr im Ledger auftauchen darf. Rein, nur Ledger-Zeilen — kein Termin-Status
 * nötig.
 */
export function detectPhantomDoubleStornos(rows: PhantomLedgerRow[]): PhantomDoubleStorno[] {
  const linked = findLinkedReversedConsumptionIds(rows);
  const out: PhantomDoubleStorno[] = [];
  for (const r of rows) {
    if (r.transactionType !== "reversal") continue;
    if (r.reversedTransactionId != null) continue; // nur Waisen
    const ref = parseStornoReference(r.notes);
    if (ref == null) continue;
    if (linked.has(ref)) {
      out.push({
        orphanId: r.id,
        referencedConsumptionId: ref,
        customerId: r.customerId,
        budgetType: r.budgetType,
        amountCents: r.amountCents,
      });
    }
  }
  return out;
}

export type OrphanPhantomReason =
  | "double_storno_linked"        // Original ist zusätzlich regulär storniert → Waise ist reiner Extra-Kredit
  | "live_appointment_consumption" // Original-Konsum gehört zu einem real geleisteten (lebenden) Termin
  | "skipped_legit_cancellation"  // Einzel-Storno eines stornierten/gelöschten Termins → legitim, NICHT anfassen
  | "skipped_unresolved_ref";     // Referenz nicht auflösbar / keine Consumption → konservativ überspringen

export interface ClassifiedOrphan {
  orphan: PhantomLedgerRow;
  referencedConsumptionId: number;
  isPhantom: boolean;
  reason: OrphanPhantomReason;
}

export interface ClassifyOrphanInput {
  /** ALLE Ledger-Zeilen des Kunden (Consumption + Reversal), damit Referenzen auflösbar sind. */
  rows: PhantomLedgerRow[];
  /**
   * Map: Consumption-ID → ob ihr Termin real geleistet wurde (lebt), d.h. NICHT
   * storniert / soft-deleted. Nur relevant für Einzel-Waisen ohne verknüpftes
   * Storno. Fehlt der Eintrag, wird der Termin als nicht-lebend behandelt
   * (konservativ: kein Phantom).
   */
  consumptionAppointmentLive: Map<number, boolean>;
}

/**
 * Reconcile-Klassifikation (Step 1): klassifiziert jede verwaiste Reversal-Zeile
 * als Phantom (zu korrigieren) oder legitim (in Ruhe lassen).
 *
 * Eine Waise ist PHANTOM, wenn ihre referenzierte Original-Buchung tatsächlich
 * verbraucht bleibt, die Gutschrift also zu Unrecht erfolgt:
 *   - entweder die Original-Buchung ist ZUSÄTZLICH regulär storniert
 *     (`double_storno_linked` — Saldo ist ohne die Waise bereits ausgeglichen),
 *   - oder der referenzierte Konsum gehört zu einem real geleisteten Termin
 *     (`live_appointment_consumption` — der Verbrauch soll stehen bleiben).
 *
 * Eine Waise ist LEGITIM (überspringen), wenn sie der EINZIGE Storno eines
 * tatsächlich stornierten/gelöschten Termins ist (nur die Verknüpfung fehlt) —
 * dann soll der Verbrauch NICHT gezählt werden und die Gutschrift ist korrekt.
 */
export function classifyOrphanStornos(input: ClassifyOrphanInput): ClassifiedOrphan[] {
  const { rows, consumptionAppointmentLive } = input;
  const linked = findLinkedReversedConsumptionIds(rows);
  const byId = new Map<number, PhantomLedgerRow>(rows.map((r) => [r.id, r]));
  const out: ClassifiedOrphan[] = [];

  for (const r of rows) {
    if (r.transactionType !== "reversal") continue;
    if (r.reversedTransactionId != null) continue; // nur Waisen
    const ref = parseStornoReference(r.notes);
    if (ref == null) continue;

    const refRow = byId.get(ref);
    if (!refRow || refRow.transactionType !== "consumption") {
      out.push({ orphan: r, referencedConsumptionId: ref, isPhantom: false, reason: "skipped_unresolved_ref" });
      continue;
    }
    if (linked.has(ref)) {
      out.push({ orphan: r, referencedConsumptionId: ref, isPhantom: true, reason: "double_storno_linked" });
      continue;
    }
    if (consumptionAppointmentLive.get(ref) === true) {
      out.push({ orphan: r, referencedConsumptionId: ref, isPhantom: true, reason: "live_appointment_consumption" });
    } else {
      out.push({ orphan: r, referencedConsumptionId: ref, isPhantom: false, reason: "skipped_legit_cancellation" });
    }
  }
  return out;
}

/** Eindeutige Notiz der Ausgleichsbuchung — trägt die Idempotenz-Markierung. */
export function buildPhantomCorrectionNote(orphanId: number, referencedConsumptionId: number): string {
  return (
    `Phantom-Storno-Korrektur (Task #987): Gegenbuchung zum verwaisten Storno ` +
    `#${orphanId} (ref #${referencedConsumptionId}).`
  );
}

/**
 * Idempotenz-Check: existiert bereits eine Ausgleichsbuchung für genau diese
 * verwaiste Reversal-Zeile? Matcht exakt auf "verwaisten Storno #<id> (" und
 * vermeidet damit Präfix-Kollisionen (#11 vs. #115).
 */
export function isPhantomCorrectionFor(notes: string | null | undefined, orphanId: number): boolean {
  if (!notes) return false;
  return notes.includes(`verwaisten Storno #${orphanId} (`);
}
