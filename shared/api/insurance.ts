export interface InsuranceProviderItem {
  id: number;
  name: string;
  empfaenger: string | null;
  empfaengerZeile2: string | null;
  ikNummer: string;
  strasse: string | null;
  hausnummer: string | null;
  plz: string | null;
  stadt: string | null;
  telefon: string | null;
  fax: string | null;
  email: string | null;
  emailVerhinderungspflege: string | null;
  kimAdresse: string | null;
  ansprechpartner: string | null;
  datenannahmeIk: string | null;
  emailInvoiceEnabled: boolean;
  zahlungsbedingungen: string | null;
  zahlungsart: string | null;
  isActive: boolean;
  createdAt: string;
}
