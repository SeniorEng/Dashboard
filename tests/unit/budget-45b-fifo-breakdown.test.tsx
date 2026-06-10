// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { formatEuroDE } from "@shared/utils/money";
import { formatDateForDisplay } from "@shared/utils/datetime";
import type { BudgetFifo45bBreakdownDTO, BudgetFifoPotDTO } from "@shared/api/budget";
import { Budget45bFifoBreakdown } from "@/features/customers/components/budget-45b-fifo-breakdown";

// Task #1131 — read-only §45b FIFO-Aufschlüsselungs-Balken im UI absichern.
//
// Gegenstück zum Backend-Konsistenztest (tests/equality/45b-fifo-breakdown-
// consistency.test.ts, Task #1129), der nur beweist, dass die API-Summen mit der
// Budget-Karte rekonzilieren. Hier prüfen wir, dass die Komponente daraus die
// richtigen Segmente und Euro-Werte rendert:
//   - pro Topf ein Segment je Nicht-Null-Wert (data-testid="fifo-seg-…")
//   - der zugehörige Euro-Label-Wert (data-testid="fifo-val-…")
//   - Null-Wert-Segmente werden ausgelassen (KEIN data-testid)
//   - das Verfallsdatum des Übertrags-Topfes (data-testid="fifo-carryover-expiry")
//   - Töpfe ohne Allokation werden nicht gerendert; ist gar kein Topf allokiert,
//     rendert die Komponente nichts (null).
//
// Hintergrund: würde ein Refactor die Segment-Breiten/-Werte oder das
// Auslassen von Null-Segmenten brechen, fiele das ohne diesen Test unbemerkt aus.

function makePot(overrides: Partial<BudgetFifoPotDTO> & Pick<BudgetFifoPotDTO, "potType">): BudgetFifoPotDTO {
  return {
    allocatedCents: 0,
    consumedCents: 0,
    consumedBilledCents: 0,
    consumedDocumentedCents: 0,
    consumedOtherCents: 0,
    plannedCents: 0,
    remainingCents: 0,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("Budget45bFifoBreakdown (Task #1131)", () => {
  it("rendert beide Töpfe mit Segmenten, Euro-Werten und Verfallsdatum", () => {
    // Übertrag: 200,00 € alloziert, davon 50,00 € abgerechnet + 30,00 €
    // dokumentiert (Σ consumed = 80,00 €), Rest 120,00 € frei. Kein Hold,
    // kein „sonstiger" Verbrauch → diese beiden Segmente müssen fehlen.
    const carryover = makePot({
      potType: "carryover",
      allocatedCents: 20_000,
      consumedCents: 8_000,
      consumedBilledCents: 5_000,
      consumedDocumentedCents: 3_000,
      consumedOtherCents: 0,
      plannedCents: 0,
      remainingCents: 12_000,
    });
    // Laufendes Jahr: 131,00 € alloziert, 10,00 € geplant/blockiert, 121,00 € frei.
    const currentYear = makePot({
      potType: "current_year",
      allocatedCents: 13_100,
      consumedCents: 0,
      plannedCents: 1_000,
      remainingCents: 12_100,
    });

    const data: BudgetFifo45bBreakdownDTO = {
      pots: [carryover, currentYear],
      carryoverExpiresAt: "2026-06-30",
      totalAllocatedCents: 33_100,
      totalConsumedCents: 8_000,
      totalPlannedCents: 1_000,
      totalAvailableCents: 24_100,
    };

    render(React.createElement(Budget45bFifoBreakdown, { data }));

    expect(screen.getByTestId("fifo-breakdown")).toBeTruthy();
    expect(screen.getByTestId("fifo-pot-carryover")).toBeTruthy();
    expect(screen.getByTestId("fifo-pot-current_year")).toBeTruthy();

    // Pro-Topf Allokations-Label.
    expect(screen.getByTestId("fifo-pot-allocated-carryover").textContent).toBe(formatEuroDE(20_000));
    expect(screen.getByTestId("fifo-pot-allocated-current_year").textContent).toBe(formatEuroDE(13_100));

    // Übertrag: abgerechnet + dokumentiert + frei vorhanden, sonstiger Verbrauch
    // und Geplant fehlen (Wert 0).
    expect(screen.getByTestId("fifo-seg-carryover-consumedBilledCents")).toBeTruthy();
    expect(screen.getByTestId("fifo-seg-carryover-consumedDocumentedCents")).toBeTruthy();
    expect(screen.getByTestId("fifo-seg-carryover-remainingCents")).toBeTruthy();
    expect(screen.queryByTestId("fifo-seg-carryover-consumedOtherCents")).toBeNull();
    expect(screen.queryByTestId("fifo-seg-carryover-plannedCents")).toBeNull();

    expect(screen.getByTestId("fifo-val-carryover-consumedBilledCents").textContent).toBe(formatEuroDE(5_000));
    expect(screen.getByTestId("fifo-val-carryover-consumedDocumentedCents").textContent).toBe(formatEuroDE(3_000));
    expect(screen.getByTestId("fifo-val-carryover-remainingCents").textContent).toBe(formatEuroDE(12_000));

    // Laufendes Jahr: nur Geplant + Frei.
    expect(screen.getByTestId("fifo-seg-current_year-plannedCents")).toBeTruthy();
    expect(screen.getByTestId("fifo-seg-current_year-remainingCents")).toBeTruthy();
    expect(screen.queryByTestId("fifo-seg-current_year-consumedBilledCents")).toBeNull();
    expect(screen.queryByTestId("fifo-seg-current_year-consumedDocumentedCents")).toBeNull();
    expect(screen.queryByTestId("fifo-seg-current_year-consumedOtherCents")).toBeNull();

    expect(screen.getByTestId("fifo-val-current_year-plannedCents").textContent).toBe(formatEuroDE(1_000));
    expect(screen.getByTestId("fifo-val-current_year-remainingCents").textContent).toBe(formatEuroDE(12_100));

    // Verfallsdatum nur am Übertrags-Topf.
    const expiry = screen.getByTestId("fifo-carryover-expiry");
    expect(expiry.textContent).toContain(formatDateForDisplay("2026-06-30"));
  });

  it("lässt Töpfe ohne Allokation weg und zeigt kein Verfallsdatum ohne Übertrag", () => {
    const data: BudgetFifo45bBreakdownDTO = {
      pots: [
        makePot({ potType: "carryover", allocatedCents: 0 }),
        makePot({
          potType: "current_year",
          allocatedCents: 13_100,
          remainingCents: 13_100,
        }),
      ],
      carryoverExpiresAt: null,
      totalAllocatedCents: 13_100,
      totalConsumedCents: 0,
      totalPlannedCents: 0,
      totalAvailableCents: 13_100,
    };

    render(React.createElement(Budget45bFifoBreakdown, { data }));

    expect(screen.getByTestId("fifo-breakdown")).toBeTruthy();
    expect(screen.queryByTestId("fifo-pot-carryover")).toBeNull();
    expect(screen.getByTestId("fifo-pot-current_year")).toBeTruthy();
    expect(screen.queryByTestId("fifo-carryover-expiry")).toBeNull();
  });

  it("rendert nichts, wenn kein Topf eine Allokation trägt", () => {
    const data: BudgetFifo45bBreakdownDTO = {
      pots: [
        makePot({ potType: "carryover", allocatedCents: 0 }),
        makePot({ potType: "current_year", allocatedCents: 0 }),
      ],
      carryoverExpiresAt: null,
      totalAllocatedCents: 0,
      totalConsumedCents: 0,
      totalPlannedCents: 0,
      totalAvailableCents: 0,
    };

    const { container } = render(React.createElement(Budget45bFifoBreakdown, { data }));
    expect(screen.queryByTestId("fifo-breakdown")).toBeNull();
    expect(container.firstChild).toBeNull();
  });
});
