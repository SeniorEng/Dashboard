CREATE TABLE "invoice_number_sequence" (
	"billing_year" integer PRIMARY KEY NOT NULL,
	"last_number" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "issued_at" timestamp with time zone;