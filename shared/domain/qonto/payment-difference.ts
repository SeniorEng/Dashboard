/**
 * Eine SSoT für die fachliche Frage „Passt der gezahlte Betrag zur Rechnung?".
 *
 * Reine, DB-freie Klassifikation, genutzt von ALLEN Lese- und Schreibpfaden des
 * Zahlungsabgleichs: Qonto-Auto-Match (`server/services/qonto.ts`), manuelle
 * Einzel-/Mehrfach-Zuordnung, Avis-„als bezahlt" und der Avis-Lesepfad
 * (`server/routes/admin/qonto.ts`).
 *
 * Ersetzt (Ersetzungs-Regel):
 *  - die Ad-hoc-Ableitung `Math.max(0, gross − betrag)` im Avis-Lesepfad
 *    (verschluckte Überzahlungen, war reine Anzeige) und
 *  - die inline-Prüfung `Math.abs(tx.amountCents) === inv.grossAmountCents` im
 *    Auto-Match, die bei Referenz-Treffern mit abweichendem Betrag die Rechnung
 *    still auf „bezahlt" setzte.
 *
 * Geldbeträge ausnahmslos Integer-Cents.
 */

/**
 * Toleranz für „passt hinreichend genau": kleine Abweichungen (Rundung, geringes
 * Skonto) gelten noch als Vollzahlung. BEWUSST ein absoluter Cent-Wert und KEIN
 * Prozentsatz — eine 2–3%-Bandbreite würde bei großen Rechnungen echte
 * Kassen-Kürzungen verschlucken, die gerade zur Prüfung markiert werden sollen.
 * Reicht der Wert fachlich nicht, wird er nach Rückfrage in company_settings
 * gehoben; bis dahin bleibt es eine Konstante (nicht additiv).
 */
export const PAYMENT_DIFFERENCE_TOLERANCE_CENTS = 100;

/**
 * Die moeglichen Ergebnisse der Differenz-Klassifikation — als Konstante, damit
 * Typ UND Laufzeit-Validierung (OpenAPI/zod) aus derselben Quelle kommen. Vorher
 * war das eine reine Union und die Werte standen im API-Schema ein zweites Mal.
 */
export const PAYMENT_DIFFERENCE_RESULTS = ["exact", "tolerated", "underpaid", "overpaid"] as const;
export type PaymentDifferenceResult = (typeof PAYMENT_DIFFERENCE_RESULTS)[number];

export interface PaymentDifferenceInput {
  /** Brutto-Forderung der Rechnung (Integer-Cents). */
  invoiceGrossCents: number;
  /** Tatsächlich gezahlter Betrag (Integer-Cents, immer positiv). */
  paidCents: number;
  /**
   * Bekanntes Skonto (Integer-Cents), das die Forderung legitim mindert. Nur auf
   * Avis-Pfaden gesetzt (`payment_advice_items.skonto_cents`); reine
   * Qonto-Transaktionspfade übergeben 0.
   */
  skontoCents?: number;
  /** Toleranz-Override (Tests); Default `PAYMENT_DIFFERENCE_TOLERANCE_CENTS`. */
  toleranceCents?: number;
}

export interface PaymentDifferenceClassification {
  result: PaymentDifferenceResult;
  /** `gross − skonto − paid`. Positiv = Unterzahlung, negativ = Überzahlung. */
  differenceCents: number;
}

/**
 * Klassifiziert eine Zahlung gegen eine Rechnung. `exact` (0 Differenz) und
 * `tolerated` (|Differenz| ≤ Toleranz) dürfen als Vollzahlung gebucht werden;
 * `underpaid`/`overpaid` müssen zur manuellen Prüfung markiert werden, statt
 * still auf „bezahlt" gesetzt zu werden.
 */
export function classifyPaymentDifference({
  invoiceGrossCents,
  paidCents,
  skontoCents = 0,
  toleranceCents = PAYMENT_DIFFERENCE_TOLERANCE_CENTS,
}: PaymentDifferenceInput): PaymentDifferenceClassification {
  const differenceCents = invoiceGrossCents - skontoCents - paidCents;

  if (differenceCents === 0) {
    return { result: "exact", differenceCents };
  }
  if (Math.abs(differenceCents) <= toleranceCents) {
    return { result: "tolerated", differenceCents };
  }
  return {
    result: differenceCents > 0 ? "underpaid" : "overpaid",
    differenceCents,
  };
}

/**
 * Darf die Zahlung als Vollzahlung („bezahlt") gebucht werden? Genau dann, wenn
 * die Klassifikation `exact` oder `tolerated` ist. Einziger Ort, an dem diese
 * Entscheidung getroffen wird (Schreibpfade rufen NICHT selbst gegen `result`).
 */
export function isPaymentFullyCovered(
  classification: PaymentDifferenceClassification,
): boolean {
  return classification.result === "exact" || classification.result === "tolerated";
}
