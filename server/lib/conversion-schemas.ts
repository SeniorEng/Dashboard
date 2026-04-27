import { z } from "zod";
import {
  optionalGermanPhoneSchema,
  internationalEmailSchema,
  versichertennummerFlexSchema,
} from "@shared/schema/common";

const baseContactSchema = z.object({
  contactType: z.string(),
  isPrimary: z.boolean(),
  vorname: z.string(),
  nachname: z.string(),
  festnetz: optionalGermanPhoneSchema,
  mobilnummer: optionalGermanPhoneSchema,
  email: z.string().optional(),
});

const baseConversionFields = {
  billingType: z.enum(["pflegekasse_gesetzlich", "pflegekasse_privat", "selbstzahler"]),
  vorname: z.string().min(1),
  nachname: z.string().min(1),
  geburtsdatum: z.string().optional().nullable(),
  email: internationalEmailSchema.optional().nullable(),
  telefon: optionalGermanPhoneSchema,
  festnetz: optionalGermanPhoneSchema,
  strasse: z.string().min(1),
  nr: z.string().min(1),
  plz: z.string().regex(/^\d{5}$/),
  stadt: z.string().min(1),
  pflegegrad: z.number().min(1).max(5).optional(),
  pflegegradSeit: z.string().optional(),
  vorerkrankungen: z.string().max(2000).optional().nullable(),
  haustierVorhanden: z.boolean().optional(),
  haustierDetails: z.string().max(500).optional().nullable(),
  personenbefoerderungGewuenscht: z.boolean().optional(),
  acceptsPrivatePayment: z.boolean().optional(),
  documentDeliveryMethod: z.enum(["email", "post"]).optional(),
  insurance: z.object({
    providerId: z.number(),
    versichertennummer: versichertennummerFlexSchema,
    validFrom: z.string(),
  }).optional(),
  budgets: z.object({
    entlastungsbetrag45b: z.number(),
    verhinderungspflege39: z.number(),
    pflegesachleistungen36: z.number(),
    validFrom: z.string(),
  }).optional(),
  contract: z.object({
    contractStart: z.string(),
    contractDate: z.string().optional(),
    vereinbarteLeistungen: z.string().optional(),
    hoursPerPeriod: z.number(),
    periodType: z.string(),
    rates: z.array(z.object({
      serviceCategory: z.string(),
      hourlyRateCents: z.number(),
    })).optional(),
  }).optional(),
  primaryEmployeeId: z.number().nullable().optional(),
  backupEmployeeId: z.number().nullable().optional(),
  backupEmployeeId2: z.number().nullable().optional(),
  skipDuplicateCheck: z.boolean().optional(),
} as const;

export const convertCustomerSchema = z.object({
  ...baseConversionFields,
  contacts: z.array(baseContactSchema).optional(),
});

export const convertProspectSchema = z.object({
  ...baseConversionFields,
  contacts: z.array(baseContactSchema.extend({
    telefon: optionalGermanPhoneSchema,
  })).optional(),
});
