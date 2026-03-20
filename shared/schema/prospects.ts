import { pgTable, text, integer, serial, date, boolean, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { timestamp, optionalGermanPhoneSchema, internationalEmailSchema } from "./common";
import { users } from "./users";
import { customers } from "./customers";

export const PROSPECT_STATUSES = [
  "neu",
  "kontaktiert",
  "wiedervorlage",
  "qualifiziert",
  "disqualifiziert",
  "erstberatung_vereinbart",
  "erstberatung_durchgeführt",
  "angebot_gemacht",
  "gewonnen",
  "nicht_interessiert",
  "absage",
] as const;

export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];

export const PROSPECT_STATUS_LABELS: Record<ProspectStatus, string> = {
  neu: "Neu",
  kontaktiert: "Kontaktiert",
  wiedervorlage: "Wiedervorlage",
  qualifiziert: "Qualifiziert",
  disqualifiziert: "Disqualifiziert",
  erstberatung_vereinbart: "Erstberatung vereinbart",
  erstberatung_durchgeführt: "Erstberatung durchgeführt",
  angebot_gemacht: "Angebot gemacht",
  gewonnen: "Erfolgreich gewonnen",
  nicht_interessiert: "Nicht interessiert",
  absage: "Absage",
};

export const PROSPECT_NOTE_TYPES = [
  "anruf",
  "email",
  "notiz",
  "statuswechsel",
] as const;

export type ProspectNoteType = (typeof PROSPECT_NOTE_TYPES)[number];

export const PROSPECT_NOTE_TYPE_LABELS: Record<ProspectNoteType, string> = {
  anruf: "Anruf",
  email: "E-Mail",
  notiz: "Notiz",
  statuswechsel: "Statuswechsel",
};

export const prospects = pgTable("prospects", {
  id: serial("id").primaryKey(),
  vorname: text("vorname").notNull(),
  nachname: text("nachname").notNull(),
  telefon: text("telefon"),
  email: text("email"),
  strasse: text("strasse"),
  nr: text("nr"),
  plz: text("plz"),
  stadt: text("stadt"),
  pflegegrad: integer("pflegegrad"),
  status: text("status").notNull().default("neu"),
  wiedervorlageDate: date("wiedervorlage_date"),
  statusNotiz: text("status_notiz"),
  quelle: text("quelle"),
  quelleDetails: text("quelle_details"),
  rawEmailContent: text("raw_email_content"),
  geoQualified: boolean("geo_qualified"),
  disqualificationReason: text("disqualification_reason"),
  convertedCustomerId: integer("converted_customer_id").references(() => customers.id),
  assignedEmployeeId: integer("assigned_employee_id").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  index("prospects_status_idx").on(table.status),
  index("prospects_wiedervorlage_date_idx").on(table.wiedervorlageDate),
  index("prospects_converted_customer_id_idx").on(table.convertedCustomerId),
]);

export const prospectNotes = pgTable("prospect_notes", {
  id: serial("id").primaryKey(),
  prospectId: integer("prospect_id").notNull().references(() => prospects.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => users.id),
  noteText: text("note_text").notNull(),
  noteType: text("note_type").notNull().default("notiz"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("prospect_notes_prospect_id_idx").on(table.prospectId),
]);

export const DISQUALIFICATION_REASONS = [
  "ausserhalb_einzugsgebiet",
  "keine_kapazitaet",
  "pflegegrad_ungeeignet",
  "sonstige",
] as const;

export type DisqualificationReason = (typeof DISQUALIFICATION_REASONS)[number];

export const DISQUALIFICATION_REASON_LABELS: Record<DisqualificationReason, string> = {
  ausserhalb_einzugsgebiet: "Außerhalb Einzugsgebiet",
  keine_kapazitaet: "Keine Kapazität",
  pflegegrad_ungeeignet: "Pflegegrad ungeeignet",
  sonstige: "Sonstige",
};

export const PROSPECT_OFFER_STATUSES = ["offen", "angenommen", "abgelehnt"] as const;
export type ProspectOfferStatus = (typeof PROSPECT_OFFER_STATUSES)[number];

export const prospectOffers = pgTable("prospect_offers", {
  id: serial("id").primaryKey(),
  prospectId: integer("prospect_id").notNull().references(() => prospects.id, { onDelete: "cascade" }),
  wizardData: jsonb("wizard_data").notNull(),
  status: text("status").notNull().default("offen"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdBy: integer("created_by").references(() => users.id),
  expiresAt: timestamp("expires_at"),
}, (table) => [
  index("prospect_offers_prospect_id_idx").on(table.prospectId),
  index("prospect_offers_status_idx").on(table.prospectId, table.status),
]);

export const insertProspectSchema = createInsertSchema(prospects).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
}).extend({
  vorname: z.string().min(1, "Vorname ist erforderlich").max(100, "Maximal 100 Zeichen"),
  nachname: z.string().min(1, "Nachname ist erforderlich").max(100, "Maximal 100 Zeichen"),
  telefon: optionalGermanPhoneSchema.nullable(),
  email: internationalEmailSchema.optional().or(z.literal("")).nullable(),
  strasse: z.string().max(200, "Maximal 200 Zeichen").optional().nullable(),
  nr: z.string().max(20, "Maximal 20 Zeichen").optional().nullable(),
  plz: z.string().regex(/^\d{5}$/, "PLZ muss 5 Ziffern haben").optional().or(z.literal("")).nullable(),
  stadt: z.string().max(100, "Maximal 100 Zeichen").optional().nullable(),
  pflegegrad: z.number().min(1, "Pflegegrad muss zwischen 1 und 5 liegen").max(5, "Pflegegrad muss zwischen 1 und 5 liegen").optional().nullable(),
  status: z.enum(PROSPECT_STATUSES).default("neu"),
  wiedervorlageDate: z.string().optional().nullable(),
  statusNotiz: z.string().max(1000, "Maximal 1000 Zeichen").optional().nullable(),
  quelle: z.string().max(200, "Maximal 200 Zeichen").optional().nullable(),
  quelleDetails: z.string().max(500, "Maximal 500 Zeichen").optional().nullable(),
  rawEmailContent: z.string().optional().nullable(),
  geoQualified: z.boolean().optional().nullable(),
  disqualificationReason: z.string().optional().nullable(),
  convertedCustomerId: z.number().optional().nullable(),
  assignedEmployeeId: z.number().optional().nullable(),
});

export const updateProspectSchema = insertProspectSchema.partial();

export const qualifyProspectSchema = z.object({
  action: z.enum(["qualify", "disqualify"]),
  disqualificationReason: z.enum(DISQUALIFICATION_REASONS).optional(),
}).refine(
  (data) => data.action === "qualify" || data.disqualificationReason !== undefined,
  { message: "Disqualifizierungsgrund ist erforderlich", path: ["disqualificationReason"] }
);

export const insertProspectOfferSchema = z.object({
  wizardData: z.record(z.unknown()),
  expiresAt: z.string().optional().nullable(),
});

export const insertProspectNoteSchema = createInsertSchema(prospectNotes).omit({
  id: true,
  createdAt: true,
}).extend({
  noteText: z.string().min(1, "Notiz darf nicht leer sein").max(2000, "Maximal 2000 Zeichen"),
  noteType: z.enum(PROSPECT_NOTE_TYPES).default("notiz"),
});

export type Prospect = typeof prospects.$inferSelect;
export type InsertProspect = z.infer<typeof insertProspectSchema>;
export type UpdateProspect = z.infer<typeof updateProspectSchema>;
export type ProspectNote = typeof prospectNotes.$inferSelect;
export type InsertProspectNote = z.infer<typeof insertProspectNoteSchema>;
export type ProspectOffer = typeof prospectOffers.$inferSelect;
export type InsertProspectOffer = z.infer<typeof insertProspectOfferSchema>;
