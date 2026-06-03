import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  return (
    <div>
      <Card data-testid={`invoice-row-${invoice.id}`}>
        <CardContent className="py-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <span className="font-medium text-gray-900">{invoice.invoiceNumber}</span>
                <Badge variant="outline" className={TYPE_COLORS[invoice.invoiceType] || "bg-gray-100 text-gray-600 border-gray-200"}>
                  {TYPE_LABELS[invoice.invoiceType] || invoice.invoiceType}
                </Badge>
                <Badge variant="outline" className={STATUS_COLORS[invoice.status] || "bg-gray-100 text-gray-600 border-gray-200"}>
                  {STATUS_LABELS[invoice.status] || invoice.status}
                </Badge>
                {invoice.billingRunId && (
                  <Badge
                    variant="outline"
                    className="bg-violet-50 text-violet-700 border-violet-200"
                    title={`Teil eines Topf-Splits (Lauf-ID ${invoice.billingRunId.slice(0, 8)}…). Cascade-Storno betrifft alle Geschwister-Rechnungen.`}
                    data-testid={`badge-topf-gruppe-${invoice.id}`}
                  >
                    Topf-Gruppe
                  </Badge>
                )}
                {/* Task #546: PDF-Persistierungs-Status sichtbar
                    machen — wenn der Hintergrund-Render hängt
                    oder gescheitert ist, sehen Admins das hier
                    statt es erst beim Drucken zu bemerken. */}
                {(() => {
                  const pdfStatus = getPdfStatus(invoice);
                  if (pdfStatus === "ok") return null;
                  if (pdfStatus === "pending") {
                    return (
                      <Badge
                        variant="outline"
                        className="bg-amber-50 text-amber-700 border-amber-200"
                        title="Das PDF wird gerade im Hintergrund erstellt."
                        data-testid={`badge-pdf-pending-${invoice.id}`}
                      >
                        PDF ausstehend
                      </Badge>
                    );
                  }
                  return (
                    <Badge
                      variant="outline"
                      className="bg-red-50 text-red-700 border-red-200"
                      title="Das PDF konnte nicht im Hintergrund erstellt werden. Beim nächsten Druck-/Versand-Klick wird ein erneuter Versuch unternommen."
                      data-testid={`badge-pdf-error-${invoice.id}`}
                    >
                      PDF-Fehler
                    </Badge>
                  );
                })()}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-500">
                {/* Task #533: Kunde sichtbar — Vor- und Nachname
                    immer anzeigen; bei Selbstzahler ist
                    recipientName == Kundenname, dort entsteht
                    keine Dopplung (zweite Zeile entfällt). */}
                {(() => {
                  const customerDisplay = getInvoiceCustomerDisplayName(invoice);
                  const showSeparate = customerDisplay && customerDisplay.trim() !== invoice.recipientName.trim();
                  return (
                    <>
                      {customerDisplay && (
                        <Link
                          href={`/admin/customers/${invoice.customerId}`}
                          className="text-gray-900 font-medium hover:underline"
                          data-testid={`link-customer-${invoice.id}`}
                        >
                          {customerDisplay}
                        </Link>
                      )}
                      {showSeparate && (
                        <span data-testid={`text-recipient-${invoice.id}`}>
                          <span className="text-gray-400">Empfänger:</span> {invoice.recipientName}
                        </span>
                      )}
                    </>
                  );
                })()}
                <span className={`font-medium ${invoice.grossAmountCents < 0 ? "text-red-600" : "text-gray-900"}`}>
                  {formatAmount(invoice.grossAmountCents)}
                  {invoice.billingType === "selbstzahler" && (
                    <span className="text-xs text-gray-400 font-normal ml-1">inkl. MwSt.</span>
                  )}
                </span>
                {/* Task #533: Versand-Datum auch im Listenview —
                    für alle Rechnungstypen (Pflegekasse,
                    Selbstzahler, Privat). */}
                {invoice.sentAt && (invoice.status === "versendet" || invoice.status === "bezahlt") && (
                  <span className="text-xs text-blue-700" data-testid={`text-sentat-${invoice.id}`}>
                    Versendet am {formatSentAt(invoice.sentAt)}
                  </span>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1">
              <a
                href={`/api/billing/${invoice.id}/pdf`}
                target="_blank"
                rel="noopener noreferrer"
                data-testid={`button-pdf-${invoice.id}`}
              >
                <Button variant="ghost" size="icon" aria-label="PDF herunterladen">
                  <FileText className={iconSize.sm} />
                </Button>
              </a>
              <a
                href={`/api/billing/${invoice.id}/leistungsnachweis`}
                target="_blank"
                rel="noopener noreferrer"
                data-testid={`button-leistungsnachweis-${invoice.id}`}
              >
                <Button variant="ghost" size="icon" aria-label="Leistungsnachweis herunterladen">
                  <FileCheck2 className={iconSize.sm} />
                </Button>
              </a>
              {/* Task #533: Bündel-Druck — Rechnung +
                  Leistungsnachweis als ein zusammengeführtes PDF. */}
              <a
                href={`/api/billing/${invoice.id}/bundle`}
                target="_blank"
                rel="noopener noreferrer"
                data-testid={`button-bundle-${invoice.id}`}
              >
                <Button variant="ghost" size="icon" aria-label="Drucken (Rechnung + Leistungsnachweis)" title="Drucken (Rechnung + Leistungsnachweis)">
                  <Printer className={iconSize.sm} />
                </Button>
              </a>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onToggleDetail(invoice.id)}
                aria-label="Details anzeigen"
                data-testid={`button-detail-${invoice.id}`}
              >
                <Eye className={iconSize.sm} />
              </Button>

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
                      Sende...
                    </>
                  ) : (
                    <>
                      <Send className={`${iconSize.sm} mr-1`} />
                      An Kasse senden
                    </>
                  )}
                </Button>
              )}

              {/* Task #533: Manuelles „Als versendet markieren"
                  für Pflegekassen-Entwürfe — solange der TI-
                  Anschluss fehlt, kann der Admin den Versand
                  außerhalb des Systems durchführen und den
                  Status nachziehen. Audit-Log dokumentiert
                  den manuellen Pfad. */}
              {invoice.status === "entwurf" && (invoice.billingType === "pflegekasse_gesetzlich" || invoice.billingType === "pflegekasse_privat") && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-gray-600 hover:text-gray-800 hover:bg-gray-100"
                  onClick={() => markSentMutation.mutate(invoice.id)}
                  disabled={markSentMutation.isPending}
                  data-testid={`button-mark-sent-${invoice.id}`}
                  title="Manuell als versendet markieren (z.B. nach Postversand)"
                >
                  <Check className={`${iconSize.sm} mr-1`} />
                  Als versendet markieren
                </Button>
              )}

              {invoice.status === "entwurf" && invoice.billingType !== "pflegekasse_gesetzlich" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                  onClick={() => statusMutation.mutate({ id: invoice.id, status: "versendet" })}
                  disabled={statusMutation.isPending}
                  data-testid={`button-status-versendet-${invoice.id}`}
                >
                  <Send className={`${iconSize.sm} mr-1`} />
                  Versendet
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
                  <Check className={`${iconSize.sm} mr-1`} />
                  Bezahlt
                </Button>
              )}

              {invoice.status !== "storniert" && invoice.invoiceType !== "stornorechnung" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                  onClick={() => onStorno(invoice)}
                  disabled={statusMutation.isPending}
                  data-testid={`button-status-stornieren-${invoice.id}`}
                >
                  <Ban className={`${iconSize.sm} mr-1`} />
                  Stornieren
                </Button>
              )}
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
