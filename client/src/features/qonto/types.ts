import type { PaymentDifferenceResult } from "@shared/domain/qonto/payment-difference";

export type { PaymentDifferenceResult };

export interface QontoAccountStatus {
  iban: string;
  success: boolean;
  error?: string;
}

export interface QontoStatus {
  configured: boolean;
  lastSync: string | null;
  connection: {
    success: boolean;
    error?: string;
    bankAccountName?: string;
    accounts?: QontoAccountStatus[];
  } | null;
}

export interface QontoTransaction {
  id: number;
  qontoTransactionId: string;
  amountCents: number;
  currency: string;
  side: string;
  counterpartyName: string | null;
  reference: string | null;
  label: string | null;
  emittedAt: string;
  status: string;
  sourceIban: string | null;
  matchedInvoiceId: number | null;
  matchedPaymentAdviceId: number | null;
  matchConfidence: string | null;
  billingIrrelevantAt: string | null;
  billingIrrelevantSource: string | null;
  billingRelevantOverrideAt: string | null;
  adviceSuggestionDismissedAt: string | null;
  /** Task #1672 — Anzeige-Infos zum verknüpften Sammel-Avis (nur wenn gebunden). */
  matchedAdvice?: {
    id: number;
    avisNummer: string | null;
    invoiceCount: number;
    gesamtBetragCents: number | null;
  } | null;
  /** Σ Brutto aller dieser Zahlung zugeordneten Rechnungen (nur wenn gebunden). */
  matchedGrossCents?: number | null;
  /** `matchedGross − gezahlt`: >0 Unterzahlung, <0 Überzahlung (nur wenn gebunden). */
  paymentDifferenceCents?: number | null;
  /** SSoT-Klassifikation der Zahlungsdifferenz (nur wenn gebunden). */
  paymentDifferenceResult?: PaymentDifferenceResult | null;
}

/** Task #1672 — ein rückwirkender Sammel-Avis-Vorschlag für eine offene Zahlung. */
export interface AdviceSuggestionCandidate {
  adviceId: number;
  avisNummer: string | null;
  invoiceCount: number;
  gesamtBetragCents: number | null;
  reason: "unique_amount" | "discriminator" | "amount_ambiguous";
  strong: boolean;
}

export interface AdviceSuggestion {
  transactionId: number;
  candidates: AdviceSuggestionCandidate[];
}

export interface QontoHideRule {
  id: number;
  ruleType: "counterparty" | "iban";
  value: string;
  createdByUserId: number | null;
  createdAt: string;
}

export interface Invoice {
  id: number;
  invoiceNumber: string;
  customerName: string | null;
  grossAmountCents: number;
  status: string;
}

export interface PaymentAdviceItem {
  id: number;
  paymentAdviceId: number;
  belegNr: string | null;
  vorgangsNr: string | null;
  rechnungsNummer: string | null;
  rechnungsDatum: string | null;
  verwendungszweck: string | null;
  betragCents: number;
  skontoCents: number;
  buchungsDatum: string | null;
  matchedInvoiceId: number | null;
  /** Task #1687 — Brutto der zugeordneten Rechnung (nur bei Treffer, am Lesepfad angereichert). */
  matchedInvoiceGrossCents?: number | null;
  /** Task #1687 — abgeleitete Unterzahlung/Kürzung = max(0, Rechnungs-Brutto − gezahlt). */
  unterzahlungCents?: number;
  /** Abgeleitete Überzahlung = max(0, gezahlt − Rechnungs-Brutto) (am Lesepfad angereichert). */
  ueberzahlungCents?: number;
  /** SSoT-Klassifikation der Positions-Zahlungsdifferenz (nur bei Treffer). */
  paymentDifferenceResult?: PaymentDifferenceResult | null;
}

export interface PaymentAdvice {
  id: number;
  insuranceProviderName: string | null;
  ikNummer: string | null;
  objectPath: string | null;
  fileName: string;
  notes: string | null;
  format: string;
  avisNummer: string | null;
  belegNummer: string | null;
  gesamtBetragCents: number | null;
  zahlungsDatum: string | null;
  kostentraegerIk: string | null;
  kostentraegerName: string | null;
  zahlungsempfaengerIk: string | null;
  zahlungsempfaengerIban: string | null;
  skontoCents: number;
  kuerzungCents: number;
  uploadedAt: string;
  items: PaymentAdviceItem[];
  matchedInvoiceCount?: number;
  unpaidMatchedCount?: number;
  /** Task #1687 — Σ der abgeleiteten Positions-Unterzahlungen (am Lesepfad angereichert). */
  unterzahlungCents?: number;
  /** Σ der abgeleiteten Positions-Überzahlungen (am Lesepfad angereichert). */
  ueberzahlungCents?: number;
}

/** Task #1685 — eine konkurrierende Gutschrift eines mehrdeutigen Avis. */
export interface AmbiguousAdviceCredit {
  txId: number;
  txAmountCents: number;
  txEmittedAt: string;
  daysDelta: number;
  txCounterpartyName: string | null;
  txSourceIban: string | null;
  nameMatchesAdvisory: boolean;
}

/**
 * Task #1685 — ein Avis, dessen Sammelzahlungs-Zuordnung mehrdeutig ist und daher
 * vom Operator manuell aufgelöst werden muss. Spiegelt die `AmbiguousAdvice`-Logik
 * aus dem Backfill-Verifier (SSoT `computeProposals`).
 */
export interface AmbiguousAdvice {
  adviceId: number;
  avisNummer: string | null;
  adviceAmountCents: number;
  adviceIban: string | null;
  kostentraegerName: string | null;
  anchorDate: string | null;
  invoiceCount: number;
  reason: "multiple_credits" | "credit_collision";
  collidingAdviceIds: number[];
  candidates: AmbiguousAdviceCredit[];
}

/** Task #1742 — eine Rechnung, die in eine Zahlung eingeflossen ist (Anzeige). */
export interface MatchedInvoiceDisplay {
  id: number;
  invoiceNumber: string;
  recipientName: string;
  customerName: string | null;
  grossAmountCents: number;
  status: string;
  createdAt: string;
}

/** Task #1742 — die einer Qonto-Zahlung zugeordneten Rechnungen inkl. Σ-Abgleich. */
export interface MatchedInvoicesForTransaction {
  matchType: "single" | "bulk" | "none";
  transactionAmountCents: number;
  invoices: MatchedInvoiceDisplay[];
  sumCents: number;
}

export type Tab = "transactions" | "advices" | "ambiguous";

export type MatchFilter = "all" | "matched" | "unmatched" | "ignored";
