ALTER TABLE "customers" ALTER COLUMN "inaktiv_ab" SET DATA TYPE date USING "inaktiv_ab"::date;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ALTER COLUMN "appointment_date" SET DATA TYPE date USING "appointment_date"::date;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ALTER COLUMN "start_time" SET DATA TYPE time USING "start_time"::time;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ALTER COLUMN "end_time" SET DATA TYPE time USING "end_time"::time;