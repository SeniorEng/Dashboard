import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { displayPriceCents } from "@shared/domain/customers";
import { renderLineItemQuantity } from "@shared/domain/invoice-line-items";
import { iconSize } from "@/design-system";
import { Loader2, AlertTriangle, Clock, Mail, MapPin } from "lucide-react";
import type { InvoiceItem, InvoiceDetail as InvoiceDetailType, DeliveryRecord } from "@shared/api";
import { formatAmount, formatDate } from "../utils";

interface InvoiceDetailProps {
  invoice: InvoiceItem;
  expandedDetail: InvoiceDetailType | null | undefined;
  detailLoading: boolean;
  deliveryHistory: DeliveryRecord[] | undefined;
}

export function InvoiceDetail({ invoice, expandedDetail, detailLoading, deliveryHistory }: InvoiceDetailProps) {
  return (
    <Card className="mt-1 border-l-4 border-l-teal-500">
      <CardContent className="py-4">
        {(expandedDetail?.pdfDrift || expandedDetail?.leistungsnachweisDrift) && (
          <div
            className="mb-4 flex items-start gap-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
            data-testid={`pdf-drift-warning-${invoice.id}`}
          >
            <AlertTriangle className={`${iconSize.sm} mt-0.5 flex-shrink-0 text-amber-600`} />
            <div>
              <div className="font-medium">PDF entspricht nicht mehr den aktuellen Daten</div>
              <div className="text-amber-800">
                {expandedDetail.pdfDrift && expandedDetail.leistungsnachweisDrift
                  ? "Rechnung und Leistungsnachweis wurden nach der PDF-Erstellung geändert."
                  : expandedDetail.pdfDrift
                  ? "Die Rechnungsdaten wurden nach der PDF-Erstellung geändert."
                  : "Die Leistungsnachweis-Daten (z.B. Unterschriften) wurden nach der PDF-Erstellung geändert."}
                {" "}Für eine korrigierte Fassung bitte Storno + Neuerstellung durchführen.
              </div>
            </div>
          </div>
        )}
        {detailLoading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className={`${iconSize.md} animate-spin text-teal-600`} />
          </div>
        ) : expandedDetail?.lineItems && expandedDetail.lineItems.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-gray-500">
                  <th className="pb-2 pr-3">Datum</th>
                  <th className="pb-2 pr-3">Uhrzeit</th>
                  <th className="pb-2 pr-3">Leistung</th>
                  <th className="pb-2 pr-3 text-right">Dauer</th>
                  <th className="pb-2 pr-3 text-right">
                    Betrag{expandedDetail.billingType === "selbstzahler" ? " (brutto)" : ""}
                  </th>
                  <th className="pb-2">Mitarbeiter</th>
                </tr>
              </thead>
              <tbody>
                {expandedDetail.lineItems.map((item) => {
                  const displayTotal = displayPriceCents(item.totalCents, expandedDetail.billingType);
                  return (
                  <tr key={item.id} className="border-b last:border-0">
                    <td className="py-2 pr-3">{formatDate(item.appointmentDate)}</td>
                    <td className="py-2 pr-3">
                      {item.startTime && item.endTime
                        ? `${item.startTime.slice(0, 5)} - ${item.endTime.slice(0, 5)}`
                        : "-"}
                    </td>
                    <td className="py-2 pr-3">{item.serviceDescription}</td>
                    <td className="py-2 pr-3 text-right">
                      {renderLineItemQuantity(item)}
                    </td>
                    <td className={`py-2 pr-3 text-right ${displayTotal < 0 ? "text-red-600" : ""}`}>
                      {formatAmount(displayTotal)}
                    </td>
                    <td className="py-2">{item.employeeName || "-"}</td>
                  </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 font-medium">
                  <td colSpan={4} className="pt-2 pr-3 text-right">
                    Gesamt{expandedDetail.billingType === "selbstzahler" ? " (inkl. MwSt.)" : ""}:
                  </td>
                  <td className={`pt-2 pr-3 text-right ${expandedDetail.grossAmountCents < 0 ? "text-red-600" : ""}`}>
                    {formatAmount(expandedDetail.grossAmountCents)}
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        ) : (
          <p className="text-gray-500 text-sm">Keine Positionen vorhanden.</p>
        )}

        {deliveryHistory && deliveryHistory.length > 0 && (
          <div className="mt-4 pt-4 border-t" data-testid={`delivery-history-${invoice.id}`}>
            <h4 className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-1">
              <Clock className={iconSize.sm} />
              Versandhistorie
            </h4>
            <div className="space-y-2">
              {deliveryHistory.map((d) => (
                <div key={d.id} className="flex items-start gap-3 text-sm bg-gray-50 rounded px-3 py-2" data-testid={`delivery-record-${d.id}`}>
                  {d.deliveryMethod === "email" ? (
                    <Mail className={`${iconSize.sm} text-blue-500 mt-0.5 flex-shrink-0`} />
                  ) : (
                    <MapPin className={`${iconSize.sm} text-orange-500 mt-0.5 flex-shrink-0`} />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">
                        {d.recipientName || "Unbekannt"}
                      </span>
                      <Badge variant="outline" className={
                        d.status === "sent" ? "bg-green-50 text-green-700 border-green-200" :
                        d.status === "pending" ? "bg-amber-50 text-amber-700 border-amber-200" :
                        "bg-red-50 text-red-700 border-red-200"
                      }>
                        {d.status === "sent" ? "Gesendet" : d.status === "pending" ? "Ausstehend" : "Fehler"}
                      </Badge>
                      {d.documentFileNames?.includes("Kopie:") && (
                        <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200">Kundenkopie</Badge>
                      )}
                    </div>
                    <div className="text-gray-500 text-xs mt-0.5">
                      {d.recipientEmail && <span>{d.recipientEmail}</span>}
                      {d.recipientAddress && <span>{d.recipientAddress}</span>}
                      {d.sentAt && <span> · {new Date(d.sentAt).toLocaleString("de-DE")}</span>}
                      {!d.sentAt && d.createdAt && <span> · {new Date(d.createdAt).toLocaleString("de-DE")}</span>}
                    </div>
                    {d.letterxpressLetterId && (
                      <div className="text-gray-500 text-xs mt-0.5" data-testid={`text-letterxpress-id-${d.id}`}>
                        Brief-ID: <span className="font-mono">{d.letterxpressLetterId}</span>
                      </div>
                    )}
                    {d.errorMessage && <div className="text-red-600 text-xs mt-1">{d.errorMessage}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
