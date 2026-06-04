/**
 * Task #696 (Bug 2) — §45b "Gesamt zugewiesen" darf den Vorjahresmonat nicht
 * doppelt zählen, wenn bereits eine Carryover-Allokation für das aktuelle
 * Jahr existiert.
 *
 * Prod-Fall „Schröder" (27.05.2026):
 *   - Carryover 344,50 € aus 2025 → Zeile mit `source='carryover'`,
 *     `year=2026`, `validFrom=2026-01-01`, `expiresAt=2026-06-30`.
 *   - `customer_budget_preferences.budget_start_date = 2025-12-15`
 *     (Onboarding fand im Dezember statt).
 *   - §45b aktiv ohne expliziten Monats-Anteil → gesetzliche 131 €/Monat.
 *
 * Vor dem Fix lief `calculateAllocated45b` von Dez 2025 bis Mai 2026 = 6
 * Monate × 131 € = 786 € + Carryover 344,50 € = 1130,50 €. Dezember 2025
 * wurde damit zweimal gezählt: einmal als monthly_auto, einmal — als
 * Bestandteil — im Carryover-Restguthaben.
 *
 * Nach dem Fix wird `allocStart` auf den 1. Januar des spätesten gezählten
 * Carryover-Zieljahrs vorgeschoben (hier: 2026-01). Loop = Jan..Mai 2026 =
 * 5 × 131 € = 655 €, plus 344,50 € Carryover → 999,50 €.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { customerBudgetTypeSettings } from "@shared/schema";
import {
  calculateAllocatedCents,
  upsertCarryoverAllocation,
} from "../../server/storage/budget/allocation-storage";
import { upsertBudgetPreferences } from "../../server/storage/budget/preferences-storage";
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

async function fresh45bCustomerWithoutAutoSettings(prefix: string): Promise<number> {
  const c = await createTestCustomer({
    vorname: prefix,
    nachname: `T696_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    pflegegrad: 3,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  const customerId = c.id as number;
  // Auto-angelegte Settings-Zeilen (aus dem Wizard) wegräumen — der Test
  // setzt seine §45b-Konfiguration explizit unten.
  await db.delete(customerBudgetTypeSettings).where(
    eq(customerBudgetTypeSettings.customerId, customerId),
  );
  return customerId;
}

describe("Task #696 (Bug 2) — §45b: kein Doppelzähl-Drift durch Vorjahres-Monatslauf bei Carryover", () => {
  it("Schröder-Repro: Dez-Budgetstart + Carryover 2026 ⇒ Mai 2026 = 5×131 + 344,50 € (NICHT 6×131)", async () => {
    const customerId = await fresh45bCustomerWithoutAutoSettings("T696-SCHROEDER");

    // §45b aktiv, kein „Unser Anteil" → gesetzliche 13100 ct/Monat als Fallback.
    await db.insert(customerBudgetTypeSettings).values({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      enabled: true,
      priority: 1,
      monthlyLimitCents: null,
      yearlyLimitCents: null,
      // validFrom NULL = „gilt rückwirkend", analog zur Erstanlage des Wizards.
      validFrom: null,
      validTo: null,
    });

    // Budget-Start im Vorjahr (Dezember 2025) — entspricht der Prod-Konstellation.
    await upsertBudgetPreferences({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      monthlyLimitCents: null,
      budgetStartDate: "2025-12-15",
    });

    // Carryover 344,50 € aus 2025 (Zieljahr 2026, validFrom 2026-01-01,
    // expiresAt 2026-06-30 — siehe `upsertCarryoverAllocation`).
    await upsertCarryoverAllocation(
      { customerId, budgetType: "entlastungsbetrag_45b", sourceYear: 2025, amountCents: 34_450 },
    );

    const totalAllocated = await calculateAllocatedCents(
      customerId,
      "entlastungsbetrag_45b",
      { asOfDate: "2026-05-27" },
    );

    // Erwartet: Jan..Mai 2026 = 5 × 13100 = 65500, plus 34450 Carryover = 99950.
    // Vor dem Fix: zusätzlich Dez 2025 = 6 × 13100 = 78600, plus 34450 = 113050.
    expect(totalAllocated).toBe(5 * 13_100 + 34_450);
    expect(totalAllocated).not.toBe(6 * 13_100 + 34_450);
  });

  it("Vorjahres-Startwert wird vom Carryover superseded (exactly-once, Task #959): Carryover zählt, IB nicht doppelt", async () => {
    // Task #959 — Universelles Verfalls-/Übertrags-Modell: Der Carryover bildet
    // das gesamte Restguthaben des Quelljahrs (inkl. eines Dez-Startwerts) ab.
    // Die alte `ibYears`-Ausnahme (Task #101: Carryover bei vorhandenem Quelljahr-
    // Startwert unterdrücken, Startwert behalten) entfällt — stattdessen wird der
    // Carryover gezählt UND der Vorjahres-Startwert per IB-Supersession aus
    // `initialBalanceTotal` herausgerechnet. Ergebnis = identisch zur ersten
    // Repro (99.950 €), KEINE Doppelzählung, kein Verlust von Restguthaben.
    const customerId = await fresh45bCustomerWithoutAutoSettings("T696-IB-SUPERSEDED");

    await db.insert(customerBudgetTypeSettings).values({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      enabled: true,
      priority: 1,
      monthlyLimitCents: null,
      yearlyLimitCents: null,
      validFrom: null,
      validTo: null,
    });

    await upsertBudgetPreferences({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      monthlyLimitCents: null,
      budgetStartDate: "2025-12-01",
    });

    // Manueller Startwert für 2025-12: deckt Dez 2025 (Quelljahr-Monat).
    // Direkter Insert in `budget_allocations` über den Storage-Helfer, damit
    // ibYears die Carryover-Anrechnung blockiert.
    const { upsertInitialBalanceAllocation } = await import("../../server/storage/budget/allocation-storage");
    await upsertInitialBalanceAllocation({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      year: 2025,
      month: 12,
      amountCents: 13_100,
      validFrom: "2025-12-01",
      expiresAt: null,
    });

    await upsertCarryoverAllocation(
      { customerId, budgetType: "entlastungsbetrag_45b", sourceYear: 2025, amountCents: 34_450 },
    );

    const totalAllocated = await calculateAllocatedCents(
      customerId,
      "entlastungsbetrag_45b",
      { asOfDate: "2026-05-27" },
    );

    // Task #959 — Erwartung neu (exactly-once): Carryover wird gezählt (34450),
    // der Vorjahres-Startwert (year 2025) wird per IB-Supersession aus
    // `initialBalanceTotal` entfernt (ibFloorYear = max(2025, 2026) = 2026).
    // Monatslauf: allocStart auf 2026-01 geschoben → Jan..Mai 2026 = 5 × 13100 =
    // 65500, plus Carryover 34450 → 99950. Identisch zur ersten Repro, KEINE
    // Doppelzählung des Dez-2025-Guthabens.
    expect(totalAllocated).toBe(5 * 13_100 + 34_450);
    expect(totalAllocated).not.toBe(6 * 13_100); // alte ibYears-Semantik (78600) ist weg
  });
});
