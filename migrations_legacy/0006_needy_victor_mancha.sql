CREATE TABLE "appointment_series" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"assigned_employee_id" integer NOT NULL,
	"created_by_user_id" integer,
	"frequency" text DEFAULT 'weekly' NOT NULL,
	"weekdays" text[] NOT NULL,
	"scheduled_start" time NOT NULL,
	"duration_minutes" integer NOT NULL,
	"service_ids" integer[] NOT NULL,
	"service_durations" integer[] NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"notes" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "customer_contacts" ALTER COLUMN "telefon" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_contacts" ADD COLUMN "festnetz" text;--> statement-breakpoint
ALTER TABLE "customer_contacts" ADD COLUMN "mobilnummer" text;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "series_id" integer;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "is_series_exception" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "appointment_series" ADD CONSTRAINT "appointment_series_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_series" ADD CONSTRAINT "appointment_series_assigned_employee_id_users_id_fk" FOREIGN KEY ("assigned_employee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_series" ADD CONSTRAINT "appointment_series_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_series_customer_id_idx" ON "appointment_series" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "appointment_series_employee_id_idx" ON "appointment_series" USING btree ("assigned_employee_id");--> statement-breakpoint
CREATE INDEX "appointment_series_status_idx" ON "appointment_series" USING btree ("status");--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_series_id_appointment_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."appointment_series"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointments_series_id_idx" ON "appointments" USING btree ("series_id");