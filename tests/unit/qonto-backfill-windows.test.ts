/**
 * Task #1599 — Monats-Fenster-Zerlegung für den datums-basierten Qonto-Backfill.
 */

import { describe, it, expect } from "vitest";
import {
  enumerateMonthlyWindows,
  monthsBetween,
  exceedsBackfillLookbackCap,
  MAX_BACKFILL_LOOKBACK_MONTHS,
} from "../../shared/domain/qonto/backfill-windows";

describe("enumerateMonthlyWindows", () => {
  it("liefert genau ein Fenster innerhalb eines Monats", () => {
    const start = new Date(2026, 5, 1, 0, 0, 0, 0); // 01.06.2026
    const end = new Date(2026, 5, 20, 12, 0, 0, 0); // 20.06.2026
    const windows = enumerateMonthlyWindows(start, end);
    expect(windows).toHaveLength(1);
    expect(windows[0].from.getTime()).toBe(start.getTime());
    expect(windows[0].to.getTime()).toBe(end.getTime());
  });

  it("zerlegt einen Mehrmonatszeitraum lückenlos und überlappungsfrei", () => {
    const start = new Date(2026, 5, 15, 0, 0, 0, 0); // 15.06.2026
    const end = new Date(2026, 7, 10, 0, 0, 0, 0); // 10.08.2026
    const windows = enumerateMonthlyWindows(start, end);
    expect(windows).toHaveLength(3);

    // Erstes Fenster beginnt exakt am Startdatum.
    expect(windows[0].from.getTime()).toBe(start.getTime());
    // Letztes Fenster endet exakt am Enddatum.
    expect(windows[windows.length - 1].to.getTime()).toBe(end.getTime());

    // Lückenlos + überlappungsfrei: jedes Folgefenster startet 1ms nach dem Ende.
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].from.getTime()).toBe(windows[i - 1].to.getTime() + 1);
    }

    // Zwischenfenster starten am Monatsersten.
    expect(windows[1].from.getTime()).toBe(new Date(2026, 6, 1, 0, 0, 0, 0).getTime());
    expect(windows[2].from.getTime()).toBe(new Date(2026, 7, 1, 0, 0, 0, 0).getTime());
  });

  it("liefert ein leeres Array, wenn end vor start liegt", () => {
    const start = new Date(2026, 5, 10);
    const end = new Date(2026, 5, 1);
    expect(enumerateMonthlyWindows(start, end)).toEqual([]);
  });

  it("behandelt einen Jahreswechsel korrekt", () => {
    const start = new Date(2025, 11, 20, 0, 0, 0, 0); // 20.12.2025
    const end = new Date(2026, 0, 15, 0, 0, 0, 0); // 15.01.2026
    const windows = enumerateMonthlyWindows(start, end);
    expect(windows).toHaveLength(2);
    expect(windows[1].from.getTime()).toBe(new Date(2026, 0, 1, 0, 0, 0, 0).getTime());
    expect(windows[1].to.getTime()).toBe(end.getTime());
  });
});

describe("monthsBetween", () => {
  it("zählt volle Kalendermonate zwischen start und end", () => {
    expect(monthsBetween(new Date(2026, 0, 15), new Date(2026, 3, 1))).toBe(3);
    expect(monthsBetween(new Date(2024, 5, 1), new Date(2026, 5, 1))).toBe(24);
  });

  it("liefert 0, wenn start im selben Monat oder nach end liegt", () => {
    expect(monthsBetween(new Date(2026, 5, 1), new Date(2026, 5, 28))).toBe(0);
    expect(monthsBetween(new Date(2026, 5, 1), new Date(2026, 3, 1))).toBe(0);
  });
});

describe("exceedsBackfillLookbackCap (Task #1607)", () => {
  it("erlaubt aktuelle Backfills innerhalb der Grenze", () => {
    const end = new Date(2026, 5, 15); // 15.06.2026
    // Genau an der Grenze (== MAX Monate zurück) ist noch erlaubt.
    const atLimit = new Date(2026 - 2, 5, 1); // 24 Monate zurück
    expect(monthsBetween(atLimit, end)).toBe(MAX_BACKFILL_LOOKBACK_MONTHS);
    expect(exceedsBackfillLookbackCap(atLimit, end)).toBe(false);
  });

  it("blockiert Läufe, die weiter als die Grenze zurückreichen", () => {
    const end = new Date(2026, 5, 15); // 15.06.2026
    const tooFar = new Date(2026 - 3, 4, 1); // > 24 Monate zurück
    expect(exceedsBackfillLookbackCap(tooFar, end)).toBe(true);
  });
});
