import { Card, CardContent } from "@/components/ui/card";
import { iconSize } from "@/design-system";
import { Loader2, Receipt } from "lucide-react";
import type { UseMutationResult } from "@tanstack/react-query";
import type { InvoiceItem, InvoiceDetail as InvoiceDetailType, DeliveryRecord } from "@shared/api";
import { InvoiceRow } from "./invoice-row";

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
}: InvoiceListProps) {
  if (invoicesLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className={`${iconSize.xl} animate-spin text-teal-600`} />
      </div>
    );
  }

  if (invoices && invoices.length > 0) {
    return (
      <div className="flex flex-col gap-3">
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
