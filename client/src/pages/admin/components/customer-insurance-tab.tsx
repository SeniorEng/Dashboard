import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { useInsuranceProviders, customerKeys } from "@/features/customers";
import { api, unwrapResult } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { iconSize, componentStyles } from "@/design-system";
import { formatDateForDisplay, todayISO } from "@shared/utils/datetime";
import { Heart, Loader2, Clock, Plus, ArrowRightLeft } from "lucide-react";
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
  currentInsurance?: {
    id: number;
    providerName: string;
    ikNummer?: string;
    versichertennummer: string;
    validFrom: string;
  } | null;
}

const VERSICHERTENNUMMER_REGEX = /^[A-Z]\d{9}$/; // matches versichertennummerSchema from @shared/schema

export function CustomerInsuranceTab({ customerId, currentInsurance }: CustomerInsuranceTabProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const [insuranceProviderId, setInsuranceProviderId] = useState("");
  const [versichertennummer, setVersichertennummer] = useState("");
  const [validFrom, setValidFrom] = useState(todayISO());
  const [vnError, setVnError] = useState<string | null>(null);

  const { data: providers } = useInsuranceProviders();

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
      queryClient.invalidateQueries({ queryKey: customerKeys.all });
      queryClient.invalidateQueries({ queryKey: ["customer-insurance-history", customerId] });
      toast({ title: currentInsurance ? "Pflegekasse gewechselt" : "Pflegekasse hinzugefügt" });
      setDialogOpen(false);
      resetForm();
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const resetForm = () => {
    setInsuranceProviderId("");
    setVersichertennummer("");
    setValidFrom(todayISO());
    setVnError(null);
  };

  const openDialog = () => {
    resetForm();
    setDialogOpen(true);
  };

  const handleVnChange = (value: string) => {
    const upper = value.toUpperCase();
    setVersichertennummer(upper);
    if (upper.length === 0) {
      setVnError(null);
    } else if (upper.length === 10 && !VERSICHERTENNUMMER_REGEX.test(upper)) {
      setVnError("Format: 1 Buchstabe + 9 Ziffern (z.B. A123456789)");
    } else if (upper.length === 10 && VERSICHERTENNUMMER_REGEX.test(upper)) {
      setVnError(null);
    } else if (upper.length > 10) {
      setVnError("Maximal 10 Zeichen");
    } else {
      setVnError(null);
    }
  };

  const handleSave = () => {
    if (!insuranceProviderId) {
      toast({ title: "Bitte Pflegekasse auswählen", variant: "destructive" });
      return;
    }
    if (!VERSICHERTENNUMMER_REGEX.test(versichertennummer)) {
      setVnError("Versichertennummer muss 1 Buchstabe + 9 Ziffern sein (z.B. A123456789)");
      return;
    }
    if (!validFrom) {
      toast({ title: "Bitte Gültig-ab-Datum angeben", variant: "destructive" });
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
    label: `${p.name} (IK: ${p.ikNummer})`,
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
                  {!entry.validTo && (
                    <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">Aktuell</span>
                  )}
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

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {currentInsurance ? "Pflegekasse wechseln" : "Pflegekasse hinzufügen"}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 mt-2">
            <div className="space-y-2">
              <Label>Pflegekasse *</Label>
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
                  Noch keine Kostenträger angelegt. Bitte zuerst unter Administration → Kostenträger anlegen.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="versichertennummer">Versichertennummer *</Label>
              <Input
                id="versichertennummer"
                value={versichertennummer}
                onChange={(e) => handleVnChange(e.target.value)}
                placeholder="A123456789"
                maxLength={10}
                className={vnError ? "border-red-500" : ""}
                data-testid="input-versichertennummer"
              />
              {vnError ? (
                <p className="text-xs text-red-500">{vnError}</p>
              ) : (
                <p className="text-xs text-gray-500">
                  Format: 1 Buchstabe + 9 Ziffern (z.B. A123456789)
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Gültig ab *</Label>
              <DatePicker
                value={validFrom}
                onChange={(date) => setValidFrom(date || todayISO())}
                placeholder="Datum wählen"
                data-testid="datepicker-valid-from"
              />
              {currentInsurance && (
                <p className="text-xs text-gray-500">
                  Die bisherige Kasse wird automatisch zum Vortag beendet.
                </p>
              )}
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
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
