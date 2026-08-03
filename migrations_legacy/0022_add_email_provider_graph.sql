-- Task #1856: Microsoft Graph (App-only OAuth2 / client-credentials) as a second
-- email transport behind the SSoT `sendEmail`. SMTP stays the default/fallback;
-- the active transport is chosen per environment via `email_provider`.
-- All columns are additive and idempotent so existing environments upgrade safely.
ALTER TABLE "company_settings" ADD COLUMN IF NOT EXISTS "email_provider" text DEFAULT 'smtp' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN IF NOT EXISTS "graph_tenant_id" text;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN IF NOT EXISTS "graph_client_id" text;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN IF NOT EXISTS "graph_sender_upn" text;--> statement-breakpoint
-- graph_client_secret is AES-256-GCM at-rest (encryptedText), like smtp_pass.
ALTER TABLE "company_settings" ADD COLUMN IF NOT EXISTS "graph_client_secret" text;
