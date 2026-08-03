CREATE TABLE "admin_permissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"permission_key" text NOT NULL,
	"granted" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_permissions_user_id_permission_key_key" UNIQUE("user_id","permission_key")
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_reset_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_role_unique" UNIQUE("user_id","role")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"vorname" text,
	"nachname" text,
	"telefon" text,
	"strasse" text,
	"hausnummer" text,
	"plz" text,
	"stadt" text,
	"geburtsdatum" date,
	"eintrittsdatum" date,
	"austritts_datum" date,
	"vacation_days_per_year" integer DEFAULT 30 NOT NULL,
	"employment_status" text DEFAULT 'aktiv' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"deactivated_at" timestamp with time zone,
	"is_anonymized" boolean DEFAULT false NOT NULL,
	"anonymized_at" timestamp with time zone,
	"is_admin" boolean DEFAULT false NOT NULL,
	"is_super_admin" boolean DEFAULT false NOT NULL,
	"is_team_lead" boolean DEFAULT false NOT NULL,
	"haustier_akzeptiert" boolean DEFAULT true NOT NULL,
	"is_eu_rentner" boolean DEFAULT false NOT NULL,
	"employment_type" text DEFAULT 'sozialversicherungspflichtig' NOT NULL,
	"weekly_work_days" integer DEFAULT 5 NOT NULL,
	"monthly_work_hours" numeric(6, 2),
	"notfallkontakt_name" text,
	"notfallkontakt_telefon" text,
	"notfallkontakt_beziehung" text,
	"onboarding_completed" boolean DEFAULT false NOT NULL,
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "customer_assignment_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"employee_id" integer NOT NULL,
	"role" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"changed_by_user_id" integer,
	"changed_by_role" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_care_level_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"pflegegrad" integer NOT NULL,
	"pflegegrad_beantragt" integer,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" integer
);
--> statement-breakpoint
CREATE TABLE "customer_contacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"contact_type" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"vorname" text NOT NULL,
	"nachname" text NOT NULL,
	"festnetz" text,
	"mobilnummer" text,
	"email" text,
	"notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_needs_assessments" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"assessment_date" date NOT NULL,
	"household_size" integer DEFAULT 1 NOT NULL,
	"pflegedienst_beauftragt" boolean DEFAULT false NOT NULL,
	"anamnese" text,
	"service_haushalt_hilfe" boolean DEFAULT false,
	"service_mahlzeiten" boolean DEFAULT false,
	"service_reinigung" boolean DEFAULT false,
	"service_waesche_pflege" boolean DEFAULT false,
	"service_einkauf" boolean DEFAULT false,
	"service_tagesablauf" boolean DEFAULT false,
	"service_alltagsverrichtungen" boolean DEFAULT false,
	"service_terminbegleitung" boolean DEFAULT false,
	"service_botengaenge" boolean DEFAULT false,
	"service_grundpflege" boolean DEFAULT false,
	"service_freizeitbegleitung" boolean DEFAULT false,
	"service_demenzbetreuung" boolean DEFAULT false,
	"service_gesellschaft" boolean DEFAULT false,
	"service_soziale_kontakte" boolean DEFAULT false,
	"service_freizeitgestaltung" boolean DEFAULT false,
	"service_kreativ" boolean DEFAULT false,
	"sonstige_leistungen" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" integer
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"vorname" text,
	"nachname" text,
	"email" text,
	"festnetz" text,
	"telefon" text,
	"geburtsdatum" date,
	"address" text NOT NULL,
	"strasse" text,
	"nr" text,
	"plz" text,
	"stadt" text,
	"pflegegrad" integer,
	"primary_employee_id" integer,
	"backup_employee_id" integer,
	"backup_employee_id_2" integer,
	"vorerkrankungen" text,
	"haustier_vorhanden" boolean DEFAULT false NOT NULL,
	"haustier_details" text,
	"status" text DEFAULT 'aktiv' NOT NULL,
	"inaktiv_ab" text,
	"personenbefoerderung_gewuenscht" boolean DEFAULT false NOT NULL,
	"billing_type" text DEFAULT 'pflegekasse_gesetzlich' NOT NULL,
	"beihilfe_berechtigt" boolean DEFAULT false NOT NULL,
	"accepts_private_payment" boolean DEFAULT false NOT NULL,
	"rechnung_an_kunde" boolean DEFAULT false NOT NULL,
	"document_delivery_method" text DEFAULT 'email' NOT NULL,
	"receives_monthly_invoice" boolean DEFAULT false NOT NULL,
	"deactivation_reason" text,
	"deactivation_note" text,
	"merged_into_customer_id" integer,
	"converted_from_prospect_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" integer,
	"deleted_at" timestamp with time zone,
	"is_anonymized" boolean DEFAULT false NOT NULL,
	"anonymized_at" timestamp with time zone,
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"setup_signatures_pending" boolean DEFAULT false NOT NULL,
	"setup_documents_pending" boolean DEFAULT false NOT NULL,
	"setup_budgets_pending" boolean DEFAULT false NOT NULL,
	"setup_delivery_pending" boolean DEFAULT false NOT NULL,
	"setup_pending_payloads" jsonb,
	"cancellation_policy_type" text DEFAULT 'none' NOT NULL,
	"cancellation_flat_cents" integer,
	"cancellation_hourly_rate_cents" integer,
	"cancellation_km_rate_cents" integer
);
--> statement-breakpoint
CREATE TABLE "customer_insurance_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"insurance_provider_id" integer NOT NULL,
	"versichertennummer" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" integer
);
--> statement-breakpoint
CREATE TABLE "insurance_providers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"empfaenger" text,
	"empfaenger_zeile2" text,
	"is_private" boolean DEFAULT false NOT NULL,
	"ik_nummer" text,
	"strasse" text,
	"hausnummer" text,
	"plz" text,
	"stadt" text,
	"telefon" text,
	"fax" text,
	"email" text,
	"email_verhinderungspflege" text,
	"kim_adresse" text,
	"ansprechpartner" text,
	"datenannahme_ik" text,
	"email_invoice_enabled" boolean DEFAULT false NOT NULL,
	"zahlungsbedingungen" text DEFAULT '30_tage',
	"zahlungsart" text DEFAULT 'ueberweisung',
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"anschrift" text,
	"plz_ort" text,
	CONSTRAINT "insurance_providers_ik_nummer_unique" UNIQUE("ik_nummer")
);
--> statement-breakpoint
CREATE TABLE "service_budget_pots" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_id" integer NOT NULL,
	"budget_type" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text,
	"name" text NOT NULL,
	"description" text,
	"unit_type" text NOT NULL,
	"default_price_cents" integer DEFAULT 0 NOT NULL,
	"vat_rate" integer DEFAULT 19 NOT NULL,
	"min_duration_minutes" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_billable" boolean DEFAULT true NOT NULL,
	"employee_rate_cents" integer DEFAULT 0 NOT NULL,
	"lohnart_kategorie" text DEFAULT 'hauswirtschaft' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "services_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "customer_contracts" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"contract_date" date,
	"contract_start" date NOT NULL,
	"contract_end" date,
	"vereinbarte_leistungen" text,
	"hours_per_period" integer DEFAULT 0 NOT NULL,
	"period_type" text DEFAULT 'month' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" integer
);
--> statement-breakpoint
CREATE TABLE "prices" (
	"id" serial PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"origin" text NOT NULL,
	"customer_id" integer,
	"service_id" integer NOT NULL,
	"cents" integer NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" integer
);
--> statement-breakpoint
CREATE TABLE "role_wage_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"service_id" integer NOT NULL,
	"cents" integer NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" integer
);
--> statement-breakpoint
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
CREATE TABLE "appointment_services" (
	"id" serial PRIMARY KEY NOT NULL,
	"appointment_id" integer NOT NULL,
	"service_id" integer NOT NULL,
	"planned_duration_minutes" integer NOT NULL,
	"actual_duration_minutes" integer,
	"details" text
);
--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer,
	"prospect_id" integer,
	"created_by_user_id" integer,
	"assigned_employee_id" integer,
	"performed_by_employee_id" integer,
	"appointment_type" text NOT NULL,
	"date" date NOT NULL,
	"scheduled_start" time NOT NULL,
	"scheduled_end" time,
	"duration_promised" integer NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"actual_start" time,
	"actual_end" time,
	"travel_origin_type" text,
	"travel_from_appointment_id" integer,
	"travel_kilometers" numeric(10, 3),
	"travel_minutes" integer,
	"customer_kilometers" numeric(10, 3),
	"notes" text,
	"signature_data" text,
	"signature_hash" text,
	"signed_at" timestamp with time zone,
	"signed_by_user_id" integer,
	"is_fahrtdienst" boolean DEFAULT false NOT NULL,
	"doctor_name" text,
	"doctor_appointment_time" time,
	"doctor_strasse" text,
	"doctor_nr" text,
	"doctor_plz" text,
	"doctor_stadt" text,
	"doctor_latitude" numeric(9, 6),
	"doctor_longitude" numeric(9, 6),
	"estimated_travel_minutes" integer,
	"travel_buffer_minutes" integer,
	"series_id" integer,
	"is_series_exception" boolean DEFAULT false NOT NULL,
	"co_visit_group_id" text,
	"no_show_reason" text,
	"no_show_reason_text" text,
	"no_show_wait_minutes" integer,
	"no_show_kilometers" numeric(10, 3),
	"no_show_notes" text,
	"no_show_charge_suppressed" boolean DEFAULT false NOT NULL,
	"no_show_charge_suppression_reason" text,
	"import_batch_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "budget_allocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"budget_type" text DEFAULT 'entlastungsbetrag_45b' NOT NULL,
	"year" integer NOT NULL,
	"month" integer,
	"amount_cents" integer NOT NULL,
	"source" text NOT NULL,
	"valid_from" date NOT NULL,
	"expires_at" date,
	"notes" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" integer
);
--> statement-breakpoint
CREATE TABLE "budget_migrations" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"version" text DEFAULT '1' NOT NULL,
	"summary" text,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_reservations" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"appointment_id" integer,
	"occurrence_id" text,
	"allocation_id" integer,
	"budget_type" text NOT NULL,
	"period" text,
	"amount_cents" integer NOT NULL,
	"hauswirtschaft_minutes" integer,
	"hauswirtschaft_cents" integer,
	"alltagsbegleitung_minutes" integer,
	"alltagsbegleitung_cents" integer,
	"travel_kilometers" numeric(10, 3),
	"travel_cents" integer,
	"customer_kilometers" numeric(10, 3),
	"customer_kilometers_cents" integer,
	"state" text DEFAULT 'hold' NOT NULL,
	"idempotency_key" text NOT NULL,
	"expires_at" timestamp with time zone,
	"captured_transaction_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" integer
);
--> statement-breakpoint
CREATE TABLE "budget_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"budget_type" text DEFAULT 'entlastungsbetrag_45b' NOT NULL,
	"transaction_date" date NOT NULL,
	"transaction_type" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"hauswirtschaft_minutes" integer,
	"hauswirtschaft_cents" integer,
	"alltagsbegleitung_minutes" integer,
	"alltagsbegleitung_cents" integer,
	"travel_kilometers" numeric(10, 3),
	"travel_cents" integer,
	"customer_kilometers" numeric(10, 3),
	"customer_kilometers_cents" integer,
	"appointment_id" integer,
	"allocation_id" integer,
	"reversed_transaction_id" integer,
	"import_batch_id" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" integer
);
--> statement-breakpoint
CREATE TABLE "customer_budget_preferences" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"monthly_limit_cents" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_budget_preferences_customer_id_unique" UNIQUE("customer_id")
);
--> statement-breakpoint
CREATE TABLE "customer_budget_type_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"budget_type" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 1 NOT NULL,
	"monthly_limit_cents" integer,
	"yearly_limit_cents" integer,
	"initial_balance_cents" integer,
	"initial_balance_month" text,
	"valid_from" date,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_hours_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"category" text NOT NULL,
	"anfangsbestand" numeric(10, 2),
	"bezahlt" numeric(10, 2),
	"opening_balance_type" text DEFAULT 'carryover' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hours_account_unique" UNIQUE("user_id","year","month","category")
);
--> statement-breakpoint
CREATE TABLE "employee_time_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"entry_type" text NOT NULL,
	"entry_date" date NOT NULL,
	"start_time" time,
	"end_time" time,
	"is_full_day" boolean DEFAULT false NOT NULL,
	"duration_minutes" integer,
	"kilometers" numeric(10, 3) DEFAULT 0,
	"is_auto_generated" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "employee_vacation_allowance" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"year" integer NOT NULL,
	"total_days" numeric(5, 2) DEFAULT '30' NOT NULL,
	"carry_over_days" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_year_unique" UNIQUE("user_id","year")
);
--> statement-breakpoint
CREATE TABLE "vacation_entitlement_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"valid_from_year" integer NOT NULL,
	"valid_from_month" integer NOT NULL,
	"days_per_year" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" integer,
	CONSTRAINT "vacation_entitlement_history_unique" UNIQUE("user_id","valid_from_year","valid_from_month")
);
--> statement-breakpoint
CREATE TABLE "monthly_service_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"employee_id" integer NOT NULL,
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"record_type" text DEFAULT 'monthly' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"employee_signature_data" text,
	"employee_signature_hash" text,
	"employee_signed_at" timestamp with time zone,
	"employee_signed_by_user_id" integer,
	"employee_signing_ip" text,
	"employee_signing_location" text,
	"customer_signature_data" text,
	"customer_signature_hash" text,
	"customer_signed_at" timestamp with time zone,
	"customer_signed_by_user_id" integer,
	"customer_signing_ip" text,
	"customer_signing_location" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_record_appointments" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_record_id" integer NOT NULL,
	"appointment_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_record_appointment_unique" UNIQUE("service_record_id","appointment_id")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"due_date" date,
	"priority" text DEFAULT 'medium' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by_user_id" integer NOT NULL,
	"assigned_to_user_id" integer NOT NULL,
	"customer_id" integer,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "employee_month_closings" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_by_user_id" integer NOT NULL,
	"reopened_at" timestamp with time zone,
	"reopened_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "month_closing_unique" UNIQUE("user_id","year","month")
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"auto_breaks_enabled" boolean DEFAULT true NOT NULL,
	"last_document_review_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" integer
);
--> statement-breakpoint
CREATE TABLE "customer_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"document_type_id" integer NOT NULL,
	"file_name" text NOT NULL,
	"object_path" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uploaded_by_user_id" integer,
	"review_due_date" date,
	"document_date" date,
	"is_current" boolean DEFAULT true NOT NULL,
	"notes" text,
	"batch_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"batch_label" text,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "document_signing_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_signing_tokens_token_hash_key" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "document_template_billing_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"template_id" integer NOT NULL,
	"billing_type" text NOT NULL,
	"requirement" text DEFAULT 'pflicht' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"html_content" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"document_type_id" integer,
	"context" text DEFAULT 'beide' NOT NULL,
	"target_type" text DEFAULT 'customer' NOT NULL,
	"requires_customer_signature" boolean DEFAULT true NOT NULL,
	"requires_employee_signature" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_templates_slug_key" UNIQUE("slug")
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
CREATE TABLE "document_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"target_type" text DEFAULT 'employee' NOT NULL,
	"context" text DEFAULT 'beide' NOT NULL,
	"input_method" text DEFAULT 'upload' NOT NULL,
	"is_mandatory" boolean DEFAULT false NOT NULL,
	"renewal_days" integer,
	"review_interval_months" integer,
	"reminder_lead_time_days" integer DEFAULT 14,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer NOT NULL,
	"document_type_id" integer NOT NULL,
	"file_name" text NOT NULL,
	"object_path" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uploaded_by_user_id" integer,
	"review_due_date" date,
	"document_date" date,
	"is_current" boolean DEFAULT true NOT NULL,
	"notes" text,
	"batch_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"batch_label" text,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "generated_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer,
	"employee_id" integer,
	"template_id" integer NOT NULL,
	"template_version" integer NOT NULL,
	"document_type_id" integer,
	"file_name" text NOT NULL,
	"object_path" text NOT NULL,
	"rendered_html" text,
	"customer_signature_data" text,
	"employee_signature_data" text,
	"signing_status" text DEFAULT 'complete' NOT NULL,
	"signed_at" timestamp with time zone,
	"signed_by_employee_id" integer,
	"integrity_hash" text,
	"signing_ip" text,
	"signing_location" text,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"generated_by_user_id" integer
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" integer NOT NULL,
	"metadata" jsonb,
	"ip_address" text,
	"parent_deletion_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_name" text,
	"geschaeftsfuehrer" text,
	"strasse" text,
	"hausnummer" text,
	"plz" text,
	"stadt" text,
	"telefon" text,
	"email" text,
	"website" text,
	"steuernummer" text,
	"ust_id" text,
	"iban" text,
	"bic" text,
	"bank_name" text,
	"bank_account_holder" text,
	"ik_nummer" text,
	"logo_url" text,
	"pdf_logo_url" text,
	"lohnart_alltagsbegleitung" text,
	"lohnart_hauswirtschaft" text,
	"lohnart_urlaub" text,
	"lohnart_krankheit" text,
	"smtp_host" text,
	"smtp_port" text,
	"smtp_user" text,
	"smtp_pass" text,
	"smtp_from_email" text,
	"smtp_from_name" text,
	"smtp_secure" boolean DEFAULT false NOT NULL,
	"email_provider" text DEFAULT 'smtp' NOT NULL,
	"graph_tenant_id" text,
	"graph_client_id" text,
	"graph_sender_upn" text,
	"graph_client_secret" text,
	"letterxpress_username" text,
	"letterxpress_api_key" text,
	"minijob_earnings_limit_cents" integer DEFAULT 60300 NOT NULL,
	"invoice_default_due_days" integer DEFAULT 30 NOT NULL,
	"letterxpress_test_mode" boolean DEFAULT false NOT NULL,
	"qonto_login" text,
	"qonto_secret_key" text,
	"qonto_iban" text,
	"qonto_additional_ibans" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"whatsapp_access_token" text,
	"whatsapp_phone_number_id" text,
	"whatsapp_business_account_id" text,
	"whatsapp_from_or_service" text,
	"whatsapp_enabled" boolean DEFAULT false NOT NULL,
	"twilio_account_sid" text,
	"twilio_auth_token" text,
	"twilio_phone_number" text,
	"lead_call_bridge_phone" text,
	"lead_call_bridge_enabled" boolean DEFAULT false NOT NULL,
	"delivery_email_subject" text,
	"delivery_cover_letter_text" text,
	"lead_auto_reply_enabled" boolean DEFAULT false NOT NULL,
	"lead_auto_reply_subject" text,
	"lead_auto_reply_body" text,
	"lead_auto_reply_attachment_path" text,
	"lead_auto_reply_attachment_name" text,
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" integer
);
--> statement-breakpoint
CREATE TABLE "document_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer,
	"generated_document_id" integer,
	"delivery_method" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"recipient_email" text,
	"recipient_name" text,
	"recipient_address" text,
	"letterxpress_letter_id" text,
	"error_message" text,
	"document_file_names" text,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" integer
);
--> statement-breakpoint
CREATE TABLE "customer_budget_recipients" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"budget_type" text NOT NULL,
	"insurance_provider_id" integer,
	"recipient_name" text NOT NULL,
	"recipient_address" text,
	"ik_nummer" text,
	"versichertennummer" text,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" integer
);
--> statement-breakpoint
CREATE TABLE "invoice_line_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" integer NOT NULL,
	"appointment_id" integer,
	"appointment_date" date NOT NULL,
	"service_description" text NOT NULL,
	"service_code" text,
	"start_time" time,
	"end_time" time,
	"duration_minutes" integer NOT NULL,
	"quantity_raw" numeric(10, 3),
	"quantity_unit" text,
	"unit_price_cents" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"employee_name" text,
	"appointment_notes" text,
	"service_details" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_number" text NOT NULL,
	"customer_id" integer NOT NULL,
	"billing_type" text NOT NULL,
	"invoice_type" text NOT NULL,
	"billing_month" integer NOT NULL,
	"billing_year" integer NOT NULL,
	"recipient_name" text NOT NULL,
	"recipient_address" text,
	"customer_name" text,
	"insurance_provider_name" text,
	"insurance_ik_nummer" text,
	"versichertennummer" text,
	"pflegegrad" integer,
	"due_date" date,
	"buyer_reference" text,
	"assignment_declaration_date" date,
	"assignment_declaration_ref" text,
	"net_amount_cents" integer DEFAULT 0 NOT NULL,
	"vat_amount_cents" integer DEFAULT 0 NOT NULL,
	"gross_amount_cents" integer DEFAULT 0 NOT NULL,
	"vat_rate" integer,
	"status" text DEFAULT 'entwurf' NOT NULL,
	"stornierte_rechnung_id" integer,
	"referenced_storno_invoice_ids" integer[],
	"pdf_path" text,
	"pdf_hash" text,
	"zugferd_xml" text,
	"leistungsnachweis_path" text,
	"leistungsnachweis_hash" text,
	"pdf_data_fingerprint" text,
	"leistungsnachweis_data_fingerprint" text,
	"render_snapshot" jsonb,
	"sent_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"storniert_at" timestamp with time zone,
	"notes" text,
	"budget_type" text,
	"billing_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" integer,
	CONSTRAINT "invoices_invoice_number_key" UNIQUE("invoice_number")
);
--> statement-breakpoint
CREATE TABLE "employee_document_proofs" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer NOT NULL,
	"qualification_id" integer,
	"document_type_id" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"file_name" text,
	"object_path" text,
	"uploaded_at" timestamp with time zone,
	"reviewed_at" timestamp with time zone,
	"reviewed_by_user_id" integer,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "employee_qualifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer NOT NULL,
	"qualification_id" integer NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_by_user_id" integer,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "qualification_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"qualification_id" integer NOT NULL,
	"document_type_id" integer NOT NULL,
	"is_required" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qualifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "birthday_card_tracking" (
	"id" serial PRIMARY KEY NOT NULL,
	"person_type" text NOT NULL,
	"person_id" integer NOT NULL,
	"year" integer NOT NULL,
	"sent" boolean DEFAULT false NOT NULL,
	"sent_at" timestamp with time zone,
	"sent_by_user_id" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prospect_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"prospect_id" integer NOT NULL,
	"user_id" integer,
	"note_text" text NOT NULL,
	"note_type" text DEFAULT 'notiz' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "prospects" (
	"id" serial PRIMARY KEY NOT NULL,
	"vorname" text NOT NULL,
	"nachname" text NOT NULL,
	"telefon" text,
	"email" text,
	"strasse" text,
	"nr" text,
	"plz" text,
	"stadt" text,
	"pflegegrad" integer,
	"status" text DEFAULT 'neu' NOT NULL,
	"wiedervorlage_date" date,
	"status_notiz" text,
	"quelle" text,
	"quelle_details" text,
	"raw_email_content" text,
	"geo_qualified" boolean,
	"disqualification_reason" text,
	"converted_customer_id" integer,
	"assigned_employee_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
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
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"reference_id" integer,
	"reference_type" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "qonto_hide_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_type" text NOT NULL,
	"value" text NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
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
	"source_iban" text,
	"matched_invoice_id" integer,
	"matched_payment_advice_id" integer,
	"match_confidence" text,
	"billing_irrelevant_at" timestamp with time zone,
	"billing_irrelevant_source" text,
	"billing_relevant_override_at" timestamp with time zone,
	"advice_suggestion_dismissed_at" timestamp with time zone,
	"raw_data" jsonb,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qonto_transactions_qonto_id_unique" UNIQUE("qonto_transaction_id"),
	CONSTRAINT "qonto_transactions_match_xor" CHECK (NOT (matched_invoice_id IS NOT NULL AND matched_payment_advice_id IS NOT NULL))
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
CREATE TABLE "customer_creation_idempotency_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"customer_id" integer,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"file_name" text,
	"file_hash" text NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"imported_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" integer
);
--> statement-breakpoint
ALTER TABLE "admin_permissions" ADD CONSTRAINT "admin_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_assignment_history" ADD CONSTRAINT "customer_assignment_history_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_assignment_history" ADD CONSTRAINT "customer_assignment_history_employee_id_users_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_assignment_history" ADD CONSTRAINT "customer_assignment_history_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_care_level_history" ADD CONSTRAINT "customer_care_level_history_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_care_level_history" ADD CONSTRAINT "customer_care_level_history_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_needs_assessments" ADD CONSTRAINT "customer_needs_assessments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_needs_assessments" ADD CONSTRAINT "customer_needs_assessments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_primary_employee_id_users_id_fk" FOREIGN KEY ("primary_employee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_backup_employee_id_users_id_fk" FOREIGN KEY ("backup_employee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_backup_employee_id_2_users_id_fk" FOREIGN KEY ("backup_employee_id_2") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_merged_into_customer_id_customers_id_fk" FOREIGN KEY ("merged_into_customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_insurance_history" ADD CONSTRAINT "customer_insurance_history_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_insurance_history" ADD CONSTRAINT "customer_insurance_history_insurance_provider_id_insurance_providers_id_fk" FOREIGN KEY ("insurance_provider_id") REFERENCES "public"."insurance_providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_insurance_history" ADD CONSTRAINT "customer_insurance_history_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_budget_pots" ADD CONSTRAINT "service_budget_pots_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_contracts" ADD CONSTRAINT "customer_contracts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_contracts" ADD CONSTRAINT "customer_contracts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_wage_rates" ADD CONSTRAINT "role_wage_rates_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_wage_rates" ADD CONSTRAINT "role_wage_rates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_series" ADD CONSTRAINT "appointment_series_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_series" ADD CONSTRAINT "appointment_series_assigned_employee_id_users_id_fk" FOREIGN KEY ("assigned_employee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_series" ADD CONSTRAINT "appointment_series_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_services" ADD CONSTRAINT "appointment_services_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_services" ADD CONSTRAINT "appointment_services_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_assigned_employee_id_users_id_fk" FOREIGN KEY ("assigned_employee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_performed_by_employee_id_users_id_fk" FOREIGN KEY ("performed_by_employee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_travel_from_appointment_id_appointments_id_fk" FOREIGN KEY ("travel_from_appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_signed_by_user_id_users_id_fk" FOREIGN KEY ("signed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_series_id_appointment_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."appointment_series"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_allocations" ADD CONSTRAINT "budget_allocations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_allocations" ADD CONSTRAINT "budget_allocations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_allocation_id_budget_allocations_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "public"."budget_allocations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_captured_transaction_id_budget_transactions_id_fk" FOREIGN KEY ("captured_transaction_id") REFERENCES "public"."budget_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_transactions" ADD CONSTRAINT "budget_transactions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_transactions" ADD CONSTRAINT "budget_transactions_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_transactions" ADD CONSTRAINT "budget_transactions_allocation_id_budget_allocations_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "public"."budget_allocations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_transactions" ADD CONSTRAINT "budget_transactions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_budget_preferences" ADD CONSTRAINT "customer_budget_preferences_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_budget_type_settings" ADD CONSTRAINT "customer_budget_type_settings_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_hours_accounts" ADD CONSTRAINT "employee_hours_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_time_entries" ADD CONSTRAINT "employee_time_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_vacation_allowance" ADD CONSTRAINT "employee_vacation_allowance_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacation_entitlement_history" ADD CONSTRAINT "vacation_entitlement_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacation_entitlement_history" ADD CONSTRAINT "vacation_entitlement_history_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_service_records" ADD CONSTRAINT "monthly_service_records_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_service_records" ADD CONSTRAINT "monthly_service_records_employee_id_users_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_service_records" ADD CONSTRAINT "monthly_service_records_employee_signed_by_user_id_users_id_fk" FOREIGN KEY ("employee_signed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_service_records" ADD CONSTRAINT "monthly_service_records_customer_signed_by_user_id_users_id_fk" FOREIGN KEY ("customer_signed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_record_appointments" ADD CONSTRAINT "service_record_appointments_service_record_id_monthly_service_records_id_fk" FOREIGN KEY ("service_record_id") REFERENCES "public"."monthly_service_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_record_appointments" ADD CONSTRAINT "service_record_appointments_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_to_user_id_users_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_month_closings" ADD CONSTRAINT "employee_month_closings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_month_closings" ADD CONSTRAINT "employee_month_closings_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_month_closings" ADD CONSTRAINT "employee_month_closings_reopened_by_user_id_users_id_fk" FOREIGN KEY ("reopened_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_documents" ADD CONSTRAINT "customer_documents_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_documents" ADD CONSTRAINT "customer_documents_document_type_id_document_types_id_fk" FOREIGN KEY ("document_type_id") REFERENCES "public"."document_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_documents" ADD CONSTRAINT "customer_documents_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_signing_tokens" ADD CONSTRAINT "document_signing_tokens_document_id_generated_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."generated_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_template_billing_types" ADD CONSTRAINT "document_template_billing_types_template_id_document_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."document_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_document_type_id_document_types_id_fk" FOREIGN KEY ("document_type_id") REFERENCES "public"."document_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_type_triggers" ADD CONSTRAINT "document_type_triggers_document_type_id_document_types_id_fk" FOREIGN KEY ("document_type_id") REFERENCES "public"."document_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_employee_id_users_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_document_type_id_document_types_id_fk" FOREIGN KEY ("document_type_id") REFERENCES "public"."document_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_employee_id_users_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_template_id_document_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."document_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_document_type_id_document_types_id_fk" FOREIGN KEY ("document_type_id") REFERENCES "public"."document_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_signed_by_employee_id_users_id_fk" FOREIGN KEY ("signed_by_employee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_generated_by_user_id_users_id_fk" FOREIGN KEY ("generated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_parent_deletion_id_audit_log_id_fk" FOREIGN KEY ("parent_deletion_id") REFERENCES "public"."audit_log"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_deliveries" ADD CONSTRAINT "document_deliveries_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_deliveries" ADD CONSTRAINT "document_deliveries_generated_document_id_generated_documents_id_fk" FOREIGN KEY ("generated_document_id") REFERENCES "public"."generated_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_deliveries" ADD CONSTRAINT "document_deliveries_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_budget_recipients" ADD CONSTRAINT "customer_budget_recipients_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_budget_recipients" ADD CONSTRAINT "customer_budget_recipients_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_stornierte_rechnung_id_invoices_id_fk" FOREIGN KEY ("stornierte_rechnung_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_document_proofs" ADD CONSTRAINT "employee_document_proofs_employee_id_users_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_document_proofs" ADD CONSTRAINT "employee_document_proofs_qualification_id_qualifications_id_fk" FOREIGN KEY ("qualification_id") REFERENCES "public"."qualifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_document_proofs" ADD CONSTRAINT "employee_document_proofs_document_type_id_document_types_id_fk" FOREIGN KEY ("document_type_id") REFERENCES "public"."document_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_document_proofs" ADD CONSTRAINT "employee_document_proofs_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_qualifications" ADD CONSTRAINT "employee_qualifications_employee_id_users_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_qualifications" ADD CONSTRAINT "employee_qualifications_qualification_id_qualifications_id_fk" FOREIGN KEY ("qualification_id") REFERENCES "public"."qualifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_qualifications" ADD CONSTRAINT "employee_qualifications_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualification_documents" ADD CONSTRAINT "qualification_documents_qualification_id_qualifications_id_fk" FOREIGN KEY ("qualification_id") REFERENCES "public"."qualifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualification_documents" ADD CONSTRAINT "qualification_documents_document_type_id_document_types_id_fk" FOREIGN KEY ("document_type_id") REFERENCES "public"."document_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "birthday_card_tracking" ADD CONSTRAINT "birthday_card_tracking_sent_by_user_id_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_notes" ADD CONSTRAINT "prospect_notes_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_notes" ADD CONSTRAINT "prospect_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_offers" ADD CONSTRAINT "prospect_offers_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_offers" ADD CONSTRAINT "prospect_offers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_converted_customer_id_customers_id_fk" FOREIGN KEY ("converted_customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_assigned_employee_id_users_id_fk" FOREIGN KEY ("assigned_employee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_calls" ADD CONSTRAINT "scheduled_calls_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_advice_items" ADD CONSTRAINT "payment_advice_items_payment_advice_id_payment_advices_id_fk" FOREIGN KEY ("payment_advice_id") REFERENCES "public"."payment_advices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_advice_items" ADD CONSTRAINT "payment_advice_items_matched_invoice_id_invoices_id_fk" FOREIGN KEY ("matched_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_advices" ADD CONSTRAINT "payment_advices_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qonto_hide_rules" ADD CONSTRAINT "qonto_hide_rules_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qonto_transactions" ADD CONSTRAINT "qonto_transactions_matched_invoice_id_invoices_id_fk" FOREIGN KEY ("matched_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qonto_transactions" ADD CONSTRAINT "qonto_transactions_matched_payment_advice_id_payment_advices_id_fk" FOREIGN KEY ("matched_payment_advice_id") REFERENCES "public"."payment_advices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_whatsapp_preferences" ADD CONSTRAINT "user_whatsapp_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_message_log" ADD CONSTRAINT "whatsapp_message_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_creation_idempotency_keys" ADD CONSTRAINT "customer_creation_idempotency_keys_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_permissions_user_idx" ON "admin_permissions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "password_reset_tokens_user_idx" ON "password_reset_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "user_roles_user_id_idx" ON "user_roles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "assignment_history_customer_idx" ON "customer_assignment_history" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "assignment_history_employee_idx" ON "customer_assignment_history" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "assignment_history_valid_idx" ON "customer_assignment_history" USING btree ("customer_id","role","valid_from","valid_to");--> statement-breakpoint
CREATE INDEX "customer_care_level_history_customer_id_idx" ON "customer_care_level_history" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customer_care_level_history_valid_idx" ON "customer_care_level_history" USING btree ("customer_id","valid_to");--> statement-breakpoint
CREATE INDEX "customer_contacts_customer_id_idx" ON "customer_contacts" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customer_contacts_active_idx" ON "customer_contacts" USING btree ("customer_id","is_active");--> statement-breakpoint
CREATE INDEX "customer_needs_assessments_customer_idx" ON "customer_needs_assessments" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customers_primary_employee_id_idx" ON "customers" USING btree ("primary_employee_id");--> statement-breakpoint
CREATE INDEX "customers_backup_employee_id_idx" ON "customers" USING btree ("backup_employee_id");--> statement-breakpoint
CREATE INDEX "customers_backup_employee_id_2_idx" ON "customers" USING btree ("backup_employee_id_2");--> statement-breakpoint
CREATE INDEX "customers_name_idx" ON "customers" USING btree ("name");--> statement-breakpoint
CREATE INDEX "customer_insurance_history_customer_id_idx" ON "customer_insurance_history" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customer_insurance_history_provider_id_idx" ON "customer_insurance_history" USING btree ("insurance_provider_id");--> statement-breakpoint
CREATE INDEX "customer_insurance_history_valid_idx" ON "customer_insurance_history" USING btree ("customer_id","valid_from","valid_to");--> statement-breakpoint
CREATE INDEX "insurance_providers_active_idx" ON "insurance_providers" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "service_budget_pots_service_idx" ON "service_budget_pots" USING btree ("service_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_budget_pots_unique_idx" ON "service_budget_pots" USING btree ("service_id","budget_type");--> statement-breakpoint
CREATE INDEX "services_active_sort_idx" ON "services" USING btree ("is_active","sort_order");--> statement-breakpoint
CREATE INDEX "customer_contracts_customer_status_idx" ON "customer_contracts" USING btree ("customer_id","status");--> statement-breakpoint
CREATE INDEX "prices_scope_service_idx" ON "prices" USING btree ("scope","service_id");--> statement-breakpoint
CREATE INDEX "prices_customer_service_idx" ON "prices" USING btree ("customer_id","service_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prices_active_validfrom_uniq" ON "prices" USING btree ("scope","origin","customer_id","service_id","valid_from") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "role_wage_rates_role_service_idx" ON "role_wage_rates" USING btree ("role","service_id");--> statement-breakpoint
CREATE UNIQUE INDEX "role_wage_rates_active_validfrom_uniq" ON "role_wage_rates" USING btree ("role","service_id","valid_from") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "appointment_series_customer_id_idx" ON "appointment_series" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "appointment_series_employee_id_idx" ON "appointment_series" USING btree ("assigned_employee_id");--> statement-breakpoint
CREATE INDEX "appointment_series_status_idx" ON "appointment_series" USING btree ("status");--> statement-breakpoint
CREATE INDEX "appointment_services_appointment_id_idx" ON "appointment_services" USING btree ("appointment_id");--> statement-breakpoint
CREATE INDEX "appointment_services_service_id_idx" ON "appointment_services" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "appointments_customer_id_idx" ON "appointments" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "appointments_date_idx" ON "appointments" USING btree ("date");--> statement-breakpoint
CREATE INDEX "appointments_assigned_employee_id_idx" ON "appointments" USING btree ("assigned_employee_id");--> statement-breakpoint
CREATE INDEX "appointments_performed_by_employee_id_idx" ON "appointments" USING btree ("performed_by_employee_id");--> statement-breakpoint
CREATE INDEX "appointments_date_customer_id_idx" ON "appointments" USING btree ("date","customer_id");--> statement-breakpoint
CREATE INDEX "appointments_status_date_idx" ON "appointments" USING btree ("status","date");--> statement-breakpoint
CREATE INDEX "appointments_employee_date_idx" ON "appointments" USING btree ("assigned_employee_id","date");--> statement-breakpoint
CREATE INDEX "appointments_active_date_idx" ON "appointments" USING btree ("date") WHERE "appointments"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "appointments_active_customer_idx" ON "appointments" USING btree ("customer_id") WHERE "appointments"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "appointments_active_employee_date_idx" ON "appointments" USING btree ("assigned_employee_id","date") WHERE "appointments"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "appointments_prospect_id_idx" ON "appointments" USING btree ("prospect_id");--> statement-breakpoint
CREATE INDEX "appointments_series_id_idx" ON "appointments" USING btree ("series_id");--> statement-breakpoint
CREATE INDEX "appointments_co_visit_group_id_idx" ON "appointments" USING btree ("co_visit_group_id");--> statement-breakpoint
CREATE INDEX "budget_allocations_customer_idx" ON "budget_allocations" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "budget_allocations_customer_year_idx" ON "budget_allocations" USING btree ("customer_id","year");--> statement-breakpoint
CREATE INDEX "budget_allocations_expires_idx" ON "budget_allocations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "budget_allocations_fifo_idx" ON "budget_allocations" USING btree ("customer_id","budget_type","valid_from");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_allocations_auto_unique_idx" ON "budget_allocations" USING btree ("customer_id","budget_type","year","month","source") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_migrations_name_key" ON "budget_migrations" USING btree ("name");--> statement-breakpoint
CREATE INDEX "budget_reservations_customer_idx" ON "budget_reservations" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "budget_reservations_appointment_idx" ON "budget_reservations" USING btree ("appointment_id");--> statement-breakpoint
CREATE INDEX "budget_reservations_allocation_idx" ON "budget_reservations" USING btree ("allocation_id");--> statement-breakpoint
CREATE INDEX "budget_reservations_state_idx" ON "budget_reservations" USING btree ("customer_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_reservations_idempotency_key_idx" ON "budget_reservations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "budget_reservations_captured_transaction_idx" ON "budget_reservations" USING btree ("captured_transaction_id");--> statement-breakpoint
CREATE INDEX "budget_transactions_customer_idx" ON "budget_transactions" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "budget_transactions_customer_date_idx" ON "budget_transactions" USING btree ("customer_id","transaction_date");--> statement-breakpoint
CREATE INDEX "budget_transactions_appointment_idx" ON "budget_transactions" USING btree ("appointment_id");--> statement-breakpoint
CREATE INDEX "budget_transactions_allocation_idx" ON "budget_transactions" USING btree ("allocation_id");--> statement-breakpoint
CREATE INDEX "budget_transactions_allocation_type_idx" ON "budget_transactions" USING btree ("allocation_id","transaction_type");--> statement-breakpoint
CREATE INDEX "budget_transactions_customer_type_txtype_idx" ON "budget_transactions" USING btree ("customer_id","budget_type","transaction_type");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_transactions_reversal_unique_idx" ON "budget_transactions" USING btree ("reversed_transaction_id") WHERE transaction_type = 'reversal' AND reversed_transaction_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_transactions_write_off_unique_idx" ON "budget_transactions" USING btree ("customer_id","allocation_id") WHERE transaction_type = 'write_off' AND allocation_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "customer_budget_preferences_customer_idx" ON "customer_budget_preferences" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_budget_type_settings_unique_idx" ON "customer_budget_type_settings" USING btree ("customer_id","budget_type") WHERE valid_to IS NULL;--> statement-breakpoint
CREATE INDEX "customer_budget_type_settings_customer_idx" ON "customer_budget_type_settings" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "hours_account_user_idx" ON "employee_hours_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "hours_account_period_idx" ON "employee_hours_accounts" USING btree ("year","month");--> statement-breakpoint
CREATE INDEX "time_entries_user_id_idx" ON "employee_time_entries" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "time_entries_entry_date_idx" ON "employee_time_entries" USING btree ("entry_date");--> statement-breakpoint
CREATE INDEX "time_entries_user_date_idx" ON "employee_time_entries" USING btree ("user_id","entry_date");--> statement-breakpoint
CREATE INDEX "vacation_entitlement_history_user_idx" ON "vacation_entitlement_history" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "service_records_customer_idx" ON "monthly_service_records" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "service_records_employee_idx" ON "monthly_service_records" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "service_records_period_idx" ON "monthly_service_records" USING btree ("year","month");--> statement-breakpoint
CREATE INDEX "service_records_status_idx" ON "monthly_service_records" USING btree ("status");--> statement-breakpoint
CREATE INDEX "service_records_type_idx" ON "monthly_service_records" USING btree ("record_type");--> statement-breakpoint
CREATE INDEX "service_record_appointments_record_idx" ON "service_record_appointments" USING btree ("service_record_id");--> statement-breakpoint
CREATE INDEX "service_record_appointments_appointment_idx" ON "service_record_appointments" USING btree ("appointment_id");--> statement-breakpoint
CREATE INDEX "tasks_assigned_to_idx" ON "tasks" USING btree ("assigned_to_user_id");--> statement-breakpoint
CREATE INDEX "tasks_created_by_idx" ON "tasks" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "tasks_customer_id_idx" ON "tasks" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "tasks_status_idx" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tasks_due_date_idx" ON "tasks" USING btree ("due_date");--> statement-breakpoint
CREATE INDEX "month_closing_user_idx" ON "employee_month_closings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "customer_documents_customer_idx" ON "customer_documents" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customer_documents_type_idx" ON "customer_documents" USING btree ("document_type_id");--> statement-breakpoint
CREATE INDEX "customer_documents_current_idx" ON "customer_documents" USING btree ("customer_id","is_current");--> statement-breakpoint
CREATE INDEX "customer_documents_review_due_idx" ON "customer_documents" USING btree ("review_due_date","is_current");--> statement-breakpoint
CREATE INDEX "customer_documents_batch_idx" ON "customer_documents" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "signing_tokens_document_idx" ON "document_signing_tokens" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "signing_tokens_hash_idx" ON "document_signing_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "dtbt_template_idx" ON "document_template_billing_types" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "dtbt_billing_type_idx" ON "document_template_billing_types" USING btree ("billing_type");--> statement-breakpoint
CREATE UNIQUE INDEX "dtbt_template_billing_unique" ON "document_template_billing_types" USING btree ("template_id","billing_type");--> statement-breakpoint
CREATE INDEX "document_templates_type_idx" ON "document_templates" USING btree ("document_type_id");--> statement-breakpoint
CREATE INDEX "document_templates_context_idx" ON "document_templates" USING btree ("context");--> statement-breakpoint
CREATE INDEX "document_templates_target_idx" ON "document_templates" USING btree ("target_type");--> statement-breakpoint
CREATE INDEX "dtt_doc_type_idx" ON "document_type_triggers" USING btree ("document_type_id");--> statement-breakpoint
CREATE INDEX "dtt_entity_type_idx" ON "document_type_triggers" USING btree ("entity_type");--> statement-breakpoint
CREATE INDEX "dtt_active_idx" ON "document_type_triggers" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "dtt_unique" ON "document_type_triggers" USING btree ("document_type_id","entity_type","trigger_type","condition_field","condition_value");--> statement-breakpoint
CREATE INDEX "employee_documents_employee_idx" ON "employee_documents" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "employee_documents_type_idx" ON "employee_documents" USING btree ("document_type_id");--> statement-breakpoint
CREATE INDEX "employee_documents_current_idx" ON "employee_documents" USING btree ("employee_id","is_current");--> statement-breakpoint
CREATE INDEX "employee_documents_review_due_idx" ON "employee_documents" USING btree ("review_due_date","is_current");--> statement-breakpoint
CREATE INDEX "employee_documents_batch_idx" ON "employee_documents" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "generated_docs_customer_idx" ON "generated_documents" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "generated_docs_employee_idx" ON "generated_documents" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "generated_docs_template_idx" ON "generated_documents" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "generated_docs_doctype_idx" ON "generated_documents" USING btree ("document_type_id");--> statement-breakpoint
CREATE INDEX "generated_docs_signing_status_idx" ON "generated_documents" USING btree ("signing_status");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_user_idx" ON "audit_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_log_created_at_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_log_metadata_idx" ON "audit_log" USING gin ("metadata");--> statement-breakpoint
CREATE INDEX "audit_log_parent_deletion_idx" ON "audit_log" USING btree ("parent_deletion_id");--> statement-breakpoint
CREATE INDEX "doc_deliveries_customer_idx" ON "document_deliveries" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "doc_deliveries_document_idx" ON "document_deliveries" USING btree ("generated_document_id");--> statement-breakpoint
CREATE INDEX "doc_deliveries_status_idx" ON "document_deliveries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "customer_budget_recipients_customer_idx" ON "customer_budget_recipients" USING btree ("customer_id","budget_type");--> statement-breakpoint
CREATE INDEX "invoice_line_items_invoice_id_idx" ON "invoice_line_items" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "invoice_line_items_appointment_id_idx" ON "invoice_line_items" USING btree ("appointment_id");--> statement-breakpoint
CREATE INDEX "invoices_customer_id_idx" ON "invoices" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "invoices_billing_period_idx" ON "invoices" USING btree ("billing_year","billing_month");--> statement-breakpoint
CREATE INDEX "invoices_status_idx" ON "invoices" USING btree ("status");--> statement-breakpoint
CREATE INDEX "invoices_invoice_number_idx" ON "invoices" USING btree ("invoice_number");--> statement-breakpoint
CREATE INDEX "invoices_stornierte_rechnung_id_idx" ON "invoices" USING btree ("stornierte_rechnung_id");--> statement-breakpoint
CREATE INDEX "invoices_billing_run_id_idx" ON "invoices" USING btree ("billing_run_id");--> statement-breakpoint
CREATE INDEX "edp_employee_idx" ON "employee_document_proofs" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "edp_qual_idx" ON "employee_document_proofs" USING btree ("qualification_id");--> statement-breakpoint
CREATE INDEX "edp_doctype_idx" ON "employee_document_proofs" USING btree ("document_type_id");--> statement-breakpoint
CREATE INDEX "edp_status_idx" ON "employee_document_proofs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "edp_unique" ON "employee_document_proofs" USING btree ("employee_id","qualification_id","document_type_id");--> statement-breakpoint
CREATE INDEX "emp_qual_employee_idx" ON "employee_qualifications" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "emp_qual_qual_idx" ON "employee_qualifications" USING btree ("qualification_id");--> statement-breakpoint
CREATE UNIQUE INDEX "emp_qual_unique" ON "employee_qualifications" USING btree ("employee_id","qualification_id");--> statement-breakpoint
CREATE INDEX "qual_docs_qual_idx" ON "qualification_documents" USING btree ("qualification_id");--> statement-breakpoint
CREATE INDEX "qual_docs_doctype_idx" ON "qualification_documents" USING btree ("document_type_id");--> statement-breakpoint
CREATE UNIQUE INDEX "qual_docs_unique" ON "qualification_documents" USING btree ("qualification_id","document_type_id");--> statement-breakpoint
CREATE UNIQUE INDEX "birthday_card_unique_idx" ON "birthday_card_tracking" USING btree ("person_type","person_id","year");--> statement-breakpoint
CREATE INDEX "prospect_notes_prospect_id_idx" ON "prospect_notes" USING btree ("prospect_id");--> statement-breakpoint
CREATE INDEX "prospect_offers_prospect_id_idx" ON "prospect_offers" USING btree ("prospect_id");--> statement-breakpoint
CREATE INDEX "prospect_offers_status_idx" ON "prospect_offers" USING btree ("prospect_id","status");--> statement-breakpoint
CREATE INDEX "prospects_status_idx" ON "prospects" USING btree ("status");--> statement-breakpoint
CREATE INDEX "prospects_wiedervorlage_date_idx" ON "prospects" USING btree ("wiedervorlage_date");--> statement-breakpoint
CREATE INDEX "prospects_converted_customer_id_idx" ON "prospects" USING btree ("converted_customer_id");--> statement-breakpoint
CREATE INDEX "scheduled_calls_status_idx" ON "scheduled_calls" USING btree ("status");--> statement-breakpoint
CREATE INDEX "scheduled_calls_scheduled_at_idx" ON "scheduled_calls" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "notifications_user_id_idx" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("user_id") WHERE read_at IS NULL;--> statement-breakpoint
CREATE INDEX "notifications_created_at_idx" ON "notifications" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "payment_advice_items_advice_id_idx" ON "payment_advice_items" USING btree ("payment_advice_id");--> statement-breakpoint
CREATE INDEX "payment_advice_items_matched_invoice_idx" ON "payment_advice_items" USING btree ("matched_invoice_id");--> statement-breakpoint
CREATE INDEX "payment_advices_uploaded_at_idx" ON "payment_advices" USING btree ("uploaded_at");--> statement-breakpoint
CREATE INDEX "qonto_hide_rules_active_idx" ON "qonto_hide_rules" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "qonto_transactions_emitted_at_idx" ON "qonto_transactions" USING btree ("emitted_at");--> statement-breakpoint
CREATE INDEX "qonto_transactions_matched_invoice_idx" ON "qonto_transactions" USING btree ("matched_invoice_id");--> statement-breakpoint
CREATE INDEX "qonto_transactions_side_idx" ON "qonto_transactions" USING btree ("side");--> statement-breakpoint
CREATE UNIQUE INDEX "qonto_transactions_matched_advice_unique_idx" ON "qonto_transactions" USING btree ("matched_payment_advice_id") WHERE matched_payment_advice_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "qonto_transactions_matched_advice_idx" ON "qonto_transactions" USING btree ("matched_payment_advice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_whatsapp_prefs_user_id_unique" ON "user_whatsapp_preferences" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "whatsapp_log_user_idx" ON "whatsapp_message_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "whatsapp_log_created_idx" ON "whatsapp_message_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_rules_event_type_unique" ON "whatsapp_notification_rules" USING btree ("event_type");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_idem_key_unique" ON "customer_creation_idempotency_keys" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "customer_idem_key_expires_idx" ON "customer_creation_idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "import_batches_file_hash_idx" ON "import_batches" USING btree ("file_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "import_batches_id_idx" ON "import_batches" USING btree ("id");