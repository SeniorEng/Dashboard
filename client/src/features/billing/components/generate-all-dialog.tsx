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
import { isPartiallyDocumented, hasOpenAppointments } from "@shared/domain/billing-eligibility";
import { MONTH_NAMES, BILLING_MATURITY_SCOPE_LABELS } from "../constants";
import { getCustomerName } from "../utils";
import type { GenerateAllResponse, BillingMaturityScope } from "../types";

interface GenerateAllDialogProps {
  open: boolean;
  setOpen: (open: boolean) => void;
  generateAllProgress: GenerateAllResponse | null;
  setGenerateAllProgress: (progress: GenerateAllResponse | null) => void;
  generateAllMutation: UseMutationResult<
    GenerateAllResponse,
    Error,
    { skipIncomplete: boolean; maturityScope: BillingMaturityScope },
    unknown
  >;
  customers: BillingCustomerItem[] | undefined;
  // Task #1771: gewählte Reifegruppe des Split-Knopfs — steuert den Untertitel,
  // die Zähler (nur Kunden der Gruppe) und den an den Server übergebenen Scope.
  maturityScope: BillingMaturityScope;
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
  maturityScope,
  selectedMonth,
  selectedYear,
  closeButtonRef,
}: GenerateAllDialogProps) {
  // Task #1625: Kunden mit unvollständig dokumentierten Terminen überspringen —
  // per Default AN, damit nur vollständig dokumentierte Kunden abgerechnet
  // werden. Die Zähler unten leiten sich aus derselben Regel ab
  // (`isPartiallyDocumented`), die auch der Server für den Skip nutzt.
  const [skipIncomplete, setSkipIncomplete] = useState(true);

  // Task #1771: Auf die gewählte Reifegruppe eingeschränkte Kundenmenge. „ready"
  // = nur Kunden ohne offene Termine, „open" = nur Kunden mit offenen Terminen,
  // „all" = alle. Nutzt dieselbe reine SSoT (`hasOpenAppointments`) wie die
  // Karte „Noch zu erstellen" UND der Server-Filter — keine zweite Regel. Alle
  // Zähler unten leiten sich aus dieser Menge ab.
  const scopedCustomers = useMemo(() => {
    const list = customers ?? [];
    if (maturityScope === "ready") return list.filter((c) => !hasOpenAppointments(c));
    if (maturityScope === "open") return list.filter((c) => hasOpenAppointments(c));
    return list;
  }, [customers, maturityScope]);

  const totalCount = scopedCustomers.length;
  const incompleteCount = scopedCustomers.filter((c) => isPartiallyDocumented(c)).length;
  const willCreate = skipIncomplete ? totalCount - incompleteCount : totalCount;
  const willSkip = skipIncomplete ? incompleteCount : 0;

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
          {/* Task #1771: gewählte Reifegruppe sichtbar machen, damit klar ist,
              welche Teilmenge der berechtigten Kunden abgerechnet wird. */}
          <div className="text-gray-600" data-testid="text-generate-all-scope">
            Auswahl: <span className="font-medium text-gray-800">{BILLING_MATURITY_SCOPE_LABELS[maturityScope]}</span>
          </div>
          <div className="text-gray-700">
            Berechtigte Kunden: <span className="font-medium" data-testid="text-generate-all-count">{totalCount}</span>
          </div>

          {!generateAllProgress && (
            <div className="space-y-2">
              <label className="flex items-start gap-2 cursor-pointer">
                <Checkbox
                  checked={skipIncomplete}
                  onCheckedChange={(v) => setSkipIncomplete(v === true)}
                  disabled={generateAllMutation.isPending}
                  className="mt-0.5"
                  data-testid="checkbox-skip-incomplete"
                />
                <span className="text-gray-700">
                  Kunden mit unvollständig dokumentierten Terminen überspringen
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
                    <span className="text-gray-600 font-medium">{generateAllProgress.summary.skipped}</span> übersprungen (bereits abgerechnet)
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
                  „bereits abgerechnet"). */}
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
            onClick={() => generateAllMutation.mutate({ skipIncomplete, maturityScope })}
            disabled={generateAllMutation.isPending || scopedCustomers.length === 0 || !!generateAllProgress}
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
