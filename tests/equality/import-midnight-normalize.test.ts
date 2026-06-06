/**
 * Task #997 (#5) — Mitternacht-Normalisierung beim Excel-Import.
 *
 * Ein Excel-Zeitserial von genau 1.0 (Mitternacht des Folgetages) bzw. ein
 * Wert, der auf 24:00 rundet, ergab vorher "24:00" — keine gültige Uhrzeit und
 * PostgreSQL-`time`-untauglich. `excelTimeToHHMM` faltet 24:00 → 00:00.
 */
import { describe, expect, it } from "vitest";
import { excelTimeToHHMM } from "../../server/services/appointment-import";

describe("excelTimeToHHMM — Mitternacht (Task #997)", () => {
  it("1.0 (Mitternacht) → 00:00, nicht 24:00", () => {
    expect(excelTimeToHHMM(1)).toBe("00:00");
  });

  it("0.0 → 00:00", () => {
    expect(excelTimeToHHMM(0)).toBe("00:00");
  });

  it("Wert der auf 24:00 rundet → 00:00", () => {
    // 0.99999 * 24h ≈ 23:59:59 → rundet auf 1440 min → 00:00 statt 24:00.
    expect(excelTimeToHHMM(0.9999999)).toBe("00:00");
  });

  it("reguläre Uhrzeiten bleiben unverändert", () => {
    expect(excelTimeToHHMM(0.5)).toBe("12:00");
    expect(excelTimeToHHMM(10 / 24)).toBe("10:00");
    expect(excelTimeToHHMM((23 * 60 + 30) / 1440)).toBe("23:30");
  });
});
