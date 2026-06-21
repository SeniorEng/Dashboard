import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { iconSize } from "@/design-system";
import { Loader2, Receipt, Trash2, ChevronDown } from "lucide-react";
import type { UseMutationResult } from "@tanstack/react-query";
import type { InvoiceItem, InvoiceDetail as InvoiceDetailType, DeliveryRecord } from "@shared/api";
import { InvoiceRow } from "./invoice-row";
import type { BulkActionProgress } from "../hooks/use-billing-mutations";

// Task #1376: Sammel-Statuswechsel ist bewusst auf die fortschreitenden
// Lebenszyklus-Status begrenzt — „storniert" ist KEINE Sammelaktion (Storno
// läuft cascade-sicher über den Einzelpfad).
const BULK_STATUS_OPTIONS: { value: "versendet" | "avis_erhalten" | "bezahlt"; label: string }[] = [
  { value: "versendet", label: "Versendet" },
  { value: "avis_erhalten", label: "Avis erhalten" },
  { value: "bezahlt", label: "Bezahlt" },
];

interface InvoiceListProps {
  invoices: InvoiceItem[] | undefined;
  invoicesLoading: boolean;
  expandedInvoiceId: number | null;
  onToggleDetail: (invoiceId: number) => void;
  expandedDetail: InvoiceDetailType | null | undefined;
  detailLoading: boolean;
  deliveryHistory: DeliveryRecord[] | undefined;
  sendingInvoiceId: number | null;
  sendInvoiceMutation: UseMutationResult<unknown, Error, number, unknown>;
  markSentMutation: UseMutationResult<unknown, Error, number, unknown>;
  statusMutation: UseMutationResult<unknown, Error, { id: number; status: string }, unknown>;
  onStorno: (invoice: InvoiceItem) => void;
  onMarkPaid: (invoice: InvoiceItem) => void;
  // Task #1376: Mehrfachauswahl + Sammelaktionen.
  selectedIds: Set<number>;
  onToggleSelect: (invoiceId: number, checked: boolean) => void;
  onToggleSelectAll: (checked: boolean) => void;
  onBulkDelete: () => void;
  onBulkStatus: (status: "versendet" | "avis_erhalten" | "bezahlt") => void;
  bulkActionPending: boolean;
  // Task #1380: laufender Fortschritt der blockweisen Sammelaktion.
  bulkActionProgress: BulkActionProgress | null;
}

export function InvoiceList({
  invoices,
  invoicesLoading,
  expandedInvoiceId,
  onToggleDetail,
  expandedDetail,
  detailLoading,
  deliveryHistory,
  sendingInvoiceId,
  sendInvoiceMutation,
  markSentMutation,
  statusMutation,
  onStorno,
  onMarkPaid,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  onBulkDelete,
  onBulkStatus,
  bulkActionPending,
  bulkActionProgress,
}: InvoiceListProps) {
  if (invoicesLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className={`${iconSize.xl} animate-spin text-teal-600`} />
      </div>
    );
  }

  if (invoices && invoices.length > 0) {
    const selectedCount = selectedIds.size;
    const allSelected = invoices.every((inv) => selectedIds.has(inv.id));
    const someSelected = selectedCount > 0 && !allSelected;

    return (
      <div className="flex flex-col gap-3">
        {/* Task #1376: Auswahl-Kopfzeile mit „Alle auswählen" + kontextueller
            Sammelaktions-Leiste (nur sichtbar, wenn etwas ausgewählt ist). */}
        <div className="flex flex-wrap items-center gap-3 px-3 py-2 rounded-md border border-gray-200 bg-gray-50">
          <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
            <Checkbox
              checked={allSelected ? true : someSelected ? "indeterminate" : false}
              onCheckedChange={(checked) => onToggleSelectAll(checked === true)}
              aria-label="Alle Rechnungen auswählen"
              data-testid="checkbox-select-all"
            />
            <span>Alle auswählen</span>
          </label>

          {selectedCount > 0 && (
            <>
              <span className="text-sm font-medium text-gray-900" data-testid="text-selection-count">
                {selectedCount} ausgewählt
              </span>
              {/* Task #1380: laufendes Fortschritts-Feedback bei großen
                  Auswahlen — zeigt "X von Y verarbeitet", solange Blöcke
                  abgearbeitet werden. */}
              {bulkActionProgress && (
                <span
                  className="flex items-center gap-1.5 text-sm text-gray-600"
                  data-testid="text-bulk-progress"
                  aria-live="polite"
                >
                  <Loader2 className={`${iconSize.sm} animate-spin text-teal-600`} />
                  {bulkActionProgress.processed} von {bulkActionProgress.total} verarbeitet
                </span>
              )}
              <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={bulkActionPending}
                      data-testid="button-bulk-status"
                    >
                      {bulkActionPending ? (
                        <Loader2 className={`${iconSize.sm} mr-1 animate-spin`} />
                      ) : null}
                      Status setzen
                      <ChevronDown className={`${iconSize.sm} ml-1`} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {BULK_STATUS_OPTIONS.map((opt) => (
                      <DropdownMenuItem
                        key={opt.value}
                        onSelect={() => onBulkStatus(opt.value)}
                        data-testid={`button-bulk-status-${opt.value}`}
                      >
                        {opt.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200"
                  onClick={onBulkDelete}
                  disabled={bulkActionPending}
                  data-testid="button-bulk-delete"
                >
                  <Trash2 className={`${iconSize.sm} mr-1`} />
                  Löschen
                </Button>
              </div>
            </>
          )}
        </div>

        {invoices.map((invoice) => (
          <InvoiceRow
            key={invoice.id}
            invoice={invoice}
            isExpanded={expandedInvoiceId === invoice.id}
            onToggleDetail={onToggleDetail}
            expandedDetail={expandedDetail}
            detailLoading={detailLoading}
            deliveryHistory={deliveryHistory}
            sendingInvoiceId={sendingInvoiceId}
            sendInvoiceMutation={sendInvoiceMutation}
            markSentMutation={markSentMutation}
            statusMutation={statusMutation}
            onStorno={onStorno}
            onMarkPaid={onMarkPaid}
            selected={selectedIds.has(invoice.id)}
            onToggleSelect={onToggleSelect}
          />
        ))}
      </div>
    );
  }

  return (
    <Card>
      <CardContent className="p-12 text-center">
        <Receipt className={`${iconSize["2xl"]} mx-auto mb-4 text-gray-300`} />
        <p className="text-gray-500">Keine Rechnungen für diesen Zeitraum</p>
      </CardContent>
    </Card>
  );
}
