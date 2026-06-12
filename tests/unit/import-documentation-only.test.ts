/**
 * Task #1243 — Vorjahres-Termine echter Pflegekassen-Kunden werden nur als
 * Dokumentation (ohne Budgetverbrauch) importiert, weil der §45b-Anker auf den
 * 1. Januar des laufenden Jahres gebodet wird und für Vorjahres-Daten damit
 * §45b = 0 ist (eine echte Buchung würde hart blocken).
 *
 * Reiner Logik-Test der SSoT-Helfer — keine DB, kein Server.
 */
import { describe, it, expect } from "vitest";
import {
  isPriorYearImportDate,
  isDocumentationOnlyImport,
} from "@shared/domain/import-documentation-only";

const NOW = new Date("2026-06-12T10:00:00.000Z");

describe("isPriorYearImportDate", () => {
  it("ist true für ein Datum aus einem früheren Kalenderjahr", () => {
    expect(isPriorYearImportDate("2025-12-31", NOW)).toBe(true);
    expect(isPriorYearImportDate("2024-01-01", NOW)).toBe(true);
  });

  it("ist false für ein Datum im laufenden Jahr (auch am 1. Januar)", () => {
    expect(isPriorYearImportDate("2026-01-01", NOW)).toBe(false);
    expect(isPriorYearImportDate("2026-06-12", NOW)).toBe(false);
    expect(isPriorYearImportDate("2026-12-31", NOW)).toBe(false);
  });

  it("ist false für ein Datum aus einem zukünftigen Jahr", () => {
    expect(isPriorYearImportDate("2027-01-01", NOW)).toBe(false);
  });

  it("ist false für ein unparsbares Datum (kein versehentlicher Doku-Pfad)", () => {
    expect(isPriorYearImportDate("kein-datum", NOW)).toBe(false);
    expect(isPriorYearImportDate("", NOW)).toBe(false);
  });
});

describe("isDocumentationOnlyImport", () => {
  it("ist true: Vorjahr + Kunde akzeptiert KEINE Privatzahlung (echte Pflegekasse)", () => {
    expect(
      isDocumentationOnlyImport({
        date: "2025-08-15",
        isPrivatePaymentAllowed: false,
        now: NOW,
      }),
    ).toBe(true);
  });

  it("ist false: Vorjahr, aber Kunde zahlt privat (Selbstzahler-Routing → abrechenbar)", () => {
    expect(
      isDocumentationOnlyImport({
        date: "2025-08-15",
        isPrivatePaymentAllowed: true,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("ist false: laufendes Jahr, auch ohne Privatzahlung (reguläre Buchung)", () => {
    expect(
      isDocumentationOnlyImport({
        date: "2026-01-15",
        isPrivatePaymentAllowed: false,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("ist false: laufendes Jahr UND Privatzahlung", () => {
    expect(
      isDocumentationOnlyImport({
        date: "2026-03-01",
        isPrivatePaymentAllowed: true,
        now: NOW,
      }),
    ).toBe(false);
  });
});
