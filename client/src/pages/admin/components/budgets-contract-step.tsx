import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DatePicker } from "@/components/ui/date-picker";
import { Checkbox } from "@/components/ui/checkbox";
import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api";
import { CustomerFormData, BudgetTypeSettingForm } from "./customer-types";
import { 
  BUDGET_45B_MAX_MONTHLY_CENTS, 
  BUDGET_45A_MAX_BY_PFLEGEGRAD, 
  BUDGET_39_42A_MAX_YEARLY_CENTS,
  get45aMaxForPflegegrad,
  BUDGET_TYPES,
  BUDGET_TYPE_LABELS,
  type BudgetType,
} from "@shared/domain/budgets";

const BUDGET_COLORS: Record<BudgetType, { bg: string; border: string }> = {
  entlastungsbetrag_45b: { bg: "bg-green-50", border: "border-green-100" },
  umwandlung_45a: { bg: "bg-purple-50", border: "border-purple-100" },
  ersatzpflege_39_42a: { bg: "bg-blue-50", border: "border-blue-100" },
};

const BUDGET_HINTS: Record<BudgetType, string> = {
  entlastungsbetrag_45b: "Standard: 131 €/Monat",
  umwandlung_45a: "Max. 40% der ungenutzten Sachleistungen (PG2: 318€, PG3: 599€, PG4: 744€, PG5: 920€)",
  ersatzpflege_39_42a: "Standard: 3.539 €/Jahr (Ersatzpflege + Kurzzeitpflege, ab 01.07.2025)",
};

interface BudgetsStepProps {
  formData: CustomerFormData;
  onChange: (field: string, value: string | boolean) => void;
  onBudgetTypeToggle: (budgetType: BudgetType, enabled: boolean) => void;
  onBudgetTypeLimitChange: (budgetType: BudgetType, field: "monthlyLimitCents" | "yearlyLimitCents", value: string) => void;
  pflegegrad: number | null;
}

export function BudgetsStep({ formData, onChange, onBudgetTypeToggle, onBudgetTypeLimitChange, pflegegrad }: BudgetsStepProps) {
  const entlastungsbetrag = parseFloat(formData.entlastungsbetrag45b) || 0;
  const pflegesachleistungen = parseFloat(formData.pflegesachleistungen36) || 0;
  const verhinderungspflege = parseFloat(formData.verhinderungspflege39) || 0;

  const max45b = BUDGET_45B_MAX_MONTHLY_CENTS / 100;
  const error45b = entlastungsbetrag > max45b ? `Maximal ${max45b.toFixed(2)} €/Monat erlaubt` : null;
  const max45a = get45aMaxForPflegegrad(pflegegrad) / 100;
  const error45a = pflegegrad && pflegegrad < 2 && pflegesachleistungen > 0
    ? "§45a ist erst ab Pflegegrad 2 verfügbar"
    : pflegesachleistungen > max45a && max45a > 0
    ? `Maximal ${max45a.toFixed(2)} €/Monat bei Pflegegrad ${pflegegrad}`
    : null;
  const max39 = BUDGET_39_42A_MAX_YEARLY_CENTS / 100;
  const error39 = verhinderungspflege > max39 ? `Maximal ${max39.toFixed(2)} €/Jahr erlaubt` : null;

  const errorMap: Record<BudgetType, string | null> = {
    entlastungsbetrag_45b: error45b,
    umwandlung_45a: error45a,
    ersatzpflege_39_42a: error39,
  };

  const fieldMap: Record<BudgetType, string> = {
    entlastungsbetrag_45b: "entlastungsbetrag45b",
    umwandlung_45a: "pflegesachleistungen36",
    ersatzpflege_39_42a: "verhinderungspflege39",
  };

  const valueMap: Record<BudgetType, string> = {
    entlastungsbetrag_45b: formData.entlastungsbetrag45b,
    umwandlung_45a: formData.pflegesachleistungen36,
    ersatzpflege_39_42a: formData.verhinderungspflege39,
  };

  const unitMap: Record<BudgetType, string> = {
    entlastungsbetrag_45b: "€/Monat",
    umwandlung_45a: "€/Monat",
    ersatzpflege_39_42a: "€/Jahr",
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-600">
        Wählen Sie die Budget-Töpfe für den Kunden aus und erfassen Sie die Beträge.
      </p>

      <div className="space-y-4">
        {BUDGET_TYPES.map((budgetType) => {
          const setting = formData.budgetTypeSettings.find(s => s.budgetType === budgetType);
          const isEnabled = setting?.enabled ?? true;
          const colors = BUDGET_COLORS[budgetType];
          const error = errorMap[budgetType];
          const is45aDisabled = budgetType === "umwandlung_45a" && (!pflegegrad || pflegegrad < 2);

          return (
            <div
              key={budgetType}
              className={`p-4 rounded-lg ${isEnabled ? colors.bg : "bg-gray-50"} border ${isEnabled ? colors.border : "border-gray-200"} transition-colors`}
            >
              <div className="flex items-center gap-3 mb-3">
                <Checkbox
                  id={`budget-enable-${budgetType}`}
                  checked={isEnabled}
                  onCheckedChange={(checked) => onBudgetTypeToggle(budgetType, !!checked)}
                  data-testid={`checkbox-budget-${budgetType}`}
                />
                <Label
                  htmlFor={`budget-enable-${budgetType}`}
                  className={`font-medium ${isEnabled ? "text-gray-900" : "text-gray-400"}`}
                >
                  {BUDGET_TYPE_LABELS[budgetType]}
                </Label>
              </div>

              {isEnabled && (
                <div className="space-y-2 ml-7">
                  <Label htmlFor={fieldMap[budgetType]}>
                    Betrag ({unitMap[budgetType]})
                  </Label>
                  <Input
                    id={fieldMap[budgetType]}
                    type="number"
                    step="0.01"
                    value={valueMap[budgetType]}
                    onChange={(e) => onChange(fieldMap[budgetType], e.target.value)}
                    disabled={is45aDisabled}
                    data-testid={`input-budget-${budgetType}`}
                  />
                  <p className="text-xs text-gray-500">{BUDGET_HINTS[budgetType]}</p>
                  {budgetType === "umwandlung_45a" && pflegegrad && pflegegrad >= 2 && (
                    <p className="text-xs text-purple-600" data-testid="text-max-pflegesachleistungen">
                      Maximal: {(BUDGET_45A_MAX_BY_PFLEGEGRAD[pflegegrad] ?? 0) / 100} € für Pflegegrad {pflegegrad}
                    </p>
                  )}
                  {error && <p className="text-xs text-red-600 font-medium">{error}</p>}
                  {is45aDisabled && (
                    <p className="text-xs text-amber-600">Erst ab Pflegegrad 2 verfügbar</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface ServiceInfo {
  id: number;
  name: string;
  defaultPriceCents: number;
  unitType: string;
  vatRate: number;
}

interface ContractStepProps {
  formData: CustomerFormData;
  onChange: (field: string, value: string | boolean) => void;
  showGrossPrices?: boolean;
}

export function ContractStep({ formData, onChange, showGrossPrices = false }: ContractStepProps) {
  const { data: services } = useQuery({
    queryKey: ["/api/services"],
    queryFn: async () => {
      const result = await api.get<ServiceInfo[]>("/services");
      return unwrapResult(result);
    },
    staleTime: 60000,
  });

  const activeServices = services?.filter(s => s.defaultPriceCents > 0) || [];

  const handleContractDateChange = (val: string | null) => {
    const dateVal = val || "";
    onChange("contractDate", dateVal);
    if (dateVal && !formData.contractStart) {
      onChange("contractStart", dateVal);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="space-y-2">
          <Label>Vertragsabschluss *</Label>
          <DatePicker
            value={formData.contractDate || null}
            onChange={handleContractDateChange}
            data-testid="input-contract-date"
          />
          <p className="text-xs text-gray-500">Datum, an dem der Vertrag unterschrieben wurde</p>
        </div>

        <div className="space-y-2">
          <Label>Vertragsbeginn *</Label>
          <DatePicker
            value={formData.contractStart || null}
            onChange={(val) => onChange("contractStart", val || "")}
            data-testid="input-contract-start"
          />
          <p className="text-xs text-gray-500">Wird automatisch auf das Vertragsabschluss-Datum gesetzt, kann aber geändert werden</p>
        </div>
      </div>

      <div className="border-t pt-4 space-y-4">
        <div className="flex items-center space-x-2">
          <Checkbox
            id="personenbefoerderungGewuenscht"
            checked={formData.personenbefoerderungGewuenscht}
            onCheckedChange={(checked) => onChange("personenbefoerderungGewuenscht", !!checked)}
            data-testid="checkbox-personenbefoerderung"
          />
          <Label htmlFor="personenbefoerderungGewuenscht">Personenbeförderung gewünscht?</Label>
        </div>

        <div className="space-y-2">
          <Label htmlFor="vereinbarteLeistungen">Vereinbarte Leistungen *</Label>
          <Textarea
            id="vereinbarteLeistungen"
            value={formData.vereinbarteLeistungen}
            onChange={(e) => onChange("vereinbarteLeistungen", e.target.value)}
            placeholder="z.B. Fenster putzen alle 2 Wochen, Einkauf 1x wöchentlich, Spaziergang 2x pro Woche..."
            rows={4}
            data-testid="input-vereinbarte-leistungen"
          />
          <p className="text-xs text-gray-500">
            Beschreiben Sie die vereinbarten Leistungen im Freitext
          </p>
        </div>
      </div>

      {activeServices.length > 0 && (
        <div className="border-t pt-4">
          <h3 className="font-medium mb-3">Preise aus dem Dienstleistungskatalog</h3>
          <div className="p-3 bg-teal-50 border border-teal-100 rounded-lg mb-3">
            <p className="text-xs text-teal-800">
              Diese Standardpreise werden automatisch für den neuen Kunden übernommen. Individuelle Anpassungen sind danach in der Kundenansicht unter "Preisvereinbarung" möglich.
            </p>
          </div>
          <div className="space-y-2">
            {activeServices.map(service => {
              const unitLabel = service.unitType === "hours" ? "€/Std." : service.unitType === "kilometers" ? "€/km" : "€ pauschal";
              const netPrice = service.defaultPriceCents / 100;
              const displayPrice = showGrossPrices
                ? netPrice * (1 + (service.vatRate || 0) / 100)
                : netPrice;
              return (
                <div key={service.id} className="flex justify-between items-center py-2 px-3 bg-gray-50 rounded" data-testid={`service-rate-${service.id}`}>
                  <span className="text-sm text-gray-700">{service.name}</span>
                  <span className="text-sm font-medium text-gray-900">
                    {displayPrice.toFixed(2)} {unitLabel}
                  </span>
                </div>
              );
            })}
          </div>
          {showGrossPrices && (
            <p className="text-xs text-gray-500 mt-2">Alle Preise inkl. MwSt.</p>
          )}
        </div>
      )}
    </div>
  );
}
