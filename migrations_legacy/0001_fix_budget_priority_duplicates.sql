-- Fix duplicate priorities in customer_budget_type_settings
-- All customers with duplicate priorities get reassigned to default order:
-- entlastungsbetrag_45b=1, umwandlung_45a=2, ersatzpflege_39_42a=3
UPDATE customer_budget_type_settings
SET priority = CASE budget_type
  WHEN 'entlastungsbetrag_45b' THEN 1
  WHEN 'umwandlung_45a' THEN 2
  WHEN 'ersatzpflege_39_42a' THEN 3
END
WHERE customer_id IN (
  SELECT customer_id
  FROM customer_budget_type_settings
  GROUP BY customer_id, priority
  HAVING COUNT(*) > 1
)
AND priority != CASE budget_type
  WHEN 'entlastungsbetrag_45b' THEN 1
  WHEN 'umwandlung_45a' THEN 2
  WHEN 'ersatzpflege_39_42a' THEN 3
END;
