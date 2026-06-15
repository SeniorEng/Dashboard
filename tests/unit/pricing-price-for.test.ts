/**
 * Task #1291 (Phase 3.3) — Unit-Tests für die reine `priceFor`-Auflösung (SSoT).
 *
 * Pinnt die drei von Alrik zugesicherten Invarianten fest:
 *   (0) 0-vs-NULL: eine VORHANDENE Kundenzeile gewinnt IMMER über Standard —
 *       auch bei cents = 0. Es zählt die Existenz der Zeile, nicht der Wert.
 *   (1) Gegenprobe: ohne Kunden-Override → Standard, sonst Katalog-Default.
 *   (2) Zeitversionierung + Tiebreaker (spätestes validFrom, dann höchste id).
 */
import { describe, it, expect } from "vitest";
import {
  resolvePriceFor,
  type VersionedPriceRow,
} from "@shared/domain/pricing/price-for";

function row(p: Partial<VersionedPriceRow> & { id: number; priceCents: number }): VersionedPriceRow {
  return { validFrom: null, validTo: null, ...p };
}

describe("resolvePriceFor — 0-vs-NULL (Existenz gewinnt)", () => {
  it("Kunde mit Anfahrt = 0 → liefert 0 (scope customer), NICHT Standard/Default", () => {
    const res = resolvePriceFor({
      date: "2026-06-15",
      customerRows: [row({ id: 1, priceCents: 0, validFrom: "2026-01-01" })],
      standardRows: [row({ id: 9, priceCents: 5000, validFrom: "2026-01-01" })],
      catalog: { defaultPriceCents: 3500, isBillable: true },
    });
    expect(res).toEqual({ cents: 0, scope: "customer" });
  });

  it("Gegenprobe: kein Kunden-Override → Standard", () => {
    const res = resolvePriceFor({
      date: "2026-06-15",
      customerRows: [],
      standardRows: [row({ id: 9, priceCents: 5000, validFrom: "2026-01-01" })],
      catalog: { defaultPriceCents: 3500, isBillable: true },
    });
    expect(res).toEqual({ cents: 5000, scope: "standard" });
  });

  it("kein Override und kein Standard → Katalog-Default", () => {
    const res = resolvePriceFor({
      date: "2026-06-15",
      customerRows: [],
      standardRows: [],
      catalog: { defaultPriceCents: 3500, isBillable: true },
    });
    expect(res).toEqual({ cents: 3500, scope: "default" });
  });

  it("Kunden-Override > 0 schlägt Standard und Default", () => {
    const res = resolvePriceFor({
      date: "2026-06-15",
      customerRows: [row({ id: 1, priceCents: 4100 })],
      standardRows: [row({ id: 9, priceCents: 5000 })],
      catalog: { defaultPriceCents: 3500, isBillable: true },
    });
    expect(res).toEqual({ cents: 4100, scope: "customer" });
  });
});

describe("resolvePriceFor — Default-Gating & unbekanntes Service", () => {
  it("nicht abrechenbares Service löst Default zu 0 auf", () => {
    const res = resolvePriceFor({
      date: "2026-06-15",
      customerRows: [],
      catalog: { defaultPriceCents: 3500, isBillable: false },
    });
    expect(res).toEqual({ cents: 0, scope: "default" });
  });

  it("Kunden-Override gilt auch für nicht abrechenbares Service (Existenz gewinnt)", () => {
    const res = resolvePriceFor({
      date: "2026-06-15",
      customerRows: [row({ id: 1, priceCents: 1200 })],
      catalog: { defaultPriceCents: 0, isBillable: false },
    });
    expect(res).toEqual({ cents: 1200, scope: "customer" });
  });

  it("kein Katalog-Eintrag und keine Zeilen → null (unbekanntes Service)", () => {
    const res = resolvePriceFor({ date: "2026-06-15", customerRows: [] });
    expect(res).toBeNull();
  });
});

describe("resolvePriceFor — Zeitversionierung & Tiebreaker", () => {
  it("wählt die am Datum aktive Version", () => {
    const rows = [
      row({ id: 1, priceCents: 3000, validFrom: "2025-01-01", validTo: "2025-12-31" }),
      row({ id: 2, priceCents: 4000, validFrom: "2026-01-01", validTo: null }),
    ];
    expect(resolvePriceFor({ date: "2025-06-01", customerRows: rows })).toEqual({ cents: 3000, scope: "customer" });
    expect(resolvePriceFor({ date: "2026-06-01", customerRows: rows })).toEqual({ cents: 4000, scope: "customer" });
  });

  it("Datum vor jeder Kundenzeile → fällt auf Default", () => {
    const res = resolvePriceFor({
      date: "2024-06-01",
      customerRows: [row({ id: 1, priceCents: 4000, validFrom: "2026-01-01" })],
      catalog: { defaultPriceCents: 3500, isBillable: true },
    });
    expect(res).toEqual({ cents: 3500, scope: "default" });
  });

  it("identisches validFrom → höchste id gewinnt (deterministischer Tiebreaker)", () => {
    const rows = [
      row({ id: 5, priceCents: 4000, validFrom: "2026-01-01" }),
      row({ id: 7, priceCents: 4200, validFrom: "2026-01-01" }),
    ];
    expect(resolvePriceFor({ date: "2026-06-01", customerRows: rows })).toEqual({ cents: 4200, scope: "customer" });
  });

  it("offener validFrom (null) zählt als frühester Start", () => {
    const res = resolvePriceFor({
      date: "2026-06-01",
      customerRows: [row({ id: 1, priceCents: 3900, validFrom: null, validTo: null })],
    });
    expect(res).toEqual({ cents: 3900, scope: "customer" });
  });
});
