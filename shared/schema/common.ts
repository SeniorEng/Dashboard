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

export const plzSchema = z.string()
  .regex(/^\d{5}$/, "PLZ muss 5 Ziffern haben");
