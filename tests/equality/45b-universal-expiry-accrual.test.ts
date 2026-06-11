/**
 * Task #959 — Universelles §45b-Verfalls-/Akkumulations-Modell.
 *
 * Pinnt die vier Lücken, durch die ALT-, Legacy-, manuelle und neue Kunden
 * mehr §45b zeigen konnten, als rechtlich möglich ist:
 *
 *   (1) Legacy/Manueller Anker → unbegrenzte Monatsaufstockung über Jahre.
 *       Fix (Task #1204): Der §45b-Anker wird zur Laufzeit aus der Pflegegrad-
 *       Historie abgeleitet und auf den 1.1. des LAUFENDEN Jahres gebodet
 *       (`floorAutoAnchor45bToCurrentYear`) — ein alter Pflegegrad akkumuliert
 *       damit keine jahrelang nicht-verfallenden Monatsbeträge mehr.
 *   (2) Vorjahres-Startwert (`initial_balance`) jenseits des Fensters wird weiter
 *       gezählt. Fix: IB-Supersession (`year < ibFloorYear` → ausgeschlossen).
 *   (4) Onboarding-Baseline (Task #1204/#860): das Vorjahr gilt als aufgebraucht,
 *       es wird KEIN automatischer Vorjahres-Carryover fabriziert. Der gebodete
 *       Anker (eligibilityStartYear = laufendes Jahr) supersediert das frühere
 *       Auto-Übertrags-Modell (Task #959/#101).
 *   (3) Start-/Übertragswert über der Obergrenze bei der Anlage. Fix:
 *       `/initial-budget` weist zu hohe Werte mit 400 ab (Cap-SSoT).
 *
 * Lesepfad-Tests verwenden einen festen `asOfDate` im 1. Halbjahr (2026-05-27),
 * damit das Fenster = {Vorjahr 2025, laufendes Jahr 2026} deterministisch ist.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetAllocations, customerBudgetTypeSettings } from "@shared/schema";
import {
  calculateAllocatedCents,
  syncCarryoverAndExpiry,
  upsertInitialBalanceAllocation,
} from "../../server/storage/budget/allocation-storage";
import {
  apiPost,
  createTestCustomer,
  getAuthCookie,
  runCleanup,
} from "../test-utils";

const ORIGINAL_TZ = process.env.TZ;
const MONTHLY = 13_100; // gesetzliche §45b-Monatsaufstockung in Cent

beforeAll(async () => {
  process.env.TZ = "Europe/Berlin";
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

async function fresh45b(prefix: string): Promise<number> {
  const c = await createTestCustomer({
    vorname: prefix,
    nachname: `T959_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    pflegegrad: 3,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  const customerId = c.id as number;
  await db.delete(customerBudgetTypeSettings).where(
    eq(customerBudgetTypeSettings.customerId, customerId),
  );
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
  return customerId;
}

describe("Task #959 — universeller §45b-Verfall & Akkumulations-Cap", () => {
  it("Lücke 1 (Task #1204): Pflegegrad-Historie wird auf das laufende Jahr gebodet — keine jahrelange Akkumulation", async () => {
    const customerId = await fresh45b("T959-LEGACY");

    // Die Pflegegrad-Historie des Test-Kunden beginnt 2024-01-01
    // (createTestCustomer-Default). Task #1204 leitet den §45b-Anker zur Laufzeit
    // daraus ab und bodet ihn auf den 1.1. des laufenden Jahres (2026-01-01).
    const total = await calculateAllocatedCents(
      customerId,
      "entlastungsbetrag_45b",
      { asOfDate: "2026-05-27" },
    );

    // Gebodeter Anker 2026-01 → Jan .. Mai 2026 = 5 Monate × 131 €. KEINE
    // Akkumulation seit dem ungebodeten Pflegegrad-Beginn 2024-01 (das wären
    // 29 Monate bis Mai 2026).
    expect(total).toBe(5 * MONTHLY);
    expect(total).not.toBe(29 * MONTHLY);
  });

  it("Lücke 2: Vorjahres-Startwert für ein abgelaufenes Jahr (2024) trägt 0 € bei", async () => {
    const customerId = await fresh45b("T959-STALE-IB");

    // Accrual-Anker = gebodete Pflegegrad-Historie (2024 → 2026-01-01, Task #1204).
    // Ein alter Startwert von 2024 liegt noch herum (vor dem Boden 2025).
    await upsertInitialBalanceAllocation({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      year: 2024,
      month: 6,
      amountCents: 99_999,
      validFrom: "2024-06-01",
      expiresAt: null,
    });

    const total = await calculateAllocatedCents(
      customerId,
      "entlastungsbetrag_45b",
      { asOfDate: "2026-05-27" },
    );

    // Accrual startet 2026-01 (gebodeter Anker) → Jan .. Mai 2026 = 5 × 131 €.
    // Der 2024er-Startwert (99.999) liegt unter dem Boden 2025 und wird per
    // IB-Supersession ausgeschlossen (alt: 65.500 + 99.999 = Doppel-Verfügbarkeit).
    expect(total).toBe(5 * MONTHLY);
    expect(total).not.toBe(5 * MONTHLY + 99_999);
  });

  it("Lücke 4 (Task #1204): gebodeter Onboarding-Anker ⇒ KEIN automatischer Vorjahres-Carryover", async () => {
    const customerId = await fresh45b("T959-IB-ROLL");

    // Test-Kunde hat eine Pflegegrad-Historie ab 2024 → §45b-Anker wird auf
    // 2026-01-01 gebodet (Task #1204). Ein per Korrekturpfad gesetzter Vorjahres-
    // Startwert für 2025 rollt damit NICHT mehr automatisch in einen 2026er-
    // Carryover: das Vorjahr gilt als aufgebraucht (Onboarding-Baseline). Das
    // supersediert das frühere Auto-Übertrags-Modell (Task #959/#101).
    await upsertInitialBalanceAllocation({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      year: 2025,
      month: 1,
      amountCents: MONTHLY,
      validFrom: "2025-01-01",
      expiresAt: null,
    });

    await syncCarryoverAndExpiry(customerId);

    const carryovers = await db
      .select()
      .from(budgetAllocations)
      .where(and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
        eq(budgetAllocations.source, "carryover"),
        isNull(budgetAllocations.deletedAt),
      ));

    // eligibilityStartYear = laufendes Jahr (gebodeter Anker) ⇒ die Carryover-
    // Schleife verarbeitet kein abgelaufenes Jahr ⇒ kein Auto-Carryover.
    const carryover2026 = carryovers.filter(c => c.year === 2026);
    expect(carryover2026).toHaveLength(0);
  });

  it("Lücke 3: /initial-budget weist einen §45b-Startwert über der Obergrenze mit 400 ab", async () => {
    const customerId = await fresh45b("T959-CAP");

    // Startmonat Mai 2026 → maximal Jan..Mai = 5 Monate ansammelbar (Obergrenze
    // 5 × 131 €, selbst bei beliebig altem Anker). Ein Startwert von 6 × 131 €
    // ist rechtlich unmöglich und MUSS abgewiesen werden.
    const res = await apiPost(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentMonthAmountCents: 6 * MONTHLY,
      carryoverAmountCents: 0,
      budgetStartDate: "2026-05-15",
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.data)).toContain("BUDGET_45B_START_VALUE_EXCEEDED");
  });
});
