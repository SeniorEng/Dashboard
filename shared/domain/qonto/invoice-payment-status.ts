/**
 * Task #1822 — Eine SSoT für die fachliche Frage „Welchen Status impliziert der
 * (kumulierte) Zahlungsstand einer Rechnung?".
 *
 * Reine, DB-freie Ableitung. Baut auf `classifyPaymentDifference` (SSoT für
 * „passt der Betrag?") auf und ERSETZT die zuvor an den Match-Schreibpfaden
 * verstreute Ad-hoc-Logik `isPaymentFullyCovered(...) ? "bezahlt" : flag`, die
 * eine Unterzahlung nur binden+flaggen konnte, aber keinen Zwischenstatus kannte.
 *
 * Zusammenspiel mit dem Lebenszyklus (siehe `shared/domain/invoice-status.ts`):
 * „teilweise_bezahlt" ist ein ABGELEITETER Status — er entsteht ausschließlich
 * hier über den Zahlungsabgleich, nie über den manuellen Status-Endpoint.
 *
 * Geldbeträge ausnahmslos Integer-Cents.
 */

import {
  classifyPaymentDifference,
  isPaymentFullyCovered,
  type PaymentDifferenceClassification,
  type PaymentDifferenceInput,
} from "./payment-difference";

/**
 * Der EINZIGE Status, den eine Zahlung noch setzen kann.
 *
 * Bis zum Status-Umbau stand hier zusätzlich `teilweise_bezahlt`. Der ist jetzt
 * ein BADGE (`shared/domain/invoice-badges.ts`) und wird nicht mehr
 * geschrieben: eine Teilzahlung ändert den Zustand der Rechnung nicht — sie
 * wartet weiterhin auf Zahlung, nur eben nicht mehr auf die volle.
 */
export type InvoicePaymentDerivedStatus = "bezahlt";

export interface InvoicePaymentStatusResult {
  /**
   * Der aus dem Zahlungsstand abzuleitende Ziel-Status — oder `null`, wenn der
   * Status NICHT automatisch gesetzt werden darf:
   *  - `paidCents <= 0` (noch keine Zahlung eingegangen) ⇒ Status bleibt offen,
   *  - Über-Toleranz-ÜBERZAHLUNG (`overpaid`) ⇒ MUSS zur Prüfung markiert werden
   *    (Invariante „niemals still auf bezahlt", Task #1284/#… Payment-Mismatch),
   *    daher hier bewusst `null`.
   */
  status: InvoicePaymentDerivedStatus | null;
  /** Die zugrunde liegende Betrags-Klassifikation (für Mismatch-Flagging am Schreibpfad). */
  classification: PaymentDifferenceClassification;
}

/**
 * Leitet den Zahlungs-Status einer Rechnung aus dem KUMULIERTEN gezahlten Betrag
 * (Σ aller Teilzahlungen) und der Forderung ab:
 *
 *  - keine Zahlung (`paidCents <= 0`)          ⇒ `null`  (Status unverändert)
 *  - voll gedeckt (`exact`/`tolerated`)        ⇒ `"bezahlt"`
 *  - Unterzahlung mit positiver Zahlung        ⇒ `null`  (Status unverändert,
 *                                                 Badge „Teilweise bezahlt")
 *  - Über-Toleranz-Überzahlung (`overpaid`)    ⇒ `null`  (flaggen, NIE still „bezahlt")
 */
export function resolveInvoicePaymentStatus(
  input: PaymentDifferenceInput,
): InvoicePaymentStatusResult {
  const classification = classifyPaymentDifference(input);

  if (input.paidCents <= 0) {
    return { status: null, classification };
  }
  if (isPaymentFullyCovered(classification)) {
    return { status: "bezahlt", classification };
  }
  if (classification.result === "underpaid") {
    // Unterzahlung setzt KEINEN Status mehr. Die Rechnung bleibt `versendet`
    // und trägt das Badge „Teilweise bezahlt", das sich bei jedem Lesen aus
    // der Zahlungssumme ergibt.
    //
    // Der frühere Status hatte einen konkreten Fehler zur Folge:
    // `assignInvoiceStage` kannte ihn nicht und schickte ihn auf
    // `rechnung_erstellt` — der Betrag zählte im Cockpit-Board neben den
    // Entwürfen. Als Badge kann das nicht mehr passieren.
    return { status: null, classification };
  }
  // `overpaid`: Über-Toleranz-Überzahlung — zur Prüfung markieren, nicht setzen.
  return { status: null, classification };
}
