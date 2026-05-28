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

  it("hides the pending record on the overview page when the customer IS shown in an awaiting-signature / completed overview group (Task #718)", () => {
    const overview = [
      { customerId: 999, undocumentedCount: 0, uncoveredDocumentedCount: 0 },
    ];
    const result = computeVisiblePendingRecords([foreignPending], 2026, 3, null, overview);
    expect(result).toEqual([]);
  });

  it("keeps the pending record visible when the customer is in an ACTION group (needsDoc / ready) — those cards link to a create flow, not the existing record (Task #718)", () => {
    const overviewNeedsDoc = [
      { customerId: 999, undocumentedCount: 2, uncoveredDocumentedCount: 0 },
    ];
    const overviewReady = [
      { customerId: 999, undocumentedCount: 0, uncoveredDocumentedCount: 3 },
    ];
    expect(
      computeVisiblePendingRecords([foreignPending], 2026, 3, null, overviewNeedsDoc),
    ).toHaveLength(1);
    expect(
      computeVisiblePendingRecords([foreignPending], 2026, 3, null, overviewReady),
    ).toHaveLength(1);
  });

  it("tolerates undefined input", () => {
    expect(computeVisiblePendingRecords(undefined, 2026, 5, null)).toEqual([]);
    expect(computeVisiblePendingRecords(undefined, 2026, 5, 100)).toEqual([]);
  });
});
