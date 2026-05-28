import { AlertCircle, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import type { MonthlyServiceRecord } from "@shared/schema";
import { iconSize } from "@/design-system";
import {
  computeVisiblePendingRecords,
  type PendingBannerOverviewItem,
} from "./pending-banner";

export interface PendingBannerSectionProps {
  pendingRecords: MonthlyServiceRecord[] | undefined;
  selectedYear: number;
  selectedMonth: number;
  customerId: number | null;
  onSingleClick: (record: MonthlyServiceRecord) => void;
  onMultiClick: () => void;
  renderSingleLabel: (record: MonthlyServiceRecord) => ReactNode;
  overview?: PendingBannerOverviewItem[];
}

export function PendingBannerSection({
  pendingRecords,
  selectedYear,
  selectedMonth,
  customerId,
  onSingleClick,
  onMultiClick,
  renderSingleLabel,
  overview,
}: PendingBannerSectionProps) {
  const visible = computeVisiblePendingRecords(
    pendingRecords,
    selectedYear,
    selectedMonth,
    customerId,
    overview,
  );
  if (visible.length === 0) return null;
  const single = visible.length === 1 ? visible[0] : null;
  return (
    <div
      className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg cursor-pointer hover:bg-amber-100 transition-colors"
      data-testid="banner-pending"
      onClick={() => (single ? onSingleClick(single) : onMultiClick())}
    >
      <div className="flex items-center gap-2 text-amber-800">
        <AlertCircle className={iconSize.sm} />
        <span className="text-sm font-medium flex-1">
          {single ? (
            <>1 Leistungsnachweis offen – {renderSingleLabel(single)}</>
          ) : (
            <>{visible.length} Leistungsnachweise benötigen noch Unterschriften</>
          )}
        </span>
        <ChevronRight className={`${iconSize.sm} ml-auto`} />
      </div>
    </div>
  );
}
