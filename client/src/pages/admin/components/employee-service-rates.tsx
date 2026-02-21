import { useQuery } from "@tanstack/react-query";
import { iconSize } from "@/design-system";
import { Loader2, Euro } from "lucide-react";
import { api, unwrapResult } from "@/lib/api/client";

interface ServiceData {
  id: number;
  name: string;
  code: string | null;
  unitType: string;
  defaultPriceCents: number;
  employeeRateCents: number;
  isActive: boolean;
  isBillable: boolean;
}

const UNIT_LABELS: Record<string, string> = {
  hours: "/Std.",
  kilometers: "/km",
  flat: "pauschal",
};

function formatCurrency(cents: number): string {
  return `${(cents / 100).toFixed(2)} €`;
}

export function EmployeeServiceRates() {
  const { data: services, isLoading } = useQuery<ServiceData[]>({
    queryKey: ["services"],
    queryFn: async () => {
      const result = await api.get<ServiceData[]>("/services");
      return unwrapResult(result);
    },
    staleTime: 60000,
  });

  const activeServices = services?.filter(s => s.isActive && s.employeeRateCents > 0) || [];

  return (
    <div className="mt-6 pt-6 border-t">
      <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2 mb-3">
        <Euro className={iconSize.sm} />
        Vergütung je Dienstleistung (aus Katalog)
      </h3>

      {isLoading ? (
        <div className="flex justify-center py-4">
          <Loader2 className={`${iconSize.md} animate-spin text-teal-600`} />
        </div>
      ) : activeServices.length > 0 ? (
        <div className="space-y-1.5">
          {activeServices.map(s => (
            <div key={s.id} className="flex items-center justify-between px-3 py-2 bg-gray-50 rounded text-sm" data-testid={`service-rate-${s.id}`}>
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-gray-900 truncate">{s.name}</span>
                {s.code && <span className="text-xs text-gray-400 shrink-0">({s.code})</span>}
              </div>
              <span className="text-teal-700 font-medium shrink-0 ml-2">
                {formatCurrency(s.employeeRateCents)}{UNIT_LABELS[s.unitType] || ""}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-gray-500 py-4 text-center">Keine Dienstleistungen mit Mitarbeitervergütung definiert</p>
      )}

      <p className="text-[11px] text-gray-400 mt-2">
        Die Vergütungssätze werden im Dienstleistungskatalog global festgelegt und gelten für alle Mitarbeiter.
      </p>
    </div>
  );
}
