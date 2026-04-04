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

export interface CustomerPricingInfo {
  id: number;
  customerId: number;
  hauswirtschaftRateCents: number | null;
  alltagsbegleitungRateCents: number | null;
  kilometerRateCents: number | null;
  validFrom: string;
  validTo: string | null;
  createdAt: string;
}

export interface BudgetSummaryInfo {
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

export interface CustomerBudgetsInfo {
  entlastungsbetrag45b: number;
  verhinderungspflege39: number;
  pflegesachleistungen36: number;
}

export interface CustomerNeedsAssessmentInfo {
  id: number;
  assessmentDate: string;
  householdSize: number;
  pflegedienstBeauftragt: boolean;
  anamnese: string | null;
  serviceHaushaltHilfe: boolean;
  serviceMahlzeiten: boolean;
  serviceReinigung: boolean;
  serviceWaeschePflege: boolean;
  serviceEinkauf: boolean;
  serviceTagesablauf: boolean;
  serviceAlltagsverrichtungen: boolean;
  serviceTerminbegleitung: boolean;
  serviceBotengaenge: boolean;
  serviceGrundpflege: boolean;
  serviceFreizeitbegleitung: boolean;
  serviceDemenzbetreuung: boolean;
  serviceGesellschaft: boolean;
  serviceSozialeKontakte: boolean;
  serviceFreizeitgestaltung: boolean;
  serviceKreativ: boolean;
  sonstigeLeistungen: string | null;
}

export interface CustomerContractInfo {
  id: number;
  contractDate: string | null;
  contractStart: string;
  contractEnd: string | null;
  vereinbarteLeistungen: string | null;
  hoursPerPeriod: number;
  periodType: string;
  status: string;
  hauswirtschaftRateCents: number;
  alltagsbegleitungRateCents: number;
  kilometerRateCents: number;
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

export interface CustomerCareLevelHistoryItem {
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
  pricingHistory: CustomerPricingInfo[];
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
