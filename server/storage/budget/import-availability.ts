import { db } from "../../lib/db";
import type { DbClient } from "./types";
import { syncCarryoverAndExpiry } from "./allocation-storage";
import { projected45bAvailableCents } from "./net-available-45b";
import { readBudgetTypeSettings } from "./preferences-storage";
import { readUnifiedBudgetAvailability } from "./unified-reader";

interface DateAwareAvailability {
  total45b: number;
  total45a: number;
  total39_42a: number;
  totalCents: number;
  /**
   * Gesamt MIT §45b-Projektion bis zum Monatsende des Termins — die Zahl,
   * gegen die `planHold` beim ANLEGEN entscheidet.
   *
   * Nur gesetzt, wenn ausdruecklich angefordert (`project45bToMonthEnd`).
   * `totalCents` bleibt daneben die ungeprojizierte Zahl: die Vorschau
   * braucht BEIDE, um „reicht im Monat, heute noch nicht" von „reicht
   * ueberhaupt nicht" zu unterscheiden (Replit #1916).
   */
  projectedTotalCents?: number;
}

export interface GetAvailableForDateOptions {
  /**
   * §45b bis zum Monatsende projizieren und das Ergebnis ZUSAETZLICH als
   * `projectedTotalCents` liefern.
   *
   * Opt-in, nicht Default: derselbe Wrapper bedient die Vorab-Pruefung im
   * Terminformular UND den Import-Pfad. Das Formular braucht beide Zahlen,
   * der Import soll weiter „Stand heute" lesen — und nicht die zusaetzliche
   * Abfrage zahlen.
   */
  readonly project45bToMonthEnd?: boolean;
}

/**
 * Verfügbares Budget (Cents) zum Buchungsdatum.
 *
 * Task #874 (Budget GF Phase 4): Die eigentliche Mathematik lebt jetzt im
 * unified Reader (`unified-reader.ts#readUnifiedBudgetAvailability`) — DER eine
 * Verfügbarkeits-Reader. Diese Funktion ist nur noch ein dünner Wrapper, der
 * vor dem Lesen die zeitabhängige §45b-Carryover-/Expiry-Materialisierung
 * sichert (`syncCarryoverAndExpiry`, schreibend) und dann den reinen (nicht
 * schreibenden) Reader delegiert.
 *
 * Die Cap-Logik (limit + carryover − usedInWindow) lebt in
 * `cap-calculator.computeCapSlot` und ist mit dem Buchungs-Pfad geteilt:
 * - §45b: max(0, aufgelaufene Allocation − Netto-Konsum bis Datum)
 * - §45a: min(pot remaining, monthlyLimit + carryover − usedThisMonth)
 * - §39/§42a: min(pot remaining, yearlyLimit − usedThisYear)
 *
 * Deaktivierte/Out-of-range Töpfe tragen 0 bei.
 */
export async function getAvailableForDate(
  customerId: number,
  transactionDate: string,
  _tx?: DbClient,
  opts?: GetAvailableForDateOptions,
): Promise<DateAwareAvailability> {
  // Carryover/Expiry materialisieren (schreibend) — bleibt im Wrapper, damit der
  // unified Reader rein lesend (prod-safe für Shadow-Soak) bleibt.
  await syncCarryoverAndExpiry(customerId, _tx);

  const unified = await readUnifiedBudgetAvailability(customerId, transactionDate, _tx ?? db);
  const basis = {
    total45b: unified.total45b,
    total45a: unified.total45a,
    total39_42a: unified.total39_42a,
    totalCents: unified.totalCents,
  };
  if (!opts?.project45bToMonthEnd) return basis;

  // Dieselbe Funktion, die `planHold` fuer seine Entscheidung ruft. Verbrauch
  // und Holds kommen aus dem Read zum TERMINDATUM, nur der Anspruch wird
  // projiziert — die Asymmetrie ist die Overdraft-Garantie und gehoert dazu.
  // `typeSettings` ZUM STICHTAG mitgeben (Gate 2 zu #167, S7). Ohne den
  // Parameter faellt `calculateAllocatedCents` auf
  // `readBudgetTypeSettings(..., todayISO())` zurueck — ein „heute"-Read
  // mitten in einer Rechnung, deren Zweck der Stichtag ist. `planHold`
  // uebergibt ihn; zwei Aufrufstellen derselben Funktion mit verschiedenen
  // Stichtags-Eingaben sind genau die Drift, vor der der Docblock der
  // Funktion warnt. Spart obendrein eine Query.
  const typeSettings = await readBudgetTypeSettings(
    customerId, { kind: "forDate", asOfDate: transactionDate }, _tx,
  );
  const projiziert45b = await projected45bAvailableCents(
    customerId, transactionDate, unified.pots.entlastungsbetrag_45b, _tx ?? db, typeSettings,
  );
  return {
    ...basis,
    projectedTotalCents: projiziert45b + basis.total45a + basis.total39_42a,
  };
}
