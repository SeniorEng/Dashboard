import { User2, Heart, Users, Wallet, FileText, PenTool, UserCheck, CreditCard, Send } from "lucide-react";
import { PFLEGEGRAD_SELECT_OPTIONS, CONTACT_TYPE_SELECT_OPTIONS, type BillingType } from "@shared/domain/customers";
import { isPflegekasseCustomer, needsBudgetData } from "@shared/domain/customers";
import type { BudgetType } from "@shared/domain/budgets";

export interface ContactFormData {
  vorname: string;
  nachname: string;
  contactType: string;
  telefon: string;
  email: string;
  isPrimary: boolean;
}

export interface BudgetTypeSettingForm {
  budgetType: BudgetType;
  enabled: boolean;
  monthlyLimitCents: string;
  yearlyLimitCents: string;
}

export interface CustomerFormData {
  billingType: BillingType;
  vorname: string;
  nachname: string;
  geburtsdatum: string;
  email: string;
  telefon: string;
  festnetz: string;
  strasse: string;
  nr: string;
  plz: string;
  stadt: string;
  pflegegrad: string;
  pflegegradSeit: string;
  primaryEmployeeId: string;
  backupEmployeeId: string;
  vorerkrankungen: string;
  haustierVorhanden: boolean;
  haustierDetails: string;
  personenbefoerderungGewuenscht: boolean;
  insuranceProviderId: string;
  versichertennummer: string;
  contacts: ContactFormData[];
  budgetTypeSettings: BudgetTypeSettingForm[];
  entlastungsbetrag45b: string;
  verhinderungspflege39: string;
  pflegesachleistungen36: string;
  contractDate: string;
  contractStart: string;
  vereinbarteLeistungen: string;
  contractHours: string;
  contractPeriod: "weekly" | "monthly";
  documentDeliveryMethod: "email" | "post";
  acceptsPrivatePayment: boolean;
}

export interface SelectOption {
  value: string;
  label: string;
  sublabel?: string;
}

export interface StepConfig {
  id: string;
  title: string;
  icon: typeof User2;
}

const ALL_STEPS: StepConfig[] = [
  { id: "customerType", title: "Kundentyp", icon: CreditCard },
  { id: "personal", title: "Persönliche Daten", icon: User2 },
  { id: "insurance", title: "Pflegekasse", icon: Heart },
  { id: "contract", title: "Vertrag", icon: FileText },
  { id: "budgets", title: "Budgets", icon: Wallet },
  { id: "contacts", title: "Kontakte", icon: Users },
  { id: "signatures", title: "Unterschriften", icon: PenTool },
  { id: "delivery", title: "Versand", icon: Send },
  { id: "matching", title: "Mitarbeiter", icon: UserCheck },
];

export function getStepsForBillingType(billingType: BillingType): StepConfig[] {
  if (isPflegekasseCustomer(billingType)) {
    return ALL_STEPS;
  }
  return ALL_STEPS.filter((s) => s.id !== "insurance" && s.id !== "budgets");
}

export const STEPS = ALL_STEPS;

export const PFLEGEGRAD_OPTIONS = PFLEGEGRAD_SELECT_OPTIONS;

export const CONTACT_TYPES = CONTACT_TYPE_SELECT_OPTIONS;

export const PERIOD_TYPES = [
  { value: "weekly", label: "Pro Woche" },
  { value: "monthly", label: "Pro Monat" },
];

export const DEFAULT_BUDGETS = {
  entlastungsbetrag45b: 131,
  verhinderungspflege39: 3539,
  pflegesachleistungen36: 0,
} as const;

export const EMPTY_CONTACT: ContactFormData = {
  vorname: "",
  nachname: "",
  contactType: "familie",
  telefon: "",
  email: "",
  isPrimary: true,
};

export const MAX_CONTACTS = 3;
