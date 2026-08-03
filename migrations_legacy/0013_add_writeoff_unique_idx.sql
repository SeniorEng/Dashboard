CREATE UNIQUE INDEX IF NOT EXISTS "budget_transactions_write_off_unique_idx"
  ON "budget_transactions" USING btree ("customer_id", "allocation_id")
  WHERE transaction_type = 'write_off' AND allocation_id IS NOT NULL;
