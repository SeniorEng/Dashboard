-- Task #485: Customer-No-Show outcome (Annahmeverzug §615 BGB).
ALTER TABLE "appointments"
  ADD COLUMN IF NOT EXISTS "no_show_reason"        text,
  ADD COLUMN IF NOT EXISTS "no_show_reason_text"   varchar(255),
  ADD COLUMN IF NOT EXISTS "no_show_wait_minutes"  integer,
  ADD COLUMN IF NOT EXISTS "no_show_kilometers"    real,
  ADD COLUMN IF NOT EXISTS "no_show_notes"         varchar(255),
  ADD COLUMN IF NOT EXISTS "no_show_charge_suppressed" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "no_show_charge_suppression_reason" text;

ALTER TABLE "customers"
  ADD COLUMN IF NOT EXISTS "cancellation_policy_type"      text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS "cancellation_flat_cents"       integer,
  ADD COLUMN IF NOT EXISTS "cancellation_hourly_rate_cents" integer,
  ADD COLUMN IF NOT EXISTS "cancellation_km_rate_cents"    integer;
