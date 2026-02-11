import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DatePicker } from "@/components/ui/date-picker";
import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api";
import { CustomerFormData } from "./customer-types";
import { 
  BUDGET_45B_MAX_MONTHLY_CENTS, 
  BUDGET_45A_MAX_BY_PFLEGEGRAD, 
  BUDGET_39_42A_MAX_YEARLY_CENTS,
  get45aMaxForPflegegrad 
} from "@shared/domain/budgets";

interface BudgetsStepProps {
  formData: CustomerFormData;
  onChange: (field: string, value: string | boolean) => void;
  pflegegrad: number | null;
}

export function BudgetsStep({ formData, onChange, pflegegrad }: BudgetsStepProps) {
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
            {error45b && <p className="text-xs text-red-600 font-medium">{error45b}</p>}
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
            {error45a && <p className="text-xs text-red-600 font-medium">{error45a}</p>}
            {(!pflegegrad || pflegegrad < 2) && (
              <p className="text-xs text-amber-600">Erst ab Pflegegrad 2 verfügbar</p>
            )}
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
            {error39 && <p className="text-xs text-red-600 font-medium">{error39}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

interface ServiceInfo {
  id: number;
  name: string;
  defaultPriceCents: number;
  unitType: string;
}

interface ContractStepProps {
  formData: CustomerFormData;
  onChange: (field: string, value: string | boolean) => void;
}

export function ContractStep({ formData, onChange }: ContractStepProps) {
  const { data: services } = useQuery({
    queryKey: ["/api/services"],
    queryFn: async () => {
      const result = await api.get<ServiceInfo[]>("/services");
      return unwrapResult(result);
    },
    staleTime: 60000,
  });

  const activeServices = services?.filter(s => s.defaultPriceCents > 0) || [];

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="space-y-2">
          <Label>Vertragsabschluss</Label>
          <DatePicker
            value={formData.contractDate || null}
            onChange={(val) => onChange("contractDate", val || "")}
            data-testid="input-contract-date"
          />
          <p className="text-xs text-gray-500">Datum, an dem der Vertrag unterschrieben wurde</p>
        </div>

        <div className="space-y-2">
          <Label>Vertragsbeginn</Label>
          <DatePicker
            value={formData.contractStart || null}
            onChange={(val) => onChange("contractStart", val || "")}
            data-testid="input-contract-start"
          />
        </div>
      </div>

      <div className="border-t pt-4">
        <div className="space-y-2">
          <Label htmlFor="vereinbarteLeistungen">Vereinbarte Leistungen</Label>
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
              return (
                <div key={service.id} className="flex justify-between items-center py-2 px-3 bg-gray-50 rounded" data-testid={`service-rate-${service.id}`}>
                  <span className="text-sm text-gray-700">{service.name}</span>
                  <span className="text-sm font-medium text-gray-900">
                    {(service.defaultPriceCents / 100).toFixed(2)} {unitLabel}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
