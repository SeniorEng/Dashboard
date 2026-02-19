import { pgTable, text, integer, serial } from "drizzle-orm/pg-core";
import { z } from "zod";
import { timestamp } from "./common";
import { users } from "./users";

export const companySettings = pgTable("company_settings", {
  id: serial("id").primaryKey(),
  companyName: text("company_name"),
  geschaeftsfuehrer: text("geschaeftsfuehrer"),
  strasse: text("strasse"),
  hausnummer: text("hausnummer"),
  plz: text("plz"),
  stadt: text("stadt"),
  telefon: text("telefon"),
  email: text("email"),
  website: text("website"),
  steuernummer: text("steuernummer"),
  ustId: text("ust_id"),
  iban: text("iban"),
  bic: text("bic"),
  bankName: text("bank_name"),
  ikNummer: text("ik_nummer"),
  anerkennungsnummer45a: text("anerkennungsnummer_45a"),
  anerkennungsBundesland: text("anerkennungs_bundesland"),
  logoUrl: text("logo_url"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  updatedByUserId: integer("updated_by_user_id").references(() => users.id),
});

export type CompanySettings = typeof companySettings.$inferSelect;

export const updateCompanySettingsSchema = z.object({
  companyName: z.string().optional(),
  geschaeftsfuehrer: z.string().optional(),
  strasse: z.string().optional(),
  hausnummer: z.string().optional(),
  plz: z.string().optional(),
  stadt: z.string().optional(),
  telefon: z.string().optional(),
  email: z.string().optional(),
  website: z.string().optional().nullable(),
  steuernummer: z.string().optional(),
  ustId: z.string().optional().nullable(),
  iban: z.string().optional(),
  bic: z.string().optional(),
  bankName: z.string().optional(),
  ikNummer: z.string().optional(),
  anerkennungsnummer45a: z.string().optional(),
  anerkennungsBundesland: z.string().optional(),
  logoUrl: z.string().optional().nullable(),
});

export type UpdateCompanySettings = z.infer<typeof updateCompanySettingsSchema>;
