import type { MonthlyServiceRecord } from "@shared/schema";

export interface PendingBannerOverviewItem {
  customerId: number;
  undocumentedCount: number;
  uncoveredDocumentedCount: number;
}

export function computeVisiblePendingRecords(
  pendingRecords: MonthlyServiceRecord[] | undefined,
  selectedYear: number,
  selectedMonth: number,
  customerId: number | null,
  overview?: PendingBannerOverviewItem[],
): MonthlyServiceRecord[] {
  if (customerId) return [];
  const records = pendingRecords ?? [];
  // Customers handled by the overview's display buckets (awaiting-signature,
  // completed, orphan) — those that have NO open action work for the selected
  // month. For customers in the action buckets (needsDoc / ready) the overview
  // card links to a create flow, not to the existing pending record, so the
  // banner must still surface them.
  const customersShownInOverview = new Set<number>();
  for (const item of overview ?? []) {
    if (item.undocumentedCount > 0) continue;
    if (item.uncoveredDocumentedCount > 0) continue;
    customersShownInOverview.add(item.customerId);
  }
  return records.filter((r) => {
    if (r.year !== selectedYear || r.month !== selectedMonth) return true;
    return !customersShownInOverview.has(r.customerId);
  });
}
