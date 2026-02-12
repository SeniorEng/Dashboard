import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { SectionCard } from "@/components/patterns/section-card";
import { EmptyState } from "@/components/patterns/empty-state";
import { iconSize, componentStyles } from "@/design-system";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Users,
  Plus,
  Edit,
  Trash2,
  Loader2,
  Save,
  X,
  Phone,
  Mail,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api";
import { formatPhoneForDisplay, formatPhoneAsYouType, validateGermanPhone, normalizePhone } from "@shared/utils/phone";
import type { CustomerContactItem } from "@/lib/api/types";

const CONTACT_TYPE_OPTIONS = [
  { value: "familie", label: "Familienmitglied" },
  { value: "angehoerige", label: "Angehörige" },
  { value: "nachbar", label: "Nachbar/in" },
  { value: "hausarzt", label: "Hausarzt" },
  { value: "betreuer", label: "Betreuer/in" },
  { value: "sonstige", label: "Sonstige" },
];

function getContactTypeLabel(value: string): string {
  return CONTACT_TYPE_OPTIONS.find(o => o.value === value)?.label ?? value;
}

interface ContactFormState {
  vorname: string;
  nachname: string;
  contactType: string;
  telefon: string;
  email: string;
  isPrimary: boolean;
}

const EMPTY_FORM: ContactFormState = {
  vorname: "",
  nachname: "",
  contactType: "familie",
  telefon: "",
  email: "",
  isPrimary: false,
};

function contactToForm(c: CustomerContactItem): ContactFormState {
  return {
    vorname: c.vorname,
    nachname: c.nachname,
    contactType: c.contactType,
    telefon: formatPhoneForDisplay(c.telefon),
    email: c.email ?? "",
    isPrimary: c.isPrimary,
  };
}

interface Props {
  customerId: number;
  initialContacts?: CustomerContactItem[];
}

export function CustomerContactsTab({ customerId, initialContacts }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [form, setForm] = useState<ContactFormState>(EMPTY_FORM);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);

  const contactsQueryKey = ["admin", "customers", customerId, "contacts"];

  const { data: contacts, isLoading } = useQuery<CustomerContactItem[]>({
    queryKey: contactsQueryKey,
    queryFn: async () => {
      const res = await fetch(`/api/admin/customers/${customerId}/contacts`, { credentials: "include" });
      if (!res.ok) throw new Error("Kontakte konnten nicht geladen werden");
      return res.json();
    },
    initialData: initialContacts,
  });

  const updateField = useCallback((field: keyof ContactFormState, value: string | boolean) => {
    if (field === "telefon" && typeof value === "string") {
      const formatted = formatPhoneAsYouType(value);
      setForm(prev => ({ ...prev, telefon: formatted }));
      if (value.trim()) {
        const validation = validateGermanPhone(value);
        setPhoneError(validation.valid ? null : validation.error || "Ungültige Telefonnummer");
      } else {
        setPhoneError(null);
      }
      return;
    }
    setForm(prev => ({ ...prev, [field]: value }));
  }, []);

  const addMutation = useMutation({
    mutationFn: async (data: ContactFormState) => {
      const normalizedPhone = data.telefon.trim() ? (normalizePhone(data.telefon) ?? data.telefon) : "";
      const result = await api.post(`/admin/customers/${customerId}/contacts`, {
        customerId,
        contactType: data.contactType,
        isPrimary: data.isPrimary,
        vorname: data.vorname,
        nachname: data.nachname,
        telefon: normalizedPhone,
        email: data.email || null,
      });
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: contactsQueryKey });
      setIsAdding(false);
      setForm(EMPTY_FORM);
      setPhoneError(null);
      toast({ title: "Kontakt hinzugefügt" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: ContactFormState }) => {
      const normalizedPhone = data.telefon.trim() ? (normalizePhone(data.telefon) ?? data.telefon) : "";
      const result = await api.patch(`/admin/customers/${customerId}/contacts/${id}`, {
        contactType: data.contactType,
        isPrimary: data.isPrimary,
        vorname: data.vorname,
        nachname: data.nachname,
        telefon: normalizedPhone,
        email: data.email || null,
      });
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: contactsQueryKey });
      setEditingId(null);
      setForm(EMPTY_FORM);
      setPhoneError(null);
      toast({ title: "Kontakt aktualisiert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const result = await api.delete(`/admin/customers/${customerId}/contacts/${id}`);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: contactsQueryKey });
      setDeleteConfirmId(null);
      toast({ title: "Kontakt entfernt" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const startEdit = useCallback((contact: CustomerContactItem) => {
    setIsAdding(false);
    setEditingId(contact.id);
    setForm(contactToForm(contact));
    setPhoneError(null);
    setDeleteConfirmId(null);
  }, []);

  const startAdd = useCallback(() => {
    setEditingId(null);
    setIsAdding(true);
    setForm({ ...EMPTY_FORM, isPrimary: !contacts || contacts.length === 0 });
    setPhoneError(null);
    setDeleteConfirmId(null);
  }, [contacts]);

  const cancelForm = useCallback(() => {
    setEditingId(null);
    setIsAdding(false);
    setForm(EMPTY_FORM);
    setPhoneError(null);
  }, []);

  const handleSubmit = useCallback(() => {
    if (!form.vorname.trim() || !form.nachname.trim()) {
      toast({ title: "Bitte Vor- und Nachname eingeben", variant: "destructive" });
      return;
    }
    if (form.telefon.trim()) {
      const validation = validateGermanPhone(form.telefon);
      if (!validation.valid) {
        setPhoneError(validation.error || "Ungültige Telefonnummer");
        return;
      }
    }
    if (editingId !== null) {
      updateMutation.mutate({ id: editingId, data: form });
    } else {
      addMutation.mutate(form);
    }
  }, [form, editingId, updateMutation, addMutation, toast]);

  const isSaving = addMutation.isPending || updateMutation.isPending;

  const renderForm = () => (
    <div className="p-4 bg-gray-50 rounded-lg space-y-3 border border-gray-200">
      <p className="text-sm font-medium text-gray-700">
        {editingId !== null ? "Kontakt bearbeiten" : "Neuen Kontakt hinzufügen"}
      </p>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Vorname *</Label>
          <Input
            value={form.vorname}
            onChange={(e) => updateField("vorname", e.target.value)}
            className="text-base"
            data-testid="input-contact-edit-vorname"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Nachname *</Label>
          <Input
            value={form.nachname}
            onChange={(e) => updateField("nachname", e.target.value)}
            className="text-base"
            data-testid="input-contact-edit-nachname"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Kontaktart</Label>
          <Select value={form.contactType} onValueChange={(v) => updateField("contactType", v)}>
            <SelectTrigger data-testid="select-contact-edit-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONTACT_TYPE_OPTIONS.map(t => (
                <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Telefon</Label>
          <Input
            value={form.telefon}
            onChange={(e) => updateField("telefon", e.target.value)}
            placeholder="0170 1234567"
            className={`text-base ${phoneError ? "border-red-500" : ""}`}
            data-testid="input-contact-edit-telefon"
          />
          {phoneError && <p className="text-[11px] text-red-500">{phoneError}</p>}
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">E-Mail (optional)</Label>
        <Input
          type="email"
          value={form.email}
          onChange={(e) => updateField("email", e.target.value)}
          className="text-base"
          data-testid="input-contact-edit-email"
        />
      </div>

      <div className="flex items-center space-x-2">
        <Checkbox
          id="contact-edit-primary"
          checked={form.isPrimary}
          onCheckedChange={(checked) => updateField("isPrimary", !!checked)}
          data-testid="checkbox-contact-edit-primary"
        />
        <Label htmlFor="contact-edit-primary" className="text-sm">Hauptkontakt</Label>
      </div>

      <div className="flex gap-2 pt-1">
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={isSaving}
          className={componentStyles.btnPrimary}
          data-testid="button-contact-save"
        >
          {isSaving ? (
            <><Loader2 className={`${iconSize.sm} mr-1 animate-spin`} />Speichern...</>
          ) : (
            <><Save className={`${iconSize.sm} mr-1`} />Speichern</>
          )}
        </Button>
        <Button size="sm" variant="outline" onClick={cancelForm} disabled={isSaving}>
          <X className={`${iconSize.sm} mr-1`} />
          Abbrechen
        </Button>
      </div>
    </div>
  );

  return (
    <SectionCard
      title="Ansprechpartner & Notfallkontakte"
      icon={<Users className={iconSize.sm} />}
      actions={
        !isAdding && editingId === null ? (
          <Button
            size="sm"
            variant="outline"
            onClick={startAdd}
            data-testid="button-add-contact"
          >
            <Plus className={`${iconSize.sm} mr-1`} />
            Hinzufügen
          </Button>
        ) : undefined
      }
    >
      {isAdding && renderForm()}

      {isLoading ? (
        <div className="flex justify-center py-4">
          <Loader2 className={`${iconSize.md} animate-spin text-teal-600`} />
        </div>
      ) : contacts && contacts.length > 0 ? (
        <div className="space-y-3">
          {contacts.map((contact) => (
            <div key={contact.id}>
              {editingId === contact.id ? (
                renderForm()
              ) : (
                <div
                  className="flex items-center justify-between p-3 rounded-lg bg-gray-50"
                  data-testid={`contact-card-${contact.id}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <p className="font-medium text-sm">{contact.vorname} {contact.nachname}</p>
                      {contact.isPrimary && (
                        <Badge variant="secondary" className="text-xs">
                          Hauptkontakt
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-gray-500">{getContactTypeLabel(contact.contactType)}</p>
                    {contact.telefon && (
                      <a
                        href={`tel:${contact.telefon}`}
                        className="text-sm text-gray-700 flex items-center gap-1 mt-1 hover:text-teal-600"
                        data-testid={`contact-phone-${contact.id}`}
                      >
                        <Phone className="h-3 w-3" />
                        {formatPhoneForDisplay(contact.telefon)}
                      </a>
                    )}
                    {contact.email && (
                      <a
                        href={`mailto:${contact.email}`}
                        className="text-sm text-gray-600 flex items-center gap-1 mt-0.5 hover:text-teal-600"
                        data-testid={`contact-email-${contact.id}`}
                      >
                        <Mail className="h-3 w-3" />
                        {contact.email}
                      </a>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {deleteConfirmId === contact.id ? (
                      <div className="flex items-center gap-1">
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => deleteMutation.mutate(contact.id)}
                          disabled={deleteMutation.isPending}
                          data-testid={`button-confirm-delete-contact-${contact.id}`}
                        >
                          {deleteMutation.isPending ? (
                            <Loader2 className={`${iconSize.sm} animate-spin`} />
                          ) : "Löschen"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleteConfirmId(null)}
                        >
                          <X className={iconSize.sm} />
                        </Button>
                      </div>
                    ) : (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => startEdit(contact)}
                          data-testid={`button-edit-contact-${contact.id}`}
                        >
                          <Edit className={`${iconSize.sm} text-gray-600`} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-gray-400 hover:text-red-500"
                          onClick={() => setDeleteConfirmId(contact.id)}
                          data-testid={`button-delete-contact-${contact.id}`}
                        >
                          <Trash2 className={`${iconSize.sm}`} />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : !isAdding ? (
        <EmptyState
          icon={<Users className={iconSize.xl} />}
          title="Keine Kontakte"
          description="Noch keine Kontakte hinterlegt"
          action={
            <Button size="sm" className={componentStyles.btnPrimary} onClick={startAdd}>
              <Plus className={`${iconSize.sm} mr-1`} />
              Kontakt hinzufügen
            </Button>
          }
          className="py-6"
        />
      ) : null}
    </SectionCard>
  );
}
