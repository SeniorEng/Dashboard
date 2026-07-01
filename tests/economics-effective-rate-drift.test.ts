import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../server/lib/db";
import { getAuthCookie, createTestCustomer, cleanupCustomer } from "./test-utils";
import { getPerformanceStats } from "../server/storage/statistics/performance";
import { getEconomics } from "../server/storage/statistics/economics";
import { readBillingEconomics } from "../server/storage/billing/economics-reader";
import { resolvePeriod } from "../server/storage/statistics/common";

/**
 * Task #1546 — Anzeige-vs-Buchung für Satz-LABELS im Reporting.
 *
 * Die Geld-Spalten der drei Reporting-Reader (Wirtschaftlichkeit-Abrechnung,
 * Wirtschaftlichkeit-Statistik, Performance-Kalkulationsgrundlage) rechnen längst
 * mit den EFFEKTIVEN Werten: rollenbasierte Löhne (`role_wage_rates`) und
 * kundenspezifische Preise (`prices`). Die angezeigten SÄTZE ("38,00 €/Std",
 * "Erlös/h", "MA-Kosten/h") dürfen deshalb NICHT mehr aus den flachen
 * Katalog-Spalten (`services.default_price_cents` / `employee_rate_cents`)
 * stammen, sondern MÜSSEN effektiv aus Geld ÷ Menge abgeleitet werden — sonst
 * driftet die Anzeige von der Buchung ab.
 *
 * Die Fixture setzt bewusst BEIDE Effektiv-Quellen abweichend vom Katalog:
 *  - einen Rollen-Lohnsatz (≠ `employee_rate_cents`)
 *  - einen kundenspezifischen Preis (≠ `default_price_cents`)
 * und prüft, dass alle drei Reader den effektiven (nicht den Katalog-) Satz
 * zeigen. Isolation über ein weit in der Zukunft liegendes Jahr, damit auf der
 * geteilten Test-DB keine Fremd-Termine den geblendeten Satz verfälschen.
 */
describe("Task #1546 — Reporting: Sätze effektiv aus Geld ÷ Menge (Anzeige === Buchung)", () => {
  const testYear = 2035;
  const testMonth = 6;
  const apptDate = `${testYear}-0${testMonth}-15`;

  let userId: number;
  let hwServiceId: number;
  let customerId: number;
  let roleWageRateId: number;
  let customerPriceId: number;

  // Effektive Werte, die bewusst vom Katalog abweichen.
  let catalogRateCents: number;
  let catalogPriceCents: number;
  let effectiveWageCents: number;
  let effectivePriceCents: number;

  beforeAll(async () => {
    const auth = await getAuthCookie();
    userId = auth.user.id; // Seed-Superadmin ⇒ Lohn-Rolle 'admin'.

    // Reale Hauswirtschafts-Leistung (die Reader filtern nach Code 'hauswirtschaft').
    const svc = await db.execute(sql`
      SELECT id, COALESCE(default_price_cents, 0)::int AS price, COALESCE(employee_rate_cents, 0)::int AS rate
      FROM services WHERE code = 'hauswirtschaft' LIMIT 1
    `).then((r) => r.rows as Array<{ id: number; price: number; rate: number }>);
    hwServiceId = svc[0].id;
    catalogPriceCents = svc[0].price;
    catalogRateCents = svc[0].rate;
    // Garantiert vom Katalog verschieden.
    effectiveWageCents = catalogRateCents + 777;
    effectivePriceCents = catalogPriceCents + 1234;

    const customer = await createTestCustomer({ vorname: "T1546", nachname: `Rate_${Date.now()}` });
    customerId = customer.id as number;

    // Rollen-Lohnsatz (admin × Hauswirtschaft) für das Testjahr — spätestes
    // valid_from gewinnt, kollidiert also nicht mit anderen Suites (2025/2026).
    roleWageRateId = await db.execute(sql`
      INSERT INTO role_wage_rates (role, service_id, cents, valid_from, valid_to, created_by_user_id)
      VALUES ('admin', ${hwServiceId}, ${effectiveWageCents}, ${`${testYear}-01-01`}, ${`${testYear}-12-31`}, ${userId})
      RETURNING id
    `).then((r) => (r.rows as Array<{ id: number }>)[0].id);

    // Kundenspezifischer Preis (≠ Katalog-Default).
    customerPriceId = await db.execute(sql`
      INSERT INTO prices (scope, origin, customer_id, service_id, cents, valid_from, valid_to, created_by_user_id)
      VALUES ('customer', 'customer_service_prices', ${customerId}, ${hwServiceId}, ${effectivePriceCents}, ${`${testYear}-01-01`}, NULL, ${userId})
      RETURNING id
    `).then((r) => (r.rows as Array<{ id: number }>)[0].id);

    // Genau EIN dokumentierter 60-Minuten-Hauswirtschafts-Termin.
    const apptId = await db.execute(sql`
      INSERT INTO appointments (
        customer_id, created_by_user_id, assigned_employee_id, performed_by_employee_id,
        appointment_type, date, scheduled_start, scheduled_end, duration_promised,
        status, actual_start, actual_end, travel_origin_type, travel_kilometers,
        travel_minutes, customer_kilometers, signed_at, signed_by_user_id
      ) VALUES (
        ${customerId}, ${userId}, ${userId}, ${userId},
        'Kundentermin', ${apptDate}, '09:00', '10:00', 60,
        'completed', '09:00', '10:00', 'home', 0,
        0, 0, NOW(), ${userId}
      )
      RETURNING id
    `).then((r) => (r.rows as Array<{ id: number }>)[0].id);
    await db.execute(sql`
      INSERT INTO appointment_services
        (appointment_id, service_id, planned_duration_minutes, actual_duration_minutes, details)
      VALUES (${apptId}, ${hwServiceId}, 60, 60, 'T1546 fixture')
    `);
  });

  afterAll(async () => {
    await cleanupCustomer(customerId); // entfernt Termin + Kundenpreis (FK-Cascade)
    if (customerPriceId) await db.execute(sql`DELETE FROM prices WHERE id = ${customerPriceId}`);
    if (roleWageRateId) await db.execute(sql`DELETE FROM role_wage_rates WHERE id = ${roleWageRateId}`);
  });

  it("Reader 1 (Abrechnung-Wirtschaftlichkeit): Zeilen-Satz = effektiver Lohn/Preis, nicht Katalog", async () => {
    const billing = await readBillingEconomics(testYear, testMonth);
    const hw = billing.byService.find((r) => r.key === "hauswirtschaft");
    expect(hw).toBeDefined();
    expect(hw!.quantity).toBe(60);

    // Satz-Labels stammen aus Geld ÷ Menge (effektiv), NICHT aus dem Katalog.
    expect(hw!.costRateCents).toBe(effectiveWageCents);
    expect(hw!.costRateCents).not.toBe(catalogRateCents);
    expect(hw!.revenueRateCents).toBe(effectivePriceCents);
    expect(hw!.revenueRateCents).not.toBe(catalogPriceCents);

    // Anzeige === Buchung: Satz × Stunden === persistierte Geld-Spalte.
    expect(Math.round((hw!.costRateCents * hw!.quantity) / 60)).toBe(hw!.costCents);
    expect(Math.round((hw!.revenueRateCents * hw!.quantity) / 60)).toBe(hw!.revenueCents);

    // Menge 0 ⇒ kein Satz (Gemeinkosten-Zeile).
    const gk = billing.byService.find((r) => r.key === "gemeinkosten");
    expect(gk).toBeDefined();
    expect(gk!.quantity).toBe(0);
    expect(gk!.costRateCents).toBe(0);
    expect(gk!.revenueRateCents).toBe(0);
  });

  it("Reader 2 (Statistik-Wirtschaftlichkeit): impliziter Kosten/h-Satz = effektiver Rollenlohn", async () => {
    const { economics } = await getEconomics(resolvePeriod({ year: testYear }));
    const p = economics.personnel.hauswirtschaft;
    expect(p.minutes).toBe(60);
    // Die Kosten sind bereits rollenbasiert (Task #1503) ⇒ der abgeleitete
    // Anzeige-Satz (Kosten/h) muss dem Rollenlohn entsprechen, nicht dem Katalog.
    expect(p.costCents).toBe(effectiveWageCents);
    expect(Math.round((p.costCents * 60) / p.minutes)).toBe(effectiveWageCents);
    expect(effectiveWageCents).not.toBe(catalogRateCents);
  });

  it("Reader 3 (Performance-Kalkulationsgrundlage): Erlös/h + Lohn/h effektiv, nicht Katalog", async () => {
    const perf = await getPerformanceStats(resolvePeriod({ year: testYear }));
    const hw = perf.profitability.servicePrices.find((s) => s.code === "hauswirtschaft");
    expect(hw).toBeDefined();

    // Lohn/h = effektiver Rollenlohn, Erlös/h = kundenspezifischer Preis.
    expect(hw!.rateCents).toBe(effectiveWageCents);
    expect(hw!.rateCents).not.toBe(catalogRateCents);
    expect(hw!.priceCents).toBe(effectivePriceCents);
    expect(hw!.priceCents).not.toBe(catalogPriceCents);

    // Marge folgt konsistent aus den effektiven Sätzen.
    expect(hw!.marginCents).toBe(effectivePriceCents - effectiveWageCents);
  });
});
