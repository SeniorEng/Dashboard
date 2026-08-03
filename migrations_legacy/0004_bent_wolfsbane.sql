CREATE TABLE "prospect_offers" (
	"id" serial PRIMARY KEY NOT NULL,
	"prospect_id" integer NOT NULL,
	"wizard_data" jsonb NOT NULL,
	"status" text DEFAULT 'offen' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" integer,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "appointments" ALTER COLUMN "customer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "converted_from_prospect_id" integer;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "prospect_id" integer;--> statement-breakpoint
ALTER TABLE "prospects" ADD COLUMN "geo_qualified" boolean;--> statement-breakpoint
ALTER TABLE "prospects" ADD COLUMN "disqualification_reason" text;--> statement-breakpoint
ALTER TABLE "prospect_offers" ADD CONSTRAINT "prospect_offers_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_offers" ADD CONSTRAINT "prospect_offers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "prospect_offers_prospect_id_idx" ON "prospect_offers" USING btree ("prospect_id");--> statement-breakpoint
CREATE INDEX "prospect_offers_status_idx" ON "prospect_offers" USING btree ("prospect_id","status");--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointments_prospect_id_idx" ON "appointments" USING btree ("prospect_id");