/**
 * Task #1672 — Sammel-Avis ↔ Sammelzahlung Auto-Match.
 *
 * Pure Entscheidungslogik für den Abgleich einer Qonto-Sammelzahlung mit einem
 * Pflegekassen-Sammel-Avis. EINE Stelle (SSoT) für die Triple-Equality und die
 * Diskriminatoren — Auto-Match-Service, rückwirkende Vorschlags-Suche UND der
 * Backfill-Verifier importieren dieselbe Logik, damit Anzeige- und Buchungspfad
 * nie auseinanderlaufen. Alle Beträge sind Integer-Cents.
 */

import { normalizeIban } from "./monitored-ibans";

/** Confidence-Label für einen automatischen Sammel-Avis-Match. */
export const BULK_ADVICE_CONFIDENCE = "auto_bulk_advice";

/**
 * Toleranz für die Triple-Equality (reine Rundungsdifferenzen). Jede größere
 * Abweichung ⇒ kein sauberer Sammelzahlungs-Match ⇒ manuelle Prüfung.
 */
export const BULK_ADVICE_TOLERANCE_CENTS = 2;

export interface BulkMatchTransaction {
  reference: string | null;
  label: string | null;
  counterpartyName: string | null;
  sourceIban: string | null;
}

export interface BulkMatchAdvice {
  avisNummer: string | null;
  gesamtBetragCents: number | null;
  zahlungsempfaengerIban: string | null;
}

/**
 * Triple-Equality: Bank-Betrag ≈ Avis-Gesamtbetrag ≈ Σ offener Rechnungen, alle
 * drei müssen paarweise innerhalb der Toleranz übereinstimmen. `gesamtBetragCents`
 * wird as-is genutzt (Skonto/Kürzung sind bereits abgezogen). Ein null-Gesamtbetrag
 * (unparsbares/manuelles Avis) ist NIE ein Auto-Match-Kandidat.
 */
export function satisfiesTripleEquality(
  txAmountAbsCents: number,
  adviceGesamtBetragCents: number | null,
  sumOpenInvoiceCents: number,
  toleranceCents: number = BULK_ADVICE_TOLERANCE_CENTS,
): boolean {
  if (adviceGesamtBetragCents == null) return false;
  const within = (a: number, b: number) => Math.abs(a - b) <= toleranceCents;
  return (
    within(txAmountAbsCents, adviceGesamtBetragCents) &&
    within(adviceGesamtBetragCents, sumOpenInvoiceCents) &&
    within(txAmountAbsCents, sumOpenInvoiceCents)
  );
}

/**
 * Diskriminator zur eindeutigen Auflösung, wenn mehrere Avise denselben Betrag
 * tragen (K3): Avis-Nummer als Teilstring in reference+label+counterpartyName
 * ODER Empfänger-IBAN == Quell-IBAN der Transaktion. KEIN Namens-Fuzzy.
 */
export function adviceDiscriminatorMatches(
  tx: BulkMatchTransaction,
  advice: BulkMatchAdvice,
): boolean {
  const avis = advice.avisNummer?.trim().toLowerCase();
  if (avis) {
    const hay = [tx.reference, tx.label, tx.counterpartyName]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (hay.includes(avis)) return true;
  }
  if (advice.zahlungsempfaengerIban && tx.sourceIban) {
    if (normalizeIban(tx.sourceIban) === normalizeIban(advice.zahlungsempfaengerIban)) {
      return true;
    }
  }
  return false;
}

export interface BulkAdviceCandidate {
  adviceId: number;
  advice: BulkMatchAdvice;
  sumOpenInvoiceCents: number;
}

export interface ResolvedBulkMatch {
  adviceId: number;
  /** Warum aufgelöst: eindeutiger Betrag oder per Diskriminator. */
  reason: "unique_amount" | "discriminator";
}

/**
 * Wählt aus den Betrags-passenden Kandidaten (Triple-Equality erfüllt) genau
 * einen aus:
 *  - genau ein Kandidat  ⇒ eindeutig (unique_amount)
 *  - mehrere Kandidaten  ⇒ nur wenn ein EINZIGER per Diskriminator trifft
 *  - sonst               ⇒ null (manuelle Prüfung)
 */
export function resolveUniqueBulkMatch(
  tx: BulkMatchTransaction,
  txAmountAbsCents: number,
  candidates: BulkAdviceCandidate[],
  toleranceCents: number = BULK_ADVICE_TOLERANCE_CENTS,
): ResolvedBulkMatch | null {
  const amountMatches = candidates.filter((c) =>
    satisfiesTripleEquality(txAmountAbsCents, c.advice.gesamtBetragCents, c.sumOpenInvoiceCents, toleranceCents),
  );

  if (amountMatches.length === 0) return null;
  if (amountMatches.length === 1) {
    return { adviceId: amountMatches[0].adviceId, reason: "unique_amount" };
  }

  const discriminated = amountMatches.filter((c) => adviceDiscriminatorMatches(tx, c.advice));
  if (discriminated.length === 1) {
    return { adviceId: discriminated[0].adviceId, reason: "discriminator" };
  }
  return null;
}

export interface AdviceSuggestion {
  adviceId: number;
  /** Warum vorgeschlagen: eindeutiger Betrag, per Diskriminator, oder mehrdeutig. */
  reason: "unique_amount" | "discriminator" | "amount_ambiguous";
  /**
   * „Starkes Signal": Triple-Equality UND ein Diskriminator (Avis-Nummer im
   * Verwendungszweck ODER passende Empfänger-IBAN). Nur bei einem starken Signal
   * darf rückwirkend auto-geschlossen werden; sonst nur als Vorschlag anbieten.
   */
  strong: boolean;
}

/**
 * Task #1672 — rückwirkende Vorschlags-Suche: liefert für eine Transaktion ALLE
 * betrags-passenden offenen Avise (Triple-Equality erfüllt), je mit „strong"-Flag
 * (Diskriminator trifft) und Grund. Reine Anzeige-/Vorschlags-Logik — das
 * tatsächliche Buchen läuft weiter über {@link resolveUniqueBulkMatch} bzw. den
 * expliziten Confirm-Pfad. Kein Treffer ⇒ leeres Array.
 */
export function scanAdviceSuggestions(
  tx: BulkMatchTransaction,
  txAmountAbsCents: number,
  candidates: BulkAdviceCandidate[],
  toleranceCents: number = BULK_ADVICE_TOLERANCE_CENTS,
): AdviceSuggestion[] {
  const amountMatches = candidates.filter((c) =>
    satisfiesTripleEquality(txAmountAbsCents, c.advice.gesamtBetragCents, c.sumOpenInvoiceCents, toleranceCents),
  );
  if (amountMatches.length === 0) return [];

  const unique = amountMatches.length === 1;
  return amountMatches.map((c) => {
    const disc = adviceDiscriminatorMatches(tx, c.advice);
    return {
      adviceId: c.adviceId,
      reason: disc ? "discriminator" : unique ? "unique_amount" : "amount_ambiguous",
      strong: disc,
    };
  });
}
