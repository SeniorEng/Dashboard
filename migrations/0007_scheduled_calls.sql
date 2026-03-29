CREATE TABLE IF NOT EXISTS "scheduled_calls" (
  "id" serial PRIMARY KEY NOT NULL,
  "prospect_id" integer NOT NULL,
  "lead_name" text NOT NULL,
  "lead_phone" text NOT NULL,
  "quelle" text,
  "scheduled_at" timestamp NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "reason" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "executed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "scheduled_calls" ADD CONSTRAINT "scheduled_calls_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_calls_status_idx" ON "scheduled_calls" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_calls_scheduled_at_idx" ON "scheduled_calls" USING btree ("scheduled_at");
