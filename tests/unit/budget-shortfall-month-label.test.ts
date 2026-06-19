import { describe, expect, it } from "vitest";
import { formatShortfallMonth } from "@/components/budget/BudgetLedgerSection";

// Task #706 — Die Plan-Warnung soll den ersten Monat nennen, in dem das §45b-
// Budget die geplanten Termine nicht mehr deckt (`plannedShortfallMonth`,
// "YYYY-MM"). `formatShortfallMonth` ist die reine Formatierungs-SSoT, die das
// Warnbanner menschenlesbar macht ("Februar 2027"). Bricht die Formatierung
// oder der Null-Fallback, schlägt dieser Smoke-Test an. Der zugehörige
// Render-Smoke-Test (volle Banner-Formulierung) liegt in
// `budget-shortfall-month-warning.test.tsx`.
describe("formatShortfallMonth (Task #706)", () => {
  it("formatiert YYYY-MM als deutschen Monat mit Jahr", () => {
    expect(formatShortfallMonth("2027-02")).toBe("Februar 2027");
    expect(formatShortfallMonth("2026-12")).toBe("Dezember 2026");
    expect(formatShortfallMonth("2026-01")).toBe("Januar 2026");
  });

  it("gibt null zurück, wenn kein Monat prognostiziert ist (Fallback)", () => {
    expect(formatShortfallMonth(null)).toBeNull();
  });

  it("gibt null zurück bei ungültigem Format (Fallback)", () => {
    expect(formatShortfallMonth("")).toBeNull();
    expect(formatShortfallMonth("2027")).toBeNull();
    expect(formatShortfallMonth("2027-13")).toBeNull();
    expect(formatShortfallMonth("not-a-month")).toBeNull();
  });
});
