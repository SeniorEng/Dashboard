import { useState } from "react";
import { Link } from "wouter";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  useInsuranceProviders,
  useCreateInsuranceProvider,
  useUpdateInsuranceProvider,
  type InsuranceProviderFormData,
} from "@/features/customers";
import type { InsuranceProviderItem } from "@/lib/api/types";
import {
  ZAHLUNGSBEDINGUNGEN,
  ZAHLUNGSBEDINGUNGEN_LABELS,
  ZAHLUNGSARTEN,
  ZAHLUNGSARTEN_LABELS,
} from "@shared/schema";
import { formatAddress } from "@shared/utils/format";
import { api, unwrapResult } from "@/lib/api";
import { ArrowLeft, Plus, Pencil, Loader2, Building2, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { iconSize, componentStyles } from "@/design-system";

const EMPTY_FORM: InsuranceProviderFormData = {
  name: "",
  empfaenger: "",
  empfaengerZeile2: "",
  ikNummer: "",
  strasse: "",
  hausnummer: "",
  plz: "",
  stadt: "",
  telefon: "",
  email: "",
  emailInvoiceEnabled: false,
  zahlungsbedingungen: "30_tage",
  zahlungsart: "ueberweisung",
  isActive: true,
};

export default function AdminInsuranceProviders() {
  const { toast } = useToast();
  const { data: providers, isLoading } = useInsuranceProviders(true);
  const createMutation = useCreateInsuranceProvider();
  const updateMutation = useUpdateInsuranceProvider();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<InsuranceProviderItem | null>(null);
  const [form, setForm] = useState<InsuranceProviderFormData>(EMPTY_FORM);
  const [deactivateConfirm, setDeactivateConfirm] = useState<{ count: number; payload: InsuranceProviderFormData } | null>(null);

  const openCreate = () => {
    setEditingProvider(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (provider: InsuranceProviderItem) => {
    setEditingProvider(provider);
    setForm({
      name: provider.name,
      empfaenger: provider.empfaenger || "",
      empfaengerZeile2: provider.empfaengerZeile2 || "",
      ikNummer: provider.ikNummer,
      strasse: provider.strasse || "",
      hausnummer: provider.hausnummer || "",
      plz: provider.plz || "",
      stadt: provider.stadt || "",
      telefon: provider.telefon || "",
      email: provider.email || "",
      emailInvoiceEnabled: provider.emailInvoiceEnabled,
      zahlungsbedingungen: provider.zahlungsbedingungen || "30_tage",
      zahlungsart: provider.zahlungsart || "ueberweisung",
      isActive: provider.isActive,
    });
    setDialogOpen(true);
  };

  const handleChange = (field: keyof InsuranceProviderFormData, value: string | boolean) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const buildPayload = (): InsuranceProviderFormData | null => {
    if (!form.name.trim()) {
      toast({ title: "Suchbegriff ist erforderlich", variant: "destructive" });
      return null;
    }
    if (!form.ikNummer.trim() || !/^\d{9}$/.test(form.ikNummer)) {
      toast({ title: "IK-Nummer muss genau 9 Ziffern haben", variant: "destructive" });
      return null;
    }
    const plzValue = typeof form.plz === 'string' ? form.plz.trim() : "";
    if (plzValue && !/^\d{5}$/.test(plzValue)) {
      toast({ title: "PLZ muss genau 5 Ziffern haben", variant: "destructive" });
      return null;
    }

    return {
      ...form,
      empfaenger: form.empfaenger?.trim() || null,
      empfaengerZeile2: form.empfaengerZeile2?.trim() || null,
      strasse: form.strasse?.trim() || null,
      hausnummer: form.hausnummer?.trim() || null,
      plz: plzValue || null,
      stadt: form.stadt?.trim() || null,
      telefon: form.telefon?.trim() || null,
      email: form.email?.trim() || null,
    };
  };

  const executeSave = (payload: InsuranceProviderFormData) => {
    if (editingProvider) {
      updateMutation.mutate(
        { id: editingProvider.id, data: payload },
        {
          onSuccess: () => {
            toast({ title: "Kostenträger aktualisiert" });
            setDialogOpen(false);
          },
          onError: (error: Error) => {
            toast({ title: "Fehler", description: error.message, variant: "destructive" });
          },
        }
      );
    } else {
      createMutation.mutate(payload, {
        onSuccess: () => {
          toast({ title: "Kostenträger angelegt" });
          setDialogOpen(false);
        },
        onError: (error: Error) => {
          toast({ title: "Fehler", description: error.message, variant: "destructive" });
        },
      });
    }
  };

  const handleSave = async () => {
    const payload = buildPayload();
    if (!payload) return;

    const isDeactivating = editingProvider && editingProvider.isActive && payload.isActive === false;
    if (isDeactivating) {
      try {
        const result = await api.get<{ count: number }>(`/admin/insurance-providers/${editingProvider.id}/active-customers`);
        const { count } = unwrapResult(result);
        if (count > 0) {
          setDeactivateConfirm({ count, payload });
          return;
        }
      } catch {
        // If check fails, proceed without warning
      }
    }

    executeSave(payload);
  };

  const isSaving = createMutation.isPending || updateMutation.isPending;

  const zahlungsbedingungOptions = ZAHLUNGSBEDINGUNGEN.map((key) => ({
    value: key,
    label: ZAHLUNGSBEDINGUNGEN_LABELS[key],
  }));

  const zahlungsartOptions = ZAHLUNGSARTEN.map((key) => ({
    value: key,
    label: ZAHLUNGSARTEN_LABELS[key],
  }));

  return (
    <Layout variant="admin">
          <div className="flex items-center gap-4 mb-6">
            <Link href="/admin">
              <Button variant="ghost" size="icon" aria-label="Zurück" data-testid="button-back">
                <ArrowLeft className={iconSize.md} />
              </Button>
            </Link>
            <div className="flex-1">
              <h1 className={componentStyles.pageTitle}>Kostenträger</h1>
              <p className="text-gray-600">Pflegekassen verwalten</p>
            </div>
            <Button onClick={openCreate} className={componentStyles.btnPrimary} data-testid="button-add-provider">
              <Plus className={`${iconSize.sm} mr-1`} />
              Neu
            </Button>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
            </div>
          ) : !providers?.length ? (
            <Card>
              <CardContent className="py-12 text-center">
                <Building2 className="h-12 w-12 mx-auto mb-4 text-gray-300" />
                <p className="text-gray-500 mb-4">Noch keine Kostenträger angelegt</p>
                <Button onClick={openCreate} className={componentStyles.btnPrimary} data-testid="button-add-first-provider">
                  <Plus className={`${iconSize.sm} mr-1`} />
                  Kostenträger hinzufügen
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="flex flex-col gap-3">
              {providers.map((provider) => (
                <Card
                  key={provider.id}
                  className={`cursor-pointer hover:shadow-md transition-shadow ${!provider.isActive ? "opacity-60" : ""}`}
                  onClick={() => openEdit(provider)}
                  data-testid={`card-provider-${provider.id}`}
                >
                  <CardContent className="py-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-medium text-gray-900 truncate">{provider.name}</span>
                          {!provider.isActive && (
                            <span className="text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full">Inaktiv</span>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-500">
                          <span>IK: {provider.ikNummer}</span>
                          {provider.empfaenger && <span>· {provider.empfaenger}</span>}
                          {(provider.strasse || provider.plz || provider.stadt) && (
                            <span>· {formatAddress(provider)}</span>
                          )}
                        </div>
                        {provider.zahlungsbedingungen && (
                          <div className="text-xs text-gray-500 mt-1">
                            {ZAHLUNGSBEDINGUNGEN_LABELS[provider.zahlungsbedingungen] || provider.zahlungsbedingungen}
                            {provider.zahlungsart && ` · ${ZAHLUNGSARTEN_LABELS[provider.zahlungsart] || provider.zahlungsart}`}
                          </div>
                        )}
                      </div>
                      <Pencil className={`${iconSize.sm} text-gray-400 shrink-0`} />
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingProvider ? "Kostenträger bearbeiten" : "Neuen Kostenträger hinzufügen"}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 mt-2">
            <div className="space-y-2">
              <Label htmlFor="name">Suchbegriff *</Label>
              <Input
                id="name"
                value={form.name}
                onChange={(e) => handleChange("name", e.target.value)}
                placeholder="z. B. DAK"
                data-testid="input-provider-name"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="empfaenger">Empfänger</Label>
              <Input
                id="empfaenger"
                value={form.empfaenger || ""}
                onChange={(e) => handleChange("empfaenger", e.target.value)}
                placeholder="z. B. DAK NordWest"
                data-testid="input-provider-empfaenger"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="empfaengerZeile2">Empfänger Zeile 2 (optional)</Label>
              <Input
                id="empfaengerZeile2"
                value={form.empfaengerZeile2 || ""}
                onChange={(e) => handleChange("empfaengerZeile2", e.target.value)}
                placeholder="z. B. z. H. Herrn Mustermann"
                data-testid="input-provider-empfaenger-zeile2"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="ikNummer">IK-Nummer *</Label>
              <Input
                id="ikNummer"
                value={form.ikNummer}
                onChange={(e) => handleChange("ikNummer", e.target.value.replace(/\D/g, ""))}
                placeholder="123456789"
                maxLength={9}
                data-testid="input-provider-ik"
              />
              <p className="text-xs text-gray-500">9-stelliges Institutionskennzeichen</p>
            </div>

            <div className="border-t pt-4">
              <p className="text-xs text-gray-500 mb-3 font-medium uppercase tracking-wide">Adresse</p>
              <div className="space-y-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div className="col-span-3 space-y-2">
                    <Label htmlFor="strasse">Straße</Label>
                    <Input
                      id="strasse"
                      value={form.strasse || ""}
                      onChange={(e) => handleChange("strasse", e.target.value)}
                      placeholder="Musterstraße"
                      data-testid="input-provider-strasse"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="hausnummer">Nr.</Label>
                    <Input
                      id="hausnummer"
                      value={form.hausnummer || ""}
                      onChange={(e) => handleChange("hausnummer", e.target.value)}
                      placeholder="12"
                      data-testid="input-provider-hausnummer"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="plz">PLZ</Label>
                    <Input
                      id="plz"
                      value={form.plz || ""}
                      onChange={(e) => handleChange("plz", e.target.value.replace(/\D/g, ""))}
                      placeholder="12345"
                      maxLength={5}
                      data-testid="input-provider-plz"
                    />
                  </div>
                  <div className="col-span-3 space-y-2">
                    <Label htmlFor="stadt">Stadt</Label>
                    <Input
                      id="stadt"
                      value={form.stadt || ""}
                      onChange={(e) => handleChange("stadt", e.target.value)}
                      placeholder="Musterstadt"
                      data-testid="input-provider-stadt"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="border-t pt-4">
              <p className="text-xs text-gray-500 mb-3 font-medium uppercase tracking-wide">Kontakt</p>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="telefon">Telefon</Label>
                  <Input
                    id="telefon"
                    value={form.telefon || ""}
                    onChange={(e) => handleChange("telefon", e.target.value)}
                    placeholder="+49 89 1234567"
                    data-testid="input-provider-telefon"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email">E-Mail</Label>
                  <Input
                    id="email"
                    type="email"
                    value={form.email || ""}
                    onChange={(e) => handleChange("email", e.target.value)}
                    placeholder="kontakt@pflegekasse.de"
                    data-testid="input-provider-email"
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3 py-2">
              <Switch
                id="emailInvoiceEnabled"
                checked={form.emailInvoiceEnabled}
                onCheckedChange={(checked) => handleChange("emailInvoiceEnabled", checked)}
                data-testid="switch-email-invoice"
              />
              <Label htmlFor="emailInvoiceEnabled" className="cursor-pointer">
                E-Mail-Versand für Rechnungen aktivieren
              </Label>
            </div>

            <div className="border-t pt-4">
              <p className="text-xs text-gray-500 mb-3 font-medium uppercase tracking-wide">Zahlung</p>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Zahlungsbedingungen</Label>
                  <SearchableSelect
                    options={zahlungsbedingungOptions}
                    value={form.zahlungsbedingungen || "30_tage"}
                    onValueChange={(value) => handleChange("zahlungsbedingungen", value)}
                    placeholder="Auswählen..."
                    searchPlaceholder="Suchen..."
                    emptyText="Keine Optionen."
                    data-testid="select-zahlungsbedingungen"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Zahlungsart</Label>
                  <SearchableSelect
                    options={zahlungsartOptions}
                    value={form.zahlungsart || "ueberweisung"}
                    onValueChange={(value) => handleChange("zahlungsart", value)}
                    placeholder="Auswählen..."
                    searchPlaceholder="Suchen..."
                    emptyText="Keine Optionen."
                    data-testid="select-zahlungsart"
                  />
                </div>
              </div>
            </div>

            {editingProvider && (
              <div className="flex items-center gap-3 py-2 border-t pt-4">
                <Switch
                  id="isActive"
                  checked={form.isActive}
                  onCheckedChange={(checked) => handleChange("isActive", checked)}
                  data-testid="switch-is-active"
                />
                <Label htmlFor="isActive" className="cursor-pointer">
                  Kostenträger aktiv
                </Label>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-4 border-t">
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialogOpen(false)}
                data-testid="button-cancel"
              >
                Abbrechen
              </Button>
              <Button
                type="button"
                className={componentStyles.btnPrimary}
                onClick={handleSave}
                disabled={isSaving}
                data-testid="button-save-provider"
              >
                {isSaving ? (
                  <>
                    <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                    Speichern...
                  </>
                ) : editingProvider ? (
                  "Änderungen speichern"
                ) : (
                  "Anbieter hinzufügen"
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deactivateConfirm} onOpenChange={(open) => !open && setDeactivateConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className={`${iconSize.md} text-amber-500`} />
              Kostenträger deaktivieren?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Dieser Kostenträger ist aktuell noch {deactivateConfirm?.count} {deactivateConfirm?.count === 1 ? "Kunden" : "Kunden"} zugewiesen.
              Nach der Deaktivierung kann er nicht mehr für neue Zuweisungen ausgewählt werden. Bestehende Zuweisungen bleiben erhalten.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-deactivate">Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              className="bg-amber-600 hover:bg-amber-700"
              onClick={() => {
                if (deactivateConfirm) {
                  executeSave(deactivateConfirm.payload);
                  setDeactivateConfirm(null);
                }
              }}
              data-testid="button-confirm-deactivate"
            >
              Trotzdem deaktivieren
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Layout>
  );
}
