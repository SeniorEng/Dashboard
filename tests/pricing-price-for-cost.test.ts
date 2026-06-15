import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { apiGet, apiPost, getFutureDate, createTestCustomer, cleanupCustomer } from "./test-utils";
import { calculateAppointmentCost } from "../server/storage/budget/appointment-cost-calculator";

/**
 * Task #1291 (Phase 3.3) — Server-Regression: der gebuchte Termin-Preis läuft
 * durch die `priceFor`-SSoT (`loadCustomerPriceContext` →
 * `calculateAppointmentCost`). Alrik-Constraint #1 + #0: Die EXISTENZ einer
 * Kunden-Preiszeile gewinnt gegen Standard/Default — auch bei `priceCents = 0`.
 * Kein `||`/`value > 0`-Kurzschluss darf 0 in den Default umkippen.
 *
 * Diese Tests sind bewusst Schattenmodus-UNABHÄNGIG: sie prüfen das reale
 * Buchungsverhalten der verdrahteten SSoT, nicht den Diff-Report.
 */
let hauswirtschaftId: number;
const DEFAULT_HAUSWIRTSCHAFT_CENTS = 3800; // shared/config/services.ts

describe("Task #1291 — priceFor-SSoT im Termin-Kostenpfad", () => {
  let zeroOverrideCustomerId: number;
  let noOverrideCustomerId: number;
  const priceDate = getFutureDate(60);

  beforeAll(async () => {
    const { status, data } = await apiGet<any[]>("/api/services");
    expect(status).toBe(200);
    const hw = data.find((s) => s.code === "hauswirtschaft");
    expect(hw, "Katalog-Leistung 'hauswirtschaft' muss vorhanden sein").toBeDefined();
    hauswirtschaftId = hw.id;

    const zeroCust = await createTestCustomer();
    zeroOverrideCustomerId = zeroCust.id;
    const noCust = await createTestCustomer();
    noOverrideCustomerId = noCust.id;

    // 0-Override (kostenlose Leistung für DIESEN Kunden) ab `priceDate`.
    const ovr = await apiPost<any>(`/api/customers/${zeroOverrideCustomerId}/service-prices`, {
      serviceId: hauswirtschaftId,
      priceCents: 0,
      validFrom: priceDate,
    });
    expect(ovr.status).toBe(200);
    expect(ovr.data.priceCents).toBe(0);
  });

  afterAll(async () => {
    await cleanupCustomer(zeroOverrideCustomerId);
    await cleanupCustomer(noOverrideCustomerId);
  });

  it("Kunden-Override = 0 ⇒ priceFor liefert 0, NICHT den Standard/Default", async () => {
    const cost = await calculateAppointmentCost({
      customerId: zeroOverrideCustomerId,
      hauswirtschaftMinutes: 60,
      alltagsbegleitungMinutes: 0,
      travelKilometers: 0,
      customerKilometers: 0,
      date: priceDate,
    });
    expect(cost.hauswirtschaftCents).toBe(0);
    expect(cost.totalCents).toBe(0);
  });

  it("Gegenprobe: kein Override ⇒ priceFor fällt auf den Katalog-Default", async () => {
    const cost = await calculateAppointmentCost({
      customerId: noOverrideCustomerId,
      hauswirtschaftMinutes: 60,
      alltagsbegleitungMinutes: 0,
      travelKilometers: 0,
      customerKilometers: 0,
      date: priceDate,
    });
    expect(cost.hauswirtschaftCents).toBe(DEFAULT_HAUSWIRTSCHAFT_CENTS);
    expect(cost.totalCents).toBe(DEFAULT_HAUSWIRTSCHAFT_CENTS);
  });
});
