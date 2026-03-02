import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useCreateInsuranceProvider } from "@/features/customers";
import type { InsuranceProviderFormData } from "@/features/customers";
import { Loader2, Check, Plus, X } from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { CustomerFormData, SelectOption } from "./customer-types";
import {
  ZAHLUNGSBEDINGUNGEN,
  ZAHLUNGSBEDINGUNGEN_LABELS,
  ZAHLUNGSARTEN,
  ZAHLUNGSARTEN_LABELS,
} from "@shared/schema";

interface InsuranceStepProps {
  formData: CustomerFormData;
  insuranceOptions: SelectOption[];
  insuranceProvidersEmpty: boolean;
  onChange: (field: string, value: string | boolean) => void;
  onInsuranceProviderCreated: (providerId: string) => void;
}

const EMPTY_PROVIDER: InsuranceProviderFormData = {
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
};

const zahlungsbedingungOptions = ZAHLUNGSBEDINGUNGEN.map((key) => ({
  value: key,
  label: ZAHLUNGSBEDINGUNGEN_LABELS[key],
}));

const zahlungsartOptions = ZAHLUNGSARTEN.map((key) => ({
  value: key,
  label: ZAHLUNGSARTEN_LABELS[key],
}));

export function InsuranceStep({
  formData,
  insuranceOptions,
  insuranceProvidersEmpty,
  onChange,
  onInsuranceProviderCreated,
}: InsuranceStepProps) {
  const { toast } = useToast();
  const createProviderMutation = useCreateInsuranceProvider();
  const [showNewProviderForm, setShowNewProviderForm] = useState(false);
  const [newProvider, setNewProvider] = useState<InsuranceProviderFormData>({ ...EMPTY_PROVIDER });

  const handleNewProviderChange = (field: keyof InsuranceProviderFormData, value: string | boolean) => {
    setNewProvider((prev) => ({ ...prev, [field]: value }));
  };

  const handleCreateProvider = () => {
    if (!newProvider.name.trim()) {
      toast({
        title: "Pflichtfelder ausfüllen",
        description: "Suchbegriff ist erforderlich.",
        variant: "destructive",
      });
      return;
    }

    if (!newProvider.ikNummer.trim() || !/^\d{9}$/.test(newProvider.ikNummer)) {
      toast({
        title: "Ungültige IK-Nummer",
        description: "Die IK-Nummer muss genau 9 Ziffern enthalten.",
        variant: "destructive",
      });
      return;
    }

    const plzValue = typeof newProvider.plz === 'string' ? newProvider.plz.trim() : "";
    if (plzValue && !/^\d{5}$/.test(plzValue)) {
      toast({ title: "PLZ muss genau 5 Ziffern haben", variant: "destructive" });
      return;
    }

    const payload: InsuranceProviderFormData = {
      ...newProvider,
      empfaenger: newProvider.empfaenger?.trim() || undefined,
      empfaengerZeile2: newProvider.empfaengerZeile2?.trim() || undefined,
      strasse: newProvider.strasse?.trim() || undefined,
      hausnummer: newProvider.hausnummer?.trim() || undefined,
      plz: plzValue || undefined,
      stadt: newProvider.stadt?.trim() || undefined,
      telefon: newProvider.telefon?.trim() || undefined,
      email: newProvider.email?.trim() || undefined,
    };

    createProviderMutation.mutate(payload, {
      onSuccess: (provider) => {
        toast({ title: "Pflegekasse erfolgreich erstellt" });
        onInsuranceProviderCreated(provider.id.toString());
        setShowNewProviderForm(false);
        setNewProvider({ ...EMPTY_PROVIDER });
      },
      onError: (error: Error) => {
        toast({
          title: "Fehler",
          description: error.message,
          variant: "destructive",
        });
      },
    });
  };

  return (
    <div className="space-y-6">
      {!showNewProviderForm ? (
        <>
          <div className="space-y-2">
            <Label htmlFor="insuranceProviderId">Pflegekasse</Label>
            <div className="flex gap-2">
              <div className="min-w-0 flex-1">
                <SearchableSelect
                  options={insuranceOptions}
                  value={formData.insuranceProviderId}
                  onValueChange={(value) => onChange("insuranceProviderId", value)}
                  placeholder="Pflegekasse auswählen..."
                  searchPlaceholder="Pflegekasse suchen..."
                  emptyText="Keine Pflegekasse gefunden."
                  data-testid="select-insurance-provider"
                />
              </div>
              <Button
                type="button"
                variant="outline"
                className="shrink-0"
                onClick={() => setShowNewProviderForm(true)}
                data-testid="button-add-new-provider"
              >
                <Plus className={`${iconSize.sm} mr-1`} />
                Neu
              </Button>
            </div>
          </div>

          {formData.insuranceProviderId && (
            <div className="space-y-2">
              <Label htmlFor="versichertennummer">Versichertennummer *</Label>
              <Input
                id="versichertennummer"
                value={formData.versichertennummer}
                onChange={(e) => onChange("versichertennummer", e.target.value.toUpperCase())}
                placeholder="A123456789"
                maxLength={10}
                required
                data-testid="input-versichertennummer"
              />
              <p className="text-xs text-gray-500">
                Format: Buchstabe + 9 Ziffern (z.B. A123456789)
              </p>
            </div>
          )}

          {insuranceProvidersEmpty && !showNewProviderForm && (
            <div className="p-4 rounded-lg bg-amber-50 border border-amber-200">
              <p className="text-amber-800 text-sm">
                Es sind noch keine Pflegekassen im System hinterlegt.{" "}
                <button
                  type="button"
                  onClick={() => setShowNewProviderForm(true)}
                  className="font-medium underline hover:text-amber-900"
                  data-testid="link-add-first-provider"
                >
                  Neue Pflegekasse hinzufügen
                </button>
              </p>
            </div>
          )}
        </>
      ) : (
        <div className="p-4 rounded-lg border border-teal-200 bg-teal-50">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-medium text-teal-900">Neue Pflegekasse anlegen</h3>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowNewProviderForm(false)}
              data-testid="button-cancel-new-provider"
            >
              <X className={iconSize.sm} />
            </Button>
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="newProviderName">Suchbegriff *</Label>
              <Input
                id="newProviderName"
                value={newProvider.name}
                onChange={(e) => handleNewProviderChange("name", e.target.value)}
                placeholder="z.B. DAK"
                data-testid="input-new-provider-name"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="newProviderEmpfaenger">Empfänger</Label>
              <Input
                id="newProviderEmpfaenger"
                value={newProvider.empfaenger || ""}
                onChange={(e) => handleNewProviderChange("empfaenger", e.target.value)}
                placeholder="z.B. DAK NordWest"
                data-testid="input-new-provider-empfaenger"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="newProviderEmpfaengerZeile2">Empfänger Zeile 2 (optional)</Label>
              <Input
                id="newProviderEmpfaengerZeile2"
                value={newProvider.empfaengerZeile2 || ""}
                onChange={(e) => handleNewProviderChange("empfaengerZeile2", e.target.value)}
                placeholder="z.B. z. H. Herrn Mustermann"
                data-testid="input-new-provider-empfaenger-zeile2"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="newProviderIk">IK-Nummer *</Label>
              <Input
                id="newProviderIk"
                value={newProvider.ikNummer}
                onChange={(e) => handleNewProviderChange("ikNummer", e.target.value.replace(/\D/g, ""))}
                placeholder="123456789"
                maxLength={9}
                data-testid="input-new-provider-ik"
              />
              <p className="text-xs text-gray-500">9-stelliges Institutionskennzeichen</p>
            </div>

            <div className="border-t border-teal-200 pt-4">
              <p className="text-xs text-gray-500 mb-3 font-medium uppercase tracking-wide">Adresse</p>
              <div className="space-y-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div className="col-span-3 space-y-2">
                    <Label htmlFor="newProviderStrasse">Straße</Label>
                    <Input
                      id="newProviderStrasse"
                      value={newProvider.strasse || ""}
                      onChange={(e) => handleNewProviderChange("strasse", e.target.value)}
                      placeholder="Musterstraße"
                      data-testid="input-new-provider-strasse"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="newProviderHausnummer">Nr.</Label>
                    <Input
                      id="newProviderHausnummer"
                      value={newProvider.hausnummer || ""}
                      onChange={(e) => handleNewProviderChange("hausnummer", e.target.value)}
                      placeholder="12"
                      data-testid="input-new-provider-hausnummer"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="newProviderPlz">PLZ</Label>
                    <Input
                      id="newProviderPlz"
                      value={newProvider.plz || ""}
                      onChange={(e) => handleNewProviderChange("plz", e.target.value.replace(/\D/g, ""))}
                      placeholder="12345"
                      maxLength={5}
                      data-testid="input-new-provider-plz"
                    />
                  </div>
                  <div className="col-span-3 space-y-2">
                    <Label htmlFor="newProviderStadt">Stadt</Label>
                    <Input
                      id="newProviderStadt"
                      value={newProvider.stadt || ""}
                      onChange={(e) => handleNewProviderChange("stadt", e.target.value)}
                      placeholder="Musterstadt"
                      data-testid="input-new-provider-stadt"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="border-t border-teal-200 pt-4">
              <p className="text-xs text-gray-500 mb-3 font-medium uppercase tracking-wide">Kontakt</p>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="newProviderTelefon">Telefon</Label>
                  <Input
                    id="newProviderTelefon"
                    value={newProvider.telefon || ""}
                    onChange={(e) => handleNewProviderChange("telefon", e.target.value)}
                    placeholder="+49 89 1234567"
                    data-testid="input-new-provider-telefon"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="newProviderEmail">E-Mail</Label>
                  <Input
                    id="newProviderEmail"
                    type="email"
                    value={newProvider.email || ""}
                    onChange={(e) => handleNewProviderChange("email", e.target.value)}
                    placeholder="kontakt@pflegekasse.de"
                    data-testid="input-new-provider-email"
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3 py-2">
              <Switch
                id="newProviderEmailInvoice"
                checked={newProvider.emailInvoiceEnabled || false}
                onCheckedChange={(checked) => handleNewProviderChange("emailInvoiceEnabled", checked)}
                data-testid="switch-new-provider-email-invoice"
              />
              <Label htmlFor="newProviderEmailInvoice" className="cursor-pointer">
                E-Mail-Versand für Rechnungen aktivieren
              </Label>
            </div>

            <div className="border-t border-teal-200 pt-4">
              <p className="text-xs text-gray-500 mb-3 font-medium uppercase tracking-wide">Zahlung</p>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Zahlungsbedingungen</Label>
                  <SearchableSelect
                    options={zahlungsbedingungOptions}
                    value={newProvider.zahlungsbedingungen || "30_tage"}
                    onValueChange={(value) => handleNewProviderChange("zahlungsbedingungen", value)}
                    placeholder="Auswählen..."
                    searchPlaceholder="Suchen..."
                    emptyText="Keine Optionen."
                    data-testid="select-new-provider-zahlungsbedingungen"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Zahlungsart</Label>
                  <SearchableSelect
                    options={zahlungsartOptions}
                    value={newProvider.zahlungsart || "ueberweisung"}
                    onValueChange={(value) => handleNewProviderChange("zahlungsart", value)}
                    placeholder="Auswählen..."
                    searchPlaceholder="Suchen..."
                    emptyText="Keine Optionen."
                    data-testid="select-new-provider-zahlungsart"
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowNewProviderForm(false)}
                data-testid="button-cancel-provider-form"
              >
                Abbrechen
              </Button>
              <Button
                type="button"
                className={componentStyles.btnPrimary}
                onClick={handleCreateProvider}
                disabled={createProviderMutation.isPending}
                data-testid="button-save-new-provider"
              >
                {createProviderMutation.isPending ? (
                  <>
                    <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                    Speichern...
                  </>
                ) : (
                  <>
                    <Check className={`${iconSize.sm} mr-2`} />
                    Pflegekasse speichern
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
