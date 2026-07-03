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
  matchConfidence: string | null;
  billingIrrelevantAt: string | null;
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
}

export type Tab = "transactions" | "advices";

export type MatchFilter = "all" | "matched" | "unmatched" | "ignored";
