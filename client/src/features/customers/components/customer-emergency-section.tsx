import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Phone, Plus, Trash2, Loader2, Users, Pencil, Save,
} from "lucide-react";
import { iconSize } from "@/design-system";
import { formatPhoneForDisplay, formatPhoneAsYouType } from "@shared/utils/phone";
import { CONTACT_TYPE_LABELS, CONTACT_TYPE_SELECT_OPTIONS } from "@shared/domain/customers";
import type { CustomerContact } from "@shared/schema";
import type { UseMutationResult } from "@tanstack/react-query";
import type { EmergencyContactFormType } from "@/features/customers/hooks/use-customer-detail-form";

interface CustomerEmergencySectionProps {
  contacts: CustomerContact[] | undefined;
  editingContactId: number | null;
  showAddContact: boolean;
  emergencyContactForm: EmergencyContactFormType;
  setEmergencyContactForm: React.Dispatch<React.SetStateAction<EmergencyContactFormType>>;
  emergencyFormErrors: Record<string, string>;
  setEmergencyFormErrors: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  contactSaving: boolean;
  handleSaveEmergencyContact: () => void;
  startEditContact: (contact: CustomerContact) => void;
  cancelEditContact: () => void;
  handleStartAddContact: () => void;
  deleteContactMutation: UseMutationResult<unknown, Error, number, unknown>;
  validatePhone: (value: string, field: string) => string | null;
  validateEmail: (value: string) => string | null;
}

export function CustomerEmergencySection({
  contacts,
  editingContactId,
  showAddContact,
  emergencyContactForm,
  setEmergencyContactForm,
  emergencyFormErrors,
  setEmergencyFormErrors,
  contactSaving,
  handleSaveEmergencyContact,
  startEditContact,
  cancelEditContact,
  handleStartAddContact,
  deleteContactMutation,
  validatePhone,
  validateEmail,
}: CustomerEmergencySectionProps) {
  return (
    <Card className="mb-4" data-testid="card-emergency-contacts">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Users className={`${iconSize.sm} text-red-500`} />
            Notfallkontakte
          </h2>
          {!showAddContact && editingContactId === null && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs gap-1"
              onClick={handleStartAddContact}
              data-testid="button-add-contact"
            >
              <Plus className="h-3.5 w-3.5" /> Hinzufügen
            </Button>
          )}
        </div>

        {contacts && contacts.length > 0 && (
          <div className="space-y-3 mb-3">
            {contacts.map((contact) => (
              editingContactId === contact.id ? (
                <div key={contact.id} className="space-y-2 border rounded-lg p-3 bg-muted/30" data-testid={`contact-edit-form-${contact.id}`}>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">Vorname</Label>
                      <Input value={emergencyContactForm.vorname} onChange={(e) => setEmergencyContactForm(f => ({ ...f, vorname: e.target.value }))} className="h-9" data-testid="input-contact-vorname" />
                    </div>
                    <div>
                      <Label className="text-xs">Nachname</Label>
                      <Input value={emergencyContactForm.nachname} onChange={(e) => setEmergencyContactForm(f => ({ ...f, nachname: e.target.value }))} className="h-9" data-testid="input-contact-nachname" />
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs">Telefon</Label>
                    <Input
                      value={emergencyContactForm.telefon}
                      onChange={(e) => {
                        setEmergencyContactForm(f => ({ ...f, telefon: formatPhoneAsYouType(e.target.value) }));
                        setEmergencyFormErrors(prev => ({ ...prev, telefon: "" }));
                      }}
                      onBlur={() => {
                        const err = validatePhone(emergencyContactForm.telefon, "telefon");
                        if (err) setEmergencyFormErrors(prev => ({ ...prev, telefon: err }));
                      }}
                      placeholder="0151 12345678"
                      inputMode="tel"
                      className={`h-9 ${emergencyFormErrors.telefon ? "border-red-400" : ""}`}
                      data-testid="input-contact-telefon"
                    />
                    {emergencyFormErrors.telefon && <span className="text-xs text-red-500 mt-0.5">{emergencyFormErrors.telefon}</span>}
                  </div>
                  <div>
                    <Label className="text-xs">E-Mail</Label>
                    <Input
                      value={emergencyContactForm.email}
                      onChange={(e) => {
                        setEmergencyContactForm(f => ({ ...f, email: e.target.value }));
                        setEmergencyFormErrors(prev => ({ ...prev, email: "" }));
                      }}
                      onBlur={() => {
                        const err = validateEmail(emergencyContactForm.email);
                        if (err) setEmergencyFormErrors(prev => ({ ...prev, email: err }));
                      }}
                      placeholder="name@beispiel.de"
                      className={`h-9 ${emergencyFormErrors.email ? "border-red-400" : ""}`}
                      data-testid="input-contact-email"
                    />
                    {emergencyFormErrors.email && <span className="text-xs text-red-500 mt-0.5">{emergencyFormErrors.email}</span>}
                  </div>
                  <div>
                    <Label className="text-xs">Beziehung</Label>
                    <Select value={emergencyContactForm.contactType} onValueChange={(v) => setEmergencyContactForm(f => ({ ...f, contactType: v }))}>
                      <SelectTrigger className="h-9" data-testid="select-contact-type">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CONTACT_TYPE_SELECT_OPTIONS.map(opt => (
                          <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs">Notizen</Label>
                    <Input value={emergencyContactForm.notes} onChange={(e) => setEmergencyContactForm(f => ({ ...f, notes: e.target.value }))} className="h-9" placeholder="Optional" data-testid="input-contact-notes" />
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch checked={emergencyContactForm.isPrimary} onCheckedChange={(v) => setEmergencyContactForm(f => ({ ...f, isPrimary: v }))} data-testid="switch-contact-primary" />
                    <Label className="text-xs">Primärer Kontakt</Label>
                  </div>
                  <div className="flex gap-2 pt-1">
                    <Button size="sm" onClick={handleSaveEmergencyContact} disabled={contactSaving} className="min-h-[36px]" data-testid="button-save-contact">
                      {contactSaving ? <Loader2 className={`${iconSize.sm} animate-spin`} /> : <><Save className={`${iconSize.sm} mr-1`} />Speichern</>}
                    </Button>
                    <Button size="sm" variant="outline" onClick={cancelEditContact} disabled={contactSaving} className="min-h-[36px]" data-testid="button-cancel-contact">
                      Abbrechen
                    </Button>
                  </div>
                </div>
              ) : (
                <div key={contact.id} className="flex items-start justify-between gap-3 text-sm" data-testid={`contact-${contact.id}`}>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{contact.vorname} {contact.nachname}</span>
                      {contact.isPrimary && (
                        <span className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded">Primär</span>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {CONTACT_TYPE_LABELS[contact.contactType] ?? contact.contactType}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <a
                      href={`tel:${contact.telefon}`}
                      className="text-primary hover:underline flex items-center gap-1 text-sm"
                      onClick={(e) => e.stopPropagation()}
                      data-testid={`link-contact-phone-${contact.id}`}
                    >
                      <Phone className={iconSize.xs} />
                      {formatPhoneForDisplay(contact.telefon)}
                    </a>
                    <Button variant="ghost" size="sm" className="min-h-[44px] min-w-[44px] p-0" onClick={() => startEditContact(contact)} data-testid={`button-edit-contact-${contact.id}`}>
                      <Pencil className="h-3 w-3 text-muted-foreground" />
                    </Button>
                    <Button variant="ghost" size="sm" className="min-h-[44px] min-w-[44px] p-0" onClick={() => {
                      if (confirm(`Kontakt "${contact.vorname} ${contact.nachname}" wirklich löschen?`)) {
                        deleteContactMutation.mutate(contact.id);
                      }
                    }} disabled={contactSaving} data-testid={`button-delete-contact-${contact.id}`}>
                      <Trash2 className="h-3 w-3 text-muted-foreground" />
                    </Button>
                  </div>
                </div>
              )
            ))}
          </div>
        )}

        {!contacts?.length && !showAddContact && (
          <p className="text-sm text-muted-foreground/60">Keine Notfallkontakte hinterlegt</p>
        )}

        {showAddContact && (
          <div className="space-y-2 border rounded-lg p-3 bg-muted/30" data-testid="contact-add-form">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs">Vorname</Label>
                <Input value={emergencyContactForm.vorname} onChange={(e) => setEmergencyContactForm(f => ({ ...f, vorname: e.target.value }))} className="h-9" data-testid="input-new-contact-vorname" />
              </div>
              <div>
                <Label className="text-xs">Nachname</Label>
                <Input value={emergencyContactForm.nachname} onChange={(e) => setEmergencyContactForm(f => ({ ...f, nachname: e.target.value }))} className="h-9" data-testid="input-new-contact-nachname" />
              </div>
            </div>
            <div>
              <Label className="text-xs">Telefon</Label>
              <Input
                value={emergencyContactForm.telefon}
                onChange={(e) => {
                  setEmergencyContactForm(f => ({ ...f, telefon: formatPhoneAsYouType(e.target.value) }));
                  setEmergencyFormErrors(prev => ({ ...prev, telefon: "" }));
                }}
                onBlur={() => {
                  const err = validatePhone(emergencyContactForm.telefon, "telefon");
                  if (err) setEmergencyFormErrors(prev => ({ ...prev, telefon: err }));
                }}
                placeholder="0151 12345678"
                inputMode="tel"
                className={`h-9 ${emergencyFormErrors.telefon ? "border-red-400" : ""}`}
                data-testid="input-new-contact-telefon"
              />
              {emergencyFormErrors.telefon && <span className="text-xs text-red-500 mt-0.5">{emergencyFormErrors.telefon}</span>}
            </div>
            <div>
              <Label className="text-xs">E-Mail</Label>
              <Input
                value={emergencyContactForm.email}
                onChange={(e) => {
                  setEmergencyContactForm(f => ({ ...f, email: e.target.value }));
                  setEmergencyFormErrors(prev => ({ ...prev, email: "" }));
                }}
                onBlur={() => {
                  const err = validateEmail(emergencyContactForm.email);
                  if (err) setEmergencyFormErrors(prev => ({ ...prev, email: err }));
                }}
                placeholder="name@beispiel.de (optional)"
                className={`h-9 ${emergencyFormErrors.email ? "border-red-400" : ""}`}
                data-testid="input-new-contact-email"
              />
              {emergencyFormErrors.email && <span className="text-xs text-red-500 mt-0.5">{emergencyFormErrors.email}</span>}
            </div>
            <div>
              <Label className="text-xs">Beziehung</Label>
              <Select value={emergencyContactForm.contactType} onValueChange={(v) => setEmergencyContactForm(f => ({ ...f, contactType: v }))}>
                <SelectTrigger className="h-9" data-testid="select-new-contact-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONTACT_TYPE_SELECT_OPTIONS.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Notizen</Label>
              <Input value={emergencyContactForm.notes} onChange={(e) => setEmergencyContactForm(f => ({ ...f, notes: e.target.value }))} className="h-9" placeholder="Optional" data-testid="input-new-contact-notes" />
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={emergencyContactForm.isPrimary} onCheckedChange={(v) => setEmergencyContactForm(f => ({ ...f, isPrimary: v }))} data-testid="switch-new-contact-primary" />
              <Label className="text-xs">Primärer Kontakt</Label>
            </div>
            <div className="flex gap-2 pt-1">
              <Button size="sm" onClick={handleSaveEmergencyContact} disabled={contactSaving || !emergencyContactForm.vorname || !emergencyContactForm.nachname || !emergencyContactForm.telefon} className="min-h-[36px]" data-testid="button-save-new-contact">
                {contactSaving ? <Loader2 className={`${iconSize.sm} animate-spin`} /> : <><Save className={`${iconSize.sm} mr-1`} />Speichern</>}
              </Button>
              <Button size="sm" variant="outline" onClick={cancelEditContact} disabled={contactSaving} className="min-h-[36px]" data-testid="button-cancel-new-contact">
                Abbrechen
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
