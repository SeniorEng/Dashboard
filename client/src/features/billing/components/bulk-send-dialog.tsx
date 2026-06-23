import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { iconSize } from "@/design-system";
import { Send, Loader2 } from "lucide-react";
import type { UseMutationResult } from "@tanstack/react-query";
import type { InvoiceItem, BulkSendInvoiceResponse } from "@shared/api";
import { MONTH_NAMES } from "../constants";

interface BulkSendDialogProps {
  open: boolean;
  setOpen: (open: boolean) => void;
  bulkSendResult: BulkSendInvoiceResponse | null;
  setBulkSendResult: (result: BulkSendInvoiceResponse | null) => void;
  bulkSendMutation: UseMutationResult<BulkSendInvoiceResponse, Error, number[], unknown>;
  draftBulkInvoices: InvoiceItem[];
  invoices: InvoiceItem[] | undefined;
  onBulkSend: () => void;
  selectedMonth: number;
  selectedYear: number;
}

export function BulkSendDialog({
  open,
  setOpen,
  bulkSendResult,
  setBulkSendResult,
  bulkSendMutation,
  draftBulkInvoices,
  invoices,
  onBulkSend,
  selectedMonth,
  selectedYear,
}: BulkSendDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (bulkSendMutation.isPending) return;
        setOpen(o);
        if (!o) setBulkSendResult(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Alle Rechnungen versenden</DialogTitle>
          <DialogDescription>
            Für {MONTH_NAMES[selectedMonth - 1]} {selectedYear} werden alle Entwürfe sequenziell verarbeitet.
            Alle Rechnungen (Pflegekassen und Selbstzahler) werden manuell als versendet markiert
            (solange kein TI-Anschluss besteht). Bereits versendete Rechnungen werden übersprungen.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 pt-2 text-sm">
          <div className="text-gray-700">
            Zu verarbeitende Entwürfe: <span className="font-medium" data-testid="text-bulk-send-count">{draftBulkInvoices.length}</span>
          </div>

          {bulkSendMutation.isPending && (
            <div className="flex items-center gap-2 text-purple-700">
              <Loader2 className={`${iconSize.sm} animate-spin`} />
              <span>Versende — bitte nicht schließen ...</span>
            </div>
          )}

          {bulkSendResult && (() => {
            // Task #591: Kundenname-Lookup aus der bekannten Rechnungsliste,
            // damit die Fehler-Sektion „Rechnungsnummer + Kunde" anzeigen
            // kann, ohne dass der Server die Antwort erweitern muss.
            const customerNameById = new Map<number, string>();
            for (const inv of invoices ?? []) {
              if (inv.customerName) customerNameById.set(inv.id, inv.customerName);
            }
            const failedResults = bulkSendResult.results.filter((r) => r.status === "error");
            const nonFailedResults = bulkSendResult.results.filter((r) => r.status !== "error");
            return (
              <div
                className="rounded border border-gray-200 bg-gray-50 px-3 py-2 space-y-2"
                data-testid="bulk-send-summary"
              >
                <div>
                  <div className="font-medium text-gray-800 mb-1">Ergebnis</div>
                  <ul className="text-gray-700 space-y-0.5">
                    <li>
                      <span className="text-blue-700 font-medium">{bulkSendResult.summary.markedSent}</span> als versendet markiert
                    </li>
                    <li>
                      <span className="text-gray-600 font-medium">{bulkSendResult.summary.skipped}</span> übersprungen
                    </li>
                    <li>
                      <span className={bulkSendResult.summary.errors > 0 ? "text-red-700 font-medium" : "text-gray-600 font-medium"}>
                        {bulkSendResult.summary.errors}
                      </span>{" "}
                      Fehler
                    </li>
                  </ul>
                </div>

                {failedResults.length > 0 && (
                  <div data-testid="bulk-send-failures">
                    <div className="font-medium text-red-700 mb-1 mt-2">
                      Fehlgeschlagen ({failedResults.length})
                    </div>
                    <ul className="max-h-48 overflow-y-auto divide-y divide-red-200 border border-red-200 rounded bg-white">
                      {failedResults.map((r) => {
                        const label = r.invoiceNumber || `Rechnung #${r.invoiceId}`;
                        const customerName = customerNameById.get(r.invoiceId);
                        return (
                          <li
                            key={r.invoiceId}
                            className="px-2 py-1.5 text-sm flex items-start gap-2"
                            data-testid={`bulk-send-failure-${r.invoiceId}`}
                          >
                            <span className="mt-1.5 w-2 h-2 rounded-full flex-shrink-0 bg-red-500" aria-hidden="true" />
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-baseline gap-x-2">
                                <span className="font-medium text-gray-800 truncate">{label}</span>
                                {customerName && (
                                  <span
                                    className="text-xs text-gray-700 truncate"
                                    data-testid={`bulk-send-failure-customer-${r.invoiceId}`}
                                  >
                                    {customerName}
                                  </span>
                                )}
                              </div>
                              <div
                                className="text-xs text-red-700 mt-0.5 break-words"
                                data-testid={`bulk-send-failure-message-${r.invoiceId}`}
                              >
                                {r.message || "Unbekannter Fehler"}
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}

                {nonFailedResults.length > 0 && (
                  <div>
                    <div className="font-medium text-gray-800 mb-1 mt-2">Pro Rechnung</div>
                    <ul className="max-h-48 overflow-y-auto divide-y divide-gray-200 border border-gray-200 rounded bg-white">
                      {nonFailedResults.map((r) => {
                        const dotColor =
                          r.status === "marked_sent" ? "bg-blue-500"
                          : "bg-gray-400";
                        const labelColor =
                          r.status === "marked_sent" ? "text-blue-700"
                          : "text-gray-600";
                        const labelText =
                          r.status === "marked_sent" ? "als versendet markiert"
                          : "übersprungen";
                        const label = r.invoiceNumber || `Rechnung #${r.invoiceId}`;
                        return (
                          <li
                            key={r.invoiceId}
                            className="px-2 py-1.5 text-sm flex items-start gap-2"
                            data-testid={`bulk-send-result-${r.invoiceId}`}
                          >
                            <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`} aria-hidden="true" />
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-baseline gap-x-2">
                                <span className="font-medium text-gray-800 truncate">{label}</span>
                                <span className={`text-xs font-medium ${labelColor}`}>{labelText}</span>
                              </div>
                              {r.message && r.status === "skipped" && (
                                <div className="text-xs text-gray-600 mt-0.5 break-words">{r.message}</div>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </div>
            );
          })()}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => { setOpen(false); setBulkSendResult(null); }}
            disabled={bulkSendMutation.isPending}
          >
            Schließen
          </Button>
          <Button
            onClick={onBulkSend}
            disabled={bulkSendMutation.isPending || draftBulkInvoices.length === 0 || !!bulkSendResult}
            className="bg-purple-600 hover:bg-purple-700 text-white"
            data-testid="button-confirm-bulk-send"
          >
            {bulkSendMutation.isPending ? (
              <>
                <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                Wird versendet...
              </>
            ) : (
              <>
                <Send className={`${iconSize.sm} mr-1`} />
                Jetzt versenden
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
