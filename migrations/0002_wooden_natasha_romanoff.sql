ALTER TABLE "customer_care_level_history" ADD COLUMN "entfernt_am" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_care_level_history" ADD COLUMN "entfernt_grund" text;--> statement-breakpoint
ALTER TABLE "customer_care_level_history" ADD COLUMN "entfernt_von_user_id" integer;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD COLUMN "vat_rate_bp" integer;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD COLUMN "pflegegrad_am_leistungstag" integer;--> statement-breakpoint
ALTER TABLE "customer_care_level_history" ADD CONSTRAINT "customer_care_level_history_entfernt_von_user_id_users_id_fk" FOREIGN KEY ("entfernt_von_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;