-- Replaces Deutsche Post E-POST integration with LetterXpress (Task #302).
-- Adds letterxpress_* columns, drops e-post columns, and renames the
-- delivery letter id column. Existing rows lose their plaintext e-post
-- credentials; admins must re-enter LetterXpress credentials once after
-- deployment.

ALTER TABLE "company_settings"
  ADD COLUMN IF NOT EXISTS "letterxpress_username" text,
  ADD COLUMN IF NOT EXISTS "letterxpress_api_key" text,
  ADD COLUMN IF NOT EXISTS "letterxpress_test_mode" boolean DEFAULT true NOT NULL;
--> statement-breakpoint

ALTER TABLE "company_settings"
  DROP COLUMN IF EXISTS "epost_vendor_id",
  DROP COLUMN IF EXISTS "epost_ekp",
  DROP COLUMN IF EXISTS "epost_password",
  DROP COLUMN IF EXISTS "epost_secret",
  DROP COLUMN IF EXISTS "epost_test_mode";
--> statement-breakpoint

ALTER TABLE "document_deliveries"
  RENAME COLUMN "epost_letter_id" TO "letterxpress_letter_id";
