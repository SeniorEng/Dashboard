/**
 * Task #708 — Excel-Cutoff darf nie kleiner als der größte vorkommende
 * YYYY-MM sein und muss exakt am Monatsende liegen (inkl. Februar +
 * Schaltjahr). Termine am Cutoff-Tag selbst gelten als IN-Scope.
 */
import { describe, it, expect } from "vitest";
import { computeLastExcelMonth, isBeyondCutoff } from "@shared/domain/import-cutoff";

describe("computeLastExcelMonth", () => {
  it("nimmt den letzten Tag des größten YYYY-MM", () => {
    expect(
      computeLastExcelMonth(["2026-01-15", "2026-04-15", "2026-02-28"]),
    ).toEqual({ yearMonth: "2026-04", lastDay: "2026-04-30" });
  });

  it("respektiert Monate mit 31 Tagen", () => {
    expect(computeLastExcelMonth(["2026-01-01"])).toEqual({
      yearMonth: "2026-01",
      lastDay: "2026-01-31",
    });
    expect(computeLastExcelMonth(["2026-03-15", "2026-12-01"])).toEqual({
      yearMonth: "2026-12",
      lastDay: "2026-12-31",
    });
  });

  it("respektiert Februar in Schalt- und Nicht-Schaltjahren", () => {
    expect(computeLastExcelMonth(["2024-02-10"])).toEqual({
      yearMonth: "2024-02",
      lastDay: "2024-02-29",
    });
    expect(computeLastExcelMonth(["2026-02-10"])).toEqual({
      yearMonth: "2026-02",
      lastDay: "2026-02-28",
    });
  });

  it("ignoriert leere / ungültige Einträge und liefert null bei leerer Liste", () => {
    expect(computeLastExcelMonth([])).toBeNull();
    expect(computeLastExcelMonth([null, undefined, "", "not-a-date"])).toBeNull();
    expect(
      computeLastExcelMonth(["", null, "2026-05-10", "kaputt"]),
    ).toEqual({ yearMonth: "2026-05", lastDay: "2026-05-31" });
  });
});

describe("isBeyondCutoff", () => {
  const cutoff = { yearMonth: "2026-04", lastDay: "2026-04-30" };

  it("ist false am Cutoff-Tag selbst (Termine am 30.04. liegen im Scope)", () => {
    expect(isBeyondCutoff("2026-04-30", cutoff)).toBe(false);
  });

  it("ist true für Termine nach dem Cutoff-Tag", () => {
    expect(isBeyondCutoff("2026-05-01", cutoff)).toBe(true);
    expect(isBeyondCutoff("2027-01-01", cutoff)).toBe(true);
  });

  it("ist false für Termine vor dem Cutoff", () => {
    expect(isBeyondCutoff("2026-01-01", cutoff)).toBe(false);
    expect(isBeyondCutoff("2025-12-31", cutoff)).toBe(false);
  });
});
