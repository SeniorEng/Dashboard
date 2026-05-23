import type { MonthlyServiceRecord } from "@shared/schema";

export function computeVisiblePendingRecords(
  pendingRecords: MonthlyServiceRecord[] | undefined,
  selectedYear: number,
  selectedMonth: number,
  customerId: number | null,
): MonthlyServiceRecord[] {
  if (customerId) return [];
  return (pendingRecords ?? []).filter(
    (r) => !(r.year === selectedYear && r.month === selectedMonth),
  );
}
