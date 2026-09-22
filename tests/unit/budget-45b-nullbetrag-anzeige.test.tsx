// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BudgetOverviewDTO, BudgetOverview45bDTO } from "@shared/api/budget";

/**
 * P1 `6hXp9qMrXH2WGVVG` — die fünfte 0-€-Schranke, eine Schicht höher.
 *
 * Vier Schranken gegen 0-€-Startwerte sind gefallen (zweimal Server `min(1)`,
 * zweimal Client `!amountCents` bzw. `?? 0`). Die fünfte stand in der
 * Übersichtskarte und blieb stehen, **weil niemand nach ihr gesucht hat**:
 *
 * ```ts
 * const hasData = data.totalAllocatedCents > 0;   // sonst: "Noch keine Zuweisungen vorhanden"
 * ```
 *
 * Das wirft „keine Zuweisung" und „Zuweisung über 0 €" zusammen — genau die
 * leere Zeile, die Alriks Entscheidung ausschließt: **ein 0-€-Startwert wird
 * angezeigt wie jeder andere Betrag.** Abwesenheit und festgestellte Null
 * dürfen nicht gleich aussehen, sonst setzt der nächste Bearbeiter einen Wert
 * darüber.
 *
 * Ob der Fall heute erreichbar ist, ist für diesen Test unerheblich: bei einem
 * falschen Prädikat bestimmt die Erreichbarkeit die Dringlichkeit, nicht die
 * Richtigkeit.
 */

let overrides45b: Partial<BudgetOverview45bDTO> = {};

vi.mock("@/lib/api/client", () => {
  const base45b: BudgetOverview45bDTO = {
    totalAllocatedCents: 50_000,
    totalUsedCents: 0,
    availableCents: 50_000,
    plannedCents: 0,
    availableAfterPlannedCents: 50_000,
    currentMonthUsedCents: 0,
    currentMonthAvailableCents: 50_000,
    monthlyLimitCents: null,
    carryoverCents: 0,
    carryoverExpiresAt: null,
    currentYearAllocatedCents: 50_000,
    isCurrentlyActive: true,
    plannedShortfallMonth: null,
  };
  return {
    api: {
      get: vi.fn(async (path: string) => {
        if (path.includes("/type-settings")) {
          return {
            success: true,
            data: [{
              budgetType: "entlastungsbetrag_45b",
              enabled: true,
              priority: 1,
              validFrom: null,
              validTo: null,
            }],
          };
        }
        if (path.includes("/overview")) {
          const overview: BudgetOverviewDTO = {
            entlastungsbetrag45b: { ...base45b, ...overrides45b },
            umwandlung45a: {
              monthlyBudgetCents: 0,
              currentMonthAllocatedCents: 0,
              currentMonthUsedCents: 0,
              currentMonthAvailableCents: 0,
              isCurrentlyActive: false,
              label: "§45a Umwandlungsanspruch",
            },
            ersatzpflege39_42a: {
              yearlyBudgetCents: 0,
              currentYearAllocatedCents: 0,
              currentYearUsedCents: 0,
              currentYearAvailableCents: 0,
              label: "§39/§42a Gemeinsamer Jahresbetrag",
            },
          };
          return { success: true, data: overview };
        }
        if (path.includes("/transactions")) return { success: true, data: [] };
        return { success: true, data: null };
      }),
    },
    unwrapResult: <T,>(result: { success: boolean; data: T }) => result.data,
  };
});

import { BudgetLedgerSection } from "@/components/budget/BudgetLedgerSection";

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <BudgetLedgerSection customerId={1} customerName="Test" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  overrides45b = {};
});

describe("§45b-Karte — festgestellte Null ist nicht Abwesenheit", () => {
  it("NB-1 – ein aktiver Topf mit 0 € zeigt die Karte, nicht den Leerzustand", async () => {
    overrides45b = {
      totalAllocatedCents: 0,
      availableCents: 0,
      currentMonthAvailableCents: 0,
      currentYearAllocatedCents: 0,
      availableAfterPlannedCents: 0,
      isCurrentlyActive: true,
    };
    renderSection();

    // Vor dem Fix erschien hier "Noch keine Zuweisungen vorhanden" — die
    // leere Zeile, die ein Bearbeiter als "hier ist nichts eingetragen" liest
    // und überschreibt.
    expect(
      await screen.findByTestId("text-45b-allocated"),
      "der Leerzustand verschluckt eine festgestellte Null",
    ).toBeTruthy();
    expect(screen.queryByTestId("text-45b-no-data")).toBeNull();
  });

  it("NB-2 – ein inaktiver Topf ganz ohne Zahlen zeigt weiterhin den Leerzustand", async () => {
    // Die Gegenprobe: der Leerzustand muss erhalten bleiben, sonst wäre aus
    // "meldet zu selten" ein "meldet nie" geworden — dieselbe Klasse Fehler
    // mit umgekehrtem Vorzeichen.
    overrides45b = {
      totalAllocatedCents: 0,
      totalUsedCents: 0,
      availableCents: 0,
      carryoverCents: 0,
      currentMonthAvailableCents: 0,
      currentYearAllocatedCents: 0,
      availableAfterPlannedCents: 0,
      isCurrentlyActive: false,
    };
    renderSection();

    expect(
      await screen.findByTestId("text-45b-no-data"),
      "ein Topf ohne jede Zahl und ohne Aktivierung zeigt keinen Leerzustand mehr",
    ).toBeTruthy();
  });

  it("NB-3 – ein inaktiver Topf mit historischen Zahlen bleibt lesbar", async () => {
    // `!== 0` statt `> 0`: wer einen abgelaufenen Topf öffnet, soll sehen, was
    // dort stand, statt "keine Zuweisungen".
    overrides45b = {
      totalAllocatedCents: 0,
      totalUsedCents: 12_300,
      availableCents: 0,
      isCurrentlyActive: false,
    };
    renderSection();

    // `findBy…` zuerst, dann `queryBy…`: eine synchrone Abfrage direkt nach
    // `render` läuft, BEVOR die Query aufgelöst ist — sie findet dann nichts
    // und ist grün, egal was die Komponente entscheidet. Die erste Fassung
    // dieses Tests bestand deshalb auch auf dem defekten Stand (aufgefallen
    // beim Mutations-Gegencheck).
    expect(
      await screen.findByTestId("text-45b-allocated"),
      "ein abgelaufener Topf mit historischem Verbrauch zeigt keine Zahlen mehr",
    ).toBeTruthy();
    expect(screen.queryByTestId("text-45b-no-data")).toBeNull();
  });
});
