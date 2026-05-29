/**
 * Task #608 / #716 — Backfill-Sentinel für
 * `customer_budget_type_settings.validFrom`.
 *
 * Historische Zeilen, die der Historisierungs-Backfill nachträglich gefüllt
 * hat, tragen diesen Wert statt eines echten Inkrafttreten-Datums. UI und
 * Save-Logik müssen ihn maskieren bzw. beim ersten Edit ersetzen.
 *
 * Phase 1.1 (Task #716): Diese Konstante ist die EINZIGE Quelle für den
 * Sentinel-Wert; sowohl Backend (`server/storage/budget/preferences-storage.ts`)
 * als auch Frontend (`client/src/components/budget/BudgetTypeSettings.tsx`)
 * importieren sie. Freie Klartext-Vorkommen von `"1970-01-01"` außerhalb dieser
 * Datei verbietet `tests/architecture/budget-sentinel-uniqueness.test.ts`.
 */
// @ts-nocheck

export const SETTINGS_VALID_FROM_EPOCH = "1970-01-01";
