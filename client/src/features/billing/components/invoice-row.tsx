import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { iconSize } from "@/design-system";
import {
  Send,
  Check,
  Ban,
  Loader2,
  FileText,
  FileCheck2,
  Eye,
  Printer,
  MoreHorizontal,
} from "lucide-react";
import type { UseMutationResult } from "@tanstack/react-query";
import type { InvoiceItem, InvoiceDetail as InvoiceDetailType, DeliveryRecord } from "@shared/api";
import {
  STATUS_LABELS,
  STATUS_COLORS,
  TYPE_LABELS,
  TYPE_COLORS,
} from "../constants";
import {
  formatAmount,
  formatSentAt,
  getInvoiceCustomerDisplayName,
  getPdfStatus,
} from "../utils";
import { InvoiceDetail } from "./invoice-detail";

interface InvoiceRowProps {
  invoice: InvoiceItem;
  isExpanded: boolean;
  onToggleDetail: (invoiceId: number) => void;
  expandedDetail: InvoiceDetailType | null | undefined;
  detailLoading: boolean;
  deliveryHistory: DeliveryRecord[] | undefined;
  sendingInvoiceId: number | null;
  sendInvoiceMutation: UseMutationResult<unknown, Error, number, unknown>;
  markSentMutation: UseMutationResult<unknown, Error, number, unknown>;
  statusMutation: UseMutationResult<unknown, Error, { id: number; status: string }, unknown>;
  onStorno: (invoice: InvoiceItem) => void;
}

export function InvoiceRow({
  invoice,
  isExpanded,
  onToggleDetail,
  expandedDetail,
  detailLoading,
  deliveryHistory,
  sendingInvoiceId,
  sendInvoiceMutation,
  markSentMutation,
  statusMutation,
  onStorno,
}: InvoiceRowProps) {
  const pdfStatus = getPdfStatus(invoice);
  const customerDisplay = getInvoiceCustomerDisplayName(invoice);
  const showSeparateRecipient =
    customerDisplay && customerDisplay.trim() !== invoice.recipientName.trim();
  const canStorno =
    invoice.status !== "storniert" && invoice.invoiceType !== "stornorechnung";

  return (
    <div>
      <Card data-testid={`invoice-row-${invoice.id}`}>
        <CardContent className="py-2 px-3">
          <div className="flex items-center gap-3">
            {/* Nummer + Typ/Status-Badges */}
            <div className="flex items-center gap-2 shrink-0">
              <span className="font-medium text-gray-900 text-sm">{invoice.invoiceNumber}</span>
              <Badge
                variant="outline"
                className={`hidden sm:inline-flex ${TYPE_COLORS[invoice.invoiceType] || "bg-gray-100 text-gray-600 border-gray-200"}`}
              >
                {TYPE_LABELS[invoice.invoiceType] || invoice.invoiceType}
              </Badge>
              <Badge
                variant="outline"
                className={STATUS_COLORS[invoice.status] || "bg-gray-100 text-gray-600 border-gray-200"}
              >
                {STATUS_LABELS[invoice.status] || invoice.status}
              </Badge>
              {invoice.billingRunId && (
                <Badge
                  variant="outline"
                  className="hidden md:inline-flex bg-violet-50 text-violet-700 border-violet-200"
                  title={`Teil eines Topf-Splits (Lauf-ID ${invoice.billingRunId.slice(0, 8)}…). Cascade-Storno betrifft alle Geschwister-Rechnungen.`}
                  data-testid={`badge-topf-gruppe-${invoice.id}`}
                >
                  Topf-Gruppe
                </Badge>
              )}
              {/* Task #546: PDF-Persistierungs-Status sichtbar machen. */}
              {pdfStatus === "pending" && (
                <Badge
                  variant="outline"
                  className="bg-amber-50 text-amber-700 border-amber-200"
                  title="Das PDF wird gerade im Hintergrund erstellt."
                  data-testid={`badge-pdf-pending-${invoice.id}`}
                >
                  PDF…
                </Badge>
              )}
              {pdfStatus === "error" && (
                <Badge
                  variant="outline"
                  className="bg-red-50 text-red-700 border-red-200"
                  title="Das PDF konnte nicht im Hintergrund erstellt werden. Beim nächsten Druck-/Versand-Klick wird ein erneuter Versuch unternommen."
                  data-testid={`badge-pdf-error-${invoice.id}`}
                >
                  PDF-Fehler
                </Badge>
              )}
            </div>

            {/* Kunde / Empfänger */}
            <div className="flex-1 min-w-0 flex items-center gap-2 text-sm">
              {customerDisplay && (
                <Link
                  href={`/admin/customers/${invoice.customerId}`}
                  className="text-gray-900 font-medium hover:underline truncate"
                  data-testid={`link-customer-${invoice.id}`}
                >
                  {customerDisplay}
                </Link>
              )}
              {showSeparateRecipient && (
                <span className="text-gray-500 truncate hidden md:inline" data-testid={`text-recipient-${invoice.id}`}>
                  <span className="text-gray-400">→</span> {invoice.recipientName}
                </span>
              )}
            </div>

            {/* Betrag + Versanddatum */}
            <div className="flex items-center gap-2 shrink-0 text-sm">
              {invoice.sentAt && (invoice.status === "versendet" || invoice.status === "bezahlt") && (
                <span className="text-xs text-blue-700 hidden lg:inline" data-testid={`text-sentat-${invoice.id}`}>
                  Versendet {formatSentAt(invoice.sentAt)}
                </span>
              )}
              <span className={`font-medium tabular-nums ${invoice.grossAmountCents < 0 ? "text-red-600" : "text-gray-900"}`}>
                {formatAmount(invoice.grossAmountCents)}
                {invoice.billingType === "selbstzahler" && (
                  <span className="text-xs text-gray-400 font-normal ml-1 hidden sm:inline">inkl. MwSt.</span>
                )}
              </span>
            </div>

            {/* Aktionen: primäre Status-Aktion sichtbar, Rest im Menü */}
            <div className="flex items-center gap-1 shrink-0">
              {invoice.status === "entwurf" && invoice.billingType === "pflegekasse_gesetzlich" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                  onClick={() => sendInvoiceMutation.mutate(invoice.id)}
                  disabled={sendingInvoiceId === invoice.id || sendInvoiceMutation.isPending}
                  data-testid={`button-send-pflegekasse-${invoice.id}`}
                >
                  {sendingInvoiceId === invoice.id ? (
                    <>
                      <Loader2 className={`${iconSize.sm} mr-1 animate-spin`} />
                      <span className="hidden sm:inline">Sende...</span>
                    </>
                  ) : (
                    <>
                      <Send className={`${iconSize.sm} sm:mr-1`} />
                      <span className="hidden sm:inline">An Kasse senden</span>
                    </>
                  )}
                </Button>
              )}

              {invoice.status === "entwurf" && invoice.billingType === "pflegekasse_privat" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-gray-600 hover:text-gray-800 hover:bg-gray-100"
                  onClick={() => markSentMutation.mutate(invoice.id)}
                  disabled={markSentMutation.isPending}
                  data-testid={`button-mark-sent-${invoice.id}`}
                  title="Manuell als versendet markieren (z.B. nach Postversand)"
                >
                  <Check className={`${iconSize.sm} sm:mr-1`} />
                  <span className="hidden sm:inline">Als versendet markieren</span>
                </Button>
              )}

              {invoice.status === "entwurf" && invoice.billingType !== "pflegekasse_gesetzlich" && invoice.billingType !== "pflegekasse_privat" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                  onClick={() => statusMutation.mutate({ id: invoice.id, status: "versendet" })}
                  disabled={statusMutation.isPending}
                  data-testid={`button-status-versendet-${invoice.id}`}
                >
                  <Send className={`${iconSize.sm} sm:mr-1`} />
                  <span className="hidden sm:inline">Versendet</span>
                </Button>
              )}

              {invoice.status === "versendet" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-green-600 hover:text-green-700 hover:bg-green-50"
                  onClick={() => statusMutation.mutate({ id: invoice.id, status: "bezahlt" })}
                  disabled={statusMutation.isPending}
                  data-testid={`button-status-bezahlt-${invoice.id}`}
                >
                  <Check className={`${iconSize.sm} sm:mr-1`} />
                  <span className="hidden sm:inline">Bezahlt</span>
                </Button>
              )}

              {canStorno && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                  onClick={() => onStorno(invoice)}
                  disabled={statusMutation.isPending}
                  data-testid={`button-status-stornieren-${invoice.id}`}
                >
                  <Ban className={`${iconSize.sm} sm:mr-1`} />
                  <span className="hidden sm:inline">Stornieren</span>
                </Button>
              )}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Weitere Aktionen"
                    data-testid={`button-actions-menu-${invoice.id}`}
                  >
                    <MoreHorizontal className={iconSize.sm} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onSelect={() => onToggleDetail(invoice.id)}
                    data-testid={`button-detail-${invoice.id}`}
                  >
                    <Eye className={`${iconSize.sm} mr-2`} />
                    Details
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <a
                      href={`/api/billing/${invoice.id}/pdf`}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid={`button-pdf-${invoice.id}`}
                    >
                      <FileText className={`${iconSize.sm} mr-2`} />
                      PDF herunterladen
                    </a>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <a
                      href={`/api/billing/${invoice.id}/leistungsnachweis`}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid={`button-leistungsnachweis-${invoice.id}`}
                    >
                      <FileCheck2 className={`${iconSize.sm} mr-2`} />
                      Leistungsnachweis
                    </a>
                  </DropdownMenuItem>
                  {/* Task #533: Bündel-Druck — Rechnung + Leistungsnachweis als ein PDF. */}
                  <DropdownMenuItem asChild>
                    <a
                      href={`/api/billing/${invoice.id}/bundle`}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid={`button-bundle-${invoice.id}`}
                    >
                      <Printer className={`${iconSize.sm} mr-2`} />
                      Drucken (Rechnung + Nachweis)
                    </a>
                  </DropdownMenuItem>
                  {/* Task #533: „Als versendet markieren" für gesetzliche
                      Pflegekassen-Entwürfe ist dort eine Sekundär-Aktion
                      (Primär = „An Kasse senden") und lebt daher im Menü. */}
                  {invoice.status === "entwurf" && invoice.billingType === "pflegekasse_gesetzlich" && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() => markSentMutation.mutate(invoice.id)}
                        disabled={markSentMutation.isPending}
                        data-testid={`button-mark-sent-${invoice.id}`}
                      >
                        <Check className={`${iconSize.sm} mr-2`} />
                        Als versendet markieren
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </CardContent>
      </Card>

      {isExpanded && (
        <InvoiceDetail
          invoice={invoice}
          expandedDetail={expandedDetail}
          detailLoading={detailLoading}
          deliveryHistory={deliveryHistory}
        />
      )}
    </div>
  );
}
