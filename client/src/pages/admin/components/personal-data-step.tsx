import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DatePicker } from "@/components/ui/date-picker";
import { MapPin } from "lucide-react";
import { iconSize } from "@/design-system";
import { CustomerFormData, PFLEGEGRAD_OPTIONS } from "./customer-types";
import { needsPflegegradData, needsVorerkrankungenData, isPflegekasseCustomer } from "@shared/domain/customers";
import { AddressFields } from "./address-fields";

interface PersonalDataStepProps {
  formData: CustomerFormData;
  phoneErrors: Record<string, string | null>;
  onChange: (field: string, value: string | boolean) => void;
}

export function PersonalDataStep({ formData, phoneErrors, onChange }: PersonalDataStepProps) {
  const showPflegegrad = needsPflegegradData(formData.billingType);
  const showVorerkrankungen = needsVorerkrankungenData(formData.billingType);
  const showGeburtsdatum = isPflegekasseCustomer(formData.billingType);
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

      {showGeburtsdatum && (
        <div className="space-y-2">
          <Label>Geburtsdatum *</Label>
          <DatePicker
            value={formData.geburtsdatum || null}
            onChange={(val) => onChange("geburtsdatum", val || "")}
            data-testid="input-geburtsdatum"
          />
        </div>
      )}

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
          <AddressFields
            strasse={formData.strasse}
            nr={formData.nr}
            plz={formData.plz}
            stadt={formData.stadt}
            onChange={onChange}
            required
          />
        </div>
      </div>

      {showPflegegrad && (
        <div className="border-t pt-4 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="pflegegrad">Pflegegrad *</Label>
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
      )}

      <div className="border-t pt-4 space-y-4">
        {showVorerkrankungen && (
          <div className="space-y-2">
            <Label htmlFor="vorerkrankungen">Vorerkrankungen</Label>
            <Textarea
              id="vorerkrankungen"
              value={formData.vorerkrankungen}
              onChange={(e) => onChange("vorerkrankungen", e.target.value)}
              placeholder="z.B. Diabetes Typ 2, Bluthochdruck, Demenz..."
              rows={3}
              data-testid="input-vorerkrankungen"
            />
            <p className="text-xs text-gray-500">
              Wichtige gesundheitliche Informationen für die Betreuungskräfte
            </p>
          </div>
        )}

        <div className="space-y-3">
          <div className="flex items-center space-x-2">
            <Checkbox
              id="haustierVorhanden"
              checked={formData.haustierVorhanden}
              onCheckedChange={(checked) => onChange("haustierVorhanden", !!checked)}
              data-testid="checkbox-haustier"
            />
            <Label htmlFor="haustierVorhanden">Haustier vorhanden?</Label>
          </div>
          {formData.haustierVorhanden && (
            <div className="space-y-2 ml-6">
              <Label htmlFor="haustierDetails">Beschreibung</Label>
              <Input
                id="haustierDetails"
                value={formData.haustierDetails}
                onChange={(e) => onChange("haustierDetails", e.target.value)}
                placeholder="z.B. Hund, 10kg schwer, freundlich"
                data-testid="input-haustier-details"
              />
            </div>
          )}
        </div>

        <div className="flex items-center space-x-2">
          <Checkbox
            id="personenbefoerderungGewuenscht"
            checked={formData.personenbefoerderungGewuenscht}
            onCheckedChange={(checked) => onChange("personenbefoerderungGewuenscht", !!checked)}
            data-testid="checkbox-personenbefoerderung"
          />
          <Label htmlFor="personenbefoerderungGewuenscht">Personenbeförderung gewünscht?</Label>
        </div>
      </div>
    </div>
  );
}
