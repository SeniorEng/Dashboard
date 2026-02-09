import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CustomerFormData, PERIOD_TYPES } from "./customer-types";

interface BudgetsStepProps {
  formData: CustomerFormData;
  onChange: (field: string, value: string | boolean) => void;
}

export function BudgetsStep({ formData, onChange }: BudgetsStepProps) {
  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-600">
        Erfassen Sie die monatlichen Leistungsansprüche des Kunden.
      </p>

      <div className="space-y-4">
        <div className="p-4 rounded-lg bg-green-50 border border-green-100">
          <div className="space-y-2">
            <Label htmlFor="entlastungsbetrag45b">§45b Entlastungsbetrag (€/Monat)</Label>
            <Input
              id="entlastungsbetrag45b"
              type="number"
              step="0.01"
              value={formData.entlastungsbetrag45b}
              onChange={(e) => onChange("entlastungsbetrag45b", e.target.value)}
              data-testid="input-budget-45b"
            />
            <p className="text-xs text-gray-500">Standard: 131 €/Monat</p>
          </div>
        </div>

        <div className="p-4 rounded-lg bg-purple-50 border border-purple-100">
          <div className="space-y-2">
            <Label htmlFor="pflegesachleistungen36">§45a Umwandlungsanspruch (€/Monat)</Label>
            <Input
              id="pflegesachleistungen36"
              type="number"
              step="0.01"
              value={formData.pflegesachleistungen36}
              onChange={(e) => onChange("pflegesachleistungen36", e.target.value)}
              data-testid="input-budget-36"
            />
            <p className="text-xs text-gray-500">
              Max. 40% der ungenutzten Sachleistungen (PG2: 318€, PG3: 599€, PG4: 744€, PG5: 920€)
            </p>
          </div>
        </div>

        <div className="p-4 rounded-lg bg-blue-50 border border-blue-100">
          <div className="space-y-2">
            <Label htmlFor="verhinderungspflege39">§39/§42a Gemeinsamer Jahresbetrag (€/Jahr)</Label>
            <Input
              id="verhinderungspflege39"
              type="number"
              step="0.01"
              value={formData.verhinderungspflege39}
              onChange={(e) => onChange("verhinderungspflege39", e.target.value)}
              data-testid="input-budget-39"
            />
            <p className="text-xs text-gray-500">Standard: 3.539 €/Jahr (Ersatzpflege + Kurzzeitpflege, ab 01.07.2025)</p>
          </div>
        </div>
      </div>
    </div>
  );
}

interface ContractStepProps {
  formData: CustomerFormData;
  onChange: (field: string, value: string | boolean) => void;
}

export function ContractStep({ formData, onChange }: ContractStepProps) {
  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-600">
        Legen Sie die Vertragsbedingungen und Stundensätze fest.
      </p>

      <div className="border-b pb-4">
        <h3 className="font-medium mb-4">Vereinbarte Leistungen</h3>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="contractHours">Stunden pro Zeitraum</Label>
            <Input
              id="contractHours"
              type="number"
              step="0.5"
              value={formData.contractHours}
              onChange={(e) => onChange("contractHours", e.target.value)}
              data-testid="input-contract-hours"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="contractPeriod">Zeitraum</Label>
            <Select
              value={formData.contractPeriod}
              onValueChange={(value) => onChange("contractPeriod", value)}
            >
              <SelectTrigger data-testid="select-contract-period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERIOD_TYPES.map((type) => (
                  <SelectItem key={type.value} value={type.value}>
                    {type.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div>
        <h3 className="font-medium mb-4">Stundensätze</h3>
        <div className="grid grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label htmlFor="hauswirtschaftRate">Hauswirtschaft (€/Std)</Label>
            <Input
              id="hauswirtschaftRate"
              type="number"
              step="0.01"
              value={formData.hauswirtschaftRate}
              onChange={(e) => onChange("hauswirtschaftRate", e.target.value)}
              data-testid="input-rate-hauswirtschaft"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="alltagsbegleitungRate">Alltagsbegleitung (€/Std)</Label>
            <Input
              id="alltagsbegleitungRate"
              type="number"
              step="0.01"
              value={formData.alltagsbegleitungRate}
              onChange={(e) => onChange("alltagsbegleitungRate", e.target.value)}
              data-testid="input-rate-alltagsbegleitung"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="erstberatungRate">Erstberatung (€/Std)</Label>
            <Input
              id="erstberatungRate"
              type="number"
              step="0.01"
              value={formData.erstberatungRate}
              onChange={(e) => onChange("erstberatungRate", e.target.value)}
              data-testid="input-rate-erstberatung"
            />
          </div>
        </div>
        <p className="text-xs text-gray-500 mt-2">
          Standardsätze: Hauswirtschaft 38€/Std, Alltagsbegleitung 42€/Std
        </p>
      </div>
    </div>
  );
}
