import { useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { iconSize } from "@/design-system";
import { Loader2, Receipt, Trash2, ChevronDown, ChevronRight, Printer } from "lucide-react";
import type { UseMutationResult } from "@tanstack/react-query";
import type { InvoiceItem, InvoiceDetail as InvoiceDetailType, DeliveryRecord } from "@shared/api";
import {
  INVOICE_ACTION_CLUSTERS,
  INVOICE_ACTION_CLUSTER_LABELS,
  type InvoiceActionCluster,
} from "@shared/domain/billing-pipeline";
import { InvoiceRow } from "./invoice-row";
import { invoiceActionCluster, invoiceAgingBucket, formatAmount } from "../utils";
import type { BulkActionProgress } from "../hooks/use-billing-mutations";

// Task #1412: Reihenfolge der Handlungs-Cluster in der Liste (handlungs-
// orientiert: was zuerst Arbeit braucht, steht oben). „Abgeschlossen" und
// „Storniert" sind standardmäßig eingeklappt (Archiv-Charakter).
const CLUSTER_ORDER: InvoiceActionCluster[] = [...INVOICE_ACTION_CLUSTERS];
const DEFAULT_COLLAPSED: InvoiceActionCluster[] = ["abgeschlossen", "storniert"];

// Kurze Erklärzeile je Cluster — sagt dem Nutzer, welche Handlung ansteht.
const CLUSTER_HINTS: Record<InvoiceActionCluster, string> = {
  zu_versenden: "Entwürfe — an Kasse senden oder als versendet markieren",
  avis_ausstehend: "An Pflegekassen versendet — auf Zahlungsavis warten",
  zahlung_ausstehend: "Auf Zahlungseingang warten",
  abgeschlossen: "Bezahlt — abgeschlossen",
  storniert: "Stornierte Rechnungen und Gutschriften",
};

// Task #1376: Sammel-Statuswechsel ist bewusst auf die fortschreitenden
// Lebenszyklus-Status begrenzt — „storniert" ist KEINE Sammelaktion (Storno
// läuft cascade-sicher über den Einzelpfad).
// Task #1434: „Auf Entwurf zurücksetzen" ergänzt die Sammelaktionen — setzt
// versendete Rechnungen zurück (greift laut SSoT nur bei Quellstatus
// „versendet", alle anderen werden serverseitig als ungültiger Übergang
// übersprungen).
const BULK_STATUS_OPTIONS: { value: "entwurf" | "versendet" | "avis_erhalten" | "bezahlt"; label: string }[] = [
  { value: "versendet", label: "Versendet" },
  { value: "avis_erhalten", label: "Avis erhalten" },
  { value: "bezahlt", label: "Bezahlt" },
  { value: "entwurf", label: "Auf Entwurf zurücksetzen" },
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
  // Task #1630: „Nach Status auswählen" — alle Rechnungen eines Clusters
  // auf einmal auswählen/abwählen.
  onToggleSelectCluster: (invoiceIds: number[], checked: boolean) => void;
  onBulkDelete: () => void;
  onBulkStatus: (status: "entwurf" | "versendet" | "avis_erhalten" | "bezahlt") => void;
  // Task #1695: EIN „Drucken"-Menü für die Auswahl (READ-ONLY — kein
  // Statuswechsel). 2×2-Matrix: Zusammengefasst (1 PDF) vs Einzeln (ZIP), je ×
  // Nur Rechnungen vs + Leistungsnachweise. Ersetzt „Lexware-Export" und
  // „Drucken (inkl. Leistungsnachweise)".
  onBulkPrint: (opts: { combine: boolean; includeLeistungsnachweise: boolean }) => void;
  // Laufender „Zusammengefasst"-Druck (1 PDF, /bulk-print-preview).
  bulkPrintPending: boolean;
  // Laufender „Einzeln (ZIP)"-Export (/single-pdf-export).
  singlePdfExportPending: boolean;
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
  onToggleSelectCluster,
  onBulkDelete,
  onBulkStatus,
  onBulkPrint,
  bulkPrintPending,
  singlePdfExportPending,
  bulkActionPending,
  bulkActionProgress,
}: InvoiceListProps) {
  // Task #1412: Eingeklappte Cluster (Standard: Archiv-Cluster). Reine
  // Anzeige-Präferenz, kein Datenmodell.
  const [collapsed, setCollapsed] = useState<Set<InvoiceActionCluster>>(
    () => new Set(DEFAULT_COLLAPSED),
  );

  // Task #1412: Rechnungen in Handlungs-Cluster gruppieren (eine SICHT über die
  // SSoT `assignInvoiceActionCluster`). Pro Cluster: Zeilen (in Eingangs-
  // Reihenfolge), €-Summe, Aging je Zeile und Anzahl überfälliger Rechnungen.
  const grouped = useMemo(() => {
    const byCluster = new Map<
      InvoiceActionCluster,
      { items: InvoiceItem[]; totalCents: number; overdue: number; aging: Map<number, ReturnType<typeof invoiceAgingBucket>> }
    >();
    for (const cluster of CLUSTER_ORDER) {
      byCluster.set(cluster, { items: [], totalCents: 0, overdue: 0, aging: new Map() });
    }
    for (const inv of invoices ?? []) {
      const cluster = invoiceActionCluster(inv);
      const bucket = byCluster.get(cluster)!;
      bucket.items.push(inv);
      bucket.totalCents += inv.grossAmountCents;
      const aging = invoiceAgingBucket(inv);
      bucket.aging.set(inv.id, aging);
      if (aging === "orange" || aging === "red") bucket.overdue += 1;
    }
    return byCluster;
  }, [invoices]);

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

    const toggleCluster = (cluster: InvoiceActionCluster) => {
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(cluster)) next.delete(cluster);
        else next.add(cluster);
        return next;
      });
    };

    return (
      <div className="flex flex-col gap-3">
        {/* Task #1376: Auswahl-Kopfzeile mit „Alle auswählen" + kontextueller
            Sammelaktions-Leiste (nur sichtbar, wenn etwas ausgewählt ist).
            Bleibt global über alle Cluster (Auswahl spannt clusterübergreifend). */}
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
                {/* Task #1695: EIN „Drucken"-Menü für die Auswahl (READ-ONLY —
                    kein Statuswechsel). 2×2-Matrix: Zusammengefasst (1 PDF) vs
                    Einzeln (ZIP), je × Nur Rechnungen vs + Leistungsnachweise.
                    Ersetzt „Lexware-Export" + „Drucken (inkl. LN)". */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={bulkPrintPending || singlePdfExportPending}
                      data-testid="button-bulk-print"
                    >
                      {bulkPrintPending || singlePdfExportPending ? (
                        <Loader2 className={`${iconSize.sm} mr-1 animate-spin`} />
                      ) : (
                        <Printer className={`${iconSize.sm} mr-1`} />
                      )}
                      Drucken
                      <ChevronDown className={`${iconSize.sm} ml-1`} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-64">
                    <DropdownMenuLabel>Zusammengefasst (1 PDF)</DropdownMenuLabel>
                    <DropdownMenuItem
                      onSelect={() => onBulkPrint({ combine: true, includeLeistungsnachweise: false })}
                      data-testid="button-bulk-print-combined-invoices-only"
                    >
                      Nur Rechnungen
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => onBulkPrint({ combine: true, includeLeistungsnachweise: true })}
                      data-testid="button-bulk-print-combined-with-ln"
                    >
                      + Leistungsnachweise
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>Einzeln (ZIP)</DropdownMenuLabel>
                    <DropdownMenuItem
                      onSelect={() => onBulkPrint({ combine: false, includeLeistungsnachweise: false })}
                      data-testid="button-bulk-print-single-invoices-only"
                    >
                      Nur Rechnungen
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => onBulkPrint({ combine: false, includeLeistungsnachweise: true })}
                      data-testid="button-bulk-print-single-with-ln"
                    >
                      + Leistungsnachweise
                    </DropdownMenuItem>
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

        {/* Task #1412: Handlungs-Cluster statt flacher Liste. Leere Cluster
            werden ausgeblendet; jeder Cluster zeigt Anzahl + €-Summe und ist
            ein-/ausklappbar. */}
        {CLUSTER_ORDER.map((cluster) => {
          const group = grouped.get(cluster)!;
          if (group.items.length === 0) return null;
          const isCollapsed = collapsed.has(cluster);
          // Task #1630: Auswahl-Zustand des Clusters aus der bestehenden
          // `selectedIds`-Menge ableiten (alle/teils/keine).
          const clusterIds = group.items.map((inv) => inv.id);
          const selectedInCluster = clusterIds.reduce(
            (n, id) => (selectedIds.has(id) ? n + 1 : n),
            0,
          );
          const clusterChecked: boolean | "indeterminate" =
            selectedInCluster === 0
              ? false
              : selectedInCluster === clusterIds.length
                ? true
                : "indeterminate";
          return (
            <section key={cluster} data-testid={`cluster-${cluster}`} className="flex flex-col gap-2">
              {/* Task #1630: Kopfzeile ist kein <button> mehr — die
                  Cluster-Auswahl-Checkbox darf nicht in einem Button
                  verschachtelt sein. Checkbox + Klapp-Button sind Geschwister;
                  ein Klick auf die Checkbox löst das Ein-/Ausklappen NICHT aus. */}
              <div className="flex w-full items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-2 hover:bg-gray-50">
                <Checkbox
                  checked={clusterChecked}
                  onCheckedChange={(checked) => onToggleSelectCluster(clusterIds, checked === true)}
                  aria-label={`Alle Rechnungen im Cluster ${INVOICE_ACTION_CLUSTER_LABELS[cluster]} auswählen`}
                  data-testid={`checkbox-select-cluster-${cluster}`}
                />
                <button
                  type="button"
                  onClick={() => toggleCluster(cluster)}
                  aria-expanded={!isCollapsed}
                  className="flex flex-1 items-center gap-2 text-left"
                  data-testid={`button-cluster-toggle-${cluster}`}
                >
                  {isCollapsed ? (
                    <ChevronRight className={`${iconSize.sm} text-gray-400`} />
                  ) : (
                    <ChevronDown className={`${iconSize.sm} text-gray-400`} />
                  )}
                  <span className="font-semibold text-gray-900 text-sm">
                    {INVOICE_ACTION_CLUSTER_LABELS[cluster]}
                  </span>
                  <span
                    className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600"
                    data-testid={`text-cluster-count-${cluster}`}
                  >
                    {group.items.length}
                  </span>
                  {group.overdue > 0 && (
                    <span
                      className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 border border-red-200"
                      data-testid={`text-cluster-overdue-${cluster}`}
                    >
                      {group.overdue} überfällig
                    </span>
                  )}
                  <span className="hidden sm:inline text-xs text-gray-400">
                    {CLUSTER_HINTS[cluster]}
                  </span>
                  <span
                    className={`ml-auto text-sm font-medium tabular-nums ${group.totalCents < 0 ? "text-red-600" : "text-gray-900"}`}
                    data-testid={`text-cluster-sum-${cluster}`}
                  >
                    {formatAmount(group.totalCents)}
                  </span>
                </button>
              </div>

              {!isCollapsed &&
                group.items.map((invoice) => (
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
                    aging={group.aging.get(invoice.id)}
                  />
                ))}
            </section>
          );
        })}
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
