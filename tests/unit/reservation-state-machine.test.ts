/**
 * Task #875 (Budget GF Phase 5) — Reservation/Ledger state machine (I3).
 * Reine Logik (unit-Project, kein Server/DB).
 *
 * Beweist, dass NUR die north-star-Übergänge erlaubt sind und alle anderen
 * (insb. das Wiederbeleben eines terminalen Zustands, R5 post-or-void-once)
 * hart scheitern.
 */
import { describe, expect, it } from "vitest";
import {
  isValidReservationTransition,
  isTerminalReservationState,
  assertReservationTransition,
  isValidLedgerTransition,
  assertLedgerTransition,
} from "@shared/domain/budget/reservation-state-machine";
import {
  BUDGET_RESERVATION_STATES,
  BUDGET_LEDGER_STATES,
} from "@shared/schema/budget";

const ALLOWED_RESERVATION: ReadonlyArray<[string, string]> = [
  ["hold", "captured"],
  ["hold", "released"],
  ["hold", "expired"],
];

const ALLOWED_LEDGER: ReadonlyArray<[string, string]> = [["consumed", "reversed"]];

describe("Budget GF Phase 5 — Reservation state machine (I3, Task #875)", () => {
  it("erlaubt GENAU die north-star-Reservierungs-Übergänge", () => {
    for (const from of BUDGET_RESERVATION_STATES) {
      for (const to of BUDGET_RESERVATION_STATES) {
        const expected = ALLOWED_RESERVATION.some(([f, t]) => f === from && t === to);
        expect(isValidReservationTransition(from, to)).toBe(expected);
      }
    }
  });

  it("captured/released/expired sind terminal (R5 post-or-void-once)", () => {
    expect(isTerminalReservationState("hold")).toBe(false);
    expect(isTerminalReservationState("captured")).toBe(true);
    expect(isTerminalReservationState("released")).toBe(true);
    expect(isTerminalReservationState("expired")).toBe(true);
  });

  it("kein Wiederbeleben terminaler Zustände (captured→released etc. wirft)", () => {
    const terminals = ["captured", "released", "expired"] as const;
    for (const from of terminals) {
      for (const to of BUDGET_RESERVATION_STATES) {
        expect(() => assertReservationTransition(from, to)).toThrow(/Ungültiger Reservierungs-Übergang/);
      }
    }
  });

  it("assertReservationTransition passiert für legale Sprünge", () => {
    for (const [from, to] of ALLOWED_RESERVATION) {
      expect(() => assertReservationTransition(from as never, to as never)).not.toThrow();
    }
  });

  it("Ledger: nur consumed→reversed erlaubt; reversed ist terminal", () => {
    for (const from of BUDGET_LEDGER_STATES) {
      for (const to of BUDGET_LEDGER_STATES) {
        const expected = ALLOWED_LEDGER.some(([f, t]) => f === from && t === to);
        expect(isValidLedgerTransition(from, to)).toBe(expected);
      }
    }
    expect(() => assertLedgerTransition("reversed", "consumed")).toThrow(/Ungültiger Ledger-Übergang/);
    expect(() => assertLedgerTransition("consumed", "reversed")).not.toThrow();
  });
});
