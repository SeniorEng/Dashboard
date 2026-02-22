-- =============================================================================
-- DATABASE AUDIT QUERIES
-- Run these against the PostgreSQL database using the execute_sql tool.
-- Each query is labeled with its audit category.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- CATEGORY 3: Nullable columns without defaults
-- Finds columns that accept NULL but have no default value.
-- These may cause issues if application code doesn't always provide a value.
-- ---------------------------------------------------------------------------
SELECT
  table_name,
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND is_nullable = 'YES'
  AND column_default IS NULL
ORDER BY table_name, ordinal_position;

-- ---------------------------------------------------------------------------
-- CATEGORY 4: Sequential scan analysis
-- Tables with high sequential scan ratios may be missing indexes.
-- Focus on tables with >100 rows where seq_scan dominates.
-- ---------------------------------------------------------------------------
SELECT
  relname AS table_name,
  seq_scan,
  idx_scan,
  CASE WHEN seq_scan + idx_scan > 0
    THEN round(100.0 * seq_scan / (seq_scan + idx_scan), 1)
    ELSE 0
  END AS seq_scan_pct,
  n_live_tup AS row_count
FROM pg_stat_user_tables
WHERE n_live_tup > 100
ORDER BY seq_scan_pct DESC, seq_scan DESC;

-- ---------------------------------------------------------------------------
-- CATEGORY 4: Unused indexes
-- Indexes that have never been used (excluding primary keys).
-- Monitor over a business cycle before removing.
-- ---------------------------------------------------------------------------
SELECT
  schemaname,
  relname AS table_name,
  indexrelname AS index_name,
  idx_scan AS times_used,
  pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
  AND idx_scan = 0
  AND indexrelname NOT LIKE '%_pkey'
ORDER BY pg_relation_size(indexrelid) DESC;

-- ---------------------------------------------------------------------------
-- CATEGORY 4: Foreign keys without indexes
-- Foreign key columns should have indexes for fast JOINs and cascades.
-- ---------------------------------------------------------------------------
SELECT
  tc.table_name,
  kcu.column_name,
  tc.constraint_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
  AND tc.table_schema = kcu.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema = 'public'
  AND NOT EXISTS (
    SELECT 1
    FROM pg_indexes pi
    WHERE pi.schemaname = 'public'
      AND pi.tablename = tc.table_name
      AND pi.indexdef LIKE '%' || kcu.column_name || '%'
  )
ORDER BY tc.table_name;

-- ---------------------------------------------------------------------------
-- CATEGORY 6: Schema drift check
-- Lists all columns in the actual database for comparison with Drizzle schema.
-- Compare this output against shared/schema.ts definitions.
-- ---------------------------------------------------------------------------
SELECT
  table_name,
  column_name,
  data_type,
  is_nullable,
  column_default,
  character_maximum_length
FROM information_schema.columns
WHERE table_schema = 'public'
ORDER BY table_name, ordinal_position;

-- ---------------------------------------------------------------------------
-- CATEGORY 6: List all tables
-- Quick overview of all tables in the public schema.
-- ---------------------------------------------------------------------------
SELECT
  tablename,
  hasindexes,
  hastriggers
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;

-- ---------------------------------------------------------------------------
-- CATEGORY 8: Overlapping historization records
-- For tables using valid_from/valid_to pattern, check for overlapping periods.
-- Replace 'YOUR_TABLE' with actual historized table names.
-- ---------------------------------------------------------------------------
-- Template (adapt table name and grouping column):
--
-- SELECT a.id AS record_a, b.id AS record_b,
--   a.valid_from AS a_from, a.valid_to AS a_to,
--   b.valid_from AS b_from, b.valid_to AS b_to
-- FROM YOUR_TABLE a
-- JOIN YOUR_TABLE b
--   ON a.GROUPING_COLUMN = b.GROUPING_COLUMN
--   AND a.id < b.id
--   AND a.valid_from < COALESCE(b.valid_to, '9999-12-31'::date)
--   AND b.valid_from < COALESCE(a.valid_to, '9999-12-31'::date);

-- ---------------------------------------------------------------------------
-- CATEGORY 9: Orphaned records check
-- PROJECT-SPECIFIC: Adapt table/column names to match your schema.
-- These examples are for the CareConnect/SeniorenEngel project.
-- ---------------------------------------------------------------------------

-- Appointments with missing customers
SELECT a.id AS appointment_id, a.customer_id
FROM appointments a
LEFT JOIN customers c ON a.customer_id = c.id
WHERE c.id IS NULL;

-- Appointments with missing employees
SELECT a.id AS appointment_id, a.assigned_employee_id
FROM appointments a
LEFT JOIN employees e ON a.assigned_employee_id = e.id
WHERE a.assigned_employee_id IS NOT NULL
  AND e.id IS NULL;

-- Time entries with missing employees
SELECT t.id AS time_entry_id, t.employee_id
FROM employee_time_entries t
LEFT JOIN employees e ON t.employee_id = e.id
WHERE e.id IS NULL;

-- Generic template for other FK relationships:
-- SELECT child.id, child.fk_column
-- FROM child_table child
-- LEFT JOIN parent_table parent ON child.fk_column = parent.id
-- WHERE parent.id IS NULL;

-- ---------------------------------------------------------------------------
-- CATEGORY 9: Cross-field validation - appointments with end before start
-- ---------------------------------------------------------------------------
SELECT id, date, scheduled_start, scheduled_end
FROM appointments
WHERE scheduled_start IS NOT NULL
  AND scheduled_end IS NOT NULL
  AND scheduled_start > scheduled_end;

-- ---------------------------------------------------------------------------
-- CATEGORY 9: Cross-field validation - historized records with invalid ranges
-- Check valid_from > valid_to (should never happen)
-- ---------------------------------------------------------------------------
-- Template (adapt table name):
--
-- SELECT id, valid_from, valid_to
-- FROM YOUR_TABLE
-- WHERE valid_to IS NOT NULL
--   AND valid_from > valid_to;

-- ---------------------------------------------------------------------------
-- CATEGORY 10: Check for raw SQL (run via grep, not SQL)
-- Use grep to search for raw SQL patterns in the codebase:
--   grep -rn "db.execute\|sql\`\|\.raw(" server/
-- Legitimate uses: Drizzle's sql`` template tag (parameterized)
-- Red flags: String concatenation with user input
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- UTILITY: Table sizes and row counts
-- Useful overview for understanding data volume.
-- ---------------------------------------------------------------------------
SELECT
  relname AS table_name,
  n_live_tup AS row_count,
  pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
  pg_size_pretty(pg_relation_size(relid)) AS table_size,
  pg_size_pretty(pg_total_relation_size(relid) - pg_relation_size(relid)) AS index_size
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC;

-- ---------------------------------------------------------------------------
-- UTILITY: All indexes with definitions
-- Useful for comparing against expected indexes in schema.
-- ---------------------------------------------------------------------------
SELECT
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
ORDER BY tablename, indexname;
