import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { CustomerFormData, CONTACT_TYPES } from "./customer-types";

interface ContactsStepProps {
  formData: CustomerFormData;
  phoneErrors: Record<string, string | null>;
  onChange: (field: string, value: string | boolean) => void;
}

export function ContactsStep({ formData, phoneErrors, onChange }: ContactsStepProps) {
  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-600">
        Fügen Sie einen Notfallkontakt hinzu. Weitere Kontakte können Sie später ergänzen.
      </p>

      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="contactVorname">Vorname</Label>
            <Input
              id="contactVorname"
              value={formData.contactVorname}
              onChange={(e) => onChange("contactVorname", e.target.value)}
              data-testid="input-contact-vorname"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="contactNachname">Nachname</Label>
            <Input
              id="contactNachname"
              value={formData.contactNachname}
              onChange={(e) => onChange("contactNachname", e.target.value)}
              data-testid="input-contact-nachname"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="contactType">Kontaktart</Label>
            <Select
              value={formData.contactType}
              onValueChange={(value) => onChange("contactType", value)}
            >
              <SelectTrigger data-testid="select-contact-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTACT_TYPES.map((type) => (
                  <SelectItem key={type.value} value={type.value}>
                    {type.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="contactTelefon">Telefon</Label>
            <Input
              id="contactTelefon"
              value={formData.contactTelefon}
              onChange={(e) => onChange("contactTelefon", e.target.value)}
              placeholder="0170 1234567"
              className={phoneErrors.contactTelefon ? "border-red-500" : ""}
              data-testid="input-contact-telefon"
            />
            {phoneErrors.contactTelefon && (
              <p className="text-xs text-red-500">{phoneErrors.contactTelefon}</p>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="contactEmail">E-Mail (optional)</Label>
          <Input
            id="contactEmail"
            type="email"
            value={formData.contactEmail}
            onChange={(e) => onChange("contactEmail", e.target.value)}
            data-testid="input-contact-email"
          />
        </div>

        <div className="flex items-center space-x-2">
          <Checkbox
            id="contactIsPrimary"
            checked={formData.contactIsPrimary}
            onCheckedChange={(checked) => onChange("contactIsPrimary", !!checked)}
            data-testid="checkbox-contact-primary"
          />
          <Label htmlFor="contactIsPrimary">Hauptkontakt</Label>
        </div>
      </div>
    </div>
  );
}
