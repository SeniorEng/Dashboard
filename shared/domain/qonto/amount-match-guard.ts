/**
 * Task #1864 — Absicherung des reinen Betrags-Treffers im Qonto-Zahlungsabgleich.
 *
 * Der Auto-Match bindet eine Bankzahlung bislang automatisch an eine Rechnung und
 * setzt sie still auf „bezahlt", sobald es GENAU EINE offene Rechnung mit exakt
 * diesem Betrag gibt (`auto_amount`) — OHNE den Verwendungszweck
 * (Versicherten-Name, Versichertennummer, Abrechnungszeitraum) oder die zeitliche
 * Plausibilität zu prüfen. Dadurch konnte eine betragsgleiche Fremdzahlung eine
 * fremde Rechnung unbemerkt begleichen (kundenübergreifender Fehl-Match).
 *
 * Diese SSoT entscheidet für einen REINEN Betrags-Treffer (keine Rechnungsnummer),
 * wie damit zu verfahren ist:
 *  - `block_implausible_date` — die Zahlung datiert VOR der Rechnungserstellung
 *    (Plausibilitäts-Guard) ⇒ gar nicht binden;
 *  - `confirm` — ein identifizierendes Merkmal der Rechnung taucht im
 *    Verwendungszweck auf ⇒ darf wie bisher als Zahlung gebucht werden;
 *  - `review` — nur Betragsgleichheit, kein Beleg ⇒ binden, aber NICHT still auf
 *    „bezahlt" setzen; zur manuellen Bestätigung/Ablehnung markieren.
 *
 * Reine, DB-freie Logik (unit-getestet). Starke Treffer (Rechnungsnummer, exakt,
 * Sammel-Avis) laufen NICHT durch dieses Modul und bleiben unverändert.
 */

/** Confidence-Kennzeichen eines gebundenen, aber prüfbedürftigen Betrags-Treffers. */
export const AMOUNT_MATCH_REVIEW_CONFIDENCE = "auto_amount_review";

/** Minimale Länge, ab der ein Namensbestandteil als Beleg zählt (verhindert Initialen-/„e.V."-Treffer). */
const MIN_NAME_TOKEN_LENGTH = 3;
/** Minimale Länge einer Versichertennummer, ab der sie als Beleg zählt. */
const MIN_VERSICHERTENNUMMER_LENGTH = 5;

const MONTH_NAMES_DE = [
  "januar", "februar", "märz", "april", "mai", "juni",
  "juli", "august", "september", "oktober", "november", "dezember",
];

/** Für die Rechnung bekannte, potenziell im Verwendungszweck belegbare Merkmale. */
export interface AmountMatchInvoiceFields {
  /**
   * Name der/des VERSICHERTEN (Kunden-Stammname, z. B. „Bernd Funke"). NUR dieses
   * Feld dient als Namens-Beleg — bewusst NICHT `recipientName`: bei Pflegekassen
   * ist der Rechnungsempfänger die KASSE (z. B. „AOK Bayern"), also der Zahler
   * selbst, und stünde damit im Verwendungszweck JEDER Zahlung dieser Kasse ⇒
   * würde jeden betragsgleichen Fremd-Treffer fälschlich „belegen".
   */
  customerName?: string | null;
  versichertennummer?: string | null;
  billingMonth?: number | null;
  billingYear?: number | null;
}

export type AmountMatchDecision = "block_implausible_date" | "confirm" | "review";

export interface AmountMatchOutcome {
  decision: AmountMatchDecision;
  /** Welche Merkmale den Treffer belegt haben, z. B. `["versichertennummer"]`. */
  corroboration: string[];
}

export interface AmountMatchInput {
  /** Bank-Emissionsdatum der Zahlung (`qonto_transactions.emitted_at`). */
  paymentEmittedAt: Date;
  /** Erstellungsdatum der getroffenen Rechnung (`invoices.created_at`). */
  invoiceCreatedAt: Date;
  /** Bereits zusammengeführter, kleingeschriebener Verwendungszweck-Text. */
  searchText: string;
  invoice: AmountMatchInvoiceFields;
}

function startOfLocalDay(d: Date): number {
  const x = new Date(d.getTime());
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

/**
 * Plausibilitäts-Guard: Eine Gutschrift, deren Bank-Datum (Kalendertag) VOR dem
 * Erstellungstag der Rechnung liegt, kann diese Rechnung unmöglich betreffen —
 * das Geld war da, bevor die Forderung existierte. Verglichen wird auf
 * Tages-Granularität; derselbe Kalendertag gilt als plausibel (keine
 * Uhrzeit-/Zeitzonen-Fehlalarme).
 */
export function isPaymentDateImplausible(paymentEmittedAt: Date, invoiceCreatedAt: Date): boolean {
  return startOfLocalDay(paymentEmittedAt) < startOfLocalDay(invoiceCreatedAt);
}

function toWordTokens(s: string): string[] {
  // Auf Nicht-Buchstaben splitten (deutsche Umlaute/ß erhalten).
  return s.toLowerCase().split(/[^a-zäöüß]+/i).filter(Boolean);
}

function toCompactAlnum(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9äöüß]/gi, "");
}

/**
 * Sucht identifizierende Belege der Rechnung im Verwendungszweck:
 * Versichertennummer, Versicherten-Name (Kunden-Stammname) oder
 * Abrechnungszeitraum. Bewusst konservativ — ein FEHL-Beleg (false positive)
 * würde einen Fehl-Match still bezahlen, ein fehlender Beleg führt nur zur
 * (sicheren) manuellen Prüfung. Liefert die Liste der belegten Merkmale.
 */
export function findAmountMatchCorroboration(
  searchText: string,
  invoice: AmountMatchInvoiceFields,
): string[] {
  const matched: string[] = [];
  const haystack = (searchText ?? "").toLowerCase();
  if (!haystack) return matched;
  const compactHaystack = toCompactAlnum(haystack);

  // 1) Versichertennummer — stärkster, sicherster Beleg (eindeutige Kennung).
  const vnr = (invoice.versichertennummer ?? "").trim();
  if (vnr.length >= MIN_VERSICHERTENNUMMER_LENGTH) {
    const compactVnr = toCompactAlnum(vnr);
    if (compactVnr.length >= MIN_VERSICHERTENNUMMER_LENGTH && compactHaystack.includes(compactVnr)) {
      matched.push("versichertennummer");
    }
  }

  // 2) Versicherten-Name (Kunden-Stammname; NICHT der Kassen-Empfänger).
  const haystackTokens = new Set(toWordTokens(haystack));
  for (const t of toWordTokens(invoice.customerName ?? "")) {
    if (t.length >= MIN_NAME_TOKEN_LENGTH && haystackTokens.has(t)) {
      matched.push("name");
      break;
    }
  }

  // 3) Abrechnungszeitraum (Monat + Jahr). Nur gut abgegrenzte Schreibweisen —
  //    mit Trenner (MM/JJJJ, MM.JJJJ, MM-JJJJ, JJJJ-MM) oder Monatsname. Eine
  //    nackte 6-stellige Ziffernfolge „MMJJJJ" wird BEWUSST NICHT geprüft, da sie
  //    als Teilstring in IBANs/anderen Nummern zufällig auftreten könnte.
  const month = invoice.billingMonth;
  const year = invoice.billingYear;
  if (month && year && month >= 1 && month <= 12) {
    const mm = String(month).padStart(2, "0");
    const m = String(month);
    const y = String(year);
    const numericCandidates = [
      `${mm}/${y}`, `${mm}.${y}`, `${mm}-${y}`,
      `${m}/${y}`, `${m}.${y}`, `${m}-${y}`,
      `${y}-${mm}`,
    ];
    const monthName = MONTH_NAMES_DE[month - 1];
    const nameCandidates = [`${monthName} ${y}`, `${monthName}${y}`];
    const found =
      numericCandidates.some((c) => haystack.includes(c)) ||
      nameCandidates.some((c) => compactHaystack.includes(toCompactAlnum(c)));
    if (found) matched.push("period");
  }

  return matched;
}

/**
 * Entscheidet für einen reinen Betrags-Treffer (keine Rechnungsnummer), wie damit
 * zu verfahren ist. Siehe Modul-Kopf.
 */
export function evaluateAmountOnlyMatch(input: AmountMatchInput): AmountMatchOutcome {
  if (isPaymentDateImplausible(input.paymentEmittedAt, input.invoiceCreatedAt)) {
    return { decision: "block_implausible_date", corroboration: [] };
  }
  const corroboration = findAmountMatchCorroboration(input.searchText, input.invoice);
  if (corroboration.length > 0) {
    return { decision: "confirm", corroboration };
  }
  return { decision: "review", corroboration: [] };
}
