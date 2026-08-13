import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { iconSize } from "@/design-system";
import { Layers, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { RefObject } from "react";
import type { UseMutationResult } from "@tanstack/react-query";
import type { BillingCustomerItem } from "@shared/api";
import {
  hasOpenAppointments,
  classifyBillingMaturity,
} from "@shared/domain/billing-eligibility";
import { MONTH_NAMES } from "../constants";
import { getCustomerName } from "../utils";
import type { GenerateAllResponse } from "../types";

interface GenerateAllDialogProps {
  open: boolean;
  setOpen: (open: boolean) => void;
  generateAllProgress: GenerateAllResponse | null;
  setGenerateAllProgress: (progress: GenerateAllResponse | null) => void;
  generateAllMutation: UseMutationResult<
    GenerateAllResponse,
    Error,
    { readyOnly: boolean; confirmPartial?: boolean; customerIds?: number[] },
    unknown
  >;
  customers: BillingCustomerItem[] | undefined;
  // Task #1888 — wenn gesetzt, ist der Lauf auf DIESE Auswahl (Multi-Select
  // „Erstellen (N)") verengt: Zähler zählen nur die Auswahl, und die Allowlist wird
  // an `generate-all` durchgereicht.
  selectedCustomerIds?: number[];
  selectedMonth: number;
  selectedYear: number;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
}

export function GenerateAllDialog({
  open,
  setOpen,
  generateAllProgress,
  setGenerateAllProgress,
  generateAllMutation,
  customers,
  selectedCustomerIds,
  selectedMonth,
  selectedYear,
  closeButtonRef,
}: GenerateAllDialogProps) {
  // Task #1771: „Nur Kunden ohne offene Termine abrechnen" — per Default AN,
  // damit die Massenerstellung dieselbe Menge trifft wie die Karten-Gruppierung
  // „Bereit zum Abrechnen". AUS = alle berechtigten Kunden. Die Zähler leiten
  // sich aus derselben reinen SSoT (`hasOpenAppointments`) ab, die auch der
  // Server-Filter nutzt — so können Dialog-Auswahl und Liste nie divergieren.
  const [readyOnly, setReadyOnly] = useState(true);
  // Task #1883 — Opt-in fürs bewusste Teil-Abrechnen von Mischkunden (Variante B).
  // Default AUS: ohne dieses Häkchen werden Mischkunden (dokumentierte Termine mangels
  // Kundenunterschrift/LN nicht abrechenbar) als „übersprungen mit Ausweis" gemeldet,
  // nie still teil-abgerechnet. AN = ihr signierter Teil wird jetzt abgerechnet.
  const [confirmPartial, setConfirmPartial] = useState(false);

  // Task #1888 — bei einer Multi-Select-Auswahl zählen die Vorab-Zähler NUR die
  // ausgewählten Kunden (sonst die ganze berechtigte Menge).
  const scopedCustomers = useMemo(() => {
    if (!selectedCustomerIds) return customers ?? [];
    const allow = new Set(selectedCustomerIds);
    return (customers ?? []).filter((c) => allow.has(c.id));
  }, [customers, selectedCustomerIds]);
  const isSelectionRun = selectedCustomerIds !== undefined;

  const totalCount = scopedCustomers.length;
  // Task #1905 (absorbiert #1895) — die Vorab-Zähler leiten sich jetzt aus DER
  // EINEN Reife-SSoT `classifyBillingMaturity` ab, nicht mehr aus einer eigenen
  // Kombination von `hasOpenAppointments` + `eligibility.status`.
  //
  // Die frühere Formel zählte einen Mischkunden (kundensignierter LN für einen
  // Teil, nur mitarbeiter-signierter für den Rest) als „wird erstellt": er hat
  // keine offenen Termine und ist `eligible`. Der Server rechnet ihn aber NUR
  // mit gesetztem `confirmPartial` ab — ohne Häkchen meldet er ihn als
  // „übersprungen mit Ausweis" (#1883-Guard). Der Zähler versprach also eine
  // Rechnung, die nicht entsteht, und zwar unabhängig vom Häkchen.
  //
  // Server-Verhalten, das hier gespiegelt wird (`POST /billing/generate-all`):
  //  • `readyOnly` überspringt Kunden mit OFFENEN Terminen (nicht „nicht bereit").
  //  • ohne abrechenbaren Anteil (`unbilledAppointmentCount === 0`) wird
  //    übersprungen („Bereits abgerechnet" / kein signierter LN).
  //  • bleibt ein dokumentierter Termin mangels Kundenunterschrift/LN außen vor,
  //    entscheidet `confirmPartial` über Erstellen vs. Überspringen.
  const willCreate = useMemo(() => {
    const candidates = readyOnly
      ? scopedCustomers.filter((c) => !hasOpenAppointments(c))
      : scopedCustomers;
    return candidates.filter((c) => {
      // Nichts abzurechnen ⇒ der Server überspringt, egal was sonst gilt.
      if ((c.unbilledAppointmentCount ?? 0) <= 0) return false;
      // Ist ALLES Dokumentierte abrechenbar? Die Frage stellen wir der Reife-SSoT
      // selbst — kontrafaktisch ohne die offenen Termine, denn offene (noch nicht
      // durchgeführte) Termine lösen den Teil-Abrechnungs-Guard nicht aus: er
      // betrachtet nur dokumentierte Termine. Damit bleibt es EINE Regel; es
      // entsteht keine zweite Kopie der „ist der Nachweis vollständig?"-Frage.
      const fullyBillable =
        classifyBillingMaturity({ ...c, openAppointments: 0 }) === "ready";
      return fullyBillable || confirmPartial;
    }).length;
  }, [scopedCustomers, readyOnly, confirmPartial]);
  const willSkip = totalCount - willCreate;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (generateAllMutation.isPending) return;
        setOpen(o);
        if (!o) setGenerateAllProgress(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isSelectionRun ? "Ausgewählte Kunden abrechnen" : "Alle offenen Leistungsnachweise abrechnen"}
          </DialogTitle>
          <DialogDescription>
            Für {MONTH_NAMES[selectedMonth - 1]} {selectedYear} werden alle Kunden mit unterschriebenem Leistungsnachweis sequenziell in Rechnung gestellt. Kunden mit bereits vorhandener Rechnung werden übersprungen.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 pt-2 text-sm">
          <div className="text-gray-700">
            Berechtigte Kunden: <span className="font-medium" data-testid="text-generate-all-count">{totalCount}</span>
          </div>

          {!generateAllProgress && (
            <div className="space-y-2">
              <label className="flex items-start gap-2 cursor-pointer">
                <Checkbox
                  checked={readyOnly}
                  onCheckedChange={(v) => setReadyOnly(v === true)}
                  disabled={generateAllMutation.isPending}
                  className="mt-0.5"
                  data-testid="checkbox-ready-only"
                />
                <span className="text-gray-700">
                  Nur Kunden ohne offene Termine abrechnen
                </span>
              </label>
              {/* Task #1883 — Opt-in: Mischkunden (fehlende Kundenunterschrift/LN)
                  jetzt teil-abrechnen. Ohne Häkchen werden sie mit Ausweis der
                  betroffenen Termine übersprungen (nie still). */}
              <label className="flex items-start gap-2 cursor-pointer">
                <Checkbox
                  checked={confirmPartial}
                  onCheckedChange={(v) => setConfirmPartial(v === true)}
                  disabled={generateAllMutation.isPending}
                  className="mt-0.5"
                  data-testid="checkbox-confirm-partial-bulk"
                />
                <span className="text-gray-700">
                  Mischkunden teil-abrechnen (signierten Teil jetzt, fehlende
                  Kundenunterschriften/Leistungsnachweise werden ausgewiesen)
                </span>
              </label>
              <div className="text-gray-600" data-testid="text-generate-all-plan">
                <span className="font-medium text-green-700" data-testid="text-generate-all-will-create">{willCreate}</span> werden erstellt
                {" · "}
                <span className="font-medium text-gray-700" data-testid="text-generate-all-will-skip">{willSkip}</span> übersprungen
              </div>
            </div>
          )}

          {generateAllMutation.isPending && (
            <div className="flex items-center gap-2 text-teal-700">
              <Loader2 className={`${iconSize.sm} animate-spin`} />
              <span>Erstelle Rechnungen — bitte nicht schließen ...</span>
            </div>
          )}

          {generateAllProgress && (
            <div
              className="rounded border border-gray-200 bg-gray-50 px-3 py-2 space-y-2"
              data-testid="generate-all-summary"
            >
              <div>
                <div className="font-medium text-gray-800 mb-1">Ergebnis</div>
                <ul className="text-gray-700 space-y-0.5">
                  <li>
                    <span className="text-green-700 font-medium">{generateAllProgress.summary.created}</span> erstellt
                  </li>
                  <li>
                    <span className="text-gray-600 font-medium">{generateAllProgress.summary.skipped}</span> übersprungen
                  </li>
                  <li>
                    <span className={generateAllProgress.summary.errors > 0 ? "text-red-700 font-medium" : "text-gray-600 font-medium"}>
                      {generateAllProgress.summary.errors}
                    </span>{" "}
                    Fehler
                  </li>
                </ul>
              </div>

              {/* Task #587: Nur fehlgeschlagene Kunden namentlich auflisten —
                  inkl. Server-`message` (Task #586). Erfolgreiche bleiben
                  in der Summary, übersprungene ebenfalls (Grund ist generisch
                  „bereits abgerechnet", „noch offene Termine" bzw.
                  „Wartet auf Kundenunterschrift" — Task #1779). */}
              {(() => {
                const failed = generateAllProgress.results.filter((r) => r.status === "error");
                if (failed.length === 0) return null;
                return (
                  <div data-testid="generate-all-failures">
                    <div className="font-medium text-red-700 mb-1 mt-2">
                      Fehlgeschlagene Kunden ({failed.length})
                    </div>
                    <ul className="max-h-48 overflow-y-auto divide-y divide-gray-200 border border-red-200 rounded bg-white">
                      {failed.map((r) => {
                        const cust = customers?.find((c) => c.id === r.customerId);
                        const name = cust ? getCustomerName(cust) : `Kunde #${r.customerId}`;
                        return (
                          <li
                            key={r.customerId}
                            className="px-2 py-1.5 text-sm flex items-start gap-2"
                            data-testid={`generate-all-result-${r.customerId}`}
                          >
                            <span className="mt-1.5 w-2 h-2 rounded-full flex-shrink-0 bg-red-500" aria-hidden="true" />
                            <div className="min-w-0 flex-1">
                              <div className="font-medium text-gray-800 truncate">{name}</div>
                              <div
                                className="text-xs text-red-700 mt-0.5 break-words"
                                data-testid={`generate-all-error-message-${r.customerId}`}
                              >
                                {r.message ?? "Unbekannter Fehler"}
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })()}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            ref={closeButtonRef}
            variant="outline"
            onClick={() => { setOpen(false); setGenerateAllProgress(null); }}
            disabled={generateAllMutation.isPending}
            data-testid="button-close-generate-all"
          >
            Schließen
          </Button>
          <Button
            onClick={() => generateAllMutation.mutate({ readyOnly, confirmPartial, ...(selectedCustomerIds ? { customerIds: selectedCustomerIds } : {}) })}
            disabled={generateAllMutation.isPending || willCreate === 0 || !!generateAllProgress}
            className="bg-teal-600 hover:bg-teal-700 text-white"
            data-testid="button-confirm-generate-all"
          >
            {generateAllMutation.isPending ? (
              <>
                <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                Wird erstellt...
              </>
            ) : (
              <>
                <Layers className={`${iconSize.sm} mr-1`} />
                Jetzt erstellen
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
