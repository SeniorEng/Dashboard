#!/bin/bash
set -e

npm install --prefer-offline --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund

# Task #50: Add service_details column to invoice_line_items
psql "$DATABASE_URL" -c "ALTER TABLE invoice_line_items ADD COLUMN IF NOT EXISTS service_details TEXT;" 2>/dev/null || true

npm run db:push 2>/dev/null || true
