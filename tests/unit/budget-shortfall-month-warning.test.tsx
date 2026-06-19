// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BudgetOverviewDTO, BudgetOverview45bDTO } from "@shared/api/budget";

// Task #706 — Render-Smoke-Test: das §45b-Warnbanner nennt den konkreten Monat,
// ab dem das Budget die geplanten Termine nicht mehr deckt
// (`plannedShortfallMonth`), und fällt sonst auf die generische Formulierung
// zurück. Gegenstück zum reinen Formatter-Test
// (`budget-shortfall-month-label.test.ts`).

let overrides45b: Partial<BudgetOverview45bDTO> = {};

vi.mock("@/lib/api/client", () => {
  const base45b: BudgetOverview45bDTO = {
    totalAllocatedCents: 50_000,
    totalUsedCents: 0,
    availableCents: 50_000,
    plannedCents: 60_000,
    availableAfterPlannedCents: -10_000,
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
            data: [
              {
                budgetType: "entlastungsbetrag_45b",
                enabled: true,
                priority: 1,
                validFrom: null,
                validTo: null,
              },
            ],
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
        if (path.includes("/transactions")) {
          return { success: true, data: [] };
        }
        return { success: true, data: null };
      }),
    },
    unwrapResult: <T,>(result: { success: boolean; data: T }) => result.data,
  };
});

import { BudgetLedgerSection } from "@/components/budget/BudgetLedgerSection";

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
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

describe("BudgetLedgerSection §45b-Warnung (Task #706)", () => {
  it("nennt den Engpass-Monat menschenlesbar, wenn plannedShortfallMonth gesetzt ist", async () => {
    overrides45b = { plannedShortfallMonth: "2027-02" };
    renderSection();
    const warning = await screen.findByTestId("text-budget-exceeded-warning");
    expect(warning.textContent).toContain("ab Februar 2027 nicht mehr");
  });

  it("fällt auf die generische Formulierung zurück, wenn plannedShortfallMonth null ist", async () => {
    overrides45b = { plannedShortfallMonth: null };
    renderSection();
    const warning = await screen.findByTestId("text-budget-exceeded-warning");
    expect(warning.textContent).toContain("Budget reicht nicht für alle geplanten Termine");
    expect(warning.textContent).not.toContain(" ab ");
  });
});
