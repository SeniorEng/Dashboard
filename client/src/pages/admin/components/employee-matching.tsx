import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api, unwrapResult } from "@/lib/api";
import { Loader2, Check, X, Sparkles, RefreshCw } from "lucide-react";
import { iconSize } from "@/design-system";

interface MatchReason {
  label: string;
  matched: boolean;
  detail: string;
}

interface MatchResult {
  employeeId: number;
  displayName: string;
  score: number;
  maxScore: number;
  reasons: MatchReason[];
}

interface MatchCriteriaInline {
  plz: string | null;
  haustierVorhanden: boolean;
  personenbefoerderungGewuenscht: boolean;
  geburtsdatum: string | null;
  needsHauswirtschaft: boolean;
  needsAlltagsbegleitung: boolean;
  excludeEmployeeIds?: number[];
}

interface EmployeeMatchingProps {
  customerId?: number;
  inlineCriteria?: MatchCriteriaInline;
  onSelect?: (employeeId: number, displayName: string) => void;
  selectedLabel?: string;
}

export function EmployeeMatching({ customerId, inlineCriteria, onSelect, selectedLabel }: EmployeeMatchingProps) {
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const existingQuery = useQuery<MatchResult[]>({
    queryKey: ["employee-matching", customerId],
    queryFn: async () => {
      const result = await api.get<MatchResult[]>(`/admin/customers/${customerId}/match-employees`);
      return unwrapResult(result);
    },
    enabled: !!customerId && !inlineCriteria,
    staleTime: 30000,
  });

  const inlineMutation = useMutation<MatchResult[], Error, MatchCriteriaInline>({
    mutationFn: async (criteria) => {
      const result = await api.post("/admin/customers/match-employees", criteria);
      return unwrapResult(result) as MatchResult[];
    },
  });

  const results = customerId ? existingQuery.data : inlineMutation.data;
  const isLoading = customerId ? existingQuery.isLoading : inlineMutation.isPending;
  const error = customerId ? existingQuery.error : inlineMutation.error;

  const handleFetchInline = () => {
    if (inlineCriteria) {
      inlineMutation.mutate(inlineCriteria);
    }
  };

  const handleRefresh = () => {
    if (customerId) {
      existingQuery.refetch();
    } else if (inlineCriteria) {
      inlineMutation.mutate(inlineCriteria);
    }
  };

  const handleSelect = (emp: MatchResult) => {
    setSelectedId(emp.employeeId);
    onSelect?.(emp.employeeId, emp.displayName);
  };

  const scorePercent = (score: number, maxScore: number) => Math.round((score / maxScore) * 100);

  const scoreColor = (percent: number) => {
    if (percent >= 80) return "text-green-700 bg-green-50 border-green-200";
    if (percent >= 60) return "text-yellow-700 bg-yellow-50 border-yellow-200";
    return "text-red-700 bg-red-50 border-red-200";
  };

  if (!customerId && !results) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
          <Sparkles className={iconSize.sm} />
          Mitarbeiter-Matching
        </div>
        <p className="text-sm text-gray-500">
          Basierend auf den eingegebenen Kundendaten werden passende Mitarbeiter vorgeschlagen.
        </p>
        <Button
          variant="outline"
          onClick={handleFetchInline}
          disabled={isLoading}
          className="w-full"
          data-testid="button-run-matching"
        >
          {isLoading ? (
            <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
          ) : (
            <Sparkles className={`${iconSize.sm} mr-2`} />
          )}
          Vorschläge berechnen
        </Button>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className={`${iconSize.md} animate-spin text-teal-600`} />
        <span className="ml-2 text-sm text-gray-600">Matching wird berechnet...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-sm text-red-600 p-3 bg-red-50 rounded-lg">
        Fehler beim Matching: {error.message}
      </div>
    );
  }

  if (!results || results.length === 0) {
    return (
      <div className="text-sm text-gray-500 p-3 bg-gray-50 rounded-lg">
        Keine passenden Mitarbeiter gefunden.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
          <Sparkles className={iconSize.sm} />
          {selectedLabel || "Mitarbeiter-Vorschläge"}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleRefresh}
          disabled={isLoading}
          data-testid="button-refresh-matching"
        >
          <RefreshCw className={`${iconSize.xs} mr-1`} />
          Aktualisieren
        </Button>
      </div>

      <div className="space-y-2">
        {results.map((emp, index) => {
          const percent = scorePercent(emp.score, emp.maxScore);
          const isSelected = selectedId === emp.employeeId;

          return (
            <Card
              key={emp.employeeId}
              className={`cursor-pointer transition-all ${
                isSelected ? "ring-2 ring-teal-500 border-teal-500" : "hover:border-gray-300"
              }`}
              onClick={() => handleSelect(emp)}
              data-testid={`match-card-${emp.employeeId}`}
            >
              <CardContent className="p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-gray-400">#{index + 1}</span>
                    <span className="font-medium text-sm">{emp.displayName}</span>
                    {isSelected && (
                      <Check className={`${iconSize.sm} text-teal-600`} />
                    )}
                  </div>
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${scoreColor(percent)}`}>
                    {percent}%
                  </span>
                </div>

                <div className="flex flex-wrap gap-1">
                  {emp.reasons.map((reason, i) => (
                    <span
                      key={i}
                      className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded ${
                        reason.matched
                          ? "bg-green-50 text-green-700"
                          : "bg-red-50 text-red-700"
                      }`}
                      title={reason.detail}
                      data-testid={`match-reason-${emp.employeeId}-${i}`}
                    >
                      {reason.matched ? (
                        <Check className="w-3 h-3" />
                      ) : (
                        <X className="w-3 h-3" />
                      )}
                      {reason.label}
                    </span>
                  ))}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
