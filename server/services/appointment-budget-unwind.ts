import type { Tx } from "../lib/db";
import { budgetStorage } from "../storage/budget-storage";
import { findActiveInvoicesForAppointments } from "../lib/appointment-invoiced";

/**
 * **Budget-Fussabdruck eines Termins zurueckabwickeln** — EINE Fassung.
 *
 * ── Was das ERSETZT ─────────────────────────────────────────────────────
 * Dieselbe Kette stand dreimal im Repo, jedes Mal leicht anders eingebettet:
 *
 *  1. `DELETE /api/appointments/:id` — Rechnungspruefung, Storno der
 *     Buchungen, Hold-Freigabe. Die vollstaendigste Fassung; sie ist hier die
 *     Vorlage.
 *  2. `cancelAppointments` (`appointment-cancellation.ts`) — hatte Storno und
 *     Holds, die Rechnungspruefung fehlte bis zu diesem Vorgang.
 *  3. `POST /appointment-series/:id/shorten` — hatte NICHTS davon: ein nacktes
 *     `UPDATE ... SET deleted_at`, waehrend die Buchungen stehen blieben.
 *
 * Drei Kopien einer GoBD-relevanten Kette sind genau der Zustand, aus dem die
 * gemeldeten Leaks entstanden sind: wer eine ergaenzt, vergisst die anderen.
 *
 * ── Warum die Rechnungspruefung dazugehoert ─────────────────────────────
 * Zurueckbuchen, waehrend eine aktive Rechnung den Verbrauch ausweist, laesst
 * Rechnung und Budget auseinanderlaufen — die Rechnung weist Leistung aus, das
 * Budget hat sie wieder frei. Korrektur laeuft nach GoBD ueber Storno der
 * Rechnung, nicht ueber stilles Zurueckbuchen. Deshalb ist die Pruefung Teil
 * DIESER Funktion und nicht Sache des Aufrufers: sie darf nicht vergessen
 * werden koennen.
 *
 * ── Warum "gesperrt" hier NICHT geprueft wird ───────────────────────────
 * Die LN-Sperre (`lockAndCheckAppointmentLocked`) bleibt beim Aufrufer. Sie
 * beantwortet eine andere Frage — "darf dieser Termin ueberhaupt angefasst
 * werden?" — und die Aufrufer behandeln sie unterschiedlich: der Loesch-Pfad
 * hat einen Admin-Korrektur-Zweig (reduktions-only aus den Nachweisen
 * herausloesen), die Absage ueberspringt. Sie hierher zu ziehen hiesse, diese
 * Unterscheidung einzuebnen.
 */

/** Aktive Rechnung auf dem Termin — Rueckabwicklung ist dann gesperrt. */
export interface RechnungsSperre {
  /** `RE-2026-0123, RE-2026-0124` — fuer die Meldung an den Aufrufer. */
  nummern: string;
  /** Nur Entwuerfe? Dann reicht Verwerfen, sonst braucht es ein Storno. */
  nurEntwuerfe: boolean;
}

export interface Rueckabwicklung {
  reversedTransactionIds: number[];
  holdsReleased: boolean;
}

/**
 * Prueft, ob eine aktive Rechnung den Termin sperrt. `null` = frei.
 *
 * Getrennt von der Rueckabwicklung, weil die Aufrufer unterschiedlich
 * reagieren: der Loesch-Pfad wirft 409 (genau ein Termin), die Absage
 * UEBERSPRINGT (sie arbeitet Mengen ab, ein Abbruch risse die uebrigen mit).
 * Die FRAGE ist dieselbe, die ANTWORT darf es nicht sein.
 */
export async function pruefeRechnungsSperre(
  id: number,
  tx: Tx,
): Promise<RechnungsSperre | null> {
  const rechnungen = await findActiveInvoicesForAppointments([id], tx);
  if (rechnungen.length === 0) return null;
  return {
    nummern: [...new Set(rechnungen.map((i) => i.invoiceNumber))].join(", "),
    nurEntwuerfe: rechnungen.every((i) => i.status === "entwurf"),
  };
}

/**
 * Meldungstext zur Sperre. EINE Formulierung, damit die drei Pfade nicht
 * unterschiedlich erklaeren, was zu tun ist.
 *
 * `vorgang` benennt, was blockiert wird ("abgesagt", "geloescht", "verkuerzt").
 */
export function rechnungsSperreMeldung(sperre: RechnungsSperre, vorgang: string): string {
  return sperre.nurEntwuerfe
    ? `Für diesen Termin existiert der Rechnungsentwurf ${sperre.nummern}. Bitte zuerst den Entwurf verwerfen, danach kann ${vorgang} werden.`
    : `Dieser Termin ist auf der Rechnung ${sperre.nummern} abgerechnet. Bitte zuerst die Rechnung stornieren, danach kann ${vorgang} werden.`;
}

/**
 * Storniert die Budget-Buchungen des Termins und gibt seine Holds frei.
 *
 * BEIDES, nicht nur eines: gemessen an der Referenz-DB traegt `scheduled` nie
 * eine `budget_transaction`, aber in rund der Haelfte der Faelle einen Hold;
 * `documenting` kann beides tragen. Wer nur Holds freigaebe, liesse den
 * `documenting`-Fall stumm falsch.
 *
 * Die Hold-Freigabe haengt am selben Feature-Gate wie ueberall sonst —
 * sonst entstuende genau die Divergenz, die diese Datei beseitigt.
 *
 * RUFT DIE RECHNUNGSPRUEFUNG NICHT SELBST: der Aufrufer entscheidet, ob er
 * wirft oder ueberspringt (siehe `pruefeRechnungsSperre`). Wer sie auslaesst,
 * bucht an einer gestellten Rechnung vorbei zurueck.
 */
export async function wickleBudgetZurueck(
  id: number,
  userId: number | undefined,
  tx: Tx,
): Promise<Rueckabwicklung> {
  const transaktionen = await budgetStorage.getTransactionsByAppointmentId(id);
  for (const t of transaktionen) {
    await budgetStorage.reverseBudgetTransaction(t.id, userId, tx);
  }
  const holdsReleased = budgetStorage.hardHoldsEnabled();
  if (holdsReleased) {
    await budgetStorage.releaseHolds(id, userId, tx);
  }
  return {
    reversedTransactionIds: transaktionen.map((t: { id: number }) => t.id),
    holdsReleased,
  };
}
