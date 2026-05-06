import { pgTable, text, integer, serial, index, uniqueIndex } from "drizzle-orm/pg-core";
import { timestamp } from "./common";
import { users } from "./users";

// ============================================
// IDEMPOTENCY KEYS (Task #376)
// ============================================
//
// Speichert Idempotency-Keys für POST /admin/customers, damit doppelte
// Submits aus dem Wizard (z.B. nach verlorener Antwort, Reload, Doppel-
// klick) nicht zwei identische Kundendatensätze erzeugen. TTL 24 h.
// `payloadHash` (sha256 hex) wird verglichen: gleicher Hash → idempotente
// Wiederholung, gibt den ursprünglichen Customer zurück. Abweichender
// Hash → 409 IDEMPOTENCY_KEY_REUSED.

export const customerCreationIdempotencyKeys = pgTable("customer_creation_idempotency_keys", {
  id: serial("id").primaryKey(),
  idempotencyKey: text("idempotency_key").notNull(),
  payloadHash: text("payload_hash").notNull(),
  customerId: integer("customer_id"),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
}, (table) => [
  uniqueIndex("customer_idem_key_unique").on(table.idempotencyKey),
  index("customer_idem_key_expires_idx").on(table.expiresAt),
]);

export type CustomerCreationIdempotencyKey = typeof customerCreationIdempotencyKeys.$inferSelect;
