import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { formatDateForDisplay, todayISO } from "@shared/utils/datetime";
import { PFLEGEGRAD_SELECT_OPTIONS } from "@shared/domain/customers";
import { SectionCard } from "@/components/patterns/section-card";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DatePicker } from "@/components/ui/date-picker";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api";
import { iconSize, componentStyles } from "@/design-system";
import { EditButton } from "./section-helpers";
import { Shield, History, Save, X, Loader2, Ban, CalendarX } from "lucide-react";
import type { SectionProps } from "./types";

export function CareLevelSection({ customer, customerId, editingSection, setEditingSection, saving, invalidateCustomer }: SectionProps) {
  const { toast } = useToast();

  const [newPflegegrad, setNewPflegegrad] = useState<string>("");
  const [pflegegradSeit, setPflegegradSeit] = useState<string>(todayISO());

  // Ein als Fehleintrag entfernter Eintrag zählt für kein Datum (Ticket
  // 6hcgffPJWm57p72p) — er ist nie der laufende.
  const currentCareLevel = customer.careLevelHistory?.find((e) => !e.validTo && !e.entferntAm);
  const [beendenAb, setBeendenAb] = useState<string>(todayISO());
  const [entfernenId, setEntfernenId] = useState<number | null>(null);
  const [entfernenGrund, setEntfernenGrund] = useState("");

  const beendenMutation = useMutation({
    mutationFn: async (data: { abDatum: string }) => {
      const result = await api.post(`/admin/customers/${customerId}/care-level/beenden`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      toast({ title: "Pflegegrad beendet", description: "Ab dem gewählten Datum gilt kein Pflegegrad mehr." });
      invalidateCustomer();
      setEditingSection(null);
    },
    onError: (error: Error) => {
      toast({ variant: "destructive", title: "Fehler", description: error.message });
    },
  });

  const entfernenMutation = useMutation({
    mutationFn: async (data: { historyId: number; grund: string }) => {
      const result = await api.post(`/admin/customers/${customerId}/care-level/${data.historyId}/entfernen`, { grund: data.grund });
      return unwrapResult(result);
    },
    onSuccess: () => {
      toast({ title: "Eintrag entfernt", description: "Der Pflegegrad-Eintrag zählt für kein Datum mehr." });
      invalidateCustomer();
      setEntfernenId(null);
      setEntfernenGrund("");
    },
    onError: (error: Error) => {
      toast({ variant: "destructive", title: "Fehler", description: error.message });
    },
  });

  const changeCareLevelMutation = useMutation({
    mutationFn: async (data: { pflegegrad: number; validFrom: string }) => {
      const result = await api.post(`/admin/customers/${customerId}/care-level`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      toast({ title: "Pflegegrad aktualisiert", description: "Der Pflegegrad wurde mit Historisierung gespeichert." });
      invalidateCustomer();
      setEditingSection(null);
    },
    onError: (error: Error) => {
      toast({ variant: "destructive", title: "Fehler", description: error.message });
    },
  });

  const startEditing = () => {
    setNewPflegegrad("");
    setPflegegradSeit(todayISO());
    setEditingSection("pflegegrad");
  };

  return (
    <>
      <SectionCard
        title="Pflegegrad"
        icon={<Shield className={iconSize.sm} />}
        actions={editingSection !== "pflegegrad" ? <EditButton section="pflegegrad" editingSection={editingSection} startEditing={startEditing} /> : undefined}
      >
        {editingSection === "pflegegrad" ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3 p-3 rounded-lg bg-gray-50">
              <span className="text-sm text-gray-600">Aktueller Pflegegrad:</span>
              {customer.pflegegradHeute != null && customer.pflegegradHeute > 0 ? (
                <>
                  <StatusBadge type="pflegegrad" value={customer.pflegegradHeute} />
                  {currentCareLevel?.validFrom && (
                    <span className="text-xs text-gray-500">
                      seit {formatDateForDisplay(currentCareLevel.validFrom)}
                    </span>
                  )}
                </>
              ) : (
                <span className="text-sm text-gray-500">Nicht festgelegt</span>
              )}
            </div>

            <p className="text-xs text-gray-500">
              Der bisherige Pflegegrad wird mit Enddatum gespeichert und bleibt für Budgets und Rechnungen nachvollziehbar.
            </p>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Neuer Pflegegrad</Label>
                <Select value={newPflegegrad} onValueChange={setNewPflegegrad}>
                  <SelectTrigger data-testid="select-new-pflegegrad">
                    <SelectValue placeholder="Auswählen" />
                  </SelectTrigger>
                  <SelectContent>
                    {PFLEGEGRAD_SELECT_OPTIONS.map((opt) => (
                      <SelectItem
                        key={opt.value}
                        value={opt.value}
                        data-testid={`select-new-pflegegrad-option-${opt.value}`}
                      >
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Gültig ab</Label>
                <DatePicker
                  value={pflegegradSeit}
                  onChange={(val) => setPflegegradSeit(val || todayISO())}
                  data-testid="input-pflegegrad-seit"
                />
              </div>
            </div>

            <div className="flex items-center gap-2 pt-3">
              <Button
                className={componentStyles.btnPrimary}
                onClick={() => {
                  if (!newPflegegrad) {
                    toast({ title: "Bitte Pflegegrad auswählen", variant: "destructive" });
                    return;
                  }
                  changeCareLevelMutation.mutate({
                    pflegegrad: parseInt(newPflegegrad),
                    validFrom: pflegegradSeit,
                  });
                }}
                disabled={changeCareLevelMutation.isPending || !newPflegegrad}
                data-testid="button-save-pflegegrad"
              >
                {changeCareLevelMutation.isPending ? (
                  <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                ) : (
                  <Save className={`${iconSize.sm} mr-2`} />
                )}
                Speichern
              </Button>
              <Button
                variant="outline"
                onClick={() => setEditingSection(null)}
                disabled={changeCareLevelMutation.isPending}
                data-testid="button-cancel-pflegegrad"
              >
                <X className={`${iconSize.sm} mr-2`} />
                Abbrechen
              </Button>
            </div>

            {currentCareLevel && (
              <div className="border-t pt-4 space-y-2">
                <Label>Pflegegrad beenden ab</Label>
                <p className="text-xs text-gray-500">
                  Für ein echtes Ende (z. B. Herabstufung auf „kein Pflegegrad"). Ab diesem Datum gilt kein Pflegegrad mehr;
                  Leistungen danach tragen Umsatzsteuer. War der Eintrag ein Irrtum, im Verlauf „als Fehleintrag entfernen".
                </p>
                <div className="flex items-center gap-2">
                  <DatePicker
                    value={beendenAb}
                    onChange={(val) => setBeendenAb(val || todayISO())}
                    data-testid="input-pflegegrad-beenden-ab"
                  />
                  <Button
                    variant="outline"
                    onClick={() => beendenMutation.mutate({ abDatum: beendenAb })}
                    disabled={beendenMutation.isPending}
                    data-testid="button-pflegegrad-beenden"
                  >
                    <CalendarX className={`${iconSize.sm} mr-2`} />
                    Beenden
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {/* Aus der Historie (Server: `pflegegradHeute`), nicht aus den Stammdaten. */}
            {customer.pflegegradHeute != null && customer.pflegegradHeute > 0 ? (
              <>
                <div className="flex items-center gap-3">
                  <StatusBadge type="pflegegrad" value={customer.pflegegradHeute} />
                </div>
                {currentCareLevel?.validFrom && (
                  <p className="text-sm text-gray-500">
                    Seit {formatDateForDisplay(currentCareLevel.validFrom)}
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-gray-500" data-testid="text-pflegegrad-empty">Nicht festgelegt</p>
            )}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Pflegegrad-Verlauf"
        icon={<History className={iconSize.sm} />}
      >
        {customer.careLevelHistory && customer.careLevelHistory.length > 0 ? (
          <div className="relative">
            <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-gray-200" />
            <div className="space-y-3">
              {customer.careLevelHistory
                .filter((entry) => entry.entferntAm || !entry.validTo || entry.validTo >= entry.validFrom)
                .map((entry, index) => (
                <div key={entry.id} className="relative pl-10" data-testid={`care-level-entry-${entry.id}`}>
                  <div
                    className={`absolute left-2.5 w-3 h-3 rounded-full ${
                      index === 0 && !entry.entferntAm ? "bg-teal-500" : "bg-gray-300"
                    }`}
                  />
                  <div className={`p-3 rounded-lg ${entry.entferntAm ? "bg-gray-100 opacity-70" : "bg-gray-50"}`}>
                    <div className="flex items-center justify-between">
                      <span className={entry.entferntAm ? "line-through" : ""}>
                        <StatusBadge type="pflegegrad" value={entry.pflegegrad} />
                      </span>
                      <span className="text-xs text-gray-500">
                        {entry.validTo
                          ? `${formatDateForDisplay(entry.validFrom)} - ${formatDateForDisplay(entry.validTo)}`
                          : `seit ${formatDateForDisplay(entry.validFrom)}`}
                      </span>
                    </div>
                    {entry.notes && (
                      <p className="text-sm text-gray-600 mt-2">{entry.notes}</p>
                    )}
                    {entry.entferntAm ? (
                      <p className="text-xs text-red-700 mt-2">
                        Als Fehleintrag entfernt am {formatDateForDisplay(String(entry.entferntAm).slice(0, 10))}
                        {entry.entferntGrund ? ` — ${entry.entferntGrund}` : ""}
                      </p>
                    ) : entfernenId === entry.id ? (
                      <div className="mt-3 space-y-2">
                        <Label>Grund (Pflicht)</Label>
                        <Textarea
                          value={entfernenGrund}
                          onChange={(e) => setEntfernenGrund(e.target.value)}
                          placeholder="z. B. Pflegegrad nie bewilligt, Eintrag irrtümlich angelegt"
                          data-testid={`input-entfernen-grund-${entry.id}`}
                        />
                        <div className="flex items-center gap-2">
                          <Button
                            variant="destructive"
                            onClick={() => entfernenMutation.mutate({ historyId: entry.id, grund: entfernenGrund })}
                            disabled={entfernenMutation.isPending || entfernenGrund.trim().length < 3}
                            data-testid={`button-entfernen-bestaetigen-${entry.id}`}
                          >
                            Entfernen
                          </Button>
                          <Button variant="outline" onClick={() => { setEntfernenId(null); setEntfernenGrund(""); }}>
                            Abbrechen
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="mt-2 text-xs text-gray-600"
                        onClick={() => { setEntfernenId(entry.id); setEntfernenGrund(""); }}
                        data-testid={`button-entfernen-${entry.id}`}
                      >
                        <Ban className={`${iconSize.sm} mr-1`} />
                        Als Fehleintrag entfernen
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-500" data-testid="text-care-history-empty">Kein Verlauf vorhanden</p>
        )}
      </SectionCard>
    </>
  );
}
