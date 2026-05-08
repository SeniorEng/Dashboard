import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CustomerFormData } from "./customer-types";
import { EmployeeMatching } from "../admin/employee-matching";
import { UserCheck, UserPlus, Sparkles } from "lucide-react";
import { iconSize } from "@/design-system";
import { api, unwrapResult } from "@/lib/api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";

interface SimpleEmployee {
  id: number;
  displayName: string;
  isActive: boolean;
}

interface MatchingStepProps {
  formData: CustomerFormData;
  onChange: (field: string, value: string | boolean) => void;
}

export function MatchingStep({ formData, onChange }: MatchingStepProps) {
  const [mode, setMode] = useState<"matching" | "manual">("matching");
  const hasSelection = !!formData.primaryEmployeeId;

  const { data: employees } = useQuery<SimpleEmployee[]>({
    queryKey: ["admin", "users"],
    queryFn: async () => {
      const result = await api.get<SimpleEmployee[]>("/admin/users");
      return unwrapResult(result);
    },
    select: (data) => data.filter(e => e.isActive),
  });

  const selectedName = employees?.find(e => e.id.toString() === formData.primaryEmployeeId)?.displayName;

  const handleManualSelect = (value: string) => {
    onChange("primaryEmployeeId", value);
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-600">
        Optional: Wählen Sie einen Hauptansprechpartner für den Kunden aus. Sie können die automatischen Vorschläge nutzen oder direkt einen Mitarbeiter auswählen.
      </p>

      {hasSelection && (
        <div className="flex items-start gap-2 p-3 bg-green-50 border border-green-200 rounded-lg">
          <UserCheck className={`${iconSize.sm} text-green-600 shrink-0 mt-0.5`} />
          <p className="text-sm text-green-700">
            Hauptansprechpartner ausgewählt{selectedName ? `: ${selectedName}` : ""}.
          </p>
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setMode("matching")}
          className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
            mode === "matching"
              ? "bg-teal-50 text-teal-700 border border-teal-200"
              : "bg-gray-50 text-gray-600 border border-gray-200 hover:bg-gray-100"
          }`}
          data-testid="tab-matching"
        >
          <Sparkles className="w-3.5 h-3.5" />
          Vorschläge
        </button>
        <button
          type="button"
          onClick={() => setMode("manual")}
          className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
            mode === "manual"
              ? "bg-teal-50 text-teal-700 border border-teal-200"
              : "bg-gray-50 text-gray-600 border border-gray-200 hover:bg-gray-100"
          }`}
          data-testid="tab-manual-select"
        >
          <UserPlus className="w-3.5 h-3.5" />
          Direkt auswählen
        </button>
      </div>

      {mode === "matching" ? (
        <EmployeeMatching
          inlineCriteria={{
            plz: formData.plz || null,
            haustierVorhanden: formData.haustierVorhanden,
            personenbefoerderungGewuenscht: formData.personenbefoerderungGewuenscht,
            geburtsdatum: formData.geburtsdatum || null,
            needsHauswirtschaft: false,
            needsAlltagsbegleitung: false,
            excludeEmployeeIds: [],
          }}
          onSelect={(employeeId, _displayName) => {
            onChange("primaryEmployeeId", employeeId.toString());
          }}
          selectedLabel="Mitarbeiter-Vorschläge"
        />
      ) : (
        <div className="space-y-3">
          <Label htmlFor="manual-employee-select" className="text-sm font-medium text-gray-700">
            Mitarbeiter auswählen
          </Label>
          <Select
            value={formData.primaryEmployeeId || undefined}
            onValueChange={handleManualSelect}
          >
            <SelectTrigger id="manual-employee-select" data-testid="select-manual-employee">
              <SelectValue placeholder="Mitarbeiter wählen..." />
            </SelectTrigger>
            <SelectContent>
              {employees?.map(emp => (
                <SelectItem key={emp.id} value={emp.id.toString()} data-testid={`option-employee-${emp.id}`}>
                  {emp.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!employees?.length && (
            <p className="text-xs text-gray-500">Keine aktiven Mitarbeiter verfügbar.</p>
          )}
        </div>
      )}

      <div className="border-t pt-4 space-y-4">
        <div className="space-y-3">
          <Label htmlFor="backup-employee-select" className="text-sm font-medium text-gray-700">
            1. Vertretung (optional)
          </Label>
          <Select
            value={formData.backupEmployeeId || undefined}
            onValueChange={(value) => onChange("backupEmployeeId", value)}
          >
            <SelectTrigger id="backup-employee-select" data-testid="select-backup-employee">
              <SelectValue placeholder="Vertretung wählen..." />
            </SelectTrigger>
            <SelectContent>
              {employees
                ?.filter(emp => emp.id.toString() !== formData.primaryEmployeeId && emp.id.toString() !== formData.backupEmployeeId2)
                .map(emp => (
                  <SelectItem key={emp.id} value={emp.id.toString()} data-testid={`option-backup-employee-${emp.id}`}>
                    {emp.displayName}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-3">
          <Label htmlFor="backup-employee-2-select" className="text-sm font-medium text-gray-700">
            2. Vertretung (optional)
          </Label>
          <Select
            value={formData.backupEmployeeId2 || undefined}
            onValueChange={(value) => onChange("backupEmployeeId2", value)}
          >
            <SelectTrigger id="backup-employee-2-select" data-testid="select-backup-employee-2">
              <SelectValue placeholder="2. Vertretung wählen..." />
            </SelectTrigger>
            <SelectContent>
              {employees
                ?.filter(emp => emp.id.toString() !== formData.primaryEmployeeId && emp.id.toString() !== formData.backupEmployeeId)
                .map(emp => (
                  <SelectItem key={emp.id} value={emp.id.toString()} data-testid={`option-backup-employee-2-${emp.id}`}>
                    {emp.displayName}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
