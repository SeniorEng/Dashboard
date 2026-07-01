import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../server/lib/db";
import { getAuthCookie, createTestCustomer, cleanupCustomer } from "./test-utils";
import { getPerformanceStats } from "../server/storage/statistics/performance";
import { getEconomics, listNonBillableHours } from "../server/storage/statistics/economics";
import { readBillingEconomics } from "../server/storage/billing/economics-reader";
import { resolvePeriod } from "../server/storage/statistics/common";
import { quantizeKm } from "../shared/domain/invoice-line-items";

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

/**
 * Task #1552 — Anzeige-vs-Buchung für die KILOMETER-Satz-Labels im Reporting.
 *
 * Die drei Hours-Kategorien (Task #1546/#1551, oben) sind gegen Katalog-vs-
 * Effektiv-Drift des ANGEZEIGTEN Stundensatzes abgesichert. Dieselben Reader
 * zeigen aber auch eine „Kilometer"-Zeile mit per-km-Satz-Labels (berechneter
 * km-Preis vs. ausgezahlter km-Lohn) — dafür fehlte bislang JEDE Drift-Absi-
 * cherung. Eine künftige Änderung an der km-Satz-Auflösung könnte die Katalog-
 * vs-Effektiv-Drift für Kilometer still wieder einführen, ohne dass ein Test
 * bricht.
 *
 * Diese Suite bucht km in einem isolierten, weit entfernten Jahr und setzt für
 * den KOSTEN-Pfad einen rollenbasierten km-Lohnsatz (`role_wage_rates`), der
 * bewusst vom flachen Katalog-km-Satz (`services.employee_rate_cents`) abweicht.
 * Sie prüft, dass die Reader den EFFEKTIVEN Satz (Geld ÷ km) zeigen, dass
 * Satz × km === die jeweilige Geld-Spalte gilt und dass km 0 ⇒ Satz 0.
 *
 * Für die ERLÖS-Seite gibt es bei km KEINEN kundenspezifischen Preis-Pfad — der
 * berechnete km-Preis stammt immer aus dem Katalog (`default_price_cents`). Die
 * Erlös-Assertion prüft daher nur „Satz === Geld ÷ km" (nicht ≠ Katalog).
 *
 * ISOLATION je km-Typ über einen EIGENEN Monat: Reader 1 (Abrechnung) fasst
 * Anfahrts-, Kunden- und Zeiterfassungs-km in EINER gemischten „Kilometer"-Zeile
 * zusammen. Lägen unterschiedliche km-Sätze im selben Monat, wäre der gemischte
 * Zeilen-Satz ein Blend und die Einzel-Satz-Assertion nicht mehr sauber prüfbar.
 * Getrennte Monate halten jede km-Zeile bei genau einem Satz.
 */
describe("Task #1552 — Reporting: km-Satz effektiv aus Geld ÷ km (Anzeige === Buchung)", () => {
  const KM_YEAR = 2040;
  const TRAVEL_MONTH = 6; // Nur Anfahrts-km.
  const CUSTOMER_MONTH = 7; // Nur Kunden-km.
  const EMPTY_MONTH = 8; // Ohne km.
  const TRAVEL_KM = 10; // Ganzzahlig ⇒ quantizeKm exakt ⇒ Satz × km === Geld.
  const CUSTOMER_KM = 8;

  let userId: number;
  let customerId: number;
  let travelKmWageId = 0;
  let customerKmWageId = 0;
  let catalogTravelRateCents = 0;
  let catalogTravelPriceCents = 0;
  let catalogCustomerRateCents = 0;
  let catalogCustomerPriceCents = 0;
  let effectiveTravelWageCents = 0;
  let effectiveCustomerWageCents = 0;

  const insertKmAppointment = async (dateIso: string, travelKm: number, customerKm: number) => {
    await db.execute(sql`
      INSERT INTO appointments (
        customer_id, created_by_user_id, assigned_employee_id, performed_by_employee_id,
        appointment_type, date, scheduled_start, scheduled_end, duration_promised,
        status, actual_start, actual_end, travel_origin_type, travel_kilometers,
        travel_minutes, customer_kilometers, signed_at, signed_by_user_id
      ) VALUES (
        ${customerId}, ${userId}, ${userId}, ${userId},
        'Kundentermin', ${dateIso}, '09:00', '10:00', 60,
        'completed', '09:00', '10:00', 'home', ${travelKm},
        0, ${customerKm}, NOW(), ${userId}
      )
    `);
  };

  beforeAll(async () => {
    const auth = await getAuthCookie();
    userId = auth.user.id; // Seed-Superadmin ⇒ Lohn-Rolle 'admin'.

    const customer = await createTestCustomer({ vorname: "T1552", nachname: `Km_${Date.now()}` });
    customerId = customer.id as number;

    // Reale km-Leistungen (die Reader filtern nach Code).
    const svc = await db.execute(sql`
      SELECT code, id, COALESCE(default_price_cents, 0)::int AS price, COALESCE(employee_rate_cents, 0)::int AS rate
      FROM services WHERE code IN ('travel_km','customer_km')
    `).then((r) => r.rows as Array<{ code: string; id: number; price: number; rate: number }>);
    const travel = svc.find((s) => s.code === "travel_km")!;
    const customerKmSvc = svc.find((s) => s.code === "customer_km")!;
    catalogTravelRateCents = travel.rate;
    catalogTravelPriceCents = travel.price;
    catalogCustomerRateCents = customerKmSvc.rate;
    catalogCustomerPriceCents = customerKmSvc.price;
    // Garantiert vom Katalog-km-Satz verschieden.
    effectiveTravelWageCents = catalogTravelRateCents + 37;
    effectiveCustomerWageCents = catalogCustomerRateCents + 53;

    // Rollen-km-Lohnsatz (admin × km-Leistung) für das Testjahr — spätestes
    // valid_from gewinnt, kollidiert also nicht mit anderen Suites.
    travelKmWageId = await db.execute(sql`
      INSERT INTO role_wage_rates (role, service_id, cents, valid_from, valid_to, created_by_user_id)
      VALUES ('admin', ${travel.id}, ${effectiveTravelWageCents}, ${`${KM_YEAR}-01-01`}, ${`${KM_YEAR}-12-31`}, ${userId})
      RETURNING id
    `).then((r) => (r.rows as Array<{ id: number }>)[0].id);
    customerKmWageId = await db.execute(sql`
      INSERT INTO role_wage_rates (role, service_id, cents, valid_from, valid_to, created_by_user_id)
      VALUES ('admin', ${customerKmSvc.id}, ${effectiveCustomerWageCents}, ${`${KM_YEAR}-01-01`}, ${`${KM_YEAR}-12-31`}, ${userId})
      RETURNING id
    `).then((r) => (r.rows as Array<{ id: number }>)[0].id);

    // Ein km-Termin je Typ in getrennten Monaten (kein km-Satz-Blend in Reader 1).
    await insertKmAppointment(`${KM_YEAR}-0${TRAVEL_MONTH}-15`, TRAVEL_KM, 0);
    await insertKmAppointment(`${KM_YEAR}-0${CUSTOMER_MONTH}-15`, 0, CUSTOMER_KM);
  });

  afterAll(async () => {
    await cleanupCustomer(customerId); // entfernt Termine (FK-Cascade)
    if (travelKmWageId) await db.execute(sql`DELETE FROM role_wage_rates WHERE id = ${travelKmWageId}`);
    if (customerKmWageId) await db.execute(sql`DELETE FROM role_wage_rates WHERE id = ${customerKmWageId}`);
  });

  // --- Reader 1: Abrechnung-Wirtschaftlichkeit — „Kilometer"-Zeile. -----------
  it("Reader 1 (Abrechnung): Anfahrts-km — Kosten-Satz = effektiver Rollenlohn, nicht Katalog", async () => {
    const billing = await readBillingEconomics(KM_YEAR, TRAVEL_MONTH);
    const row = billing.byService.find((r) => r.key === "kilometer");
    expect(row).toBeDefined();
    expect(row!.unit).toBe("km");
    expect(row!.quantity).toBe(TRAVEL_KM);

    // Kosten-Satz je km stammt aus Geld ÷ km (effektiver Rollenlohn), NICHT Katalog.
    expect(row!.costRateCents).toBe(effectiveTravelWageCents);
    expect(row!.costRateCents).not.toBe(catalogTravelRateCents);
    expect(Math.round(row!.costCents / row!.quantity)).toBe(row!.costRateCents);
    expect(row!.costRateCents * quantizeKm(row!.quantity)).toBe(row!.costCents);

    // Erlös-Satz ebenfalls aus Geld ÷ km (km-Erlös nutzt den Katalog-km-Preis).
    expect(row!.revenueRateCents).toBe(catalogTravelPriceCents);
    expect(Math.round(row!.revenueCents / row!.quantity)).toBe(row!.revenueRateCents);
    expect(row!.revenueRateCents * quantizeKm(row!.quantity)).toBe(row!.revenueCents);
  });

  it("Reader 1 (Abrechnung): Kunden-km — Kosten-Satz = effektiver Rollenlohn, nicht Katalog", async () => {
    const billing = await readBillingEconomics(KM_YEAR, CUSTOMER_MONTH);
    const row = billing.byService.find((r) => r.key === "kilometer");
    expect(row).toBeDefined();
    expect(row!.unit).toBe("km");
    expect(row!.quantity).toBe(CUSTOMER_KM);

    expect(row!.costRateCents).toBe(effectiveCustomerWageCents);
    expect(row!.costRateCents).not.toBe(catalogCustomerRateCents);
    expect(Math.round(row!.costCents / row!.quantity)).toBe(row!.costRateCents);
    expect(row!.costRateCents * quantizeKm(row!.quantity)).toBe(row!.costCents);

    expect(row!.revenueRateCents).toBe(catalogCustomerPriceCents);
    expect(Math.round(row!.revenueCents / row!.quantity)).toBe(row!.revenueRateCents);
    expect(row!.revenueRateCents * quantizeKm(row!.quantity)).toBe(row!.revenueCents);
  });

  it("Reader 1 (Abrechnung): ohne km ⇒ km-Satz 0", async () => {
    const billing = await readBillingEconomics(KM_YEAR, EMPTY_MONTH);
    const row = billing.byService.find((r) => r.key === "kilometer");
    expect(row).toBeDefined();
    expect(row!.quantity).toBe(0);
    expect(row!.costRateCents).toBe(0);
    expect(row!.revenueRateCents).toBe(0);
  });

  // --- Reader 2: Statistik-Wirtschaftlichkeit — km-Zeilen (travel/customer). ---
  it("Reader 2 (Statistik): km-Zeilen — impliziter km-Satz = effektiver Rollenlohn, nicht Katalog", async () => {
    const { economics } = await getEconomics(resolvePeriod({ year: KM_YEAR }));

    // Anfahrts-km: bezahlt = effektiver Rollenlohn × km (Geld ÷ km ⇒ effektiv).
    expect(economics.km.travel.km).toBe(TRAVEL_KM);
    expect(economics.km.travel.paidCents).toBe(effectiveTravelWageCents * TRAVEL_KM);
    expect(Math.round(economics.km.travel.paidCents / economics.km.travel.km)).toBe(effectiveTravelWageCents);
    expect(effectiveTravelWageCents).not.toBe(catalogTravelRateCents);
    expect(economics.km.travel.chargedCents).toBe(catalogTravelPriceCents * TRAVEL_KM);

    // Kunden-km: analog mit eigenem Rollenlohn.
    expect(economics.km.customer.km).toBe(CUSTOMER_KM);
    expect(economics.km.customer.paidCents).toBe(effectiveCustomerWageCents * CUSTOMER_KM);
    expect(Math.round(economics.km.customer.paidCents / economics.km.customer.km)).toBe(effectiveCustomerWageCents);
    expect(effectiveCustomerWageCents).not.toBe(catalogCustomerRateCents);
    expect(economics.km.customer.chargedCents).toBe(catalogCustomerPriceCents * CUSTOMER_KM);
  });
});

/**
 * Task #1553 — Anzeige-vs-Buchung für die DRITTE km-Fläche: Mitarbeiter-km aus
 * der Zeiterfassung (`economics.km.timeEntry`).
 *
 * Task #1552 (oben) sichert die beiden TERMIN-basierten km-Typen (Anfahrts-/
 * Kunden-km) gegen Katalog-vs-Effektiv-Drift des ausgezahlten km-Lohns ab. Die
 * dritte km-Quelle — Mitarbeiter-km aus der Zeiterfassung — blieb ungeprüft.
 * Sie ist eine reine KOSTEN-Zeile: der Lohn wird dem Mitarbeiter gezahlt, dem
 * Kunden aber NIE berechnet (kein Termin-Bezug), und bewertet über den
 * effektiven, rollenbasierten km-Lohnsatz der `travel_km`-Leistung
 * (`role_wage_rates`), nicht den flachen Katalog-km-Satz
 * (`services.employee_rate_cents`).
 *
 * Eine künftige Änderung an der km-Lohn-Auflösung könnte die Zeiterfassungs-km
 * still auf den Katalog-Satz zurückfallen lassen, ohne dass ein Test bricht.
 * Diese Suite bucht Mitarbeiter-km in einem isolierten, weit entfernten Jahr,
 * setzt einen `travel_km`-Rollenlohn ≠ Katalog und prüft:
 *   - `paidCents` === effektiver Rollenlohn × km (Geld ÷ km ⇒ effektiv),
 *   - `paidCents / km` rundet auf den effektiven (nicht Katalog-) Satz zurück,
 *   - die Zeile hat KEINE Erlös-/Berechnungs-Seite (`chargedCents === 0`).
 */
describe("Task #1553 — Reporting: Zeiterfassungs-km-Lohn effektiv aus Geld ÷ km (nur Kostenseite)", () => {
  const TE_YEAR = 2041; // Eigenes, weit entferntes Jahr ⇒ keine Vermischung mit anderen Suites.
  const TE_MONTH = 6;
  const TE_KM = 12; // Ganzzahlig ⇒ quantizeKm exakt ⇒ Satz × km === Geld.

  let userId: number;
  let travelKmServiceId = 0;
  let travelKmWageId = 0;
  let timeEntryId = 0;
  let catalogTravelRateCents = 0;
  let effectiveTravelWageCents = 0;

  beforeAll(async () => {
    const auth = await getAuthCookie();
    userId = auth.user.id; // Seed-Superadmin ⇒ Lohn-Rolle 'admin'.

    // Reale km-Leistung (der Reader löst den Zeiterfassungs-km-Lohn über
    // `travel_km` auf).
    const svc = await db.execute(sql`
      SELECT id, COALESCE(employee_rate_cents, 0)::int AS rate
      FROM services WHERE code = 'travel_km' LIMIT 1
    `).then((r) => r.rows as Array<{ id: number; rate: number }>);
    travelKmServiceId = svc[0].id;
    catalogTravelRateCents = svc[0].rate;
    // Garantiert vom Katalog-km-Satz verschieden.
    effectiveTravelWageCents = catalogTravelRateCents + 41;

    // Rollen-km-Lohnsatz (admin × travel_km) für das Testjahr — spätestes
    // valid_from gewinnt, kollidiert also nicht mit anderen Suites.
    travelKmWageId = await db.execute(sql`
      INSERT INTO role_wage_rates (role, service_id, cents, valid_from, valid_to, created_by_user_id)
      VALUES ('admin', ${travelKmServiceId}, ${effectiveTravelWageCents}, ${`${TE_YEAR}-01-01`}, ${`${TE_YEAR}-12-31`}, ${userId})
      RETURNING id
    `).then((r) => (r.rows as Array<{ id: number }>)[0].id);

    // Genau EIN Zeiterfassungs-Eintrag mit Mitarbeiter-km im isolierten Jahr.
    timeEntryId = await db.execute(sql`
      INSERT INTO employee_time_entries
        (user_id, entry_type, entry_date, duration_minutes, kilometers, is_full_day)
      VALUES (${userId}, 'vertrieb', ${`${TE_YEAR}-0${TE_MONTH}-15`}, 60, ${TE_KM}, false)
      RETURNING id
    `).then((r) => (r.rows as Array<{ id: number }>)[0].id);
  });

  afterAll(async () => {
    if (timeEntryId) await db.execute(sql`DELETE FROM employee_time_entries WHERE id = ${timeEntryId}`);
    if (travelKmWageId) await db.execute(sql`DELETE FROM role_wage_rates WHERE id = ${travelKmWageId}`);
  });

  it("Reader 2 (Statistik): Zeiterfassungs-km — Lohn = effektiver Rollenlohn × km, nicht Katalog", async () => {
    const { economics } = await getEconomics(resolvePeriod({ year: TE_YEAR }));

    expect(economics.km.timeEntry.km).toBe(TE_KM);

    // Bezahlt = effektiver Rollenlohn × km (Geld ÷ km ⇒ effektiv), NICHT Katalog.
    expect(economics.km.timeEntry.paidCents).toBe(effectiveTravelWageCents * TE_KM);
    expect(Math.round(economics.km.timeEntry.paidCents / economics.km.timeEntry.km)).toBe(effectiveTravelWageCents);
    expect(effectiveTravelWageCents).not.toBe(catalogTravelRateCents);
    expect(economics.km.timeEntry.paidCents).not.toBe(catalogTravelRateCents * TE_KM);

    // Kosten-only: Zeiterfassungs-km werden dem Kunden NIE berechnet.
    expect(economics.km.timeEntry.chargedCents).toBe(0);
  });
});

/**
 * Task #1554 — Anzeige-vs-Buchung für den NICHT-ABRECHENBARE-STUNDEN-Export
 * (Drill-down / CSV) — `listNonBillableHours`.
 *
 * Der Wirtschaftlichkeits-Überblick (Reader 2, oben) ist gegen Katalog-vs-
 * Effektiv-Drift des rollenbasierten Nicht-abrechenbar-Lohns abgesichert. Der
 * gleichnamige Drill-down/CSV-Export (`listNonBillableHours`) berechnet die
 * Kosten je Mitarbeiter × Kategorie über DIESELBE rollenbasierte Lohn-Auflösung
 * (`resolvedWageCentsSql` gegen die `hauswirtschaft`-Leistung), war aber bislang
 * durch KEINEN Test gegen ein stilles Zurückfallen auf den flachen Katalog-Satz
 * (`services.employee_rate_cents`) geschützt. Eine künftige Änderung an der
 * Lohn-Auflösung könnte die exportierten Kosten unbemerkt auf den Katalog-Satz
 * driften lassen, ohne dass ein Test bricht.
 *
 * Diese Suite bucht nicht-abrechenbare Zeiterfassungs-Einträge (bueroarbeit/
 * vertrieb) in einem isolierten, weit entfernten Jahr für einen Mitarbeiter und
 * setzt einen `hauswirtschaft`-Rollenlohn (`role_wage_rates`), der bewusst vom
 * flachen Katalog-Satz abweicht. Sie prüft je Drill-down-Zeile:
 *   - `costCents` === effektiver Rollenlohn × Stunden (Minuten/60),
 *   - `costCents` !== Katalog-Satz × Stunden,
 *   - `costCents / Minuten` rundet auf den effektiven (nicht Katalog-) Satz.
 */
describe("Task #1554 — Reporting: Nicht-abrechenbar-Export Lohn effektiv aus Geld ÷ Std (nicht Katalog)", () => {
  const NB_YEAR = 2042; // Eigenes, weit entferntes Jahr ⇒ keine Vermischung mit anderen Suites.
  const NB_MONTH = 6;
  const BUERO_MINUTES = 120; // 2 Std ⇒ Katalog-vs-Effektiv-Differenz klar sichtbar.
  const VERTRIEB_MINUTES = 60; // 1 Std.

  let userId: number;
  let hauswirtschaftServiceId = 0;
  let hwWageId = 0;
  const timeEntryIds: number[] = [];
  let catalogHwRateCents = 0;
  let effectiveHwWageCents = 0;

  beforeAll(async () => {
    const auth = await getAuthCookie();
    userId = auth.user.id; // Seed-Superadmin ⇒ Lohn-Rolle 'admin'.

    // Reale HW-Leistung (der Export löst den Nicht-abrechenbar-Lohn über
    // `hauswirtschaft` auf).
    const svc = await db.execute(sql`
      SELECT id, COALESCE(employee_rate_cents, 0)::int AS rate
      FROM services WHERE code = 'hauswirtschaft' LIMIT 1
    `).then((r) => r.rows as Array<{ id: number; rate: number }>);
    hauswirtschaftServiceId = svc[0].id;
    catalogHwRateCents = svc[0].rate;
    // Garantiert vom Katalog-Satz verschieden.
    effectiveHwWageCents = catalogHwRateCents + 613;

    // Rollen-Lohnsatz (admin × hauswirtschaft) für das Testjahr — spätestes
    // valid_from gewinnt, kollidiert also nicht mit anderen Suites.
    hwWageId = await db.execute(sql`
      INSERT INTO role_wage_rates (role, service_id, cents, valid_from, valid_to, created_by_user_id)
      VALUES ('admin', ${hauswirtschaftServiceId}, ${effectiveHwWageCents}, ${`${NB_YEAR}-01-01`}, ${`${NB_YEAR}-12-31`}, ${userId})
      RETURNING id
    `).then((r) => (r.rows as Array<{ id: number }>)[0].id);

    // Zwei nicht-abrechenbare Einträge (verschiedene Kategorien ⇒ zwei Zeilen).
    for (const [entryType, minutes] of [["bueroarbeit", BUERO_MINUTES], ["vertrieb", VERTRIEB_MINUTES]] as const) {
      const id = await db.execute(sql`
        INSERT INTO employee_time_entries
          (user_id, entry_type, entry_date, duration_minutes, kilometers, is_full_day)
        VALUES (${userId}, ${entryType}, ${`${NB_YEAR}-0${NB_MONTH}-15`}, ${minutes}, 0, false)
        RETURNING id
      `).then((r) => (r.rows as Array<{ id: number }>)[0].id);
      timeEntryIds.push(id);
    }
  });

  afterAll(async () => {
    for (const id of timeEntryIds) await db.execute(sql`DELETE FROM employee_time_entries WHERE id = ${id}`);
    if (hwWageId) await db.execute(sql`DELETE FROM role_wage_rates WHERE id = ${hwWageId}`);
  });

  it("Drill-down/CSV: Kosten je Zeile = effektiver Rollenlohn × Std, nicht Katalog", async () => {
    const rows = await listNonBillableHours(resolvePeriod({ year: NB_YEAR }));
    const mine = rows.filter((row) => row.employeeId === userId);

    // Katalog ≠ Effektiv (sonst prüft der Test nichts).
    expect(effectiveHwWageCents).not.toBe(catalogHwRateCents);

    for (const [category, minutes] of [["bueroarbeit", BUERO_MINUTES], ["vertrieb", VERTRIEB_MINUTES]] as const) {
      const row = mine.find((r) => r.category === category);
      expect(row).toBeDefined();
      expect(row!.minutes).toBe(minutes);

      // Kosten = effektiver Rollenlohn × Std (Geld ÷ Minuten ⇒ effektiv), NICHT Katalog.
      expect(row!.costCents).toBe(Math.round((effectiveHwWageCents * minutes) / 60));
      expect(row!.costCents).not.toBe(Math.round((catalogHwRateCents * minutes) / 60));

      // Rück-Ableitung: Kosten ÷ Std rundet auf den effektiven (nicht Katalog-) Satz.
      expect(Math.round((row!.costCents * 60) / row!.minutes)).toBe(effectiveHwWageCents);
    }
  });
});
