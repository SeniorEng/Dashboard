CREATE TABLE "admin_permissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"permission_key" text NOT NULL,
	"granted" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_permission_unique" UNIQUE("user_id","permission_key")
);
--> statement-breakpoint
CREATE TABLE "document_type_triggers" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_type_id" integer NOT NULL,
	"entity_type" text NOT NULL,
	"trigger_type" text NOT NULL,
	"condition_field" text,
	"condition_operator" text DEFAULT 'equals' NOT NULL,
	"condition_value" text,
	"requirement" text DEFAULT 'pflicht' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_advice_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"payment_advice_id" integer NOT NULL,
	"beleg_nr" text,
	"vorgangs_nr" text,
	"rechnungs_nummer" text,
	"rechnungs_datum" text,
	"verwendungszweck" text,
	"betrag_cents" integer NOT NULL,
	"skonto_cents" integer DEFAULT 0 NOT NULL,
	"buchungs_datum" text,
	"matched_invoice_id" integer
);
--> statement-breakpoint
CREATE TABLE "payment_advices" (
	"id" serial PRIMARY KEY NOT NULL,
	"insurance_provider_name" text,
	"ik_nummer" text,
	"object_path" text,
	"file_name" text NOT NULL,
	"notes" text,
	"format" text DEFAULT 'manuell' NOT NULL,
	"avis_nummer" text,
	"beleg_nummer" text,
	"gesamt_betrag_cents" integer,
	"zahlungs_datum" text,
	"kostentraeger_ik" text,
	"kostentraeger_name" text,
	"zahlungsempfaenger_ik" text,
	"zahlungsempfaenger_iban" text,
	"skonto_cents" integer DEFAULT 0 NOT NULL,
	"kuerzung_cents" integer DEFAULT 0 NOT NULL,
	"uploaded_by_user_id" integer,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "qonto_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"qonto_transaction_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"side" text NOT NULL,
	"counterparty_name" text,
	"reference" text,
	"label" text,
	"emitted_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"matched_invoice_id" integer,
	"match_confidence" text,
	"raw_data" jsonb,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qonto_transactions_qonto_id_unique" UNIQUE("qonto_transaction_id")
);
--> statement-breakpoint
CREATE TABLE "user_whatsapp_preferences" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"whatsapp_number" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_message_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"event_type" text NOT NULL,
	"template_name" text NOT NULL,
	"phone_number" text NOT NULL,
	"status" text NOT NULL,
	"error_message" text,
	"meta_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_notification_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"template_name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "monthly_service_records" DROP CONSTRAINT "service_record_unique";--> statement-breakpoint
ALTER TABLE "employee_document_proofs" ALTER COLUMN "qualification_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_super_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "latitude" real;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "longitude" real;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "backup_employee_id_2" integer;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "latitude" real;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "longitude" real;--> statement-breakpoint
ALTER TABLE "insurance_providers" ADD COLUMN "fax" text;--> statement-breakpoint
ALTER TABLE "insurance_providers" ADD COLUMN "kim_adresse" text;--> statement-breakpoint
ALTER TABLE "insurance_providers" ADD COLUMN "ansprechpartner" text;--> statement-breakpoint
ALTER TABLE "insurance_providers" ADD COLUMN "datenannahme_ik" text;--> statement-breakpoint
ALTER TABLE "budget_allocations" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "employee_time_entries" ADD COLUMN "kilometers" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "monthly_service_records" ADD COLUMN "record_type" text DEFAULT 'monthly' NOT NULL;--> statement-breakpoint
ALTER TABLE "monthly_service_records" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_documents" ADD COLUMN "document_date" date;--> statement-breakpoint
ALTER TABLE "customer_documents" ADD COLUMN "batch_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_documents" ADD COLUMN "batch_label" text;--> statement-breakpoint
ALTER TABLE "customer_documents" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document_types" ADD COLUMN "input_method" text DEFAULT 'upload' NOT NULL;--> statement-breakpoint
ALTER TABLE "document_types" ADD COLUMN "is_mandatory" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "document_types" ADD COLUMN "renewal_days" integer;--> statement-breakpoint
ALTER TABLE "employee_documents" ADD COLUMN "document_date" date;--> statement-breakpoint
ALTER TABLE "employee_documents" ADD COLUMN "batch_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "employee_documents" ADD COLUMN "batch_label" text;--> statement-breakpoint
ALTER TABLE "employee_documents" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "qonto_login" text;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "qonto_secret_key" text;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "qonto_iban" text;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "whatsapp_access_token" text;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "whatsapp_phone_number_id" text;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "whatsapp_business_account_id" text;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "whatsapp_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "twilio_account_sid" text;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "twilio_auth_token" text;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "twilio_phone_number" text;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "lead_call_bridge_phone" text;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "lead_call_bridge_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "latitude" real;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "longitude" real;--> statement-breakpoint
ALTER TABLE "admin_permissions" ADD CONSTRAINT "admin_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_type_triggers" ADD CONSTRAINT "document_type_triggers_document_type_id_document_types_id_fk" FOREIGN KEY ("document_type_id") REFERENCES "public"."document_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_advice_items" ADD CONSTRAINT "payment_advice_items_payment_advice_id_payment_advices_id_fk" FOREIGN KEY ("payment_advice_id") REFERENCES "public"."payment_advices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_advice_items" ADD CONSTRAINT "payment_advice_items_matched_invoice_id_invoices_id_fk" FOREIGN KEY ("matched_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_advices" ADD CONSTRAINT "payment_advices_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qonto_transactions" ADD CONSTRAINT "qonto_transactions_matched_invoice_id_invoices_id_fk" FOREIGN KEY ("matched_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_whatsapp_preferences" ADD CONSTRAINT "user_whatsapp_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_message_log" ADD CONSTRAINT "whatsapp_message_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_permissions_user_idx" ON "admin_permissions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "dtt_doc_type_idx" ON "document_type_triggers" USING btree ("document_type_id");--> statement-breakpoint
CREATE INDEX "dtt_entity_type_idx" ON "document_type_triggers" USING btree ("entity_type");--> statement-breakpoint
CREATE INDEX "dtt_active_idx" ON "document_type_triggers" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "dtt_unique" ON "document_type_triggers" USING btree ("document_type_id","entity_type","trigger_type","condition_field","condition_value");--> statement-breakpoint
CREATE INDEX "payment_advice_items_advice_id_idx" ON "payment_advice_items" USING btree ("payment_advice_id");--> statement-breakpoint
CREATE INDEX "payment_advice_items_matched_invoice_idx" ON "payment_advice_items" USING btree ("matched_invoice_id");--> statement-breakpoint
CREATE INDEX "payment_advices_uploaded_at_idx" ON "payment_advices" USING btree ("uploaded_at");--> statement-breakpoint
CREATE INDEX "qonto_transactions_emitted_at_idx" ON "qonto_transactions" USING btree ("emitted_at");--> statement-breakpoint
CREATE INDEX "qonto_transactions_matched_invoice_idx" ON "qonto_transactions" USING btree ("matched_invoice_id");--> statement-breakpoint
CREATE INDEX "qonto_transactions_side_idx" ON "qonto_transactions" USING btree ("side");--> statement-breakpoint
CREATE UNIQUE INDEX "user_whatsapp_prefs_user_id_unique" ON "user_whatsapp_preferences" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_rules_event_type_unique" ON "whatsapp_notification_rules" USING btree ("event_type");--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_backup_employee_id_2_users_id_fk" FOREIGN KEY ("backup_employee_id_2") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_service_prices" ADD CONSTRAINT "customer_service_prices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_travel_from_appointment_id_appointments_id_fk" FOREIGN KEY ("travel_from_appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_deliveries" ADD CONSTRAINT "document_deliveries_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_deliveries" ADD CONSTRAINT "document_deliveries_generated_document_id_generated_documents_id_fk" FOREIGN KEY ("generated_document_id") REFERENCES "public"."generated_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_stornierte_rechnung_id_invoices_id_fk" FOREIGN KEY ("stornierte_rechnung_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customers_backup_employee_id_2_idx" ON "customers" USING btree ("backup_employee_id_2");--> statement-breakpoint
CREATE INDEX "service_records_type_idx" ON "monthly_service_records" USING btree ("record_type");--> statement-breakpoint
CREATE INDEX "customer_documents_batch_idx" ON "customer_documents" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "employee_documents_batch_idx" ON "employee_documents" USING btree ("batch_id");