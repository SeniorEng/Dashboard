import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Task #1503 — Rollenbasierte Vergütung (Lohnsatz je Rolle × Leistung).
 *
 * Stellt die Tabelle `role_wage_rates` sicher (Drizzle-Modell:
 * `shared/schema/contracts.ts`). Idempotent, ohne destruktive
 * drizzle-kit-Push-Pfade (GoBD: Bestand bleibt unverändert).
 *
 * `role_wage_rates` ist die EINE zeitversionierte Lohnsatz-Quelle hinter der
 * `wageFor`-SSoT und ERSETZT den flachen Katalogwert
 * (`services.employee_rate_cents`) als Override-Quelle sowie die schlafende
 * `employee_compensation_history`.
 *
 * Der partielle Unique-Index (`deleted_at IS NULL`) verhindert zwei aktive
 * Sätze mit identischem `valid_from` je (Rolle, Service) — analog zum
 * `prices_active_validfrom_uniq` der Preis-SSoT.
 */
export const ROLE_WAGE_RATES_CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS role_wage_rates (
    id serial PRIMARY KEY,
    role text NOT NULL,
    service_id integer NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    cents integer NOT NULL,
    valid_from date NOT NULL,
    valid_to date,
    deleted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by_user_id integer REFERENCES users(id)
  )
`;

export const ROLE_WAGE_RATES_ROLE_SERVICE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS role_wage_rates_role_service_idx
  ON role_wage_rates (role, service_id)
`;

export const ROLE_WAGE_RATES_ACTIVE_VALIDFROM_UNIQ_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS role_wage_rates_active_validfrom_uniq
  ON role_wage_rates (role, service_id, valid_from)
  WHERE deleted_at IS NULL
`;

export async function ensureRoleWageRates(): Promise<void> {
  await db.execute(sql.raw(ROLE_WAGE_RATES_CREATE_TABLE_SQL));
  await db.execute(sql.raw(ROLE_WAGE_RATES_ROLE_SERVICE_INDEX_SQL));
  await db.execute(sql.raw(ROLE_WAGE_RATES_ACTIVE_VALIDFROM_UNIQ_SQL));
  log("role_wage_rates-Tabelle sichergestellt", "startup");
}
