import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../server/lib/db";
import { getAuthCookie, createTestCustomer, cleanupCustomer } from "./test-utils";
import { getPerformanceStats } from "../server/storage/statistics/performance";
import { getEconomics } from "../server/storage/statistics/economics";
import { readBillingEconomics } from "../server/storage/billing/economics-reader";
import { resolvePeriod } from "../server/storage/statistics/common";

/**
 * Task #1546 / #1551 — Anzeige-vs-Buchung für Satz-LABELS im Reporting.
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
 * Task #1546 hatte diese Drift-Absicherung nur für „Hauswirtschaft" gebaut.
 * Task #1551 zieht sie auf die beiden anderen von den Readern gemeldeten
 * Kategorien nach — „Alltagsbegleitung" und „Erstberatung". Für jede Kategorie
 * werden BEIDE Effektiv-Quellen bewusst vom Katalog abweichend gesetzt (ein
 * Rollen-Lohnsatz ≠ `employee_rate_cents` und ein kundenspezifischer Preis ≠
 * `default_price_cents`) und geprüft, dass die Reader den effektiven (nicht den
 * Katalog-) Satz zeigen und Satz × Menge === persistierte Geld-Spalte gilt.
 *
 * WICHTIG (Reader filtern nach Service-CODE): custom-code-Test-Leistungen sind
 * für die Reader unsichtbar — es MÜSSEN die real geseedeten Leistungen
 * (`hauswirtschaft` / `alltagsbegleitung` / `erstberatung`) bebucht werden.
 *
 * ISOLATION je Kategorie über ein EIGENES weit in der Zukunft liegendes Jahr:
 * Reader 1 (Abrechnung) klassifiziert AUSSCHLIESSLICH über `lohnart_kategorie`,
 * und die Erstberatungs-Leistung trägt `lohnart_kategorie = 'hauswirtschaft'`.
 * Lägen HW- und EB-Termin im selben Jahr, würde der EB-Termin dort in die
 * Hauswirtschafts-Zeile gemischt und deren Satz-Assertion verfälschen. Getrennte
 * Jahre halten jede Kategorie sauber.
 */
type CategoryKey = "hauswirtschaft" | "alltagsbegleitung" | "erstberatung";

interface CategorySpec {
  key: CategoryKey;
  label: string;
  appointmentType: string;
  year: number;
  /** Reader 1 (Abrechnung) meldet Erstberatung NICHT als eigene Zeile. */
  inBillingReader: boolean;
}

const SPECS: CategorySpec[] = [
  { key: "hauswirtschaft", label: "Hauswirtschaft", appointmentType: "Kundentermin", year: 2035, inBillingReader: true },
  { key: "alltagsbegleitung", label: "Alltagsbegleitung", appointmentType: "Kundentermin", year: 2036, inBillingReader: true },
  { key: "erstberatung", label: "Erstberatung", appointmentType: "Erstberatung", year: 2037, inBillingReader: false },
];

const MONTH = 6;

interface CategoryFixture extends CategorySpec {
  apptDate: string;
  serviceId: number;
  roleWageRateId: number;
  customerPriceId: number;
  catalogRateCents: number;
  catalogPriceCents: number;
  effectiveWageCents: number;
  effectivePriceCents: number;
}

describe("Task #1546/#1551 — Reporting: Sätze effektiv aus Geld ÷ Menge (Anzeige === Buchung)", () => {
  let userId: number;
  let customerId: number;
  const fixtures = new Map<CategoryKey, CategoryFixture>();

  beforeAll(async () => {
    const auth = await getAuthCookie();
    userId = auth.user.id; // Seed-Superadmin ⇒ Lohn-Rolle 'admin'.

    const customer = await createTestCustomer({ vorname: "T1551", nachname: `Rate_${Date.now()}` });
    customerId = customer.id as number;

    for (const spec of SPECS) {
      // Reale Leistung (die Reader filtern nach Code).
      const svc = await db.execute(sql`
        SELECT id, COALESCE(default_price_cents, 0)::int AS price, COALESCE(employee_rate_cents, 0)::int AS rate
        FROM services WHERE code = ${spec.key} LIMIT 1
      `).then((r) => r.rows as Array<{ id: number; price: number; rate: number }>);
      const serviceId = svc[0].id;
      const catalogPriceCents = svc[0].price;
      const catalogRateCents = svc[0].rate;
      // Garantiert vom Katalog verschieden.
      const effectiveWageCents = catalogRateCents + 777;
      const effectivePriceCents = catalogPriceCents + 1234;

      // Rollen-Lohnsatz (admin × Leistung) für das Testjahr — spätestes valid_from
      // gewinnt, kollidiert also nicht mit anderen Suites (2025/2026).
      const roleWageRateId = await db.execute(sql`
        INSERT INTO role_wage_rates (role, service_id, cents, valid_from, valid_to, created_by_user_id)
        VALUES ('admin', ${serviceId}, ${effectiveWageCents}, ${`${spec.year}-01-01`}, ${`${spec.year}-12-31`}, ${userId})
        RETURNING id
      `).then((r) => (r.rows as Array<{ id: number }>)[0].id);

      // Kundenspezifischer Preis (≠ Katalog-Default).
      const customerPriceId = await db.execute(sql`
        INSERT INTO prices (scope, origin, customer_id, service_id, cents, valid_from, valid_to, created_by_user_id)
        VALUES ('customer', 'customer_service_prices', ${customerId}, ${serviceId}, ${effectivePriceCents}, ${`${spec.year}-01-01`}, NULL, ${userId})
        RETURNING id
      `).then((r) => (r.rows as Array<{ id: number }>)[0].id);

      // Genau EIN dokumentierter 60-Minuten-Termin (duration_promised ===
      // actual_duration_minutes, damit Kosten-Minuten === Erlös-Minuten).
      const apptDate = `${spec.year}-0${MONTH}-15`;
      const apptId = await db.execute(sql`
        INSERT INTO appointments (
          customer_id, created_by_user_id, assigned_employee_id, performed_by_employee_id,
          appointment_type, date, scheduled_start, scheduled_end, duration_promised,
          status, actual_start, actual_end, travel_origin_type, travel_kilometers,
          travel_minutes, customer_kilometers, signed_at, signed_by_user_id
        ) VALUES (
          ${customerId}, ${userId}, ${userId}, ${userId},
          ${spec.appointmentType}, ${apptDate}, '09:00', '10:00', 60,
          'completed', '09:00', '10:00', 'home', 0,
          0, 0, NOW(), ${userId}
        )
        RETURNING id
      `).then((r) => (r.rows as Array<{ id: number }>)[0].id);
      await db.execute(sql`
        INSERT INTO appointment_services
          (appointment_id, service_id, planned_duration_minutes, actual_duration_minutes, details)
        VALUES (${apptId}, ${serviceId}, 60, 60, 'T1551 fixture')
      `);

      fixtures.set(spec.key, {
        ...spec,
        apptDate,
        serviceId,
        roleWageRateId,
        customerPriceId,
        catalogRateCents,
        catalogPriceCents,
        effectiveWageCents,
        effectivePriceCents,
      });
    }
  });

  afterAll(async () => {
    await cleanupCustomer(customerId); // entfernt Termine + Kundenpreise (FK-Cascade)
    for (const f of fixtures.values()) {
      if (f.customerPriceId) await db.execute(sql`DELETE FROM prices WHERE id = ${f.customerPriceId}`);
      if (f.roleWageRateId) await db.execute(sql`DELETE FROM role_wage_rates WHERE id = ${f.roleWageRateId}`);
    }
  });

  // --- Reader 1: Abrechnung-Wirtschaftlichkeit (HW + AB; EB ist keine Zeile). --
  for (const spec of SPECS.filter((s) => s.inBillingReader)) {
    it(`Reader 1 (Abrechnung): ${spec.label} — Zeilen-Satz = effektiver Lohn/Preis, nicht Katalog`, async () => {
      const f = fixtures.get(spec.key)!;
      const billing = await readBillingEconomics(f.year, MONTH);
      const row = billing.byService.find((r) => r.key === spec.key);
      expect(row).toBeDefined();
      expect(row!.quantity).toBe(60);

      // Satz-Labels stammen aus Geld ÷ Menge (effektiv), NICHT aus dem Katalog.
      expect(row!.costRateCents).toBe(f.effectiveWageCents);
      expect(row!.costRateCents).not.toBe(f.catalogRateCents);
      expect(row!.revenueRateCents).toBe(f.effectivePriceCents);
      expect(row!.revenueRateCents).not.toBe(f.catalogPriceCents);

      // Anzeige === Buchung: Satz × Stunden === persistierte Geld-Spalte.
      expect(Math.round((row!.costRateCents * row!.quantity) / 60)).toBe(row!.costCents);
      expect(Math.round((row!.revenueRateCents * row!.quantity) / 60)).toBe(row!.revenueCents);

      // Menge 0 ⇒ kein Satz (Gemeinkosten-Zeile).
      const gk = billing.byService.find((r) => r.key === "gemeinkosten");
      expect(gk).toBeDefined();
      expect(gk!.quantity).toBe(0);
      expect(gk!.costRateCents).toBe(0);
      expect(gk!.revenueRateCents).toBe(0);
    });
  }

  // --- Reader 2: Statistik-Wirtschaftlichkeit (HW + AB + EB). ------------------
  for (const spec of SPECS) {
    it(`Reader 2 (Statistik): ${spec.label} — impliziter Kosten/h-Satz = effektiver Rollenlohn`, async () => {
      const f = fixtures.get(spec.key)!;
      const { economics } = await getEconomics(resolvePeriod({ year: f.year }));
      const p = economics.personnel[spec.key];
      expect(p.minutes).toBe(60);
      // Die Kosten sind bereits rollenbasiert (Task #1503) ⇒ der abgeleitete
      // Anzeige-Satz (Kosten/h) muss dem Rollenlohn entsprechen, nicht dem Katalog.
      expect(p.costCents).toBe(f.effectiveWageCents);
      expect(Math.round((p.costCents * 60) / p.minutes)).toBe(f.effectiveWageCents);
      expect(f.effectiveWageCents).not.toBe(f.catalogRateCents);
    });
  }

  // --- Reader 3: Performance-Kalkulationsgrundlage (HW + AB + EB). -------------
  for (const spec of SPECS) {
    it(`Reader 3 (Performance): ${spec.label} — Erlös/h + Lohn/h effektiv, nicht Katalog`, async () => {
      const f = fixtures.get(spec.key)!;
      const perf = await getPerformanceStats(resolvePeriod({ year: f.year }));
      const row = perf.profitability.servicePrices.find((s) => s.code === spec.key);
      expect(row).toBeDefined();

      // Lohn/h = effektiver Rollenlohn, Erlös/h = kundenspezifischer Preis.
      expect(row!.rateCents).toBe(f.effectiveWageCents);
      expect(row!.rateCents).not.toBe(f.catalogRateCents);
      expect(row!.priceCents).toBe(f.effectivePriceCents);
      expect(row!.priceCents).not.toBe(f.catalogPriceCents);

      // Marge folgt konsistent aus den effektiven Sätzen.
      expect(row!.marginCents).toBe(f.effectivePriceCents - f.effectiveWageCents);
    });
  }
});
