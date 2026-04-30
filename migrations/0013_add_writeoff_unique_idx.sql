-- Task #262 K7: Partielle UNIQUE auf budget_transactions, damit pro
-- (customer_id, allocation_id) maximal ein write_off existieren kann.
-- IF NOT EXISTS, weil der Index in Test-/Dev-DBs ggf. schon per
-- `npm run db:push --force` angelegt wurde.
CREATE UNIQUE INDEX IF NOT EXISTS "budget_transactions_write_off_unique_idx"
  ON "budget_transactions" USING btree ("customer_id", "allocation_id")
  WHERE transaction_type = 'write_off' AND allocation_id IS NOT NULL;
