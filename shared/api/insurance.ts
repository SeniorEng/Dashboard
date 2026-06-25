export interface InsuranceProviderItem {
  id: number;
  name: string;
  empfaenger: string | null;
  empfaengerZeile2: string | null;
  isPrivate: boolean;
  ikNummer: string | null;
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
  /**
   * Abgeleitetes Flag (kein DB-Feld): true, wenn die Kasse einem Kunden
   * zugewiesen ODER als Rechnungsempfänger referenziert ist. Quelle ist die
   * eine SSoT `isUnusedInsuranceProvider()`. Optional, weil nur die
   * Listen-Endpunkte es berechnen.
   */
  isUsed?: boolean;
}
