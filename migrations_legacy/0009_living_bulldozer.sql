CREATE TABLE "scheduled_calls" (
	"id" serial PRIMARY KEY NOT NULL,
	"prospect_id" integer NOT NULL,
	"lead_name" text NOT NULL,
	"lead_phone" text NOT NULL,
	"quelle" text,
	"scheduled_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"executed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "employee_time_entries" ALTER COLUMN "kilometers" SET DATA TYPE real;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "receives_monthly_invoice" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "insurance_providers" ADD COLUMN "email_verhinderungspflege" text;--> statement-breakpoint
ALTER TABLE "budget_transactions" ADD COLUMN "reversed_transaction_id" integer;--> statement-breakpoint
ALTER TABLE "customer_budget_type_settings" ADD COLUMN "valid_from" date;--> statement-breakpoint
ALTER TABLE "customer_budget_type_settings" ADD COLUMN "valid_to" date;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD COLUMN "service_details" text;--> statement-breakpoint
ALTER TABLE "scheduled_calls" ADD CONSTRAINT "scheduled_calls_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scheduled_calls_status_idx" ON "scheduled_calls" USING btree ("status");--> statement-breakpoint
CREATE INDEX "scheduled_calls_scheduled_at_idx" ON "scheduled_calls" USING btree ("scheduled_at");--> statement-breakpoint
ALTER TABLE "customer_contacts" DROP COLUMN "telefon";