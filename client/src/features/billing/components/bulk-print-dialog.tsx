import { useState } from "react";
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
import { Printer, Loader2, Layers, FileText } from "lucide-react";
import type { UseMutationResult } from "@tanstack/react-query";
import type { InvoiceItem, BulkPrintSummary } from "@shared/api";
import { MONTH_NAMES } from "../constants";

type BulkPrintData = { blob: Blob; fileName: string; summary: BulkPrintSummary | null };

interface BulkPrintDialogProps {
  open: boolean;
  setOpen: (open: boolean) => void;
  bulkPrintResult: BulkPrintSummary | null;
  setBulkPrintResult: (result: BulkPrintSummary | null) => void;
  bulkPrintMutation: UseMutationResult<BulkPrintData, Error, { groupByPayer: boolean }, unknown>;
  draftBulkInvoices: InvoiceItem[];
  invoices: InvoiceItem[] | undefined;
  onBulkPrint: (groupByPayer: boolean) => void;
  selectedMonth: number;
  selectedYear: number;
  payerSuffix: string;
}

export function BulkPrintDialog({
  open,
  setOpen,
  bulkPrintResult,
  setBulkPrintResult,
  bulkPrintMutation,
  draftBulkInvoices,
  invoices,
  onBulkPrint,
  selectedMonth,
  selectedYear,
  payerSuffix,
}: BulkPrintDialogProps) {
  // Auswahl: ein Gesamt-PDF oder ein ZIP mit je einem PDF pro Krankenkasse.
  const [groupByPayer, setGroupByPayer] = useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (bulkPrintMutation.isPending) return;
        setOpen(o);
        if (!o) setBulkPrintResult(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sammeldruck{payerSuffix}</DialogTitle>
          <DialogDescription>
            Für {MONTH_NAMES[selectedMonth - 1]} {selectedYear} werden alle Entwurfs-Rechnungen
            zusammen mit ihren Leistungsnachweisen zu einem druckfertigen Dokument gebündelt.
            Die enthaltenen Rechnungen werden anschließend als „versendet" markiert.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 pt-2 text-sm">
          <div className="text-gray-700">
            Zu druckende Entwürfe:{" "}
            <span className="font-medium" data-testid="text-bulk-print-count">
              {draftBulkInvoices.length}
            </span>
          </div>

          {!bulkPrintResult && (
            <div className="space-y-2" role="radiogroup" aria-label="Druckformat">
              <button
                type="button"
                role="radio"
                aria-checked={!groupByPayer}
                onClick={() => setGroupByPayer(false)}
                disabled={bulkPrintMutation.isPending}
                data-testid="option-bulk-print-all"
                className={`w-full flex items-start gap-2 rounded border px-3 py-2 text-left ${
                  !groupByPayer ? "border-emerald-400 bg-emerald-50" : "border-gray-200 hover:bg-gray-50"
                }`}
              >
                <FileText className={`${iconSize.sm} mt-0.5 text-emerald-700 flex-shrink-0`} />
                <span>
                  <span className="font-medium text-gray-800">Alle des Monats (ein PDF)</span>
                  <span className="block text-xs text-gray-600">
                    Ein zusammengeführtes PDF mit allen Rechnungen und Leistungsnachweisen.
                  </span>
                </span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={groupByPayer}
                onClick={() => setGroupByPayer(true)}
                disabled={bulkPrintMutation.isPending}
                data-testid="option-bulk-print-per-payer"
                className={`w-full flex items-start gap-2 rounded border px-3 py-2 text-left ${
                  groupByPayer ? "border-emerald-400 bg-emerald-50" : "border-gray-200 hover:bg-gray-50"
                }`}
              >
                <Layers className={`${iconSize.sm} mt-0.5 text-emerald-700 flex-shrink-0`} />
                <span>
                  <span className="font-medium text-gray-800">Je Krankenkasse (ZIP)</span>
                  <span className="block text-xs text-gray-600">
                    Ein ZIP-Archiv mit einem separaten PDF pro Krankenkasse (Selbstzahler eigenes Bündel).
                  </span>
                </span>
              </button>
            </div>
          )}

          {bulkPrintMutation.isPending && (
            <div className="flex items-center gap-2 text-emerald-700" data-testid="bulk-print-progress">
              <Loader2 className={`${iconSize.sm} animate-spin`} />
              <span>Erstelle Sammeldruck — bitte nicht schließen ...</span>
            </div>
          )}

          {bulkPrintResult && (() => {
            // Kundenname-Lookup aus der bekannten Rechnungsliste für die
            // Fehler-Anzeige (Server liefert nur invoiceId/customerId).
            const customerNameById = new Map<number, string>();
            for (const inv of invoices ?? []) {
              if (inv.customerName) customerNameById.set(inv.id, inv.customerName);
            }
            const failedResults = bulkPrintResult.results.filter((r) => r.status === "error");
            return (
              <div
                className="rounded border border-gray-200 bg-gray-50 px-3 py-2 space-y-2"
                data-testid="bulk-print-summary"
              >
                <div>
                  <div className="font-medium text-gray-800 mb-1">Ergebnis</div>
                  <ul className="text-gray-700 space-y-0.5">
                    <li>
                      <span className="text-emerald-700 font-medium">{bulkPrintResult.printed}</span> gedruckt
                    </li>
                    <li>
                      <span className="text-blue-700 font-medium">{bulkPrintResult.marked}</span> als versendet markiert
                    </li>
                    <li>
                      <span className={bulkPrintResult.errors > 0 ? "text-red-700 font-medium" : "text-gray-600 font-medium"}>
                        {bulkPrintResult.errors}
                      </span>{" "}
                      Fehler
                    </li>
                  </ul>
                </div>

                {failedResults.length > 0 && (
                  <div data-testid="bulk-print-failures">
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
                            data-testid={`bulk-print-failure-${r.invoiceId}`}
                          >
                            <span className="mt-1.5 w-2 h-2 rounded-full flex-shrink-0 bg-red-500" aria-hidden="true" />
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-baseline gap-x-2">
                                <span className="font-medium text-gray-800 truncate">{label}</span>
                                {customerName && (
                                  <span className="text-xs text-gray-700 truncate">{customerName}</span>
                                )}
                              </div>
                              <div className="text-xs text-red-700 mt-0.5 break-words">
                                {r.message || "Unbekannter Fehler"}
                              </div>
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
            onClick={() => { setOpen(false); setBulkPrintResult(null); }}
            disabled={bulkPrintMutation.isPending}
          >
            Schließen
          </Button>
          <Button
            onClick={() => onBulkPrint(groupByPayer)}
            disabled={bulkPrintMutation.isPending || draftBulkInvoices.length === 0 || !!bulkPrintResult}
            className="bg-emerald-600 hover:bg-emerald-700 text-white"
            data-testid="button-confirm-bulk-print"
          >
            {bulkPrintMutation.isPending ? (
              <>
                <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                Wird erstellt...
              </>
            ) : (
              <>
                <Printer className={`${iconSize.sm} mr-1`} />
                Sammeldruck erstellen
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
