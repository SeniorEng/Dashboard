import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { DatePicker } from "@/components/ui/date-picker";
import { MapPin } from "lucide-react";
import { iconSize } from "@/design-system";
import { CustomerFormData, SelectOption, PFLEGEGRAD_OPTIONS } from "./customer-types";

interface PersonalDataStepProps {
  formData: CustomerFormData;
  phoneErrors: Record<string, string | null>;
  employeeOptions: SelectOption[];
  onChange: (field: string, value: string | boolean) => void;
}

export function PersonalDataStep({ formData, phoneErrors, employeeOptions, onChange }: PersonalDataStepProps) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="vorname">Vorname *</Label>
          <Input
            id="vorname"
            value={formData.vorname}
            onChange={(e) => onChange("vorname", e.target.value)}
            required
            data-testid="input-vorname"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="nachname">Nachname *</Label>
          <Input
            id="nachname"
            value={formData.nachname}
            onChange={(e) => onChange("nachname", e.target.value)}
            required
            data-testid="input-nachname"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="email">E-Mail</Label>
        <Input
          id="email"
          type="email"
          value={formData.email}
          onChange={(e) => onChange("email", e.target.value)}
          data-testid="input-email"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="telefon">Mobiltelefon</Label>
          <Input
            id="telefon"
            value={formData.telefon}
            onChange={(e) => onChange("telefon", e.target.value)}
            placeholder="0170 1234567"
            className={phoneErrors.telefon ? "border-red-500" : ""}
            data-testid="input-telefon"
          />
          {phoneErrors.telefon && (
            <p className="text-xs text-red-500">{phoneErrors.telefon}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="festnetz">Festnetz</Label>
          <Input
            id="festnetz"
            value={formData.festnetz}
            onChange={(e) => onChange("festnetz", e.target.value)}
            placeholder="030 1234567"
            className={phoneErrors.festnetz ? "border-red-500" : ""}
            data-testid="input-festnetz"
          />
          {phoneErrors.festnetz && (
            <p className="text-xs text-red-500">{phoneErrors.festnetz}</p>
          )}
        </div>
      </div>

      <div className="border-t pt-4">
        <h3 className="font-medium mb-4 flex items-center gap-2">
          <MapPin className={iconSize.sm} />
          Adresse
        </h3>
        <div className="space-y-4">
          <div className="grid grid-cols-4 gap-4">
            <div className="col-span-3 space-y-2">
              <Label htmlFor="strasse">Straße *</Label>
              <Input
                id="strasse"
                value={formData.strasse}
                onChange={(e) => onChange("strasse", e.target.value)}
                required
                data-testid="input-strasse"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="nr">Nr. *</Label>
              <Input
                id="nr"
                value={formData.nr}
                onChange={(e) => onChange("nr", e.target.value)}
                required
                data-testid="input-nr"
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="plz">PLZ *</Label>
              <Input
                id="plz"
                value={formData.plz}
                onChange={(e) => onChange("plz", e.target.value)}
                maxLength={5}
                required
                data-testid="input-plz"
              />
            </div>
            <div className="col-span-2 space-y-2">
              <Label htmlFor="stadt">Stadt *</Label>
              <Input
                id="stadt"
                value={formData.stadt}
                onChange={(e) => onChange("stadt", e.target.value)}
                required
                data-testid="input-stadt"
              />
            </div>
          </div>
        </div>
      </div>

      <div className="border-t pt-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="pflegegrad">Pflegegrad</Label>
            <Select
              value={formData.pflegegrad}
              onValueChange={(value) => onChange("pflegegrad", value)}
            >
              <SelectTrigger data-testid="select-pflegegrad">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PFLEGEGRAD_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Pflegegrad seit</Label>
            <DatePicker
              value={formData.pflegegradSeit || null}
              onChange={(val) => onChange("pflegegradSeit", val || "")}
              data-testid="input-pflegegrad-seit"
            />
          </div>
        </div>
      </div>

      <div className="border-t pt-4">
        <h3 className="font-medium mb-4">Zuständige Mitarbeiter</h3>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="primaryEmployeeId">Hauptansprechpartner</Label>
            <SearchableSelect
              options={employeeOptions}
              value={formData.primaryEmployeeId}
              onValueChange={(value) => onChange("primaryEmployeeId", value)}
              placeholder="Auswählen..."
              searchPlaceholder="Mitarbeiter suchen..."
              emptyText="Kein Mitarbeiter gefunden."
              data-testid="select-primary-employee"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="backupEmployeeId">Vertretung</Label>
            <SearchableSelect
              options={employeeOptions}
              value={formData.backupEmployeeId}
              onValueChange={(value) => onChange("backupEmployeeId", value)}
              placeholder="Auswählen..."
              searchPlaceholder="Mitarbeiter suchen..."
              emptyText="Kein Mitarbeiter gefunden."
              data-testid="select-backup-employee"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
