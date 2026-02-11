import { z } from "zod";
import { optionalGermanPhoneSchema, germanPhoneTransformSchema, plzSchema, versichertennummerSchema } from "./common";
import { CONTACT_TYPES } from "./customers";
import { CONTRACT_PERIOD_TYPES } from "./contracts";
import type { Customer, CustomerContact, CustomerCareLevelHistory, CustomerNeedsAssessment, CustomerPricing } from "./customers";
import type { CustomerInsuranceHistory, InsuranceProvider } from "./insurance";
import type { CustomerContract, CustomerContractRate } from "./contracts";
import type { CustomerBudget, BudgetSummary } from "./budget";

// ============================================
// FULL CUSTOMER CREATION SCHEMA (Admin Form)
// ============================================

// This is the comprehensive schema for creating a customer via the admin form
export const createFullCustomerSchema = z.object({
  // Personal data
  vorname: z.string().min(1, "Vorname ist erforderlich"),
  nachname: z.string().min(1, "Nachname ist erforderlich"),
  email: z.string().email("Ungültige E-Mail-Adresse").optional().nullable(),
  festnetz: optionalGermanPhoneSchema,
  mobiltelefon: optionalGermanPhoneSchema,
  geburtsdatum: z.string().min(1, "Geburtsdatum ist erforderlich"),
  
  // Address
  strasse: z.string().min(1, "Straße ist erforderlich"),
  hausnummer: z.string().min(1, "Hausnummer ist erforderlich"),
  plz: plzSchema,
  stadt: z.string().min(1, "Stadt ist erforderlich"),
  
  // Insurance
  insuranceProviderId: z.number().min(1, "Pflegekasse ist erforderlich"),
  versichertennummer: versichertennummerSchema,
  
  // Primary emergency contact (required)
  primaryContact: z.object({
    contactType: z.enum(CONTACT_TYPES),
    vorname: z.string().min(1, "Vorname ist erforderlich"),
    nachname: z.string().min(1, "Nachname ist erforderlich"),
    telefon: germanPhoneTransformSchema,
  }),
  
  // Additional emergency contacts (optional)
  additionalContacts: z.array(z.object({
    contactType: z.enum(CONTACT_TYPES),
    vorname: z.string().min(1),
    nachname: z.string().min(1),
    telefon: germanPhoneTransformSchema,
  })).optional().default([]),
  
  // Needs assessment
  householdSize: z.number().min(1).default(1),
  pflegegrad: z.number().min(1).max(5),
  pflegegradSeit: z.string().min(1, "Pflegegrad seit ist erforderlich"),
  pflegegradBeantragt: z.number().min(1).max(5).optional().nullable(),
  pflegedienstBeauftragt: z.boolean().default(false),
  anamnese: z.string().max(2000).optional().nullable(),
  
  // Selected services
  services: z.object({
    haushaltHilfe: z.boolean().optional().default(false),
    mahlzeiten: z.boolean().optional().default(false),
    reinigung: z.boolean().optional().default(false),
    waeschePflege: z.boolean().optional().default(false),
    einkauf: z.boolean().optional().default(false),
    tagesablauf: z.boolean().optional().default(false),
    alltagsverrichtungen: z.boolean().optional().default(false),
    terminbegleitung: z.boolean().optional().default(false),
    botengaenge: z.boolean().optional().default(false),
    grundpflege: z.boolean().optional().default(false),
    freizeitbegleitung: z.boolean().optional().default(false),
    demenzbetreuung: z.boolean().optional().default(false),
    gesellschaft: z.boolean().optional().default(false),
    sozialeKontakte: z.boolean().optional().default(false),
    freizeitgestaltung: z.boolean().optional().default(false),
    kreativ: z.boolean().optional().default(false),
  }).optional().default({}),
  sonstigeLeistungen: z.string().max(250).optional().nullable(),
  
  // Budgets (in euros, will convert to cents)
  entlastungsbetrag45b: z.number().min(0).default(0),
  verhinderungspflege39: z.number().min(0).default(0),
  pflegesachleistungen36: z.number().min(0).default(0),
  
  // Contract
  contractHours: z.number().min(1),
  contractPeriod: z.enum(CONTRACT_PERIOD_TYPES),
  contractStart: z.string().optional().nullable(),
  
  // Prices (in euros, will convert to cents) - all required
  hauswirtschaftRate: z.number().min(0, "Hauswirtschaft-Preis ist erforderlich"),
  alltagsbegleitungRate: z.number().min(0, "Alltagsbegleitung-Preis ist erforderlich"),
  kilometerRate: z.number().min(0, "Kilometer-Preis ist erforderlich"),
});

export type CreateFullCustomer = z.infer<typeof createFullCustomerSchema>;

// Customer with all related data for detail view
export type CustomerWithDetails = Customer & {
  insurance?: CustomerInsuranceHistory & { provider: InsuranceProvider };
  contacts: CustomerContact[];
  careLevelHistory: CustomerCareLevelHistory[];
  needsAssessment?: CustomerNeedsAssessment;
  budget?: CustomerBudget;
  contract?: CustomerContract & { rates: CustomerContractRate[] };
  primaryEmployee?: { id: number; displayName: string };
  backupEmployee?: { id: number; displayName: string };
  pricingHistory?: CustomerPricing[];
  currentPricing?: CustomerPricing;
  budgetSummary?: BudgetSummary;
};
