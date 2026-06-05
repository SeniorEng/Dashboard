/**
 * Task #987 — Architektur-/Drift-Test für die Phantom-Storno-Erkennung.
 *
 * Schlägt an, sobald im Ledger ein verwaister Reversal (`reversed_transaction_id
 * IS NULL`, Notiz "Storno von Transaktion #N") mit einer ZUGEHÖRIGEN regulären
 * Storno-Zeile für dieselbe Original-Buchung auftritt — also die
 * Phantom-Doppel-Gutschrift, die Task #987 beseitigt hat und die nie wieder
 * entstehen darf. Rein (keine DB/IO): testet die SSoT-Logik aus
 * `shared/domain/budget/phantom-storno.ts`, die Reconcile-Skript UND
 * Schreib-Guard (`reverseBudgetTransaction`) gemeinsam nutzen.
 */
import { describe, it, expect } from "vitest";
import {
  parseStornoReference,
  detectPhantomDoubleStornos,
  classifyOrphanStornos,
  isPhantomCorrectionFor,
  type PhantomLedgerRow,
} from "@shared/domain/budget/phantom-storno";

function consumption(id: number, opts: Partial<PhantomLedgerRow> & { appointmentId: number | null }): PhantomLedgerRow {
  return {
    id,
    customerId: 39,
    budgetType: "entlastungsbetrag_45b",
    transactionType: "consumption",
    amountCents: -2282,
    reversedTransactionId: null,
    notes: null,
    ...opts,
  };
}
function linkedReversal(id: number, refId: number, opts: Partial<PhantomLedgerRow> = {}): PhantomLedgerRow {
  return {
    id,
    customerId: 39,
    budgetType: "entlastungsbetrag_45b",
    transactionType: "reversal",
    amountCents: 2282,
    appointmentId: null,
    reversedTransactionId: refId,
    notes: `Storno von Transaktion #${refId}`,
    ...opts,
  };
}
function orphanReversal(id: number, refId: number, opts: Partial<PhantomLedgerRow> = {}): PhantomLedgerRow {
  return {
    id,
    customerId: 39,
    budgetType: "entlastungsbetrag_45b",
    transactionType: "reversal",
    amountCents: 2282,
    appointmentId: 303,
    reversedTransactionId: null,
    notes: `Storno von Transaktion #${refId}`,
    ...opts,
  };
}

describe("Task #987 — parseStornoReference", () => {
  it("liest die Referenz aus allen Notiz-Varianten", () => {
    expect(parseStornoReference("Storno von Transaktion #114")).toBe(114);
    expect(parseStornoReference("Storno von Transaktion #69 (Umbuchung)")).toBe(69);
    expect(parseStornoReference("Storno (Termin-Edit) von Transaktion #33")).toBe(33);
    expect(parseStornoReference("Storno (Reconcile #116) von Transaktion #42")).toBe(42);
  });
  it("ignoriert Nicht-Storno-Notizen und Leerwerte", () => {
    expect(parseStornoReference(null)).toBeNull();
    expect(parseStornoReference("Verbrauch Termin")).toBeNull();
    // Korrektur-Notizen (#987) referenzieren KEINE Storno-Buchung.
    expect(parseStornoReference("Phantom-Storno-Korrektur (Task #987): Gegenbuchung zum verwaisten Storno #115 (ref #114).")).toBeNull();
  });
});

describe("Task #987 — detectPhantomDoubleStornos (Drift-Detektor)", () => {
  it("schlägt an bei verwaistem Reversal + verknüpfter Storno-Zeile für dieselbe Original-Buchung", () => {
    // Prod-Form Kunde 39: #114 verbraucht, #693 reversiert verknüpft, #115 ist die Waise.
    const rows: PhantomLedgerRow[] = [
      consumption(114, { appointmentId: null }),
      linkedReversal(693, 114),
      orphanReversal(115, 114),
    ];
    const hits = detectPhantomDoubleStornos(rows);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ orphanId: 115, referencedConsumptionId: 114, customerId: 39 });
  });

  it("ein sauberes Ledger (nur verknüpfte Stornos) löst NICHT aus", () => {
    const rows: PhantomLedgerRow[] = [
      consumption(10, { appointmentId: 1 }),
      linkedReversal(11, 10),
    ];
    expect(detectPhantomDoubleStornos(rows)).toHaveLength(0);
  });

  it("verwaister Einzel-Storno OHNE verknüpfte Zeile ist kein Doppel-Storno", () => {
    const rows: PhantomLedgerRow[] = [
      consumption(20, { appointmentId: 2 }),
      orphanReversal(21, 20, { appointmentId: 2 }),
    ];
    expect(detectPhantomDoubleStornos(rows)).toHaveLength(0);
  });
});

describe("Task #987 — classifyOrphanStornos (Reconcile-Klassifikation)", () => {
  it("verknüpfter Doppel-Storno → Phantom (double_storno_linked)", () => {
    const rows: PhantomLedgerRow[] = [
      consumption(114, { appointmentId: null }),
      linkedReversal(693, 114),
      orphanReversal(115, 114),
    ];
    const classified = classifyOrphanStornos({ rows, consumptionAppointmentLive: new Map() });
    const phantom = classified.filter((c) => c.isPhantom);
    expect(phantom).toHaveLength(1);
    expect(phantom[0]).toMatchObject({ referencedConsumptionId: 114, reason: "double_storno_linked" });
  });

  it("Einzel-Storno eines LEBENDEN (geleisteten) Termins → Phantom (live_appointment_consumption)", () => {
    const rows: PhantomLedgerRow[] = [
      consumption(108, { appointmentId: 252, amountCents: -12590 }),
      orphanReversal(109, 108, { appointmentId: 252, amountCents: 12590 }),
    ];
    const classified = classifyOrphanStornos({
      rows,
      consumptionAppointmentLive: new Map([[108, true]]),
    });
    expect(classified.filter((c) => c.isPhantom).map((c) => c.reason)).toEqual(["live_appointment_consumption"]);
  });

  it("Einzel-Storno eines STORNIERTEN/gelöschten Termins → legitim, NICHT anfassen", () => {
    const rows: PhantomLedgerRow[] = [
      consumption(108, { appointmentId: 252, amountCents: -12590 }),
      orphanReversal(109, 108, { appointmentId: 252, amountCents: 12590 }),
    ];
    const classified = classifyOrphanStornos({
      rows,
      consumptionAppointmentLive: new Map([[108, false]]),
    });
    expect(classified.every((c) => !c.isPhantom)).toBe(true);
    expect(classified[0].reason).toBe("skipped_legit_cancellation");
  });

  it("doppelte Waisen auf dieselbe Original-Buchung werden BEIDE als Phantom klassifiziert", () => {
    // Kunde 58: #26 wird von #30 UND #31 verwaist storniert (Termin lebt).
    const rows: PhantomLedgerRow[] = [
      consumption(26, { appointmentId: 203, amountCents: -4049 }),
      orphanReversal(30, 26, { appointmentId: 203, amountCents: 4049 }),
      orphanReversal(31, 26, { appointmentId: 203, amountCents: 4049 }),
    ];
    const classified = classifyOrphanStornos({ rows, consumptionAppointmentLive: new Map([[26, true]]) });
    expect(classified.filter((c) => c.isPhantom)).toHaveLength(2);
  });
});

describe("Task #987 — isPhantomCorrectionFor (Idempotenz)", () => {
  it("matcht exakt auf die Waisen-ID und vermeidet Präfix-Kollisionen", () => {
    const note = "Phantom-Storno-Korrektur (Task #987): Gegenbuchung zum verwaisten Storno #115 (ref #114).";
    expect(isPhantomCorrectionFor(note, 115)).toBe(true);
    expect(isPhantomCorrectionFor(note, 11)).toBe(false);
    expect(isPhantomCorrectionFor(note, 1150)).toBe(false);
    expect(isPhantomCorrectionFor(null, 115)).toBe(false);
  });
});
