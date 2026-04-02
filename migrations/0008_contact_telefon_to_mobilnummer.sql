-- Migrate customer_contacts.telefon → mobilnummer (where mobilnummer is empty)
UPDATE "customer_contacts"
SET "mobilnummer" = "telefon"
WHERE "telefon" IS NOT NULL
  AND "telefon" != ''
  AND ("mobilnummer" IS NULL OR "mobilnummer" = '');--> statement-breakpoint

-- For rows where both telefon AND mobilnummer are populated (conflict case),
-- preserve the old telefon value by appending it to the notes field to prevent data loss.
UPDATE "customer_contacts"
SET "notes" = COALESCE("notes" || ' | ', '') || 'Alt. Tel: ' || "telefon"
WHERE "telefon" IS NOT NULL
  AND "telefon" != ''
  AND "mobilnummer" IS NOT NULL
  AND "mobilnummer" != ''
  AND "telefon" != "mobilnummer";--> statement-breakpoint

-- Drop the telefon column from customer_contacts
ALTER TABLE "customer_contacts" DROP COLUMN IF EXISTS "telefon";
