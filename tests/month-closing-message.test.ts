import { describe, it, expect } from "vitest";
import {
  buildMonthClosingViewModel,
  formatGermanDate,
} from "../client/src/features/time-tracking/lib/month-closing-message";

describe("month-closing-message: formatGermanDate", () => {
  it("formatiert YYYY-MM-DD nach DD.MM.YYYY", () => {
    expect(formatGermanDate("2026-06-08")).toBe("08.06.2026");
    expect(formatGermanDate("2026-01-02")).toBe("02.01.2026");
  });
});

describe("month-closing-message: buildMonthClosingViewModel", () => {
  it("Open-Branch für Mai 2026 zeigt Cutoff 08.06.2026 und Selbst-Bearbeitungs-Hinweis", () => {
    const vm = buildMonthClosingViewModel({
      year: 2026,
      month: 5,
      isClosed: false,
      today: "2026-05-15",
    });
    expect(vm.show).toBe(true);
    expect(vm.variant).toBe("open");
    expect(vm.iconKind).toBe("unlock");
    expect(vm.monthLabel).toBe("Mai 2026");
    expect(vm.cutoffFormatted).toBe("08.06.2026");
    expect(vm.message).toContain("Mai 2026");
    expect(vm.message).toContain("08.06.2026");
    expect(vm.message).toContain("selbst anlegen, ändern oder löschen");
    expect(vm.message).toContain("Geschäftsleitung");
    expect(vm.message).not.toContain("Admin");
  });

  it("Closed-Branch zeigt Geschäftsleitung-Hinweis und keinen Admin-Reopen-Text", () => {
    const vm = buildMonthClosingViewModel({
      year: 2026,
      month: 5,
      isClosed: true,
      today: "2026-06-20",
    });
    expect(vm.show).toBe(true);
    expect(vm.variant).toBe("closed");
    expect(vm.iconKind).toBe("lock");
    expect(vm.message).toContain("Mai 2026");
    expect(vm.message).toContain("abgeschlossen");
    expect(vm.message).toContain("Geschäftsleitung");
    expect(vm.message).not.toContain("Admin");
    expect(vm.message).not.toContain("öffnen");
  });

  it("Overdue-Branch (Cutoff vergangen, aber nicht geschlossen) zeigt Schloss + Cutoff-Datum", () => {
    const vm = buildMonthClosingViewModel({
      year: 2026,
      month: 5,
      isClosed: false,
      today: "2026-06-10",
    });
    expect(vm.show).toBe(true);
    expect(vm.variant).toBe("overdue");
    expect(vm.iconKind).toBe("lock");
    expect(vm.message).toContain("08.06.2026");
    expect(vm.message).toContain("Geschäftsleitung");
  });

  it("Future-Monat: Karte wird ausgeblendet (show=false)", () => {
    const vm = buildMonthClosingViewModel({
      year: 2026,
      month: 8,
      isClosed: false,
      today: "2026-05-15",
    });
    expect(vm.show).toBe(false);
    expect(vm.variant).toBe("future");
  });

  it("Future-Jahr: ebenfalls ausgeblendet", () => {
    const vm = buildMonthClosingViewModel({
      year: 2027,
      month: 1,
      isClosed: false,
      today: "2026-12-30",
    });
    expect(vm.show).toBe(false);
  });

  it("Aktueller Monat am Cutoff-Tag selbst bleibt 'open' (Cutoff noch nicht vorbei)", () => {
    // Cutoff für Mai 2026 = 08.06.2026 (Montag, kein Feiertag)
    const vm = buildMonthClosingViewModel({
      year: 2026,
      month: 5,
      isClosed: false,
      today: "2026-06-08",
    });
    expect(vm.variant).toBe("open");
  });
});
