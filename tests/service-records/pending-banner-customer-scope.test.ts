import { describe, it, expect } from "vitest";
import { computeVisiblePendingRecords } from "../../client/src/features/service-records/pending-banner";
import type { MonthlyServiceRecord } from "../../shared/schema";

function makeRecord(overrides: Partial<MonthlyServiceRecord>): MonthlyServiceRecord {
  return {
    id: 1,
    customerId: 100,
    employeeId: 1,
    year: 2026,
    month: 3,
    status: "pending_signature",
    ...overrides,
  } as unknown as MonthlyServiceRecord;
}

describe("computeVisiblePendingRecords — customer-scoped pages must not show foreign pending banners", () => {
  const foreignPending = makeRecord({ id: 42, customerId: 999, year: 2026, month: 3 });

  it("returns an empty list on a customer page even when the cache has another customer's pending record", () => {
    const result = computeVisiblePendingRecords([foreignPending], 2026, 5, /* customerId */ 100);
    expect(result).toEqual([]);
  });

  it("returns the pending record on the overview page (no customerId) when month/year don't match", () => {
    const result = computeVisiblePendingRecords([foreignPending], 2026, 5, /* customerId */ null);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(42);
  });

  it("keeps the pending record on the overview page when the selected month matches but the customer is NOT yet handled by an overview group (Task #718: no record disappears)", () => {
    // Without overview data the banner cannot prove the record is already
    // surfaced elsewhere, so it must stay visible to keep the consistency rule
    // "one open record is always shown in EITHER overview OR banner".
    const result = computeVisiblePendingRecords([foreignPending], 2026, 3, null);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(42);
  });

  it("blendet den Nachweis aus, sobald der Abschnitt IHN zeigt", () => {
    // Die Regel wird jetzt am NACHWEIS entschieden, nicht am Kunden: der
    // Abschnitt „Wartet auf Unterschrift" rendert eine Karte je wartendem
    // Nachweis, und genau die verschwinden aus dem Banner.
    const overview = [
      {
        customerId: 999,
        undocumentedCount: 0,
        uncoveredDocumentedCount: 0,
        monthlyRecords: [{ id: 42, status: "pending" }],
      },
    ];
    expect(computeVisiblePendingRecords([foreignPending], 2026, 3, null, overview)).toEqual([]);
  });

  it("LOCKSTEP: auch neben offener Arbeit — kein Nachweis steht doppelt", () => {
    // ── Was diese Prüfung ablöst ─────────────────────────────────────────
    // Vorher hiess der Fall „keeps the pending record visible when the customer
    // is in an ACTION group — those cards link to a create flow, not the
    // existing record". Das war richtig, SOLANGE `bucketize` die
    // Zustands-Abschnitte unterdrückte, sobald es etwas zu tun gab: der
    // wartende Nachweis war dann nirgends sichtbar, und das Banner war seine
    // einzige Auffanglinie.
    //
    // Mit #1914 zeigt der Abschnitt ihn auch neben offener Arbeit. Bliebe das
    // Banner bei der alten Regel, stuende derselbe Nachweis zweimal auf dem
    // Bildschirm — Banner UND Abschnitt. Das ist die Lockstep-Bedingung des
    // Tickets, und sie kippt genau hier.
    const mitOffenerArbeit = [
      {
        customerId: 999,
        undocumentedCount: 2,
        uncoveredDocumentedCount: 3,
        monthlyRecords: [{ id: 42, status: "pending" }],
      },
    ];
    expect(computeVisiblePendingRecords([foreignPending], 2026, 3, null, mitOffenerArbeit)).toEqual([]);
  });

  it("ein FERTIGER Nachweis desselben Kunden blendet das Banner NICHT aus", () => {
    // Gegenprobe: die Menge ist nachweis-, nicht kundenbezogen. Ein Kunde kann
    // einen fertigen und einen wartenden Nachweis haben; nur der wartende steht
    // im Abschnitt, also darf auch nur er aus dem Banner fallen.
    const andererNachweis = [
      {
        customerId: 999,
        undocumentedCount: 0,
        uncoveredDocumentedCount: 0,
        monthlyRecords: [{ id: 77, status: "completed" }],
      },
    ];
    const result = computeVisiblePendingRecords([foreignPending], 2026, 3, null, andererNachweis);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(42);
  });

  it("tolerates undefined input", () => {
    expect(computeVisiblePendingRecords(undefined, 2026, 5, null)).toEqual([]);
    expect(computeVisiblePendingRecords(undefined, 2026, 5, 100)).toEqual([]);
  });
});
