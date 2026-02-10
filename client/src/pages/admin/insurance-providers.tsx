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
import { ArrowLeft, Plus, Pencil, Loader2, Building2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { iconSize, componentStyles } from "@/design-system";

const EMPTY_FORM: InsuranceProviderFormData = {
  name: "",
  empfaenger: "",
  empfaengerZeile2: "",
  ikNummer: "",
  anschrift: "",
  plzOrt: "",
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
      anschrift: provider.anschrift || "",
      plzOrt: provider.plzOrt || "",
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

  const handleSave = () => {
    if (!form.name.trim()) {
      toast({ title: "Suchbegriff ist erforderlich", variant: "destructive" });
      return;
    }
    if (!form.ikNummer.trim() || !/^\d{9}$/.test(form.ikNummer)) {
      toast({ title: "IK-Nummer muss genau 9 Ziffern haben", variant: "destructive" });
      return;
    }

    const payload: InsuranceProviderFormData = {
      ...form,
      empfaenger: form.empfaenger?.trim() || null,
      empfaengerZeile2: form.empfaengerZeile2?.trim() || null,
      anschrift: form.anschrift?.trim() || null,
      plzOrt: form.plzOrt?.trim() || null,
      telefon: form.telefon?.trim() || null,
      email: form.email?.trim() || null,
    };

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
    <Layout>
      <div className="min-h-screen bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]">
        <div className="container mx-auto px-4 py-6 max-w-4xl">
          <div className="flex items-center gap-4 mb-6">
            <Link href="/admin">
              <Button variant="ghost" size="icon" data-testid="button-back">
                <ArrowLeft className={iconSize.md} />
              </Button>
            </Link>
            <div className="flex-1">
              <h1 className="text-2xl font-bold text-gray-900">Kostenträger</h1>
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
                        <div className="flex items-center gap-3 text-sm text-gray-500">
                          <span>IK: {provider.ikNummer}</span>
                          {provider.empfaenger && <span>· {provider.empfaenger}</span>}
                          {provider.plzOrt && <span>· {provider.plzOrt}</span>}
                        </div>
                        {provider.zahlungsbedingungen && (
                          <div className="text-xs text-gray-400 mt-1">
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
        </div>
      </div>

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

            <div className="grid grid-cols-2 gap-4">
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

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="anschrift">Anschrift</Label>
                <Input
                  id="anschrift"
                  value={form.anschrift || ""}
                  onChange={(e) => handleChange("anschrift", e.target.value)}
                  placeholder="Musterstr. 2"
                  data-testid="input-provider-anschrift"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="plzOrt">PLZ & Ort</Label>
                <Input
                  id="plzOrt"
                  value={form.plzOrt || ""}
                  onChange={(e) => handleChange("plzOrt", e.target.value)}
                  placeholder="12345 Musterstadt"
                  data-testid="input-provider-plz-ort"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
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

            <div className="grid grid-cols-2 gap-4">
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
    </Layout>
  );
}
