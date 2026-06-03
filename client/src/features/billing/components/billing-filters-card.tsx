import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { iconSize } from "@/design-system";
import { Plus, Send, Loader2, FileText, Printer, Layers } from "lucide-react";
import type { BillingCustomerItem, InvoiceItem, PayerSummary } from "@shared/api";
import { MONTH_NAMES } from "../constants";

interface BillingFiltersCardProps {
  selectedMonth: number;
  setSelectedMonth: (month: number) => void;
  selectedYear: number;
  setSelectedYear: (year: number) => void;
  years: number[];
  statusFilter: string;
  setStatusFilter: (status: string) => void;
  payerFilter: string;
  setPayerFilter: (payer: string) => void;
  payers: PayerSummary[] | undefined;
  activePayer: PayerSummary | null;
  payerSuffix: string;
  draftBulkInvoices: InvoiceItem[];
  draftPflegekasseInvoices: InvoiceItem[];
  customers: BillingCustomerItem[] | undefined;
  batchSending: boolean;
  onBatchSend: () => void;
  onOpenBulkSend: () => void;
  onOpenGenerateAll: () => void;
  onOpenNewInvoice: () => void;
}

export function BillingFiltersCard({
  selectedMonth,
  setSelectedMonth,
  selectedYear,
  setSelectedYear,
  years,
  statusFilter,
  setStatusFilter,
  payerFilter,
  setPayerFilter,
  payers,
  activePayer,
  payerSuffix,
  draftBulkInvoices,
  draftPflegekasseInvoices,
  customers,
  batchSending,
  onBatchSend,
  onOpenBulkSend,
  onOpenGenerateAll,
  onOpenNewInvoice,
}: BillingFiltersCardProps) {
  return (
    <Card className="mb-6">
      <CardContent className="p-4">
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-3">
            <span className="text-sm text-gray-500">Monat:</span>
            <Select value={selectedMonth.toString()} onValueChange={(v) => setSelectedMonth(parseInt(v))}>
              <SelectTrigger className="w-full max-w-[200px]" data-testid="select-billing-month">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MONTH_NAMES.map((name, i) => (
                  <SelectItem key={i + 1} value={(i + 1).toString()}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <span className="text-sm text-gray-500">Jahr:</span>
            <Select value={selectedYear.toString()} onValueChange={(v) => setSelectedYear(parseInt(v))}>
              <SelectTrigger className="w-full max-w-[200px]" data-testid="select-billing-year">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {years.map((y) => (
                  <SelectItem key={y} value={y.toString()}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <span className="text-sm text-gray-500">Status:</span>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-full max-w-[200px]" data-testid="select-billing-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="alle">Alle</SelectItem>
                <SelectItem value="entwurf">Entwurf</SelectItem>
                <SelectItem value="versendet">Versendet</SelectItem>
                <SelectItem value="bezahlt">Bezahlt</SelectItem>
                <SelectItem value="storniert">Storniert</SelectItem>
              </SelectContent>
            </Select>

            <span className="text-sm text-gray-500">Kasse:</span>
            <Select value={payerFilter} onValueChange={setPayerFilter}>
              <SelectTrigger className="w-full max-w-[280px]" data-testid="select-billing-payer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="alle">Alle Krankenkassen</SelectItem>
                {payers?.map((p) => (
                  <SelectItem
                    key={p.insuranceProviderId}
                    value={p.insuranceProviderId.toString()}
                    data-testid={`select-payer-option-${p.insuranceProviderId}`}
                  >
                    {p.name} ({p.invoiceCount})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Task #533: Mobil-fix — Aktionsleiste bricht auf schmalen
              Viewports um (flex-wrap), Buttons nehmen volle Breite und
              Beschriftungen sind auf Mobile kürzer (sm:inline-Zusatz). */}
          <div className="flex flex-wrap justify-end gap-2">
            {activePayer && (
              <>
                <a
                  href={`/api/billing/bundle-by-payer?year=${selectedYear}&month=${selectedMonth}&insuranceProviderId=${activePayer.insuranceProviderId}&format=zip`}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="link-bundle-zip"
                  className="w-full sm:w-auto"
                >
                  <Button
                    variant="outline"
                    className="text-indigo-700 border-indigo-200 hover:bg-indigo-50 w-full sm:w-auto"
                  >
                    <FileText className={`${iconSize.sm} mr-1`} />
                    ZIP-Download{payerSuffix}
                  </Button>
                </a>
                <a
                  href={`/api/billing/bundle-by-payer?year=${selectedYear}&month=${selectedMonth}&insuranceProviderId=${activePayer.insuranceProviderId}&format=pdf`}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="link-bundle-pdf"
                  className="w-full sm:w-auto"
                >
                  <Button
                    variant="outline"
                    className="text-indigo-700 border-indigo-200 hover:bg-indigo-50 w-full sm:w-auto"
                  >
                    <Printer className={`${iconSize.sm} mr-1`} />
                    Kombi-PDF{payerSuffix}
                  </Button>
                </a>
              </>
            )}
            {draftBulkInvoices.length > 0 && (
              <Button
                variant="outline"
                className="text-purple-700 border-purple-200 hover:bg-purple-50 w-full sm:w-auto"
                onClick={onOpenBulkSend}
                data-testid="button-bulk-send"
              >
                <Send className={`${iconSize.sm} mr-1`} />
                <span className="hidden sm:inline">Alle </span>versenden{payerSuffix} ({draftBulkInvoices.length})
              </Button>
            )}
            {draftPflegekasseInvoices.length > 0 && (
              <Button
                variant="outline"
                className="text-blue-600 border-blue-200 hover:bg-blue-50 w-full sm:w-auto"
                onClick={onBatchSend}
                disabled={batchSending}
                data-testid="button-batch-send"
              >
                {batchSending ? (
                  <>
                    <Loader2 className={`${iconSize.sm} mr-1 animate-spin`} />
                    Versende...
                  </>
                ) : (
                  <>
                    <Send className={`${iconSize.sm} mr-1`} />
                    <span className="hidden sm:inline">Alle an </span>Pflegekassen senden{payerSuffix} ({draftPflegekasseInvoices.length})
                  </>
                )}
              </Button>
            )}
            {customers && customers.length > 0 && (
              <Button
                variant="outline"
                className="text-teal-700 border-teal-200 hover:bg-teal-50 w-full sm:w-auto"
                onClick={onOpenGenerateAll}
                data-testid="button-generate-all"
              >
                <Layers className={`${iconSize.sm} mr-1`} />
                <span className="hidden sm:inline">Alle offenen erstellen </span>
                <span className="sm:hidden">Alle erstellen </span>
                {payerSuffix}({customers.length})
              </Button>
            )}
            <Button
              onClick={onOpenNewInvoice}
              className="bg-teal-600 hover:bg-teal-700 text-white w-full sm:w-auto"
              data-testid="button-new-invoice"
            >
              <Plus className={`${iconSize.sm} mr-1`} />
              Neue Rechnung
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
