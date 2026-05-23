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

  it("hides the pending record on the overview page when the selected month equals the record's month", () => {
    const result = computeVisiblePendingRecords([foreignPending], 2026, 3, null);
    expect(result).toEqual([]);
  });

  it("tolerates undefined input", () => {
    expect(computeVisiblePendingRecords(undefined, 2026, 5, null)).toEqual([]);
    expect(computeVisiblePendingRecords(undefined, 2026, 5, 100)).toEqual([]);
  });
});
