import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { DatePicker } from "@/components/ui/date-picker";
import { SectionCard } from "@/components/patterns/section-card";
import { EmptyState } from "@/components/patterns/empty-state";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useInsuranceProviders, useCreateInsuranceProvider, customerKeys } from "@/features/customers";
import { api, unwrapResult } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { invalidateRelated } from "@/lib/query-invalidation";
import { iconSize, componentStyles } from "@/design-system";
import { formatDateForDisplay, todayISO } from "@shared/utils/datetime";
import {
  firstInsuranceAnchorISO,
  isMonthStartISO,
  INSURANCE_WINDOW_MUST_START_ON_FIRST,
} from "@shared/domain/insurance-period";
import {
  VERSICHERTENNUMMER_GKV_REGEX,
  VERSICHERTENNUMMER_FLEX_REGEX,
} from "@shared/schema/common";
import { Heart, Loader2, Clock, Plus, ArrowRightLeft, X, Pencil } from "lucide-react";
import type { InsuranceProviderItem } from "@/lib/api/types";

interface InsuranceHistoryEntry {
  id: number;
  customerId: number;
  insuranceProviderId: number;
  versichertennummer: string;
  validFrom: string;
  validTo: string | null;
  notes: string | null;
  createdAt: string;
  provider: InsuranceProviderItem;
}

interface CustomerInsuranceTabProps {
  customerId: number;
  customerBillingType?: string | null;
  currentInsurance?: {
    id: number;
    providerName: string;
    ikNummer?: string;
    versichertennummer: string;
    validFrom: string;
  } | null;
}

// Verwendet die zentralen Regex-Konstanten aus shared/schema/common, damit
// Frontend- und Backend-Validierung nicht auseinanderlaufen.
const VERSICHERTENNUMMER_REGEX = VERSICHERTENNUMMER_GKV_REGEX;


// Task #1893 — Kassenwechsel sind nur zum Monatsersten zulässig. Vorbelegung ist
// deshalb der 1. des FOLGENDEN Monats (der laufende Monat ist i.d.R. schon
// abgerechnet bzw. läuft noch auf die bisherige Kasse).
//
// Task #1898 — Für die ERSTZUORDNUNG gilt das NICHT: dort gibt es keine
// bisherige Kasse, auf die der laufende Monat noch liefe. Der Folgemonat würde
// den laufenden Monat ohne Kostenträger zurücklassen. Vorbelegung ist deshalb
// der 1. des LAUFENDEN Monats — derselbe Anker, den der Server berechnet.
/**
 * Vorbelegung des „Gültig ab". Task #1898: bei der ERSTZUORDNUNG der 1. des
 * LAUFENDEN Monats — der Folgemonat liesse den laufenden Monat ohne
 * Kostenträger, und der Kunde erschiene direkt nach dem Speichern weiter als
 * „Keine Pflegekasse". Beim WECHSEL bleibt es der 1. des Folgemonats.
 */
function defaultValidFrom(isFirstAssignment: boolean): string {
  return isFirstAssignment
    ? firstInsuranceAnchorISO(todayISO(), null, todayISO())
    : firstOfNextMonthISO();
}

function firstOfNextMonthISO(): string {
  const now = new Date();
  const y = now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear();
  const m = now.getMonth() === 11 ? 1 : now.getMonth() + 2;
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

export function CustomerInsuranceTab({ customerId, customerBillingType, currentInsurance }: CustomerInsuranceTabProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  // Task #1893 — Korrektur einer bestehenden Zuordnung (Gültig-ab/-bis/VNr).
  const [editEntry, setEditEntry] = useState<InsuranceHistoryEntry | null>(null);
  const [editValidFrom, setEditValidFrom] = useState("");
  const [editValidTo, setEditValidTo] = useState("");
  const [editVersichertennummer, setEditVersichertennummer] = useState("");

  const [insuranceProviderId, setInsuranceProviderId] = useState("");
  const [versichertennummer, setVersichertennummer] = useState("");
  // Erstzuordnung = der Kunde hat noch keine laufende Kasse.
  const isFirstAssignment = !currentInsurance;
  const [validFrom, setValidFrom] = useState(defaultValidFrom(isFirstAssignment));
  const [vnError, setVnError] = useState<string | null>(null);

  // Inline-Anlage einer neuen Pflegekasse direkt im Wechsel-Dialog, damit das
  // Onboarding nie blockiert, wenn die Kasse noch nicht existiert.
  const [showNewProvider, setShowNewProvider] = useState(false);
  const [newName, setNewName] = useState("");
  const [newIsPrivate, setNewIsPrivate] = useState(false);
  const [newIk, setNewIk] = useState("");

  const { data: providers } = useInsuranceProviders();
  const createProviderMutation = useCreateInsuranceProvider();

  const { data: history, isLoading: historyLoading } = useQuery<InsuranceHistoryEntry[]>({
    queryKey: ["customer-insurance-history", customerId],
    queryFn: async ({ signal }) => {
      const result = await api.get<InsuranceHistoryEntry[]>(
        `/admin/customers/${customerId}/insurance`,
        signal
      );
      return unwrapResult(result);
    },
    enabled: showHistory,
    staleTime: 60_000,
  });

  const addInsuranceMutation = useMutation({
    mutationFn: async (data: { insuranceProviderId: number; versichertennummer: string; validFrom: string }) => {
      const result = await api.post<InsuranceHistoryEntry>(
        `/admin/customers/${customerId}/insurance`,
        data
      );
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "customer-insurance", "customers");
      toast({ title: currentInsurance ? "Pflegekasse gewechselt" : "Pflegekasse hinzugefügt" });
      setDialogOpen(false);
      resetForm();
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const updateInsuranceMutation = useMutation({
    mutationFn: async (data: { insuranceId: number; validFrom: string; validTo: string | null; versichertennummer: string }) => {
      const { insuranceId, ...patch } = data;
      const result = await api.patch<InsuranceHistoryEntry>(
        `/admin/customers/${customerId}/insurance/${insuranceId}`,
        patch
      );
      return unwrapResult(result);
    },
    onSuccess: () => {
      // `customer-insurance` invalidiert bereits ["customer-insurance-history"].
      invalidateRelated(queryClient, "customer-insurance", "customers");
      toast({ title: "Zuordnung korrigiert" });
      setEditEntry(null);
    },
    onError: (error: Error) => {
      toast({ title: "Korrektur nicht möglich", description: error.message, variant: "destructive" });
    },
  });

  const openEditDialog = (entry: InsuranceHistoryEntry) => {
    setEditEntry(entry);
    setEditValidFrom(entry.validFrom);
    setEditValidTo(entry.validTo ?? "");
    setEditVersichertennummer(entry.versichertennummer);
  };

  const handleSaveEdit = () => {
    if (!editEntry) return;
    if (!isMonthStartISO(editValidFrom)) {
      toast({ title: "Nur Wechsel zum Monatsersten", description: INSURANCE_WINDOW_MUST_START_ON_FIRST, variant: "destructive" });
      return;
    }
    if (editValidTo && editValidTo < editValidFrom) {
      toast({ title: "Zeitraum ungültig", description: "„Gültig bis“ liegt vor „Gültig ab“.", variant: "destructive" });
      return;
    }
    updateInsuranceMutation.mutate({
      insuranceId: editEntry.id,
      validFrom: editValidFrom,
      validTo: editValidTo || null,
      versichertennummer: editVersichertennummer,
    });
  };

  const resetForm = () => {
    setInsuranceProviderId("");
    setVersichertennummer("");
    setValidFrom(defaultValidFrom(isFirstAssignment));
    setVnError(null);
    setShowNewProvider(false);
    setNewName("");
    setNewIsPrivate(false);
    setNewIk("");
  };

  const handleCreateProvider = () => {
    if (!newName.trim()) {
      toast({ title: "Suchbegriff ist erforderlich", variant: "destructive" });
      return;
    }
    if (!newIsPrivate) {
      if (!/^\d{9}$/.test(newIk)) {
        toast({ title: "Ungültige IK-Nummer", description: "Die IK-Nummer muss genau 9 Ziffern enthalten.", variant: "destructive" });
        return;
      }
    }

    createProviderMutation.mutate(
      { name: newName.trim(), isPrivate: newIsPrivate, ikNummer: newIk.trim() },
      {
        onSuccess: (provider) => {
          setInsuranceProviderId(provider.id.toString());
          setShowNewProvider(false);
          setNewName("");
          setNewIsPrivate(false);
          setNewIk("");
        },
      },
    );
  };

  const openDialog = () => {
    resetForm();
    setDialogOpen(true);
  };

  const selectedProvider = providers?.find(p => p.id.toString() === insuranceProviderId);
  const isPrivateProvider = selectedProvider?.isPrivate || false;
  const isPrivateCase = customerBillingType === "pflegekasse_privat" || isPrivateProvider;

  const handleVnChange = (value: string) => {
    const processed = isPrivateCase ? value : value.toUpperCase();
    setVersichertennummer(processed);
    if (processed.length === 0) {
      setVnError(null);
    } else if (isPrivateCase) {
      if (processed.length > 20) {
        setVnError("Maximal 20 Zeichen");
      } else if (processed.length < 3) {
        setVnError(null);
      } else if (!VERSICHERTENNUMMER_FLEX_REGEX.test(processed)) {
        setVnError("Nur Buchstaben, Ziffern, Bindestriche, Schrägstriche und Punkte erlaubt");
      } else {
        setVnError(null);
      }
    } else {
      if (processed.length === 10 && !VERSICHERTENNUMMER_REGEX.test(processed)) {
        setVnError("Format: 1 Buchstabe + 9 Ziffern (z.B. A123456789)");
      } else if (processed.length > 10) {
        setVnError("Maximal 10 Zeichen");
      } else {
        setVnError(null);
      }
    }
  };

  const handleSave = () => {
    if (!insuranceProviderId) {
      toast({ title: "Bitte Pflegekasse auswählen", variant: "destructive" });
      return;
    }
    if (isPrivateCase) {
      if (!VERSICHERTENNUMMER_FLEX_REGEX.test(versichertennummer)) {
        setVnError("Versichertennummer muss 3-20 Zeichen lang sein (Buchstaben, Ziffern, Bindestriche, Schrägstriche, Punkte)");
        return;
      }
    } else if (!VERSICHERTENNUMMER_REGEX.test(versichertennummer)) {
      setVnError("Versichertennummer muss 1 Buchstabe + 9 Ziffern sein (z.B. A123456789)");
      return;
    }
    if (!validFrom) {
      toast({ title: "Bitte Gültig-ab-Datum angeben", variant: "destructive" });
      return;
    }
    // Spiegelt die serverseitige Erzwingung (Task #1893) — dieselbe SSoT-Prüfung.
    // Bei der Erstzuordnung greift sie NICHT: dort normalisiert der Server auf
    // den Anker (Task #1898), ein clientseitiger Abbruch wäre eine zweite,
    // strengere Regel als die des Servers.
    if (!isFirstAssignment && !isMonthStartISO(validFrom)) {
      toast({ title: "Nur Wechsel zum Monatsersten", description: INSURANCE_WINDOW_MUST_START_ON_FIRST, variant: "destructive" });
      return;
    }

    addInsuranceMutation.mutate({
      insuranceProviderId: parseInt(insuranceProviderId),
      versichertennummer,
      validFrom,
    });
  };

  const providerOptions = (providers || []).map((p) => ({
    value: p.id.toString(),
    label: p.ikNummer ? `${p.name} (IK: ${p.ikNummer})` : `${p.name}${p.isPrivate ? " (Privat)" : ""}`,
  })).sort((a, b) => a.label.localeCompare(b.label, "de"));

  return (
    <>
      <SectionCard
        title="Aktuelle Pflegekasse"
        icon={<Heart className={iconSize.sm} />}
        actions={
          currentInsurance ? (
            <Button size="sm" variant="outline" onClick={openDialog} data-testid="button-change-insurance">
              <ArrowRightLeft className={`${iconSize.sm} mr-1`} />
              Kasse wechseln
            </Button>
          ) : undefined
        }
      >
        {currentInsurance ? (
          <div className="p-4 rounded-lg bg-blue-50 border border-blue-100">
            <p className="font-medium text-gray-900" data-testid="text-current-provider">
              {currentInsurance.providerName}
            </p>
            {currentInsurance.ikNummer && (
              <p className="text-sm text-gray-600 mt-1" data-testid="text-ik-nummer">
                IK-Nr.: {currentInsurance.ikNummer}
              </p>
            )}
            <p className="text-sm text-gray-600 mt-1" data-testid="text-versichertennummer">
              Versichertennummer: {currentInsurance.versichertennummer}
            </p>
            <p className="text-xs text-gray-500 mt-2">
              Gültig seit {formatDateForDisplay(currentInsurance.validFrom)}
            </p>
          </div>
        ) : (
          <EmptyState
            icon={<Heart className={iconSize.xl} />}
            title="Keine Pflegekasse"
            description="Keine Pflegekasse hinterlegt"
            action={
              <Button size="sm" className={componentStyles.btnPrimary} onClick={openDialog} data-testid="button-add-insurance">
                <Plus className={`${iconSize.sm} mr-1`} />
                Pflegekasse hinzufügen
              </Button>
            }
            className="py-6"
          />
        )}
      </SectionCard>

      <SectionCard
        title="Versicherungshistorie"
        icon={<Clock className={iconSize.sm} />}
      >
        {!showHistory ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowHistory(true)}
            data-testid="button-show-history"
          >
            Historie anzeigen
          </Button>
        ) : historyLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-6 w-6 animate-spin text-teal-600" />
          </div>
        ) : !history?.length ? (
          <p className="text-sm text-gray-500 py-4">Keine Einträge vorhanden.</p>
        ) : (
          <div className="space-y-2">
            {history.map((entry) => (
              <div
                key={entry.id}
                className={`p-3 rounded-lg border ${
                  !entry.validTo ? "bg-blue-50 border-blue-100" : "bg-gray-50 border-gray-100"
                }`}
                data-testid={`insurance-history-${entry.id}`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-sm">{entry.provider.name}</span>
                  <div className="flex items-center gap-2">
                    {!entry.validTo && (
                      <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">Aktuell</span>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => openEditDialog(entry)}
                      data-testid={`button-edit-insurance-${entry.id}`}
                    >
                      <Pencil className={iconSize.sm} />
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-gray-600 mt-1">
                  VNr: {entry.versichertennummer}
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  {formatDateForDisplay(entry.validFrom)}
                  {entry.validTo ? ` – ${formatDateForDisplay(entry.validTo)}` : " – heute"}
                </p>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <Dialog open={editEntry !== null} onOpenChange={(open) => !open && setEditEntry(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Zuordnung korrigieren</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 mt-2">
            <p className="text-sm text-gray-600">
              {editEntry?.provider.name}
            </p>

            <div className="space-y-2">
              <Label>Versichertennummer</Label>
              <Input
                value={editVersichertennummer}
                onChange={(e) => setEditVersichertennummer(e.target.value)}
                data-testid="input-edit-versichertennummer"
              />
            </div>

            <div className="space-y-2">
              <Label>Gültig ab *</Label>
              <DatePicker
                value={editValidFrom}
                onChange={(date) => setEditValidFrom(date || editValidFrom)}
                placeholder="Datum wählen"
                data-testid="datepicker-edit-valid-from"
              />
              <p className="text-xs text-gray-500">Muss der 1. eines Monats sein.</p>
            </div>

            <div className="space-y-2">
              <Label>Gültig bis</Label>
              <DatePicker
                value={editValidTo}
                onChange={(date) => setEditValidTo(date || "")}
                placeholder="leer = aktuell gültig"
                data-testid="datepicker-edit-valid-to"
              />
              <p className="text-xs text-gray-500">
                Leer lassen für die aktuell gültige Zuordnung. Zeiträume müssen
                lückenlos aneinander anschließen und dürfen sich nicht überschneiden.
              </p>
            </div>

            <div className="flex justify-end gap-2 pt-4 border-t">
              <Button variant="outline" onClick={() => setEditEntry(null)} data-testid="button-cancel-edit">
                Abbrechen
              </Button>
              <Button
                className={componentStyles.btnPrimary}
                onClick={handleSaveEdit}
                disabled={updateInsuranceMutation.isPending}
                data-testid="button-save-edit-insurance"
              >
                {updateInsuranceMutation.isPending ? (
                  <>
                    <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                    Speichern...
                  </>
                ) : (
                  "Korrektur speichern"
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {currentInsurance ? "Pflegekasse wechseln" : "Pflegekasse hinzufügen"}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 mt-2">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Pflegekasse *</Label>
                {!showNewProvider && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-teal-700"
                    onClick={() => setShowNewProvider(true)}
                    data-testid="button-new-provider-inline"
                  >
                    <Plus className={`${iconSize.sm} mr-1`} />
                    Neu
                  </Button>
                )}
              </div>

              {showNewProvider ? (
                <div className="rounded-lg border border-teal-200 bg-teal-50 p-3 space-y-3" data-testid="form-new-provider-inline">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-teal-900">Neue Pflegekasse anlegen</span>
                    <button
                      type="button"
                      onClick={() => setShowNewProvider(false)}
                      className="text-gray-400 hover:text-gray-600"
                      data-testid="button-cancel-new-provider-inline"
                    >
                      <X className={iconSize.sm} />
                    </button>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="new-provider-name" className="text-xs">Suchbegriff / Name *</Label>
                    <Input
                      id="new-provider-name"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="z. B. DAK"
                      data-testid="input-new-provider-name"
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label htmlFor="new-provider-private" className="text-xs cursor-pointer">Private Krankenversicherung (PKV)</Label>
                    <Switch
                      id="new-provider-private"
                      checked={newIsPrivate}
                      onCheckedChange={setNewIsPrivate}
                      data-testid="switch-new-provider-private"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="new-provider-ik" className="text-xs">
                      IK-Nummer {newIsPrivate ? "(optional)" : "*"}
                    </Label>
                    <Input
                      id="new-provider-ik"
                      value={newIk}
                      onChange={(e) => setNewIk(newIsPrivate ? e.target.value : e.target.value.replace(/\D/g, ""))}
                      placeholder={newIsPrivate ? "optional" : "9 Ziffern"}
                      maxLength={newIsPrivate ? undefined : 9}
                      inputMode={newIsPrivate ? undefined : "numeric"}
                      data-testid="input-new-provider-ik"
                    />
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    className={`w-full ${componentStyles.btnPrimary}`}
                    onClick={handleCreateProvider}
                    disabled={createProviderMutation.isPending}
                    data-testid="button-save-new-provider-inline"
                  >
                    {createProviderMutation.isPending ? (
                      <>
                        <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                        Anlegen...
                      </>
                    ) : (
                      "Pflegekasse anlegen & auswählen"
                    )}
                  </Button>
                </div>
              ) : (
                <>
                  <SearchableSelect
                    options={providerOptions}
                    value={insuranceProviderId}
                    onValueChange={setInsuranceProviderId}
                    placeholder="Pflegekasse auswählen..."
                    searchPlaceholder="Suchen..."
                    emptyText="Keine Pflegekasse gefunden."
                    data-testid="select-insurance-provider"
                  />
                  {!providers?.length && (
                    <p className="text-xs text-amber-600">
                      Noch keine Kostenträger angelegt. Über „Neu" direkt hier anlegen.
                    </p>
                  )}
                </>
              )}
            </div>

            {!showNewProvider && (
            <>
            <div className="space-y-2">
              <Label htmlFor="versichertennummer">Versichertennummer *</Label>
              <Input
                id="versichertennummer"
                value={versichertennummer}
                onChange={(e) => handleVnChange(e.target.value)}
                placeholder={isPrivateCase ? "Vertragsnummer" : "A123456789"}
                maxLength={isPrivateCase ? 20 : 10}
                className={vnError ? "border-red-500" : ""}
                data-testid="input-versichertennummer"
              />
              {vnError ? (
                <p className="text-xs text-red-500">{vnError}</p>
              ) : (
                <p className="text-xs text-gray-500">
                  {isPrivateCase
                    ? "Vertragsnummer Ihrer privaten Pflegekasse (3–20 Zeichen, z.B. 6163938.1)"
                    : "Format: 1 Buchstabe + 9 Ziffern (z.B. A123456789)"}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Gültig ab *</Label>
              <DatePicker
                value={validFrom}
                onChange={(date) => setValidFrom(date || firstOfNextMonthISO())}
                placeholder="Datum wählen"
                data-testid="datepicker-valid-from"
              />
              <p className="text-xs text-gray-500">
                Ein Kassenwechsel ist nur zum 1. eines Monats möglich.
                {currentInsurance ? " Die bisherige Kasse endet automatisch am letzten Tag des Vormonats." : ""}
              </p>
            </div>

            <div className="flex justify-end gap-2 pt-4 border-t">
              <Button variant="outline" onClick={() => setDialogOpen(false)} data-testid="button-cancel">
                Abbrechen
              </Button>
              <Button
                className={componentStyles.btnPrimary}
                onClick={handleSave}
                disabled={addInsuranceMutation.isPending}
                data-testid="button-save-insurance"
              >
                {addInsuranceMutation.isPending ? (
                  <>
                    <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                    Speichern...
                  </>
                ) : currentInsurance ? (
                  "Kasse wechseln"
                ) : (
                  "Pflegekasse hinzufügen"
                )}
              </Button>
            </div>
            </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
