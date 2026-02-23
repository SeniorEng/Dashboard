import { pgTable, text, integer, serial, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { timestamp } from "./common";
import { users } from "./users";

export const birthdayCardTracking = pgTable("birthday_card_tracking", {
  id: serial("id").primaryKey(),
  personType: text("person_type").notNull(), // "customer" | "employee"
  personId: integer("person_id").notNull(),
  year: integer("year").notNull(),
  sent: boolean("sent").notNull().default(false),
  sentAt: timestamp("sent_at"),
  sentByUserId: integer("sent_by_user_id").references(() => users.id),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("birthday_card_unique_idx").on(table.personType, table.personId, table.year),
]);

export const insertBirthdayCardSchema = createInsertSchema(birthdayCardTracking).omit({
  id: true,
  createdAt: true,
});

export type BirthdayCardTracking = typeof birthdayCardTracking.$inferSelect;
export type InsertBirthdayCardTracking = z.infer<typeof insertBirthdayCardSchema>;
