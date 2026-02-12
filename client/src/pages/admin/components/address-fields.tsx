import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface AddressFieldsProps {
  strasse: string;
  nr: string;
  plz: string;
  stadt: string;
  onChange: (field: string, value: string) => void;
  required?: boolean;
  testIdPrefix?: string;
}

export function AddressFields({ strasse, nr, plz, stadt, onChange, required = false, testIdPrefix = "" }: AddressFieldsProps) {
  const prefix = testIdPrefix ? `${testIdPrefix}-` : "";
  const suffix = required ? " *" : "";
  
  return (
    <>
      <div className="grid grid-cols-4 gap-4">
        <div className="col-span-3 space-y-2">
          <Label htmlFor={`${prefix}strasse`}>Straße{suffix}</Label>
          <Input
            id={`${prefix}strasse`}
            value={strasse}
            onChange={(e) => onChange("strasse", e.target.value)}
            placeholder="Musterstraße"
            required={required}
            data-testid={`input-${prefix}strasse`}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}nr`}>Nr.{suffix}</Label>
          <Input
            id={`${prefix}nr`}
            value={nr}
            onChange={(e) => onChange("nr", e.target.value)}
            placeholder="12a"
            required={required}
            data-testid={`input-${prefix}nr`}
          />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="space-y-2">
          <Label htmlFor={`${prefix}plz`}>PLZ{suffix}</Label>
          <Input
            id={`${prefix}plz`}
            value={plz}
            onChange={(e) => onChange("plz", e.target.value)}
            placeholder="12345"
            maxLength={5}
            required={required}
            data-testid={`input-${prefix}plz`}
          />
        </div>
        <div className="col-span-2 space-y-2">
          <Label htmlFor={`${prefix}stadt`}>Stadt{suffix}</Label>
          <Input
            id={`${prefix}stadt`}
            value={stadt}
            onChange={(e) => onChange("stadt", e.target.value)}
            placeholder="Berlin"
            required={required}
            data-testid={`input-${prefix}stadt`}
          />
        </div>
      </div>
    </>
  );
}
