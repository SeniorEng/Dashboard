/**
 * Task #1599 — Pure Matching-Logik der Auto-Ausblenden-Regeln.
 */

import { describe, it, expect } from "vitest";
import {
  matchesHideRule,
  matchesAnyHideRule,
  normalizeHideRuleValue,
} from "../../shared/domain/qonto/hide-rules";

describe("matchesHideRule (counterparty)", () => {
  it("trifft bei enthaltenem Teilstring (case-insensitive)", () => {
    expect(
      matchesHideRule(
        { counterpartyName: "Finanzamt Berlin", sourceIban: null },
        { ruleType: "counterparty", value: "finanzamt" },
      ),
    ).toBe(true);
  });

  it("trifft NICHT, wenn der Teilstring fehlt", () => {
    expect(
      matchesHideRule(
        { counterpartyName: "AOK Nordost", sourceIban: null },
        { ruleType: "counterparty", value: "finanzamt" },
      ),
    ).toBe(false);
  });

  it("trifft NICHT bei leerem Gegenpartei-Namen", () => {
    expect(
      matchesHideRule(
        { counterpartyName: null, sourceIban: null },
        { ruleType: "counterparty", value: "finanzamt" },
      ),
    ).toBe(false);
  });

  it("trifft NICHT bei leerem Regelwert", () => {
    expect(
      matchesHideRule(
        { counterpartyName: "Finanzamt", sourceIban: null },
        { ruleType: "counterparty", value: "   " },
      ),
    ).toBe(false);
  });
});

describe("matchesHideRule (iban)", () => {
  it("trifft bei gleicher IBAN trotz Leerzeichen/Kleinschreibung", () => {
    expect(
      matchesHideRule(
        { counterpartyName: null, sourceIban: "de00 1234 5678" },
        { ruleType: "iban", value: "DE0012345678" },
      ),
    ).toBe(true);
  });

  it("trifft NICHT bei abweichender IBAN", () => {
    expect(
      matchesHideRule(
        { counterpartyName: null, sourceIban: "DE0012345678" },
        { ruleType: "iban", value: "DE9987654321" },
      ),
    ).toBe(false);
  });

  it("trifft NICHT ohne Quell-IBAN", () => {
    expect(
      matchesHideRule(
        { counterpartyName: "Zahler", sourceIban: null },
        { ruleType: "iban", value: "DE0012345678" },
      ),
    ).toBe(false);
  });
});

describe("matchesHideRule (unbekannter Typ)", () => {
  it("trifft nie", () => {
    expect(
      matchesHideRule(
        { counterpartyName: "Finanzamt", sourceIban: "DE0012345678" },
        { ruleType: "sonstiges", value: "Finanzamt" },
      ),
    ).toBe(false);
  });
});

describe("matchesAnyHideRule", () => {
  const tx = { counterpartyName: "AOK Nordost", sourceIban: "DE0012345678" };

  it("trifft, sobald eine Regel greift", () => {
    expect(
      matchesAnyHideRule(tx, [
        { ruleType: "counterparty", value: "finanzamt" },
        { ruleType: "iban", value: "DE0012345678" },
      ]),
    ).toBe(true);
  });

  it("trifft nicht ohne passende Regel", () => {
    expect(
      matchesAnyHideRule(tx, [
        { ruleType: "counterparty", value: "finanzamt" },
        { ruleType: "iban", value: "DE9987654321" },
      ]),
    ).toBe(false);
  });

  it("trifft nicht bei leerer Regelmenge", () => {
    expect(matchesAnyHideRule(tx, [])).toBe(false);
  });
});

describe("normalizeHideRuleValue", () => {
  it("kanonisiert IBAN-Werte", () => {
    expect(normalizeHideRuleValue("iban", " de00 1234 5678 ")).toBe("DE0012345678");
  });

  it("trimmt Counterparty-Werte nur", () => {
    expect(normalizeHideRuleValue("counterparty", "  Finanzamt Berlin  ")).toBe(
      "Finanzamt Berlin",
    );
  });
});
