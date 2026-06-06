import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatEuroDE } from "@shared/utils/money";
import { iconSize } from "@/design-system";
import { Loader2, FileText, Ban } from "lucide-react";
import type { UseMutationResult } from "@tanstack/react-query";
import type {
  BillingCustomerItem,
  BillingInvoicePreview,
  BlockingDraftInvoice,
  DiscardDraftsResponse,
  GenerateInvoiceResponse,
} from "@shared/api";
import { POT_DISPLAY_LABELS, type InvoicePotKey } from "@shared/domain/budget-invoice-split";
import { MONTH_NAMES } from "../constants";
import { getCustomerName } from "../utils";

const SPLIT_COUNT_WORDS = ["null", "eine", "zwei", "drei", "vier"];

// Task #1010: Beschriftet den Split-Hinweis exakt nach den betroffenen Töpfen.
// „Privat" erscheint nur, wenn ein echter Selbstzahler-Anteil dabei ist;
// reine Kassen-Aufteilungen heißen „Kassen-Rechnungen".
function buildSplitHint(splitPots: InvoicePotKey[]): string {
  const count = splitPots.length;
  const countWord = SPLIT_COUNT_WORDS[count] ?? String(count);
  const hasPrivateShare = splitPots.includes("private");
  const kind = hasPrivateShare ? "Rechnungen" : "Kassen-Rechnungen";
  const labels = splitPots.map((pot) => POT_DISPLAY_LABELS[pot]).join(" + ");
  return `Wird in ${countWord} ${kind} aufgeteilt (${labels}).`;
}

interface NewInvoiceDialogProps {
  open: boolean;
  setOpen: (open: boolean) => void;
  setSelectedCustomerId: (id: string) => void;
  customers: BillingCustomerItem[] | undefined;
  selectedCustomerId: string;
  selectedMonth: number;
  selectedYear: number;
  previewCustomerId: number | null;
  invoicePreview: BillingInvoicePreview | undefined;
  previewLoading: boolean;
  previewError: boolean;
  previewErrorObj: unknown;
  blockingDrafts: BlockingDraftInvoice[] | undefined;
  onDiscardClick: () => void;
  discardDraftsMutation: UseMutationResult<DiscardDraftsResponse, Error, { customerId: number; month: number; year: number }, unknown>;
  generateMutation: UseMutationResult<GenerateInvoiceResponse, Error, { customerId: number; billingMonth: number; billingYear: number }, unknown>;
  onGenerate: () => void;
}

export function NewInvoiceDialog({
  open,
  setOpen,
  setSelectedCustomerId,
  customers,
  selectedCustomerId,
  selectedMonth,
  selectedYear,
  previewCustomerId,
  invoicePreview,
  previewLoading,
  previewError,
  previewErrorObj,
  blockingDrafts,
  onDiscardClick,
  discardDraftsMutation,
  generateMutation,
  onGenerate,
}: NewInvoiceDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setSelectedCustomerId(""); } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Neue Rechnung erstellen</DialogTitle>
          <DialogDescription>
            Rechnung für {MONTH_NAMES[selectedMonth - 1]} {selectedYear} generieren
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-700">Kunde</label>
            {customers && customers.length === 0 ? (
              <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-3" data-testid="text-no-eligible-customers">
                Keine Kunden mit unterschriebenen Leistungsnachweisen für {MONTH_NAMES[selectedMonth - 1]} {selectedYear} vorhanden.
              </div>
            ) : (
              <Select value={selectedCustomerId} onValueChange={setSelectedCustomerId}>
                <SelectTrigger data-testid="select-invoice-customer">
                  <SelectValue placeholder="Kunden auswählen..." />
                </SelectTrigger>
                <SelectContent>
                  {customers?.map((c) => {
                    // Task #576: Partial-Signing-Hinweis im Dropdown.
                    // Wenn weniger Termine durch einen aktiven LN
                    // abgedeckt sind als dokumentiert wurden, sieht
                    // der Admin sofort, dass evtl. ein zweiter LN
                    // fehlt — und versucht nicht erst, eine Rechnung
                    // zu generieren, die nur einen Teil enthält.
                    const partial = c.completedAppointments > 0
                      && c.coveredAppointments < c.completedAppointments;
                    return (
                      <SelectItem key={c.id} value={c.id.toString()}>
                        {getCustomerName(c)}
                        {c.status === "inaktiv" ? " (inaktiv)" : ""}
                        {partial
                          ? ` — nur ${c.coveredAppointments}/${c.completedAppointments} Termine im LN`
                          : ""}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Task #750: Vorschau-Block — zeigt exakt die Werte, die die
              nachfolgende Rechnung tragen wird (gemeinsamer Helper im Server). */}
          {previewCustomerId !== null && (
            <div
              className="rounded-md border border-gray-200 bg-gray-50 p-3 space-y-2"
              data-testid="block-invoice-preview"
            >
              <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Vorschau
              </div>
              {previewLoading ? (
                <div className="flex items-center text-sm text-gray-500" data-testid="text-preview-loading">
                  <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                  Wird berechnet...
                </div>
              ) : previewError || !invoicePreview ? (
                <div className="space-y-2">
                  <div className="text-sm text-amber-700" data-testid="text-preview-error">
                    {(() => {
                      // Task #816 — Die konkrete fachliche Server-Meldung (400)
                      // anzeigen statt der generischen „nicht verfügbar". Bei
                      // unerwarteten Fehlern (Netzwerk/5xx, keine spezifische
                      // Meldung) bleibt der allgemeine Fallback erhalten.
                      const apiErr = previewErrorObj as (Error & { status?: number }) | null;
                      const isClientError = !!apiErr?.status && apiErr.status >= 400 && apiErr.status < 500;
                      const serverMessage = isClientError ? apiErr?.message?.trim() : undefined;
                      return serverMessage || "Vorschau nicht verfügbar.";
                    })()}
                  </div>
                  {/* Task #817 — Verwaiste Entwurfs-Rechnungen, die die Termine
                      blockieren, direkt aus dem Dialog auflösen. Nur Entwürfe
                      (nie festgeschrieben) werden angeboten. */}
                  {blockingDrafts && blockingDrafts.length > 0 && (
                    <div
                      className="rounded-md border border-amber-200 bg-amber-50 p-2 space-y-2"
                      data-testid="block-blocking-drafts"
                    >
                      <div className="text-xs text-amber-800">
                        {blockingDrafts.length === 1
                          ? "Ein alter Rechnungs-Entwurf blockiert die Termine:"
                          : `${blockingDrafts.length} alte Rechnungs-Entwürfe blockieren die Termine:`}
                        {" "}
                        <span className="font-medium">
                          {blockingDrafts.map((d) => d.invoiceNumber).join(", ")}
                        </span>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="border-amber-300 text-amber-800 hover:bg-amber-100"
                        onClick={onDiscardClick}
                        disabled={discardDraftsMutation.isPending}
                        data-testid="button-discard-drafts"
                      >
                        {discardDraftsMutation.isPending ? (
                          <Loader2 className={`${iconSize.sm} mr-1 animate-spin`} />
                        ) : (
                          <Ban className={`${iconSize.sm} mr-1`} />
                        )}
                        {blockingDrafts.length === 1 ? "Entwurf verwerfen" : "Entwürfe verwerfen"}
                      </Button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-3 text-sm">
                  <div data-testid="text-preview-service-records">
                    <div className="text-xs text-gray-500">Leistungsnachweise</div>
                    <div className="font-semibold text-gray-900">{invoicePreview.serviceRecordCount}</div>
                  </div>
                  <div data-testid="text-preview-appointments">
                    <div className="text-xs text-gray-500">Termine</div>
                    <div className="font-semibold text-gray-900">
                      {invoicePreview.coveredAppointments}
                      {invoicePreview.completedAppointments > invoicePreview.coveredAppointments && (
                        <span className="ml-1 text-xs font-normal text-amber-700">
                          von {invoicePreview.completedAppointments} dokumentiert
                        </span>
                      )}
                    </div>
                  </div>
                  <div data-testid="text-preview-total">
                    <div className="text-xs text-gray-500">Summe (brutto)</div>
                    <div className="font-semibold text-gray-900">
                      {formatEuroDE(invoicePreview.totalCents)}
                    </div>
                  </div>
                </div>
              )}
              {invoicePreview?.splitInvoices && invoicePreview.splitPots?.length > 0 && (
                <div className="text-xs text-gray-600" data-testid="text-preview-split-hint">
                  {buildSplitHint(invoicePreview.splitPots)}
                </div>
              )}
            </div>
          )}

          <div className="flex gap-4">
            <div className="flex-1 space-y-2">
              <label className="text-sm font-medium text-gray-700">Monat</label>
              <div className="text-sm text-gray-900 p-2 bg-gray-50 rounded-md">
                {MONTH_NAMES[selectedMonth - 1]}
              </div>
            </div>
            <div className="flex-1 space-y-2">
              <label className="text-sm font-medium text-gray-700">Jahr</label>
              <div className="text-sm text-gray-900 p-2 bg-gray-50 rounded-md">
                {selectedYear}
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Abbrechen
          </Button>
          <Button
            onClick={onGenerate}
            disabled={generateMutation.isPending || !selectedCustomerId}
            className="bg-teal-600 hover:bg-teal-700 text-white"
            data-testid="button-generate-invoice"
          >
            {generateMutation.isPending ? (
              <>
                <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                Wird erstellt...
              </>
            ) : (
              <>
                <FileText className={`${iconSize.sm} mr-1`} />
                Rechnung erstellen
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
