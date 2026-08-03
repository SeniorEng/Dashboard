-- Task #389: WhatsApp-Provider von Meta Cloud API auf Twilio WhatsApp Content API umgestellt.
-- Neue Spalte company_settings.whatsapp_from_or_service hält entweder den Twilio
-- WhatsApp-Sender im E.164-Format (z. B. "+4915112345678") ODER eine Twilio
-- Messaging-Service-SID ("MG…"). Die alten Meta-spezifischen Spalten
-- (whatsapp_phone_number_id, whatsapp_business_account_id) bleiben erhalten und
-- werden durch die Startup-Migration migrate-whatsapp-twilio.ts auf NULL gesetzt.
ALTER TABLE "company_settings" ADD COLUMN IF NOT EXISTS "whatsapp_from_or_service" text;
