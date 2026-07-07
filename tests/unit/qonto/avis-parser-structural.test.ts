/**
 * Task #1687 — Phase 1: Strukturelle Betrags-/Referenz-Erkennung des Avis-Parsers.
 *
 * Sichert die NEUEN Fähigkeiten ab, die die feste `parts[4]`-Annahme ablösen:
 *  - Betrag strukturell erkannt, auch wenn er (AOK-Stil) an Feld-Index 5 steht.
 *  - Rechnungsnummer-Extraktion mit O→0-Toleranz (Excel/OCR).
 *  - Excel-Exponential (`…E+15`) wird als Referenz verworfen (kein Fehlmatch).
 *  - Mehrdeutiges Betrags-Feld ⇒ `AvisParseUncertainError` mit Preview + Vorschlag.
 *  - Format-Klassifikation (aok / barmer / kassen-csv).
 *
 * Reine Funktionen (keine DB) ⇒ Unit-Test (Projekt `unit`, groupOrder 0).
 */

import { describe, it, expect } from "vitest";
import { parseAvisCsv, AvisParseUncertainError } from "../../../server/services/avis-parser";
import {
  extractInvoiceNumber,
  normalizeAvisRef,
  isExcelExponential,
  resolveUniqueMatch,
} from "@shared/domain/qonto/avis-match";
import {
  detectAmountFieldIndex,
  isGermanAmountField,
  classifyKassenCsvFormat,
  buildSuggestedColumnMap,
} from "@shared/domain/qonto/avis-format";

describe("avis-match: Referenz-Extraktion", () => {
  it("normalisiert O→0 innerhalb einer RE-Rechnungsnummer", () => {
    expect(normalizeAvisRef("RE-2026-O191")).toBe("RE-2026-0191");
    expect(extractInvoiceNumber("Zahlung RE-2026-O191 August")).toBe("RE-2026-0191");
    expect(extractInvoiceNumber("RE-2026-0191")).toBe("RE-2026-0191");
  });

  it("erkennt eine lange Ziffernfolge als Fallback-Rechnungsnummer", () => {
    expect(extractInvoiceNumber("4000000618348494/007/2025")).toBe("4000000618348494");
    expect(extractInvoiceNumber("Schröder,R.,Z817157321")).toBeNull();
  });

  it("verwirft Excel-Exponential-Referenzen (kein Fehlmatch)", () => {
    expect(isExcelExponential("4,00000061835E+15")).toBe(true);
    expect(isExcelExponential("2025E+11")).toBe(true);
    expect(isExcelExponential("RE-2026-0191")).toBe(false);
    expect(isExcelExponential("4000000618348494/007/2025")).toBe(false);
    expect(extractInvoiceNumber("4,00000061835E+15")).toBeNull();
  });

  it("resolveUniqueMatch übernimmt nur genau einen Kandidaten", () => {
    expect(resolveUniqueMatch([42])).toBe(42);
    expect(resolveUniqueMatch<number>([])).toBeNull();
    expect(resolveUniqueMatch([1, 2])).toBeNull();
  });
});

describe("avis-format: strukturelle Betrags-Erkennung", () => {
  it("erkennt genau ein deutsch-formatiertes Betrags-Feld", () => {
    expect(isGermanAmountField("49,13")).toBe(true);
    expect(isGermanAmountField("1.234,56")).toBe(true);
    expect(isGermanAmountField("-70,00")).toBe(true);
    expect(isGermanAmountField("2025-08-03")).toBe(false);
    expect(isGermanAmountField("01.08.2025")).toBe(false);
    expect(isGermanAmountField("Sammelueberweisung")).toBe(false);
  });

  it("Barmer-Stil: Betrag an Feld 4", () => {
    const parts = ["2", "Sammelueberweisung", "RE-2026-9001", "15.04.2026", "123,45"];
    expect(detectAmountFieldIndex(parts)).toBe(4);
  });

  it("AOK-Stil: Betrag strukturell an Feld 5 (nicht 4)", () => {
    const parts = ["2", "RE-2026-0191", "Schröder", "2025-08-03", "01.08.2025 - 31.08.2025", "49,13", "+", "EUR"];
    expect(detectAmountFieldIndex(parts)).toBe(5);
  });

  it("mehrere Beträge: bevorzugt das Feld links vom Vorzeichen/EUR", () => {
    expect(detectAmountFieldIndex(["2", "70,00", "x", "1.234,56", "+", "EUR"])).toBe(3);
  });

  it("mehrdeutig ohne Vorzeichen ⇒ -1", () => {
    expect(detectAmountFieldIndex(["2", "70,00", "1.234,56", "xyz"])).toBe(-1);
    expect(detectAmountFieldIndex(["2", "abc", "def"])).toBe(-1);
  });

  it("klassifiziert Format primär nach Name, sekundär nach Dateiname", () => {
    expect(classifyKassenCsvFormat({ fileName: "AOK-Plus-2026.csv" })).toBe("aok");
    expect(classifyKassenCsvFormat({ fileName: "barmer-avis.csv" })).toBe("barmer");
    expect(classifyKassenCsvFormat({ kostentraegerName: "AOK PLUS" })).toBe("aok");
    expect(classifyKassenCsvFormat({ fileName: "SAP-56020-461438852.csv" })).toBe("kassen-csv");
  });

  it("schlägt ein Spalten-Mapping vor", () => {
    const parts = ["2", "RE-2026-0191", "Schröder", "05.08.2025", "49,13", "+", "EUR"];
    expect(buildSuggestedColumnMap(parts)).toEqual({ betrag: 4, referenz: 1, datum: 3 });
  });
});

describe("parseAvisCsv: 1;-Kassen-Familie", () => {
  it("AOK-Layout (Betrag an Feld 5) wird korrekt geparst, RE-Nummer O→0", () => {
    const csv = [
      "1;461438852;Pflegedienst",
      "2;RE-2026-O191;Schröder;2025-08-03;01.08.2025 - 31.08.2025;49,13;+;EUR",
      "3;BELEG-1;03.08.2025;49,13;DE00123456780000000000",
    ].join("\n");

    const parsed = parseAvisCsv(csv, { fileName: "AOK-Plus-2026.csv" });
    expect(parsed.header.format).toBe("aok");
    expect(parsed.header.gesamtBetragCents).toBe(4913);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].betragCents).toBe(4913);
    expect(parsed.items[0].rechnungsNummer).toBe("RE-2026-0191");
  });

  it("mehrdeutiges Betrags-Feld ⇒ AvisParseUncertainError mit Preview + Vorschlag", () => {
    const csv = [
      "1;IK123456789",
      "2;Ref;70,00;1.234,56;xyz",
      "3;BELEG;03.08.2025;70,00;DE00123456780000000000",
    ].join("\n");

    let err: unknown;
    try {
      parseAvisCsv(csv, { fileName: "unklar.csv" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AvisParseUncertainError);
    const uncertain = err as AvisParseUncertainError;
    expect(uncertain.preview.length).toBeGreaterThan(0);
    expect(uncertain.preview[0][0]).toBe("2");
    expect(uncertain.suggestedColumnMap?.betrag).toBe(2);
  });

  it("manuelles columnMap überschreibt die strukturelle Erkennung", () => {
    const csv = [
      "1;IK123456789",
      "2;Ref;70,00;1.234,56;xyz",
      "3;BELEG;03.08.2025;70,00;DE00123456780000000000",
    ].join("\n");

    const parsed = parseAvisCsv(csv, { fileName: "unklar.csv", columnMap: { betrag: 3, referenz: 1, datum: null } });
    expect(parsed.items[0].betragCents).toBe(123456);
  });
});
