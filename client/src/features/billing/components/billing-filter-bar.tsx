import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { PayerSummary } from "@shared/api";
import { MONTH_NAMES } from "../constants";
import type { ActiveEmployee } from "../hooks/use-billing-queries";

interface BillingFilterBarProps {
  selectedMonth: number;
  setSelectedMonth: (month: number) => void;
  selectedYear: number;
  setSelectedYear: (year: number) => void;
  years: number[];
  employeeFilter: string;
  setEmployeeFilter: (value: string) => void;
  employees: ActiveEmployee[] | undefined;
  payerFilter: string;
  setPayerFilter: (value: string) => void;
  payers: PayerSummary[] | undefined;
}

// Task #1473: Schlanke Filterleiste der Abrechnungsseite — NUR Monat / Jahr /
// Mitarbeiter:in / Kasse. Der frühere Datumsbereich, der Status-Dropdown und der
// Storno-Schalter sind bewusst entfernt (Status wird über die Pipeline-/Termine-
// Chips gesteuert, Stornos leben im Rechnungs-Cluster).
export function BillingFilterBar({
  selectedMonth,
  setSelectedMonth,
  selectedYear,
  setSelectedYear,
  years,
  employeeFilter,
  setEmployeeFilter,
  employees,
  payerFilter,
  setPayerFilter,
  payers,
}: BillingFilterBarProps) {
  return (
    <div
      className="mb-6 grid grid-cols-2 gap-3 rounded-lg border border-gray-200 bg-white p-3 sm:grid-cols-4"
      data-testid="bar-billing-filter"
    >
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-gray-500">Monat</label>
        <Select
          value={String(selectedMonth)}
          onValueChange={(v) => setSelectedMonth(Number(v))}
        >
          <SelectTrigger data-testid="select-month">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MONTH_NAMES.map((name, idx) => (
              <SelectItem key={idx} value={String(idx + 1)} data-testid={`option-month-${idx + 1}`}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-gray-500">Jahr</label>
        <Select
          value={String(selectedYear)}
          onValueChange={(v) => setSelectedYear(Number(v))}
        >
          <SelectTrigger data-testid="select-year">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {years.map((y) => (
              <SelectItem key={y} value={String(y)} data-testid={`option-year-${y}`}>
                {y}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-gray-500">Mitarbeiter:in</label>
        <Select value={employeeFilter} onValueChange={setEmployeeFilter}>
          <SelectTrigger data-testid="select-employee">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="alle" data-testid="option-employee-alle">
              Alle Mitarbeiter:innen
            </SelectItem>
            {(employees ?? []).map((emp) => (
              <SelectItem
                key={emp.id}
                value={String(emp.id)}
                data-testid={`option-employee-${emp.id}`}
              >
                {emp.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-gray-500">Kasse</label>
        <Select value={payerFilter} onValueChange={setPayerFilter}>
          <SelectTrigger data-testid="select-payer">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="alle" data-testid="option-payer-alle">
              Alle Kassen
            </SelectItem>
            {(payers ?? []).map((p) => (
              <SelectItem
                key={p.insuranceProviderId}
                value={String(p.insuranceProviderId)}
                data-testid={`option-payer-${p.insuranceProviderId}`}
              >
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
