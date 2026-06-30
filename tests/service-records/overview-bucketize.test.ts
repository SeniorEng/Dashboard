import { describe, expect, it } from "vitest";
import {
  bucketize,
  type CustomerOverviewItem,
} from "../../client/src/features/service-records/components/overview-sections";

function makeItem(overrides: Partial<CustomerOverviewItem>): CustomerOverviewItem {
  return {
    customerId: 0,
    customerName: "",
    monthlyRecords: [],
    singleRecords: [],
    documentedCount: 0,
    undocumentedCount: 0,
    totalAppointments: 0,
    coveredBySingleCount: 0,
    coveredByMonthlyCount: 0,
    uncoveredDocumentedCount: 0,
    status: "ready",
    canCreateRecord: false,
    ...overrides,
  };
}

describe("bucketize — Wolfgang/Rosali regression (Task #718)", () => {
  // Mirror of the Ursula-Mai-2026 production case described in the task.
  const wolfgang = makeItem({
    customerId: 1,
    customerName: "Wolfgang Seidel",
    monthlyRecords: [{ id: 81, status: "pending" }],
    singleRecords: [],
    documentedCount: 3,
    undocumentedCount: 0,
    totalAppointments: 3,
    coveredByMonthlyCount: 3,
    uncoveredDocumentedCount: 0,
  });

  const rosali = makeItem({
    customerId: 2,
    customerName: "Rosali Demirev",
    monthlyRecords: [{ id: 82, status: "pending" }],
    singleRecords: [{ id: 83, status: "completed", recordType: "single" }],
    documentedCount: 3,
    undocumentedCount: 0,
    totalAppointments: 3,
    coveredBySingleCount: 1,
    coveredByMonthlyCount: 2,
    uncoveredDocumentedCount: 0,
  });

  const completedOnly = makeItem({
    customerId: 3,
    customerName: "Carla Completed",
    monthlyRecords: [{ id: 90, status: "completed" }],
    documentedCount: 2,
    totalAppointments: 2,
    coveredByMonthlyCount: 2,
  });

  const onlyOpenAppointments = makeItem({
    customerId: 4,
    customerName: "Doris Doku",
    documentedCount: 0,
    undocumentedCount: 2,
    totalAppointments: 2,
  });

  const readyToCreate = makeItem({
    customerId: 5,
    customerName: "Erika Ready",
    documentedCount: 4,
    undocumentedCount: 0,
    totalAppointments: 4,
    uncoveredDocumentedCount: 4,
  });

  it("puts Wolfgang and Rosali into the awaiting-signature bucket exactly once", () => {
    const buckets = bucketize([wolfgang, rosali, completedOnly, onlyOpenAppointments, readyToCreate]);
    const awaitingIds = buckets.awaitingSignature.map((i) => i.customerId);
    expect(awaitingIds).toEqual([2, 1]); // Demirev before Seidel by Nachname
    expect(buckets.completed.map((i) => i.customerId)).toEqual([3]);
    expect(buckets.needsDoc.map((i) => i.customerId)).toEqual([4]);
    expect(buckets.ready.map((i) => i.customerId)).toEqual([5]);
  });

  it("invariant: every customer with activity ends up in exactly one bucket", () => {
    const items = [wolfgang, rosali, completedOnly, onlyOpenAppointments, readyToCreate];
    const buckets = bucketize(items);
    const seen = new Set<number>();
    const all = [
      ...buckets.needsDoc,
      ...buckets.ready,
      ...buckets.awaitingSignature,
      ...buckets.completed,
      ...buckets.orphans,
    ];
    for (const it of all) {
      expect(seen.has(it.customerId)).toBe(false);
      seen.add(it.customerId);
    }
    expect(seen.size).toBe(items.length);
  });

  it("action buckets keep priority over awaiting-signature when the customer ALSO has open work", () => {
    // Customer has a pending monthly record AND still uncovered documented
    // appointments. Action takes priority — they belong in `ready`, not in
    // `awaitingSignature` (the banner still surfaces the pending record).
    const mixed = makeItem({
      customerId: 99,
      customerName: "Mixed Case",
      monthlyRecords: [{ id: 999, status: "pending" }],
      documentedCount: 5,
      undocumentedCount: 0,
      totalAppointments: 5,
      uncoveredDocumentedCount: 2,
    });
    const buckets = bucketize([mixed]);
    expect(buckets.ready.map((i) => i.customerId)).toEqual([99]);
    expect(buckets.awaitingSignature).toEqual([]);
  });

  it("customer with ONLY a pending single record (no monthly) still lands in awaiting-signature", () => {
    const pendingSingleOnly = makeItem({
      customerId: 7,
      customerName: "Petra Pending-Single",
      singleRecords: [{ id: 700, status: "pending", recordType: "single" }],
      documentedCount: 1,
      totalAppointments: 1,
      coveredBySingleCount: 1,
    });
    const buckets = bucketize([pendingSingleOnly]);
    expect(buckets.awaitingSignature.map((i) => i.customerId)).toEqual([7]);
    expect(buckets.completed).toEqual([]);
  });
});
