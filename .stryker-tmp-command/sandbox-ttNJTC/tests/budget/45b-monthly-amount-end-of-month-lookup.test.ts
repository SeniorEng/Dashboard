/**
 * Task #668 — §45b-Monatsaufstockung darf bei `validFrom > 15.` nicht verschwinden.
 *
 * Hintergrund: `calculateAllocated45b` schlägt pro iteriertem Monat die zum
 * Monat gültige `customer_budget_type_settings`-Zeile nach. Bis #668 nutzte
 * der Lookup einen Mitte-des-Monats-Stichtag (`YYYY-MM-15`). Damit fielen
 * Settings-Wechsel, die erst NACH dem 15. greifen, für den aktuellen Monat
 * heraus — der Bug aus dem Prod-Fall „Jack Finley Kretlow": Übertrag aus
 * dem Vorjahr wurde angezeigt, die Mai-Aufstockung fehlte komplett.
 *
 * Der Fix vergleicht gegen das **Monatsende**. Dieser Test sichert die drei
 * im Task beschriebenen Szenarien gegen Regressionen ab:
 *   1. Frisch angelegt mit `validFrom = heute (>15.)` → Aufstockung enthalten.
 *   2. Append-only-Transition mit `validFrom = morgen` → Aufstockung enthalten.
 *   3. Lookup fällt nie auf 0 zurück, solange irgendeine §45b-Zeile mit
 *      konfiguriertem `monthlyLimitCents` den Monat überlappt.
 */
// @ts-nocheck

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { customerBudgetTypeSettings } from "@shared/schema";
import { calculateAllocatedCents } from "../../server/storage/budget/allocation-storage";
import { createTestCustomer, getAuthCookie, runCleanup } from "../test-utils";

const ORIGINAL_TZ = process.env.TZ;

beforeAll(async () => {
  process.env.TZ = "Europe/Berlin";
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

async function freshCustomer(prefix: string): Promise<number> {
  const c = await createTestCustomer({
    vorname: prefix,
    nachname: `T668_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    pflegegrad: 3,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  return c.id as number;
}

async function clear45bSettings(customerId: number): Promise<void> {
  await db.delete(customerBudgetTypeSettings).where(and(
    eq(customerBudgetTypeSettings.customerId, customerId),
    eq(customerBudgetTypeSettings.budgetType, "entlastungsbetrag_45b"),
  ));
}

// Mai 2026 enthält den 27. und 31. — perfekter Repro-Monat für den Bug
// (Stichtag 2026-05-15 würde validFrom=2026-05-27 verfehlen).
const REPRO_AS_OF = "2026-05-31";
const REPRO_YEAR = 2026;
const MAY_ANTEIL_CENTS = 6550; // €65,50 — Wert aus dem Prod-Repro

describe("Task #668 — §45b monthlyAmountFor: Monatsende-Lookup statt Mitte-des-Monats", () => {
  it("Szenario 1: frisch angelegt mit validFrom = 27. des Monats → Mai-Aufstockung im Summary enthalten", async () => {
    const customerId = await freshCustomer("T668-FRESH");
    await clear45bSettings(customerId);

    await db.insert(customerBudgetTypeSettings).values({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      enabled: true,
      priority: 1,
      monthlyLimitCents: MAY_ANTEIL_CENTS,
      yearlyLimitCents: null,
      validFrom: "2026-05-27",
      validTo: null,
    });

    const yearAllocated = await calculateAllocatedCents(
      customerId,
      "entlastungsbetrag_45b",
      { year: REPRO_YEAR },
    );

    expect(yearAllocated).toBe(MAY_ANTEIL_CENTS);

    const totalAllocated = await calculateAllocatedCents(
      customerId,
      "entlastungsbetrag_45b",
      { asOfDate: REPRO_AS_OF },
    );
    expect(totalAllocated).toBe(MAY_ANTEIL_CENTS);
  });

  it("Szenario 2: Transition (alt geschlossen heute, neu validFrom=morgen) — Mai fällt nicht heraus", async () => {
    const customerId = await freshCustomer("T668-TRANS");
    await clear45bSettings(customerId);

    // Repro der append-only-Transition: alte Zeile mit altem validFrom,
    // geschlossen mitten im Mai; neue Zeile mit validFrom = Folgetag,
    // gesetztem „Unser Anteil".
    await db.insert(customerBudgetTypeSettings).values([
      {
        customerId,
        budgetType: "entlastungsbetrag_45b",
        enabled: true,
        priority: 1,
        monthlyLimitCents: null,
        yearlyLimitCents: null,
        validFrom: "2026-01-01",
        validTo: "2026-05-27",
      },
      {
        customerId,
        budgetType: "entlastungsbetrag_45b",
        enabled: true,
        priority: 1,
        monthlyLimitCents: MAY_ANTEIL_CENTS,
        yearlyLimitCents: null,
        validFrom: "2026-05-28",
        validTo: null,
      },
    ]);

    const yearAllocated = await calculateAllocatedCents(
      customerId,
      "entlastungsbetrag_45b",
      { year: REPRO_YEAR },
    );

    // Jan–Apr: alte Zeile (monthlyLimit=null) → gesetzlicher Default 131 €.
    // Mai: neue Zeile (6550 ct). Summe = 4×13100 + 6550 = 58950.
    expect(yearAllocated).toBe(4 * 13100 + MAY_ANTEIL_CENTS);
  });

  it("Szenario 3: Lookup fällt nie auf 0 zurück, solange eine §45b-Zeile den Monat überlappt", async () => {
    const customerId = await freshCustomer("T668-FALLBACK");
    await clear45bSettings(customerId);

    // Zeile nur in Mai 2026 gültig (validFrom 27., validTo 31.), mit Anteil.
    await db.insert(customerBudgetTypeSettings).values({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      enabled: true,
      priority: 1,
      monthlyLimitCents: MAY_ANTEIL_CENTS,
      yearlyLimitCents: null,
      validFrom: "2026-05-27",
      validTo: "2026-05-31",
    });

    const yearAllocated = await calculateAllocatedCents(
      customerId,
      "entlastungsbetrag_45b",
      { year: REPRO_YEAR },
    );

    expect(yearAllocated).toBe(MAY_ANTEIL_CENTS);
    expect(yearAllocated).not.toBe(0);
  });
});
