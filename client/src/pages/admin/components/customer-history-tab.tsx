import { formatDateForDisplay } from "@shared/utils/datetime";
import { SectionCard } from "@/components/patterns/section-card";
import { EmptyState } from "@/components/patterns/empty-state";
import { StatusBadge } from "@/components/patterns/status-badge";
import { iconSize } from "@/design-system";
import { History } from "lucide-react";
import type { CustomerDetail } from "@/lib/api/types";

interface CustomerHistoryTabProps {
  customer: CustomerDetail;
}

export function CustomerHistoryTab({ customer }: CustomerHistoryTabProps) {
  return (
    <div className="space-y-4">
      <SectionCard
        title="Pflegegrad-Verlauf"
        icon={<History className={iconSize.sm} />}
      >
        {customer.careLevelHistory && customer.careLevelHistory.length > 0 ? (
          <div className="relative">
            <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-gray-200" />
            <div className="space-y-4">
              {customer.careLevelHistory.map((entry, index) => (
                <div key={entry.id} className="relative pl-10">
                  <div
                    className={`absolute left-2.5 w-3 h-3 rounded-full ${
                      index === 0 ? "bg-teal-500" : "bg-gray-300"
                    }`}
                  />
                  <div className="p-3 rounded-lg bg-gray-50">
                    <div className="flex items-center justify-between">
                      <StatusBadge type="pflegegrad" value={entry.pflegegrad} />
                      <span className="text-xs text-gray-500">
                        {formatDateForDisplay(entry.validFrom)}
                        {entry.validTo && ` - ${formatDateForDisplay(entry.validTo)}`}
                      </span>
                    </div>
                    {entry.notes && (
                      <p className="text-sm text-gray-600 mt-2">{entry.notes}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <EmptyState
            icon={<History className={iconSize.xl} />}
            title="Kein Verlauf"
            description="Kein Pflegegrad-Verlauf vorhanden"
            className="py-6"
          />
        )}
      </SectionCard>
    </div>
  );
}
