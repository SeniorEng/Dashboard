/**
 * Task #1587 — SSoT-Resolver `resolveMonitoredIbans`.
 *
 * Reine Unit-Tests (kein Server/DB): Reihenfolge (primär zuerst),
 * Dedup (auch bei abweichender Formatierung), Ignorieren von Leerwerten.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeIban,
  resolveMonitoredIbans,
} from "../../shared/domain/qonto/monitored-ibans";

describe("normalizeIban", () => {
  it("entfernt Whitespace und schreibt groß", () => {
    expect(normalizeIban("de89 3704 0044 0532 0130 00")).toBe(
      "DE89370400440532013000",
    );
  });
});

describe("resolveMonitoredIbans", () => {
  it("liefert nur das Geschäftskonto, wenn keine weiteren IBANs gesetzt sind", () => {
    expect(
      resolveMonitoredIbans({ qontoIban: "DE111", qontoAdditionalIbans: [] }),
    ).toEqual(["DE111"]);
  });

  it("setzt das primäre Geschäftskonto an die erste Stelle", () => {
    expect(
      resolveMonitoredIbans({
        qontoIban: "DE111",
        qontoAdditionalIbans: ["DE222", "DE333"],
      }),
    ).toEqual(["DE111", "DE222", "DE333"]);
  });

  it("dedupliziert auch bei abweichender Formatierung/Whitespace/Case", () => {
    expect(
      resolveMonitoredIbans({
        qontoIban: "DE89 3704 0044 0532 0130 00",
        qontoAdditionalIbans: ["de8937040044053201300 0", "DE222"],
      }),
    ).toEqual(["DE89 3704 0044 0532 0130 00", "DE222"]);
  });

  it("ignoriert Leerwerte und Whitespace-only-Einträge", () => {
    expect(
      resolveMonitoredIbans({
        qontoIban: "DE111",
        qontoAdditionalIbans: ["", "   ", "DE222"],
      }),
    ).toEqual(["DE111", "DE222"]);
  });

  it("liefert leere Liste, wenn kein Konto hinterlegt ist", () => {
    expect(
      resolveMonitoredIbans({ qontoIban: null, qontoAdditionalIbans: null }),
    ).toEqual([]);
  });

  it("funktioniert, wenn nur additionalIbans gesetzt sind", () => {
    expect(
      resolveMonitoredIbans({
        qontoIban: "",
        qontoAdditionalIbans: ["DE222", "DE222"],
      }),
    ).toEqual(["DE222"]);
  });
});
