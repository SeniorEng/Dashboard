/**
 * Task #1326 — Drop der drei verwaisten Legacy-Preis-Tabellen
 * (`customer_service_prices`, `customer_contract_rates`, `service_rates`).
 *
 * Prüft den datensicheren, idempotenten Kern `dropLegacyPriceTables`:
 *   - Eine NICHT-existente Tabelle ist ein No-Op (idempotent).
 *   - Eine LEERE Legacy-Tabelle wird gedroppt (kein Datenverlust möglich).
 *   - Eine BEFÜLLTE Legacy-Tabelle wird NICHT gedroppt, solange `prices` für die
 *     zugehörige `origin` leer ist (Migration noch nicht gelaufen → Schutz vor
 *     Datenverlust).
 *   - Sobald `prices` Zeilen der passenden `origin` enthält, wird die Tabelle
 *     gedroppt (Vorbedingung erfüllt).
 */
import { describe, it, expect, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { dropLegacyPriceTables } from "../../server/startup/drop-legacy-price-tables";

async function tableExists(table: string): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ${table}
    LIMIT 1
  `);
  return ((res as { rows?: unknown[] }).rows?.length ?? 0) > 0;
}

async function firstServiceId(): Promise<number> {
  const res = await db.execute(sql`SELECT id FROM services ORDER BY id LIMIT 1`);
  const rows = (res as unknown as { rows?: Array<{ id: number }> }).rows ?? [];
  return Number(rows[0].id);
}

afterEach(async () => {
  // Eigene Test-Artefakte restlos entfernen — die echten Prod-Tabellen existieren
  // in der Wegwerf-Test-DB ohnehin nicht (Task #1325).
  await db.execute(sql`DROP TABLE IF EXISTS customer_contract_rates`);
  await db.execute(sql`DROP TABLE IF EXISTS customer_service_prices`);
  await db.execute(sql`DROP TABLE IF EXISTS service_rates`);
  await db.execute(
    sql`DELETE FROM prices WHERE origin IN ('customer_contract_rates','customer_service_prices','service_rates')`,
  );
});

describe("Task #1326 — Drop verwaiste Legacy-Preis-Tabellen", () => {
  it("ist ein No-Op, wenn keine der Tabellen existiert (idempotent)", async () => {
    await expect(dropLegacyPriceTables()).resolves.toBeUndefined();
  });

  it("droppt eine LEERE Legacy-Tabelle (kein Datenverlust möglich)", async () => {
    await db.execute(
      sql`CREATE TABLE service_rates (id serial primary key, service_category text, hourly_rate_cents int, valid_from date)`,
    );
    expect(await tableExists("service_rates")).toBe(true);

    await dropLegacyPriceTables();

    expect(await tableExists("service_rates")).toBe(false);
  });

  it("droppt eine BEFÜLLTE Tabelle NICHT, solange prices für die origin leer ist", async () => {
    await db.execute(
      sql`CREATE TABLE customer_contract_rates (id serial primary key, contract_id int, service_category text, hourly_rate_cents int, valid_from date, valid_to date, created_at timestamptz default now(), created_by_user_id int)`,
    );
    await db.execute(
      sql`INSERT INTO customer_contract_rates (contract_id, service_category, hourly_rate_cents, valid_from) VALUES (9, 'hauswirtschaft', 3800, '2025-05-13')`,
    );

    await dropLegacyPriceTables();

    // Migration nach prices noch nicht gelaufen → Tabelle bleibt erhalten.
    expect(await tableExists("customer_contract_rates")).toBe(true);
  });

  it("droppt eine BEFÜLLTE Tabelle, sobald prices Zeilen der passenden origin enthält", async () => {
    await db.execute(
      sql`CREATE TABLE customer_contract_rates (id serial primary key, contract_id int, service_category text, hourly_rate_cents int, valid_from date, valid_to date, created_at timestamptz default now(), created_by_user_id int)`,
    );
    await db.execute(
      sql`INSERT INTO customer_contract_rates (contract_id, service_category, hourly_rate_cents, valid_from) VALUES (9, 'hauswirtschaft', 3800, '2025-05-13')`,
    );
    const serviceId = await firstServiceId();
    await db.execute(sql`
      INSERT INTO prices (scope, origin, service_id, cents, valid_from)
      VALUES ('customer', 'customer_contract_rates', ${serviceId}, 3800, '2025-05-13')
    `);

    await dropLegacyPriceTables();

    // Vorbedingung erfüllt (Zeilen in prices repräsentiert) → Drop.
    expect(await tableExists("customer_contract_rates")).toBe(false);
  });
});
