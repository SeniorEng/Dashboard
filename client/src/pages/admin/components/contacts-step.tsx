import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus, Trash2 } from "lucide-react";
import { iconSize } from "@/design-system";
import { ContactFormData, CONTACT_TYPES, EMPTY_CONTACT, MAX_CONTACTS } from "./customer-types";

interface ContactsStepProps {
  contacts: ContactFormData[];
  phoneErrors: Record<string, string | null>;
  onContactChange: (index: number, field: keyof ContactFormData, value: string | boolean) => void;
  onAddContact: () => void;
  onRemoveContact: (index: number) => void;
}

function isContactEmpty(contact: ContactFormData): boolean {
  return !contact.vorname.trim() && !contact.nachname.trim();
}

export function ContactsStep({ contacts, phoneErrors, onContactChange, onAddContact, onRemoveContact }: ContactsStepProps) {
  const lastContact = contacts[contacts.length - 1];
  const lastContactEmpty = lastContact ? isContactEmpty(lastContact) : false;

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-600">
        Fügen Sie bis zu {MAX_CONTACTS} Notfallkontakte hinzu.
      </p>

      {contacts.map((contact, index) => (
        <div key={index} className="p-4 rounded-lg border border-gray-200 bg-white space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">
              Kontakt {index + 1}
            </span>
            {contacts.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onRemoveContact(index)}
                className="text-red-500 hover:text-red-700 hover:bg-red-50"
                data-testid={`button-remove-contact-${index}`}
              >
                <Trash2 className={iconSize.sm} />
              </Button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor={`contactVorname-${index}`}>Vorname</Label>
              <Input
                id={`contactVorname-${index}`}
                value={contact.vorname}
                onChange={(e) => onContactChange(index, "vorname", e.target.value)}
                data-testid={`input-contact-vorname-${index}`}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`contactNachname-${index}`}>Nachname</Label>
              <Input
                id={`contactNachname-${index}`}
                value={contact.nachname}
                onChange={(e) => onContactChange(index, "nachname", e.target.value)}
                data-testid={`input-contact-nachname-${index}`}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor={`contactType-${index}`}>Kontaktart</Label>
              <Select
                value={contact.contactType}
                onValueChange={(value) => onContactChange(index, "contactType", value)}
              >
                <SelectTrigger data-testid={`select-contact-type-${index}`}>
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
              <Label htmlFor={`contactTelefon-${index}`}>Telefon</Label>
              <Input
                id={`contactTelefon-${index}`}
                value={contact.telefon}
                onChange={(e) => onContactChange(index, "telefon", e.target.value)}
                placeholder="0170 1234567"
                className={phoneErrors[`contact_${index}`] ? "border-red-500" : ""}
                data-testid={`input-contact-telefon-${index}`}
              />
              {phoneErrors[`contact_${index}`] && (
                <p className="text-xs text-red-500">{phoneErrors[`contact_${index}`]}</p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor={`contactEmail-${index}`}>E-Mail (optional)</Label>
            <Input
              id={`contactEmail-${index}`}
              type="email"
              value={contact.email}
              onChange={(e) => onContactChange(index, "email", e.target.value)}
              data-testid={`input-contact-email-${index}`}
            />
          </div>

          <div className="flex items-center space-x-2">
            <Checkbox
              id={`contactIsPrimary-${index}`}
              checked={contact.isPrimary}
              onCheckedChange={(checked) => onContactChange(index, "isPrimary", !!checked)}
              data-testid={`checkbox-contact-primary-${index}`}
            />
            <Label htmlFor={`contactIsPrimary-${index}`}>Hauptkontakt</Label>
          </div>
        </div>
      ))}

      {contacts.length < MAX_CONTACTS && (
        <div className="space-y-1">
          <Button
            type="button"
            variant="outline"
            onClick={onAddContact}
            className="w-full"
            disabled={lastContactEmpty}
            data-testid="button-add-contact"
          >
            <Plus className={`${iconSize.sm} mr-2`} />
            Weiteren Kontakt hinzufügen
          </Button>
          {lastContactEmpty && (
            <p className="text-xs text-amber-600 text-center" data-testid="text-empty-contact-hint">
              Bitte zuerst den aktuellen Kontakt ausfüllen (Vor- und Nachname).
            </p>
          )}
        </div>
      )}
    </div>
  );
}
