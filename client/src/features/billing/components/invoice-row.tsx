import { useState } from "react";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { api } from "@/lib/api/client";
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
  MailCheck,
  Banknote,
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
  // Task #1317: „Bezahlt" ist eine bewusste, bestätigungspflichtige Aktion —
  // der Row meldet nur den Wunsch, die Bestätigung läuft im MarkPaidDialog.
  onMarkPaid: (invoice: InvoiceItem) => void;
  // Task #1376: Mehrfachauswahl für Sammelaktionen.
  selected: boolean;
  onToggleSelect: (invoiceId: number, checked: boolean) => void;
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
  onMarkPaid,
  selected,
  onToggleSelect,
}: InvoiceRowProps) {
  const { toast } = useToast();
  // Task #1349: Öffnet ein Dokument-PDF (Rechnung / Leistungsnachweis / Bündel)
  // robust statt über einen rohen `<a target="_blank">`-Link. Bei einem
  // vorübergehend nicht erreichbaren Speicher (503) oder einem anderen Fehler
  // wird KEINE rohe Fehlerseite im neuen Tab geöffnet, sondern eine klare
  // Meldung mit „Erneut versuchen"-Aktion angezeigt. Der Tab wird synchron im
  // Klick-Gesten-Kontext geöffnet (Popup-Blocker-sicher) und erst gefüllt, wenn
  // die Bytes da sind — bei Fehler wieder geschlossen.
  const [openingPath, setOpeningPath] = useState<string | null>(null);

  async function openDocument(path: string, label: string) {
    if (openingPath) return;
    setOpeningPath(path);
    const win = window.open("about:blank", "_blank");
    if (win) win.opener = null;
    try {
      const result = await api.getBlob(path);
      if (!result.success) {
        if (win && !win.closed) win.close();
        const isStorageUnavailable =
          result.error.code === "STORAGE_UNAVAILABLE" || result.error.status === 503;
        toast({
          title: isStorageUnavailable
            ? "Speicher vorübergehend nicht erreichbar"
            : `${label} konnte nicht geöffnet werden`,
          description: isStorageUnavailable
            ? "Bitte in wenigen Minuten erneut versuchen — das PDF ist sicher gespeichert."
            : result.error.message,
          variant: "destructive",
          action: (
            <ToastAction altText="Erneut versuchen" onClick={() => openDocument(path, label)}>
              Erneut versuchen
            </ToastAction>
          ),
        });
        return;
      }
      const url = URL.createObjectURL(result.data.blob);
      if (win && !win.closed) {
        win.location.href = url;
      } else {
        // Popup wurde geblockt: als Datei-Download nachreichen.
        const a = document.createElement("a");
        a.href = url;
        a.download = result.data.fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      // Blob-URL erst nach dem Laden im neuen Tab freigeben.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } finally {
      setOpeningPath(null);
    }
  }

  const pdfStatus = getPdfStatus(invoice);
  const customerDisplay = getInvoiceCustomerDisplayName(invoice);
  const showSeparateRecipient =
    customerDisplay && customerDisplay.trim() !== invoice.recipientName.trim();
  const canStorno =
    invoice.status !== "storniert" && invoice.invoiceType !== "stornorechnung";

  // Task #1007: Betrag wird am Handy in der Kopfzeile (neben der Nummer) und auf
  // größeren Screens in der eigenen Spalte angezeigt — dieselbe Darstellung,
  // zwei Positionen. Eine Hilfsfunktion vermeidet Logik-Duplikate.
  const amountNode = (
    <span className={`font-medium tabular-nums ${invoice.grossAmountCents < 0 ? "text-red-600" : "text-gray-900"}`}>
      {formatAmount(invoice.grossAmountCents)}
      {invoice.billingType === "selbstzahler" && (
        <span className="text-xs text-gray-400 font-normal ml-1 hidden sm:inline">inkl. MwSt.</span>
      )}
    </span>
  );

  return (
    <div>
      <Card data-testid={`invoice-row-${invoice.id}`}>
        <CardContent className="py-2 px-3">
          {/* Task #1007: Am Handy gestapeltes Layout (Kopf / Kunde / Aktionen
              je eigene Zeile), ab sm wieder kompakt in einer Reihe. */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            {/* Kopf: Nummer + Typ/Status-Badges, am Handy zusätzlich der Betrag rechts */}
            <div className="flex items-center gap-2 sm:shrink-0">
              {/* Task #1376: Auswahl-Checkbox für Sammelaktionen. */}
              <Checkbox
                checked={selected}
                onCheckedChange={(checked) => onToggleSelect(invoice.id, checked === true)}
                aria-label={`Rechnung ${invoice.invoiceNumber} auswählen`}
                data-testid={`checkbox-select-${invoice.id}`}
              />
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
              {/* Betrag am Handy: rechts in der Kopfzeile */}
              <span className="ml-auto text-sm sm:hidden" data-testid={`text-amount-mobile-${invoice.id}`}>
                {amountNode}
              </span>
            </div>

            {/* Kunde / Empfänger — am Handy eigene, gut sichtbare Zeile */}
            {(customerDisplay || showSeparateRecipient) && (
              <div className="min-w-0 sm:flex-1 flex items-center gap-2 text-sm">
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
            )}

            {/* Betrag + Versanddatum — ab sm in eigener Spalte */}
            <div className="hidden sm:flex items-center gap-2 sm:shrink-0 text-sm">
              {invoice.sentAt && (invoice.status === "versendet" || invoice.status === "bezahlt") && (
                <span className="text-xs text-blue-700 hidden lg:inline" data-testid={`text-sentat-${invoice.id}`}>
                  Versendet {formatSentAt(invoice.sentAt)}
                </span>
              )}
              {amountNode}
            </div>

            {/* Aktionen: am Handy eigene Zeile mit Beschriftungen, ab sm kompakt */}
            <div className="flex flex-wrap items-center justify-end gap-1 sm:flex-nowrap sm:shrink-0">
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
                      <span>Sende...</span>
                    </>
                  ) : (
                    <>
                      <Send className={`${iconSize.sm} mr-1`} />
                      <span>An Kasse senden</span>
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
                  <Check className={`${iconSize.sm} mr-1`} />
                  <span>Als versendet markieren</span>
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
                  <Send className={`${iconSize.sm} mr-1`} />
                  <span>Versendet</span>
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
                  <Ban className={`${iconSize.sm} mr-1`} />
                  <span>Stornieren</span>
                </Button>
              )}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Weitere Aktionen"
                    className="border border-gray-200 text-gray-700 sm:border-0"
                    data-testid={`button-actions-menu-${invoice.id}`}
                  >
                    <MoreHorizontal className={iconSize.sm} />
                    <span className="ml-1 sm:hidden">Mehr</span>
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
                  <DropdownMenuItem
                    onSelect={() => openDocument(`/billing/${invoice.id}/pdf`, "Rechnungs-PDF")}
                    disabled={openingPath !== null}
                    data-testid={`button-pdf-${invoice.id}`}
                  >
                    <FileText className={`${iconSize.sm} mr-2`} />
                    PDF herunterladen
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => openDocument(`/billing/${invoice.id}/leistungsnachweis`, "Leistungsnachweis")}
                    disabled={openingPath !== null}
                    data-testid={`button-leistungsnachweis-${invoice.id}`}
                  >
                    <FileCheck2 className={`${iconSize.sm} mr-2`} />
                    Leistungsnachweis
                  </DropdownMenuItem>
                  {/* Task #533: Bündel-Druck — Rechnung + Leistungsnachweis als ein PDF. */}
                  <DropdownMenuItem
                    onSelect={() => openDocument(`/billing/${invoice.id}/bundle`, "Druck-Bündel")}
                    disabled={openingPath !== null}
                    data-testid={`button-bundle-${invoice.id}`}
                  >
                    <Printer className={`${iconSize.sm} mr-2`} />
                    Drucken (Rechnung + Nachweis)
                  </DropdownMenuItem>
                  {/* Task #1317: Zahlungs-Lebenszyklus — „Avis erhalten" und
                      „Bezahlt" sind bewusste Aktionen ab Status „versendet".
                      „Avis erhalten" (Zahlungsavis der Kasse) ist ein
                      Zwischenschritt ohne Bestätigung; „Als bezahlt markieren"
                      ist endgültig und läuft über den Bestätigungsdialog. So
                      kann „versendet" nie still zu „bezahlt" werden. */}
                  {(invoice.status === "versendet" || invoice.status === "avis_erhalten") && (
                    <>
                      <DropdownMenuSeparator />
                      {invoice.status === "versendet" && (
                        <DropdownMenuItem
                          onSelect={() => statusMutation.mutate({ id: invoice.id, status: "avis_erhalten" })}
                          disabled={statusMutation.isPending}
                          data-testid={`button-status-avis-${invoice.id}`}
                        >
                          <MailCheck className={`${iconSize.sm} mr-2`} />
                          Avis erhalten
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        onSelect={() => onMarkPaid(invoice)}
                        disabled={statusMutation.isPending}
                        className="text-green-700 focus:text-green-700"
                        data-testid={`button-status-bezahlt-${invoice.id}`}
                      >
                        <Banknote className={`${iconSize.sm} mr-2`} />
                        Als bezahlt markieren
                      </DropdownMenuItem>
                    </>
                  )}
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
