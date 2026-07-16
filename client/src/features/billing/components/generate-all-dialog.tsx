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
import { hasOpenAppointments } from "@shared/domain/billing-eligibility";
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
    { readyOnly: boolean },
    unknown
  >;
  customers: BillingCustomerItem[] | undefined;
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

  const totalCount = customers?.length ?? 0;
  // Task #1775: Der (N)-Zähler „werden erstellt" darf nur die Kunden zählen, die
  // tatsächlich abgerechnet werden — also solche ohne offene Termine UND mit
  // erfülltem Unterschrifts-Gate (`eligibility.status === "eligible"`). Das
  // entspricht der Karten-Gruppe „Bereit zum Abrechnen". Signatur-blockierte
  // Pflegekasse-Kunden (`customer_signature_required`) haben keine offenen
  // Termine mehr, werden aber server-seitig nicht abgerechnet — sie zählten
  // vorher fälschlich mit und ließen den Zähler mehr versprechen, als entsteht.
  const readyCount = useMemo(
    () =>
      (customers ?? []).filter(
        (c) => !hasOpenAppointments(c) && c.eligibility.status === "eligible",
      ).length,
    [customers],
  );
  const willCreate = readyOnly ? readyCount : totalCount;
  const willSkip = readyOnly ? totalCount - readyCount : 0;

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
          <DialogTitle>Alle offenen Leistungsnachweise abrechnen</DialogTitle>
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
            onClick={() => generateAllMutation.mutate({ readyOnly })}
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
