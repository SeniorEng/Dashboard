/**
 * Task #1329 — Idempotente Startup-Befüllung der `prices`-SSoT aus den drei
 * Alt-Preis-Tabellen (`service_rates`, `customer_contract_rates`,
 * `customer_service_prices`).
 *
 * Prüft den Befüllungs-Kern `populatePricesFromLegacy` (läuft hier in einer
 * Test-Transaktion statt über den Ledger-gegateten Runner):
 *   - Fehlende Alt-Tabellen → sauberer No-Op (kein Fehler).
 *   - Mappbare Alt-Zeilen werden verlustfrei + origin-gestempelt nach `prices`
 *     gespiegelt (service_rates→standard, ccr/csp→customer).
 *   - Erneuter Lauf über identische Quelldaten ist idempotent (0 neue Zeilen).
 *   - Der harte Gate-2-Paritäts-Selbstcheck läuft mit (kein Throw = wertgleich).
 *   - Der 0-Cent-Kunden-Override („keine Anfahrt") löst auf 0 Cent auf
 *     (Existence-Wins über 0).
 *
 * Die Alt-Tabellen sind aus dem Schema entfernt → per Raw-SQL seeden.
 */
import { describe, it, expect, afterEach } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { prices } from "@shared/schema";
import { resolvePriceFor } from "@shared/domain/pricing/price-for";
import {
  populatePricesFromLegacy,
  Gate2ParityError,
} from "../../server/startup/populate-prices-from-legacy";

async function serviceIdByCode(code: string): Promise<number> {
  const res = await db.execute(
    sql`SELECT id FROM services WHERE code = ${code} ORDER BY id LIMIT 1`,
  );
  const rows = (res as unknown as { rows?: Array<{ id: number }> }).rows ?? [];
  if (rows.length === 0) throw new Error(`Service mit code=${code} nicht gefunden`);
  return Number(rows[0].id);
}

async function createCustomer(name: string): Promise<number> {
  const res = await db.execute(
    sql`INSERT INTO customers (name, address) VALUES (${name}, ${"Teststraße 1, 10115 Berlin"}) RETURNING id`,
  );
  const rows = (res as unknown as { rows?: Array<{ id: number }> }).rows ?? [];
  return Number(rows[0].id);
}

async function createContract(customerId: number): Promise<number> {
  const res = await db.execute(
    sql`INSERT INTO customer_contracts (customer_id, contract_start) VALUES (${customerId}, ${"2024-01-01"}) RETURNING id`,
  );
  const rows = (res as unknown as { rows?: Array<{ id: number }> }).rows ?? [];
  return Number(rows[0].id);
}

async function createLegacyTables(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS service_rates (
      id serial primary key, service_category text, hourly_rate_cents int,
      valid_from date, valid_to date, created_at timestamptz default now(), created_by_user_id int
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS customer_contract_rates (
      id serial primary key, contract_id int, service_category text, hourly_rate_cents int,
      valid_from date, valid_to date, created_at timestamptz default now(), created_by_user_id int
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS customer_service_prices (
      id serial primary key, customer_id int, service_id int, price_cents int,
      valid_from timestamptz default now(), valid_to timestamptz, deleted_at timestamptz,
      created_at timestamptz default now()
    )
  `);
}

const createdCustomerIds: number[] = [];

afterEach(async () => {
  await db.execute(sql`DROP TABLE IF EXISTS customer_contract_rates`);
  await db.execute(sql`DROP TABLE IF EXISTS customer_service_prices`);
  await db.execute(sql`DROP TABLE IF EXISTS service_rates`);
  await db.execute(
    sql`DELETE FROM prices WHERE origin IN ('customer_contract_rates','customer_service_prices','service_rates')`,
  );
  for (const id of createdCustomerIds.splice(0)) {
    await db.execute(sql`DELETE FROM customer_contracts WHERE customer_id = ${id}`);
    await db.execute(sql`DELETE FROM customers WHERE id = ${id}`);
  }
});

describe("Task #1329 — prices aus Alt-Tabellen befüllen", () => {
  it("ist ein sauberer No-Op, wenn keine Alt-Tabelle existiert", async () => {
    const summary = await db.transaction((tx) => populatePricesFromLegacy(tx));
    expect(summary.changed).toBe(0);
    expect(summary.note).toContain("keine Alt-Tabellen");
  });

  it("spiegelt mappbare Alt-Zeilen origin-gestempelt nach prices (verlustfrei) und ist idempotent", async () => {
    await createLegacyTables();
    const customerId = await createCustomer(`T1329 Kunde ${Date.now()}`);
    createdCustomerIds.push(customerId);
    const contractId = await createContract(customerId);
    const travelKmId = await serviceIdByCode("travel_km");

    // Standard (firmenweit) via service_rates → scope="standard".
    await db.execute(sql`
      INSERT INTO service_rates (service_category, hourly_rate_cents, valid_from)
      VALUES ('hauswirtschaft', 3000, '2024-01-01')
    `);
    // Kunden-Override via customer_contract_rates → scope="customer".
    await db.execute(sql`
      INSERT INTO customer_contract_rates (contract_id, service_category, hourly_rate_cents, valid_from)
      VALUES (${contractId}, 'alltagsbegleitung', 4000, '2024-01-01')
    `);
    // 0-Override „keine Anfahrt" via customer_service_prices → scope="customer", 0 ct.
    await db.execute(sql`
      INSERT INTO customer_service_prices (customer_id, service_id, price_cents, valid_from)
      VALUES (${customerId}, ${travelKmId}, 0, '2024-01-01')
    `);

    const summary = await db.transaction((tx) => populatePricesFromLegacy(tx));
    expect(summary.changed).toBe(3);

    const byOrigin = async (origin: string) => {
      const rows = await db
        .select({ scope: prices.scope, cents: prices.cents, customerId: prices.customerId })
        .from(prices)
        .where(and(eq(prices.origin, origin), isNull(prices.deletedAt)));
      return rows;
    };

    const sr = await byOrigin("service_rates");
    expect(sr).toHaveLength(1);
    expect(sr[0].scope).toBe("standard");
    expect(sr[0].cents).toBe(3000);
    expect(sr[0].customerId).toBeNull();

    const ccr = await byOrigin("customer_contract_rates");
    expect(ccr).toHaveLength(1);
    expect(ccr[0].scope).toBe("customer");
    expect(ccr[0].cents).toBe(4000);
    expect(ccr[0].customerId).toBe(customerId);

    const csp = await byOrigin("customer_service_prices");
    expect(csp).toHaveLength(1);
    expect(csp[0].scope).toBe("customer");
    expect(csp[0].cents).toBe(0);

    // Idempotenz: erneuter Lauf über identische Quelldaten fügt nichts ein.
    const again = await db.transaction((tx) => populatePricesFromLegacy(tx));
    expect(again.changed).toBe(0);
    expect((await byOrigin("service_rates"))).toHaveLength(1);
    expect((await byOrigin("customer_contract_rates"))).toHaveLength(1);
    expect((await byOrigin("customer_service_prices"))).toHaveLength(1);
  });

  it("der 0-Override löst über die konsolidierte prices-SSoT auf 0 Cent auf (Existence-Wins)", async () => {
    await createLegacyTables();
    const customerId = await createCustomer(`T1329 Null ${Date.now()}`);
    createdCustomerIds.push(customerId);
    const travelKmId = await serviceIdByCode("travel_km");
    await db.execute(sql`
      INSERT INTO customer_service_prices (customer_id, service_id, price_cents, valid_from)
      VALUES (${customerId}, ${travelKmId}, 0, '2024-01-01')
    `);

    await db.transaction((tx) => populatePricesFromLegacy(tx));

    const rows = await db
      .select({
        id: prices.id,
        cents: prices.cents,
        validFrom: prices.validFrom,
        validTo: prices.validTo,
      })
      .from(prices)
      .where(
        and(
          eq(prices.scope, "customer"),
          eq(prices.customerId, customerId),
          eq(prices.serviceId, travelKmId),
          isNull(prices.deletedAt),
        ),
      );
    const resolution = resolvePriceFor({
      date: "2025-06-01",
      customerRows: rows.map((r) => ({
        id: Number(r.id),
        priceCents: Number(r.cents),
        validFrom: r.validFrom ? String(r.validFrom).substring(0, 10) : null,
        validTo: r.validTo ? String(r.validTo).substring(0, 10) : null,
      })),
      standardRows: [],
      catalog: { defaultPriceCents: 5000, isBillable: true },
    });
    expect(resolution?.cents).toBe(0);
    expect(resolution?.scope).toBe("customer");
  });

  it("Gate2ParityError ist exportiert und verständlich", () => {
    const err = new Gate2ParityError([
      { customerId: 7, serviceId: 3, date: "2025-01-01", baselineCents: 100, consolidatedCents: 200 },
    ]);
    expect(err.name).toBe("Gate2ParityError");
    expect(err.message).toContain("GATE 2 ROT");
  });
});
