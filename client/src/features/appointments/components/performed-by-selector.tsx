import { SearchableSelect } from "@/components/ui/searchable-select";
import { useActiveEmployees } from "@/features/appointments";

interface PerformedBySelectorProps {
  value: number | null;
  onChange: (val: number | null) => void;
}

export function PerformedBySelector({ value, onChange }: PerformedBySelectorProps) {
  const { data: employees = [] } = useActiveEmployees();

  const options = employees.map(e => ({
    value: String(e.id),
    label: e.displayName,
  })).sort((a, b) => a.label.localeCompare(b.label, "de"));

  return (
    <SearchableSelect
      options={options}
      value={value ? String(value) : ""}
      onValueChange={(val) => onChange(val ? parseInt(val) : null)}
      placeholder="Mitarbeiter auswählen"
      searchPlaceholder="Mitarbeiter suchen..."
      data-testid="select-performed-by"
    />
  );
}
