import type { Customer } from "../schema";
import type { PaginationParams } from "./pagination";

export interface CustomerListItem {
  id: number;
  name: string;
  vorname: string | null;
  nachname: string | null;
  billingType: string | null;
  email: string | null;
  telefon: string | null;
  festnetz: string | null;
  address: string | null;
  stadt: string | null;
  pflegegrad: number | null;
  geburtsdatum: string | null;
  status: string;
  inaktivAb: string | null;
  primaryEmployee: { id: number; displayName: string } | null;
  backupEmployee: { id: number; displayName: string } | null;
  backupEmployee2: { id: number; displayName: string } | null;
  matchedRole?: "primary" | "backup" | "backup2";
  hasActiveContract: boolean;
  hasBetreuer: boolean;
  rechnungAnKunde: boolean;
  createdAt: string;
}

export interface CustomerListParams extends PaginationParams {
  pflegegrad?: string;
  billingType?: string;
  responsibleEmployeeId?: string;
  status?: string;
  insuranceProviderId?: string;
  sortBy?: string;
  sortOrder?: string;
}

interface BudgetSummaryInfo {
  customerId: number;
  totalAllocatedCents: number;
  totalUsedCents: number;
  availableCents: number;
  carryoverCents: number;
  carryoverExpiresAt: string | null;
  currentYearAllocatedCents: number;
  monthlyLimitCents: number | null;
  currentMonthUsedCents: number;
}

interface CustomerBudgetsInfo {
  entlastungsbetrag45b: number;
  verhinderungspflege39: number;
  pflegesachleistungen36: number;
}

interface CustomerNeedsAssessmentInfo {
  id: number;
  customerId: number;
  createdByUserId: number | null;
  createdAt: string | Date;
  assessmentDate: string;
  householdSize: number;
  pflegedienstBeauftragt: boolean | null;
  anamnese: string | null;
  serviceHaushaltHilfe: boolean | null;
  serviceMahlzeiten: boolean | null;
  serviceReinigung: boolean | null;
  serviceWaeschePflege: boolean | null;
  serviceEinkauf: boolean | null;
  serviceTagesablauf: boolean | null;
  serviceAlltagsverrichtungen: boolean | null;
  serviceTerminbegleitung: boolean | null;
  serviceBotengaenge: boolean | null;
  serviceGrundpflege: boolean | null;
  serviceFreizeitbegleitung: boolean | null;
  serviceDemenzbetreuung: boolean | null;
  serviceGesellschaft: boolean | null;
  serviceSozialeKontakte: boolean | null;
  serviceFreizeitgestaltung: boolean | null;
  serviceKreativ: boolean | null;
  sonstigeLeistungen: string | null;
}

interface CustomerContractInfo {
  id: number;
  contractDate: string | null;
  contractStart: string;
  contractEnd: string | null;
  vereinbarteLeistungen: string | null;
  hoursPerPeriod: number;
  periodType: string;
  status: string;
  notes: string | null;
}

export interface CustomerContactItem {
  id: number;
  contactType: string;
  isPrimary: boolean;
  vorname: string;
  nachname: string;
  festnetz: string | null;
  mobilnummer: string | null;
  email: string | null;
  notes: string | null;
}

interface CustomerCareLevelHistoryItem {
  id: number;
  pflegegrad: number;
  validFrom: string;
  validTo: string | null;
  notes: string | null;
}

export interface CustomerDetail extends Customer {
  currentInsurance: {
    id: number;
    providerName: string;
    ikNummer?: string;
    versichertennummer: string;
    validFrom: string;
  } | null;
  contacts: CustomerContactItem[];
  careLevelHistory: CustomerCareLevelHistoryItem[];
  currentBudgets: CustomerBudgetsInfo | null;
  activeContractCount: number;
  needsAssessment: CustomerNeedsAssessmentInfo | null;
  currentContract: CustomerContractInfo | null;
  primaryEmployee: { id: number; displayName: string } | null;
  backupEmployee: { id: number; displayName: string } | null;
  backupEmployee2: { id: number; displayName: string } | null;
}

export interface CreateCustomerRequest {
  vorname: string;
  nachname: string;
  telefon?: string;
  festnetz?: string;
  email?: string;
  strasse: string;
  nr: string;
  plz: string;
  stadt: string;
  pflegegrad?: number;
  pflegegradSeit?: string;
  vorerkrankungen?: string;
  haustierVorhanden?: boolean;
  haustierDetails?: string;
  personenbefoerderungGewuenscht?: boolean;
  acceptsPrivatePayment?: boolean;
  rechnungAnKunde?: boolean;
  documentDeliveryMethod?: "email" | "post";
  receivesMonthlyInvoice?: boolean;
  billingType?: "pflegekasse_gesetzlich" | "pflegekasse_privat" | "selbstzahler";
  insurance?: {
    providerId: number;
    versichertennummer: string;
    validFrom: string;
  };
  contacts?: Array<{
    contactType: string;
    isPrimary: boolean;
    vorname: string;
    nachname: string;
    festnetz?: string;
    mobilnummer?: string;
    email?: string;
    notes?: string;
  }>;
  budgets?: {
    entlastungsbetrag45b: number;
    verhinderungspflege39: number;
    pflegesachleistungen36: number;
    validFrom: string;
  };
  contract?: {
    contractStart: string;
    contractDate?: string;
    vereinbarteLeistungen?: string;
    hoursPerPeriod: number;
    periodType: string;
    rates?: Array<{
      serviceCategory: string;
      hourlyRateCents: number;
    }>;
  };
}
