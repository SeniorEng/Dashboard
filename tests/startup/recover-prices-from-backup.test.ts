/**
 * Task #1334 — Wiederherstellung der beim Cutover-Publish verlorenen Produktiv-
 * Preise aus dem 07:46-Backup über fixe Konstanten in die `prices`-SSoT.
 *
 * Prüft den Migrations-Kern `recoverPricesFromBackup` (läuft hier in einer
 * Test-Transaktion statt über den Ledger-gegateten Runner). Da die Prod-Kunden-
 * IDs (39/205) in der frischen Test-DB nicht existieren, werden eigene Entitäten
 * geseedet und Specs/Verifikationen gegen deren IDs gefahren:
 *   - Auflösung Vertrag → Kunde + Kategorie/Code → Service-ID.
 *   - Die 4 Zeilen werden origin-gestempelt nach `prices` geschrieben.
 *   - Fehlende Entität (z. B. unbekannter Vertrag) → Zeile übersprungen, kein Crash.
 *   - Soll-Wert-Verifikation (0/3800/4200) läuft mit (kein Throw = wertgleich).
 *   - Erneuter Lauf ist idempotent (0 neue Zeilen).
 *   - 0-Override löst über die konsolidierte priceFor-Auflösung auf 0 Cent auf.
 */
import { describe, it, expect, afterEach } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { prices } from "@shared/schema";
import {
  recoverPricesFromBackup,
  PriceRecoveryVerificationError,
  type PriceRecoverySpec,
  type PriceRecoveryVerification,
} from "../../server/startup/recover-prices-from-backup";

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

const createdCustomerIds: number[] = [];

afterEach(async () => {
  await db.execute(
    sql`DELETE FROM prices WHERE origin IN ('customer_contract_rates','customer_service_prices')`,
  );
  for (const id of createdCustomerIds.splice(0)) {
    await db.execute(sql`DELETE FROM customer_contracts WHERE customer_id = ${id}`);
    await db.execute(sql`DELETE FROM customers WHERE id = ${id}`);
  }
});

describe("Task #1334 — prices aus Backup wiederherstellen", () => {
  it("stellt die 4 Zeilen aus den Specs wieder her, verifiziert die Soll-Werte und ist idempotent", async () => {
    const c205 = await createCustomer(`T1334 c205 ${Date.now()}`);
    const c39 = await createCustomer(`T1334 c39 ${Date.now()}`);
    createdCustomerIds.push(c205, c39);
    const contractId = await createContract(c39);

    const specs: PriceRecoverySpec[] = [
      {
        origin: "customer_service_prices",
        customerId: c205,
        serviceCode: "travel_km",
        cents: 0,
        validFrom: "2026-06-01",
        validTo: null,
        label: "c205 Anfahrt 0",
      },
      {
        origin: "customer_service_prices",
        customerId: c39,
        serviceCode: "hauswirtschaft",
        cents: 3800,
        validFrom: "2026-03-19",
        validTo: "2026-05-26",
        label: "c39 Hauswirtschaft 3800 csp",
      },
      {
        origin: "customer_contract_rates",
        contractId,
        serviceCode: "hauswirtschaft",
        cents: 3800,
        validFrom: "2025-05-13",
        validTo: null,
        label: "Vertrag Hauswirtschaft 3800 ccr",
      },
      {
        origin: "customer_contract_rates",
        contractId,
        serviceCode: "alltagsbegleitung",
        cents: 4200,
        validFrom: "2025-05-13",
        validTo: null,
        label: "Vertrag Alltagsbegleitung 4200 ccr",
      },
    ];
    const verifications: PriceRecoveryVerification[] = [
      { customerId: c205, serviceCode: "travel_km", date: "2026-06-01", expectedCents: 0 },
      { customerId: c39, serviceCode: "hauswirtschaft", date: "2026-04-01", expectedCents: 3800 },
      { customerId: c39, serviceCode: "alltagsbegleitung", date: "2026-04-01", expectedCents: 4200 },
    ];

    const summary = await db.transaction((tx) =>
      recoverPricesFromBackup(tx, specs, verifications),
    );
    expect(summary.changed).toBe(4);

    const byOrigin = async (origin: string) =>
      db
        .select({ scope: prices.scope, cents: prices.cents, customerId: prices.customerId })
        .from(prices)
        .where(and(eq(prices.origin, origin), isNull(prices.deletedAt)));

    const csp = await byOrigin("customer_service_prices");
    expect(csp).toHaveLength(2);
    expect(csp.every((r) => r.scope === "customer")).toBe(true);

    const ccr = await byOrigin("customer_contract_rates");
    expect(ccr).toHaveLength(2);
    expect(ccr.map((r) => r.cents).sort()).toEqual([3800, 4200]);
    expect(ccr.every((r) => r.customerId === c39)).toBe(true);

    // Idempotenz: zweiter Lauf über identische Specs fügt nichts ein.
    const again = await db.transaction((tx) =>
      recoverPricesFromBackup(tx, specs, verifications),
    );
    expect(again.changed).toBe(0);
    expect(await byOrigin("customer_service_prices")).toHaveLength(2);
    expect(await byOrigin("customer_contract_rates")).toHaveLength(2);
  });

  it("überspringt Zeilen mit fehlender Entität (No-Op außerhalb Prod), statt zu crashen", async () => {
    const c = await createCustomer(`T1334 skip ${Date.now()}`);
    createdCustomerIds.push(c);

    const specs: PriceRecoverySpec[] = [
      {
        origin: "customer_service_prices",
        customerId: 999999999, // existiert nicht
        serviceCode: "travel_km",
        cents: 0,
        validFrom: "2026-06-01",
        validTo: null,
        label: "fehlender Kunde",
      },
      {
        origin: "customer_contract_rates",
        contractId: 999999999, // existiert nicht
        serviceCode: "hauswirtschaft",
        cents: 3800,
        validFrom: "2025-05-13",
        validTo: null,
        label: "fehlender Vertrag",
      },
      {
        origin: "customer_service_prices",
        customerId: c,
        serviceCode: "definitiv_unbekannter_code",
        cents: 1000,
        validFrom: "2026-01-01",
        validTo: null,
        label: "fehlender Service",
      },
    ];

    const summary = await db.transaction((tx) =>
      recoverPricesFromBackup(tx, specs, []),
    );
    expect(summary.changed).toBe(0);
    expect(summary.note).toContain("übersprungen=3");
  });

  it("der 0-Override löst über die konsolidierte prices-SSoT auf 0 Cent auf (Existence-Wins)", async () => {
    const c = await createCustomer(`T1334 null ${Date.now()}`);
    createdCustomerIds.push(c);
    const travelKmId = await serviceIdByCode("travel_km");

    const specs: PriceRecoverySpec[] = [
      {
        origin: "customer_service_prices",
        customerId: c,
        serviceCode: "travel_km",
        cents: 0,
        validFrom: "2026-06-01",
        validTo: null,
        label: "0-Override",
      },
    ];
    await db.transaction((tx) => recoverPricesFromBackup(tx, specs, []));

    const rows = await db
      .select({ cents: prices.cents })
      .from(prices)
      .where(
        and(
          eq(prices.scope, "customer"),
          eq(prices.customerId, c),
          eq(prices.serviceId, travelKmId),
          isNull(prices.deletedAt),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].cents).toBe(0);
  });

  it("wirft PriceRecoveryVerificationError (Rollback), wenn die Soll-Werte abweichen", async () => {
    const c = await createCustomer(`T1334 fail ${Date.now()}`);
    createdCustomerIds.push(c);

    const specs: PriceRecoverySpec[] = [
      {
        origin: "customer_service_prices",
        customerId: c,
        serviceCode: "hauswirtschaft",
        cents: 3800,
        validFrom: "2026-03-19",
        validTo: null,
        label: "c Hauswirtschaft 3800",
      },
    ];
    // Falscher Soll-Wert (5000 statt 3800) → muss hart fehlschlagen.
    const verifications: PriceRecoveryVerification[] = [
      { customerId: c, serviceCode: "hauswirtschaft", date: "2026-04-01", expectedCents: 5000 },
    ];

    await expect(
      db.transaction((tx) => recoverPricesFromBackup(tx, specs, verifications)),
    ).rejects.toBeInstanceOf(PriceRecoveryVerificationError);

    // Rollback: keine Zeile persistiert.
    const persisted = await db
      .select({ id: prices.id })
      .from(prices)
      .where(
        and(
          eq(prices.origin, "customer_service_prices"),
          eq(prices.customerId, c),
          isNull(prices.deletedAt),
        ),
      );
    expect(persisted).toHaveLength(0);
  });
});
