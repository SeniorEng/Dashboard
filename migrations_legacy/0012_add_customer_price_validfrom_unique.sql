-- Pre-index dedup: if duplicate active rows exist for the same
-- (customer_id, service_id, valid_from), keep the highest id (which
-- matches the existing billing tie-break "latest inserted wins") and
-- soft-delete the older ones so the unique index can be created safely.
UPDATE "customer_service_prices" csp
SET "deleted_at" = NOW()
WHERE "deleted_at" IS NULL
  AND "id" < (
    SELECT MAX(d."id")
    FROM "customer_service_prices" d
    WHERE d."customer_id" = csp."customer_id"
      AND d."service_id"  = csp."service_id"
      AND d."valid_from"  = csp."valid_from"
      AND d."deleted_at" IS NULL
  );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "csp_customer_service_validfrom_active_idx" ON "customer_service_prices" USING btree ("customer_id","service_id","valid_from") WHERE deleted_at IS NULL;
