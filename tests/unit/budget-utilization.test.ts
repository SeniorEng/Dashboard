/**
 * Task #937 — Direkte Unit-Tests für die in Task #928 ausgelagerte reine
 * Budget-Ausnutzungs-Mathematik (`shared/domain/budget/utilization.ts`).
 *
 * Fortschrittsbalken (gedeckelt auf 100 %) und KPI-Kacheln (ungedeckelt)
 * teilen dieselbe Formel. Diese Tests pinnen die Rundung, die Division-durch-0-
 * Absicherung (`allocated <= 0`) und das 100-%-Deckelverhalten, damit beide
 * Anzeige-Pfade nicht auseinanderdriften.
 */
import { describe, it, expect } from "vitest";
import {
  utilizationPercent,
  clampedUtilizationPercent,
} from "@shared/domain/budget/utilization";

describe("utilizationPercent", () => {
  it("berechnet eine einfache Quote (gerundet)", () => {
    expect(utilizationPercent(50, 100)).toBe(50);
  });

  it("rundet kaufmännisch (0,5 → auf)", () => {
    // 1/3 = 33,33… → 33
    expect(utilizationPercent(1, 3)).toBe(33);
    // 2/3 = 66,66… → 67
    expect(utilizationPercent(2, 3)).toBe(67);
  });

  it("gibt 0 zurück, wenn nichts genutzt wurde", () => {
    expect(utilizationPercent(0, 100)).toBe(0);
  });

  it("gibt 0 zurück bei allocated === 0 (keine Division durch 0)", () => {
    expect(utilizationPercent(50, 0)).toBe(0);
  });

  it("gibt 0 zurück bei negativem allocated", () => {
    expect(utilizationPercent(50, -100)).toBe(0);
  });

  it("liefert ungedeckelt Werte über 100 % (Überziehung)", () => {
    expect(utilizationPercent(150, 100)).toBe(150);
  });

  it("liefert exakt 100 % bei voller Ausnutzung", () => {
    expect(utilizationPercent(100, 100)).toBe(100);
  });
});

describe("clampedUtilizationPercent", () => {
  it("entspricht utilizationPercent unterhalb von 100 %", () => {
    expect(clampedUtilizationPercent(50, 100)).toBe(50);
  });

  it("deckelt Überziehung auf 100 %", () => {
    expect(clampedUtilizationPercent(150, 100)).toBe(100);
  });

  it("liefert genau 100 % bei voller Ausnutzung", () => {
    expect(clampedUtilizationPercent(100, 100)).toBe(100);
  });

  it("gibt 0 zurück bei allocated <= 0", () => {
    expect(clampedUtilizationPercent(50, 0)).toBe(0);
    expect(clampedUtilizationPercent(50, -1)).toBe(0);
  });
});
