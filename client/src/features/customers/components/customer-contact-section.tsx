import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  MapPin, Phone, Mail, Loader2, Cake, PhoneCall, Pencil, Save,
} from "lucide-react";
import { iconSize } from "@/design-system";
import { formatPhoneForDisplay, formatPhoneAsYouType } from "@shared/utils/phone";
import { formatDateForDisplay } from "@shared/utils/datetime";
import { formatAddress } from "@shared/utils/format";
import type { Customer } from "@shared/schema";
import type { EditSection } from "@/features/customers/hooks/use-customer-detail-form";

interface CustomerContactSectionProps {
  customer: Customer;
  editingSection: EditSection;
  contactForm: {
    strasse: string;
    nr: string;
    plz: string;
    stadt: string;
    telefon: string;
    festnetz: string;
    email: string;
  };
  setContactForm: React.Dispatch<React.SetStateAction<CustomerContactSectionProps["contactForm"]>>;
  contactFormErrors: Record<string, string>;
  setContactFormErrors: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  plzLoading: boolean;
  isSaving: boolean;
  handleSaveContact: () => void;
  cancelEditing: () => void;
  startEditing: (section: EditSection) => void;
  validatePhone: (value: string, field: string) => string | null;
  validateEmail: (value: string) => string | null;
}

export function CustomerContactSection({
  customer,
  editingSection,
  contactForm,
  setContactForm,
  contactFormErrors,
  setContactFormErrors,
  plzLoading,
  isSaving,
  handleSaveContact,
  cancelEditing,
  startEditing,
  validatePhone,
  validateEmail,
}: CustomerContactSectionProps) {
  const address = formatAddress(customer);
  const phoneMobil = customer.telefon ? formatPhoneForDisplay(customer.telefon) : null;
  const phoneFestnetz = customer.festnetz ? formatPhoneForDisplay(customer.festnetz) : null;
  const geburtsdatum = customer.geburtsdatum
    ? formatDateForDisplay(customer.geburtsdatum)
    : null;

  return (
    <Card className="mb-4" data-testid="card-personal-info">
      <CardContent className="p-4">
        {editingSection === "contact" ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Kontaktdaten bearbeiten</h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div className="col-span-2">
                <Label>Straße</Label>
                <Input value={contactForm.strasse} onChange={(e) => setContactForm(f => ({ ...f, strasse: e.target.value }))} data-testid="input-strasse" />
              </div>
              <div>
                <Label>Nr.</Label>
                <Input value={contactForm.nr} onChange={(e) => setContactForm(f => ({ ...f, nr: e.target.value }))} data-testid="input-nr" />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div>
                <Label>PLZ</Label>
                <Input
                  value={contactForm.plz}
                  onChange={(e) => {
                    const v = e.target.value.replace(/\D/g, "").slice(0, 5);
                    setContactForm(f => ({ ...f, plz: v }));
                    setContactFormErrors(prev => ({ ...prev, plz: "" }));
                  }}
                  maxLength={5}
                  inputMode="numeric"
                  className={contactFormErrors.plz ? "border-red-400" : ""}
                  data-testid="input-plz"
                />
                {contactFormErrors.plz && <span className="text-xs text-red-500 mt-0.5">{contactFormErrors.plz}</span>}
              </div>
              <div className="col-span-2">
                <Label>{plzLoading ? "Stadt (wird gesucht...)" : "Stadt"}</Label>
                <Input value={contactForm.stadt} onChange={(e) => setContactForm(f => ({ ...f, stadt: e.target.value }))} data-testid="input-stadt" />
              </div>
            </div>
            <div>
              <Label>Mobilnummer</Label>
              <Input
                value={contactForm.telefon}
                onChange={(e) => {
                  setContactForm(f => ({ ...f, telefon: formatPhoneAsYouType(e.target.value) }));
                  setContactFormErrors(prev => ({ ...prev, telefon: "" }));
                }}
                onBlur={() => {
                  const err = validatePhone(contactForm.telefon, "telefon");
                  if (err) setContactFormErrors(prev => ({ ...prev, telefon: err }));
                }}
                placeholder="0151 12345678"
                inputMode="tel"
                className={contactFormErrors.telefon ? "border-red-400" : ""}
                data-testid="input-telefon"
              />
              {contactFormErrors.telefon && <span className="text-xs text-red-500 mt-0.5">{contactFormErrors.telefon}</span>}
            </div>
            <div>
              <Label>Festnetz</Label>
              <Input
                value={contactForm.festnetz}
                onChange={(e) => {
                  setContactForm(f => ({ ...f, festnetz: formatPhoneAsYouType(e.target.value) }));
                  setContactFormErrors(prev => ({ ...prev, festnetz: "" }));
                }}
                onBlur={() => {
                  const err = validatePhone(contactForm.festnetz, "festnetz");
                  if (err) setContactFormErrors(prev => ({ ...prev, festnetz: err }));
                }}
                placeholder="0351 1234567"
                inputMode="tel"
                className={contactFormErrors.festnetz ? "border-red-400" : ""}
                data-testid="input-festnetz"
              />
              {contactFormErrors.festnetz && <span className="text-xs text-red-500 mt-0.5">{contactFormErrors.festnetz}</span>}
            </div>
            <div>
              <Label>E-Mail</Label>
              <Input
                type="email"
                value={contactForm.email}
                onChange={(e) => {
                  setContactForm(f => ({ ...f, email: e.target.value }));
                  setContactFormErrors(prev => ({ ...prev, email: "" }));
                }}
                onBlur={() => {
                  const err = validateEmail(contactForm.email);
                  if (err) setContactFormErrors(prev => ({ ...prev, email: err }));
                }}
                placeholder="name@beispiel.de"
                className={contactFormErrors.email ? "border-red-400" : ""}
                data-testid="input-email"
              />
              {contactFormErrors.email && <span className="text-xs text-red-500 mt-0.5">{contactFormErrors.email}</span>}
            </div>
            <div className="flex gap-2 pt-1">
              <Button size="sm" onClick={handleSaveContact} disabled={isSaving} className="min-h-[36px]" data-testid="button-save-contact">
                {isSaving ? <Loader2 className={`${iconSize.sm} animate-spin`} /> : <><Save className={`${iconSize.sm} mr-1`} />Speichern</>}
              </Button>
              <Button size="sm" variant="outline" onClick={cancelEditing} disabled={isSaving} className="min-h-[36px]" data-testid="button-cancel-contact">
                Abbrechen
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-gray-700">Kontakt & Adresse</span>
              <Button variant="ghost" size="sm" className="min-h-[44px] min-w-[44px] p-0" onClick={() => startEditing("contact")} data-testid="button-edit-contact">
                <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </div>
            <div className="space-y-2.5">
              <div className="flex items-center gap-2 text-sm" data-testid="text-geburtsdatum">
                <Cake className={`${iconSize.sm} flex-shrink-0 text-primary/60`} />
                <span className="text-muted-foreground">{geburtsdatum || "Kein Geburtsdatum"}</span>
              </div>
              <div className="flex items-start gap-2 text-sm">
                <MapPin className={`${iconSize.sm} mt-0.5 flex-shrink-0 text-primary/60`} />
                {address ? (
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                    data-testid="link-address"
                  >
                    {address}
                  </a>
                ) : (
                  <span className="text-muted-foreground" data-testid="text-address">Keine Adresse</span>
                )}
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Phone className={`${iconSize.sm} flex-shrink-0 text-primary/60`} />
                {phoneMobil ? (
                  <a href={`tel:${customer.telefon}`} className="text-primary hover:underline" data-testid="link-phone-mobil">
                    {phoneMobil}
                  </a>
                ) : (
                  <span className="text-muted-foreground/60">Kein Mobiltelefon</span>
                )}
              </div>
              <div className="flex items-center gap-2 text-sm">
                <PhoneCall className={`${iconSize.sm} flex-shrink-0 text-primary/60`} />
                {phoneFestnetz ? (
                  <a href={`tel:${customer.festnetz}`} className="text-primary hover:underline" data-testid="link-phone-festnetz">
                    {phoneFestnetz}
                  </a>
                ) : (
                  <span className="text-muted-foreground/60">Kein Festnetz</span>
                )}
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Mail className={`${iconSize.sm} flex-shrink-0 text-primary/60`} />
                {customer.email ? (
                  <a href={`mailto:${customer.email}`} className="text-primary hover:underline" data-testid="link-email">
                    {customer.email}
                  </a>
                ) : (
                  <span className="text-muted-foreground/60">Keine E-Mail</span>
                )}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
