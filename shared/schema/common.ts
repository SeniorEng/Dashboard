import { timestamp as pgTimestamp } from "drizzle-orm/pg-core";
import { z } from "zod";
import { isValidPhoneNumber, parsePhoneNumber, CountryCode } from "libphonenumber-js/min";

export const timestamp = (name: string) => pgTimestamp(name, { withTimezone: true });

const DACH_COUNTRIES: CountryCode[] = ["DE", "AT", "CH"];
const PHONE_ERROR = "Ungültige Telefonnummer (DE/AT/CH)";

export function isDachPhone(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    for (const country of DACH_COUNTRIES) {
      if (isValidPhoneNumber(trimmed, country)) {
        const parsed = parsePhoneNumber(trimmed, country);
        if (parsed?.country && DACH_COUNTRIES.includes(parsed.country as CountryCode)) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

function parseDachPhone(value: string): string {
  const trimmed = value.trim();
  for (const country of DACH_COUNTRIES) {
    if (isValidPhoneNumber(trimmed, country)) {
      const parsed = parsePhoneNumber(trimmed, country);
      if (parsed?.country && DACH_COUNTRIES.includes(parsed.country as CountryCode)) {
        return parsed.format("E.164");
      }
    }
  }
  return value;
}

export const germanPhoneSchema = z.string().refine(
  (value) => {
    if (!value || value.trim() === "") return false;
    return isDachPhone(value);
  },
  { message: PHONE_ERROR }
);

export const germanPhoneTransformSchema = germanPhoneSchema.transform((value) => {
  return parseDachPhone(value);
});

export const optionalGermanPhoneSchema = z.union([
  z.null(),
  z.undefined(),
  z.literal(""),
  z.string(),
]).transform((value, ctx) => {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  
  const trimmed = value.trim();
  if (trimmed === "") return null;
  
  if (!isDachPhone(trimmed)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: PHONE_ERROR,
    });
    return z.NEVER;
  }
  return parseDachPhone(trimmed);
});

export const internationalPhoneTransformSchema = z.string().refine(
  (value) => {
    if (!value || value.trim() === "") return false;
    return isDachPhone(value);
  },
  { message: PHONE_ERROR }
).transform((value) => {
  return parseDachPhone(value);
});

export const optionalInternationalPhoneSchema = z.string().optional().nullable().transform((val, ctx) => {
  if (val === undefined) return undefined;
  if (val === null || val.trim() === "") return val;
  
  const trimmed = val.trim();
  
  try {
    for (const country of DACH_COUNTRIES) {
      if (isValidPhoneNumber(trimmed, country)) {
        const parsed = parsePhoneNumber(trimmed, country);
        if (parsed?.isValid()) {
          return parsed.format("E.164");
        }
      }
    }
    if (isValidPhoneNumber(trimmed)) {
      const parsed = parsePhoneNumber(trimmed);
      return parsed?.format("E.164") ?? trimmed;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Ungültige Telefonnummer",
    });
    return z.NEVER;
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Ungültige Telefonnummer",
    });
    return z.NEVER;
  }
});

export const ikNummerSchema = z.string()
  .regex(/^\d{9}$/, "IK-Nummer muss genau 9 Ziffern haben");

export const internationalEmailSchema = z.string()
  .refine(
    (value) => {
      if (!value || value.trim() === "") return true;
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
    },
    { message: "Ungültige E-Mail-Adresse" }
  );

export const versichertennummerSchema = z.string()
  .regex(/^[A-Z]\d{9}$/, "Versichertennummer muss 1 Buchstabe + 9 Ziffern sein (z.B. A123456789)");

// Privatpatienten haben uneinheitliche Nummernformate (z.B. Debeka:
// "6163938.1"). Daher zusätzlich zu Buchstaben/Ziffern/Binde-/Schrägstrichen
// auch Punkte erlauben.
export const versichertennummerFlexSchema = z.string()
  .min(3, "Versichertennummer muss mindestens 3 Zeichen haben")
  .max(20, "Versichertennummer darf maximal 20 Zeichen haben")
  .regex(/^[A-Za-z0-9\-\/.]+$/, "Versichertennummer darf nur Buchstaben, Ziffern, Bindestriche, Schrägstriche und Punkte enthalten");

export const VERSICHERTENNUMMER_GKV_REGEX = /^[A-Z]\d{9}$/;
export const VERSICHERTENNUMMER_FLEX_REGEX = /^[A-Za-z0-9\-\/.]{3,20}$/;
export const VERSICHERTENNUMMER_GKV_HINT = "Format: 1 Buchstabe + 9 Ziffern (z.B. A123456789)";
export const VERSICHERTENNUMMER_FLEX_HINT = "3–20 Zeichen: Buchstaben, Ziffern, Bindestriche, Schrägstriche, Punkte";

export function isPrivatePatientCase(opts: {
  billingType?: string | null;
  isPrivateProvider?: boolean | null;
}): boolean {
  return opts.billingType === "pflegekasse_privat" || !!opts.isPrivateProvider;
}

export function pickVersichertennummerSchema(opts: {
  billingType?: string | null;
  isPrivateProvider?: boolean | null;
}) {
  return isPrivatePatientCase(opts) ? versichertennummerFlexSchema : versichertennummerSchema;
}

export function validateVersichertennummerFor(
  value: string,
  opts: { billingType?: string | null; isPrivateProvider?: boolean | null },
): { ok: true } | { ok: false; message: string } {
  const isPrivate = isPrivatePatientCase(opts);
  if (isPrivate) {
    return VERSICHERTENNUMMER_FLEX_REGEX.test(value)
      ? { ok: true }
      : { ok: false, message: "Versichertennummer muss 3-20 Zeichen sein (Buchstaben, Ziffern, Bindestriche, Schrägstriche, Punkte)" };
  }
  return VERSICHERTENNUMMER_GKV_REGEX.test(value)
    ? { ok: true }
    : { ok: false, message: "Versichertennummer muss 1 Großbuchstabe + 9 Ziffern sein (z.B. A123456789)" };
}

export const plzSchema = z.string()
  .regex(/^\d{5}$/, "PLZ muss 5 Ziffern haben");
