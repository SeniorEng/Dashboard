-- Idempotente Anlage von `vacation_entitlement_history` (Schema-Add aus Task #279).
-- Wurde im Drizzle-Schema definiert, war aber in einigen DB-Instanzen noch nicht
-- angelegt. Diese Migration kann gefahrlos mehrfach ausgeführt werden.
--
-- Hinweis: Das Projekt verwendet `shared/schema/common.ts::timestamp`, das alle
-- timestamp-Spalten implizit mit `withTimezone: true` anlegt. `created_at` muss
-- daher `timestamp with time zone` (timestamptz) sein, nicht `timestamp`.

CREATE TABLE IF NOT EXISTS "vacation_entitlement_history" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL,
  "valid_from_year" integer NOT NULL,
  "valid_from_month" integer NOT NULL,
  "days_per_year" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" integer
);
--> statement-breakpoint

-- Falls die Tabelle in einer früheren Variante mit `timestamp` (ohne TZ) angelegt
-- wurde, hier auf `timestamptz` heben. ALTER ist no-op, wenn der Typ bereits passt.
ALTER TABLE "vacation_entitlement_history"
  ALTER COLUMN "created_at" TYPE timestamp with time zone
  USING "created_at" AT TIME ZONE 'UTC';
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "vacation_entitlement_history"
    ADD CONSTRAINT "vacation_entitlement_history_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "vacation_entitlement_history"
    ADD CONSTRAINT "vacation_entitlement_history_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "vacation_entitlement_history"
    ADD CONSTRAINT "vacation_entitlement_history_unique"
    UNIQUE ("user_id", "valid_from_year", "valid_from_month");
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "vacation_entitlement_history_user_idx"
  ON "vacation_entitlement_history" USING btree ("user_id");
