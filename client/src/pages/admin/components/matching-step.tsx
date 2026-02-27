import { CustomerFormData } from "./customer-types";
import { EmployeeMatching } from "./employee-matching";
import { UserCheck } from "lucide-react";
import { iconSize } from "@/design-system";

interface MatchingStepProps {
  formData: CustomerFormData;
  onChange: (field: string, value: string | boolean) => void;
}

export function MatchingStep({ formData, onChange }: MatchingStepProps) {
  const hasSelection = !!formData.primaryEmployeeId;

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-600">
        Optional: Wählen Sie einen Hauptansprechpartner für den Kunden aus. Die Vorschläge basieren auf den eingegebenen Kundendaten. Sie können diesen Schritt auch überspringen.
      </p>

      {hasSelection && (
        <div className="flex items-start gap-2 p-3 bg-green-50 border border-green-200 rounded-lg">
          <UserCheck className={`${iconSize.sm} text-green-600 shrink-0 mt-0.5`} />
          <p className="text-sm text-green-700">
            Hauptansprechpartner ausgewählt.
          </p>
        </div>
      )}

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
    </div>
  );
}
