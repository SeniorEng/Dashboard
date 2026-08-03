ALTER TABLE "company_settings" ADD COLUMN "lead_auto_reply_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "lead_auto_reply_subject" text;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "lead_auto_reply_body" text;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "lead_auto_reply_attachment_path" text;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "lead_auto_reply_attachment_name" text;