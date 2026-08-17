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
  Undo2,
  Scissors,
  Link2,
} from "lucide-react";
import type { UseMutationResult } from "@tanstack/react-query";
import type { InvoiceItem, InvoiceDetail as InvoiceDetailType, DeliveryRecord } from "@shared/api";
import { isStorniertInvoice,
  istAktionsfaehigeRechnung, type AgingBucket } from "@shared/domain/billing-pipeline";
import {
  STATUS_LABELS,
  STATUS_COLORS,
  BADGE_COLORS,
  BADGE_LABELS,
  TYPE_LABELS,
  TYPE_COLORS,
  AGING_BADGE,
} from "../constants";
import {
  formatAmount,
  formatSentAt,
  getInvoiceCustomerDisplayName,
  getPdfStatus,
  paymentBadgeLabel,
  paymentBadgeTitle,
} from "../utils";
import { InvoiceDetail } from "./invoice-detail";
import type { InvoiceStatus } from "@shared/schema/billing";

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
  // Task #1785 P4: §45b-Kürzung ist superadmin-only; die Row meldet nur den
  // Wunsch, Eingabe + Bestätigung laufen im Reduce45bDialog.
  isSuperAdmin: boolean;
  onReduce45b: (invoice: InvoiceItem) => void;
  // Task #1376: Mehrfachauswahl für Sammelaktionen.
  // Task #1890: Storno-Belege sind nicht sammel-auswählbar → dann Checkbox aus.
  selectable?: boolean;
  selected: boolean;
  onToggleSelect: (invoiceId: number, checked: boolean) => void;
  // Task #1890: Verknüpfte Rechnung (Original ↔ Stornorechnung) + Sprung dorthin.
  linkedInvoice?: { id: number; invoiceNumber: string; relation: "cancels" | "cancelledBy" };
  onNavigateToInvoice?: (invoiceId: number) => void;
  // #66 — Ruecknahme einer irrtuemlichen Versand-Markierung. Der Aufrufer holt
  // die Pflicht-Begruendung ein; die Zeile oeffnet nur den Weg.
  onRevokeSentMark?: (invoice: InvoiceItem) => void;
  // Task #1412: Aging-Bucket (Ampel) für die wartenden Cluster. `none`/`green`
  // → kein Badge; nur mahnende Stufen werden hervorgehoben.
  aging?: AgingBucket;
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
  isSuperAdmin,
  onReduce45b,
  selectable = true,
  selected,
  onToggleSelect,
  linkedInvoice,
  onNavigateToInvoice,
  onRevokeSentMark,
  aging = "none",
}: InvoiceRowProps) {
  // Task #1785 P4: §45b-Kürzung nur für Superadmins auf einer AUSGESTELLTEN
  // (nicht Entwurf/storniert) originären §45b-Rechnung — nie auf Stornobelegen.
  const canReduce45b =
    isSuperAdmin &&
    invoice.budgetType === "entlastungsbetrag_45b" &&
    invoice.invoiceType !== "stornorechnung" &&
    invoice.status !== "entwurf" &&
    invoice.status !== "storniert";
  const { toast } = useToast();
  // Task #1349/#1696: Lädt ein Dokument-PDF (Rechnung / Leistungsnachweis /
  // Bündel) als echten Datei-Download herunter — mit dem sprechenden Dateinamen
  // aus dem `Content-Disposition`-Header (z. B. `RE-2026-0034 - Mustermann,
  // Erika - Rechnung.pdf`). Ein `blob:`-URL im neuen Tab würde beim Speichern
  // nur die UUID übernehmen (Task #1696), daher der explizite `<a download>`.
  // Bei nicht erreichbarem Speicher (503) oder anderem Fehler wird KEINE rohe
  // Fehlerseite gezeigt, sondern eine klare Meldung mit „Erneut versuchen".
  const [openingPath, setOpeningPath] = useState<string | null>(null);

  async function downloadDocument(path: string, label: string) {
    if (openingPath) return;
    setOpeningPath(path);
    try {
      const result = await api.getBlob(path);
      if (!result.success) {
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
            <ToastAction altText="Erneut versuchen" onClick={() => downloadDocument(path, label)}>
              Erneut versuchen
            </ToastAction>
          ),
        });
        return;
      }
      // Echter Datei-Download mit dem vom Server gelieferten sprechenden Namen.
      const url = URL.createObjectURL(result.data.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.data.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } finally {
      setOpeningPath(null);
    }
  }

  const pdfStatus = getPdfStatus(invoice);
  const customerDisplay = getInvoiceCustomerDisplayName(invoice);
  const showSeparateRecipient =
    customerDisplay && customerDisplay.trim() !== invoice.recipientName.trim();
  // „Stornierbar?" ist die Aktiv-Frage — über die SSoT, nicht handgeschrieben.
  const canStorno = istAktionsfaehigeRechnung({
    status: invoice.status,
    invoiceType: invoice.invoiceType,
  });

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
      <Card id={`invoice-row-${invoice.id}`} data-testid={`invoice-row-${invoice.id}`}>
        <CardContent className="py-2 px-3">
          {/* Task #1007: Am Handy gestapeltes Layout (Kopf / Kunde / Aktionen
              je eigene Zeile), ab sm wieder kompakt in einer Reihe. */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            {/* Kopf: Nummer + Typ/Status-Badges, am Handy zusätzlich der Betrag rechts */}
            <div className="flex items-center gap-2 sm:shrink-0">
              {/* Task #1376: Auswahl-Checkbox für Sammelaktionen.
                  Task #1890: Storno-Belege sind nicht auswählbar → keine Box. */}
              {selectable && (
                <Checkbox
                  checked={selected}
                  onCheckedChange={(checked) => onToggleSelect(invoice.id, checked === true)}
                  aria-label={`Rechnung ${invoice.invoiceNumber} auswählen`}
                  data-testid={`checkbox-select-${invoice.id}`}
                />
              )}
              <span className="font-medium text-gray-900 text-sm">{invoice.invoiceNumber}</span>
              <Badge
                variant="outline"
                className={`hidden sm:inline-flex ${TYPE_COLORS[invoice.invoiceType] || "bg-gray-100 text-gray-600 border-gray-200"}`}
              >
                {TYPE_LABELS[invoice.invoiceType] || invoice.invoiceType}
              </Badge>
              {/* Status — EIN Wert, immer sichtbar. `parseInvoiceStatus` ist
                  hier bewusst NICHT im Einsatz: eine Liste soll nicht wegen
                  einer einzelnen kaputten Zeile weiß bleiben. Ein unbekannter
                  Wert wird angezeigt wie er ist, damit er auffällt. */}
              <Badge
                variant="outline"
                className={STATUS_COLORS[invoice.status as InvoiceStatus] ?? "bg-gray-100 text-gray-600 border-gray-200"}
              >
                {STATUS_LABELS[invoice.status as InvoiceStatus] ?? invoice.status}
              </Badge>
              {/* Badges — KEINE Zustände, sondern Sichten auf Zahlen. Null bis
                  drei Stück, je nach Zahlungsstand, Frist und Versand. Sie
                  stehen NEBEN dem Status, nie an seiner Stelle. */}
              {(invoice.badges ?? []).map((b) => (
                <Badge
                  key={b}
                  variant="outline"
                  className={`hidden sm:inline-flex ${BADGE_COLORS[b]}`}
                  data-testid={`badge-${b}-${invoice.id}`}
                >
                  {BADGE_LABELS[b]}
                </Badge>
              ))}
              {/* Task #1890: Verknüpfung Original ↔ Stornorechnung. Eine
                  Stornorechnung zeigt die stornierte Originalrechnung, ein
                  storniertes Original seine Gutschrift — beide anklickbar
                  (Sprung + Aufklappen der Gegenseite). */}
              {/* #1897 — Absprung in den Qonto-Tab. Deep-Link ueber die
                  RECHNUNG (nicht die Transaktion): der Listen-Endpunkt liefert
                  `hasBoundPayment`, aber keine Transaktions-ID. Die Qonto-Seite
                  loest sie fuer den 1:1-Match selbst auf; siehe FINDING im
                  PR-Body zum Sammel-Avis-Fall. */}
              {invoice.hasBoundPayment && (
                <Link
                  href={`/admin/qonto?invoiceId=${invoice.id}`}
                  className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                  title="Zugeordnete Zahlung in Zahlungen & Qonto ansehen"
                  data-testid={`link-qonto-payment-${invoice.id}`}
                >
                  <Banknote className={iconSize.xs} />
                  Zahlung ansehen
                </Link>
              )}
              {linkedInvoice && (
                <button
                  type="button"
                  onClick={() => onNavigateToInvoice?.(linkedInvoice.id)}
                  className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                  title={
                    linkedInvoice.relation === "cancels"
                      ? `Storniert Rechnung ${linkedInvoice.invoiceNumber}`
                      : `Storniert durch ${linkedInvoice.invoiceNumber}`
                  }
                  data-testid={`link-storno-ref-${invoice.id}`}
                >
                  <Link2 className={iconSize.xs} />
                  {linkedInvoice.relation === "cancels" ? "storniert " : "Storno "}
                  {linkedInvoice.invoiceNumber}
                </button>
              )}
              {/* Task #1822: Offener Rest bei Teilzahlung — die Summe der bereits
                  eingegangenen Zahlungen deckt die Rechnung noch nicht. Der Betrag
                  stammt aus derselben SSoT wie der Statuswechsel
                  (openAmountCents = Brutto − Skonto − gezahlt). */}
              {invoice.status === "teilweise_bezahlt" && invoice.openAmountCents != null && (
                <Badge
                  variant="outline"
                  className="bg-cyan-50 text-cyan-700 border-cyan-200"
                  data-testid={`badge-open-amount-${invoice.id}`}
                >
                  Rest {formatAmount(invoice.openAmountCents)} offen
                </Badge>
              )}
              {/* #1897 — Zahlungsbindung. NEUTRAL gehalten (grau/blau, kein
                  Ampel-Ton): das Geld ist da, es ist keine Mahnstufe, sondern
                  eine offene Pruefung. Der Betrag steht dabei, damit man ohne
                  Absprung sieht, ob die Zahlung passt. Die Mahn-Ampel weiter
                  unten kann hier nicht gleichzeitig feuern — `invoiceAgingBucket`
                  liefert fuer die gebundenen Cluster `none` (#1897, Schritt 5). */}
              {invoice.hasBoundPayment && (
                <Badge
                  variant="outline"
                  className="bg-slate-50 text-slate-700 border-slate-300"
                  title={paymentBadgeTitle(invoice)}
                  data-testid={`badge-payment-bound-${invoice.id}`}
                >
                  {paymentBadgeLabel(invoice, formatAmount)}
                </Badge>
              )}
              {/* Task #1412: Aging-Ampel-Badge — nur mahnende Stufen
                  (gelb/orange/rot) werden sichtbar gemacht. */}
              {aging !== "none" && aging !== "green" && (
                <Badge
                  variant="outline"
                  className={AGING_BADGE[aging].className}
                  data-testid={`badge-aging-${aging}-${invoice.id}`}
                >
                  {AGING_BADGE[aging].label}
                </Badge>
              )}
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

              {/* Task #1403: Privat-Kassen UND Selbstzahler nutzen denselben
                  manuellen „Als versendet markieren"-Pfad — kein Spezial-Pfad
                  mehr für Selbstzahler. Nur gesetzliche Kassen haben oben
                  „An Kasse senden" als Primär-Aktion (Mark-Sent dort sekundär
                  im Menü). */}
              {invoice.status === "entwurf" && invoice.billingType !== "pflegekasse_gesetzlich" && (
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
                    onSelect={() => downloadDocument(`/billing/${invoice.id}/pdf`, "Rechnungs-PDF")}
                    disabled={openingPath !== null}
                    data-testid={`button-pdf-${invoice.id}`}
                  >
                    <FileText className={`${iconSize.sm} mr-2`} />
                    PDF herunterladen
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => downloadDocument(`/billing/${invoice.id}/leistungsnachweis`, "Leistungsnachweis")}
                    disabled={openingPath !== null}
                    data-testid={`button-leistungsnachweis-${invoice.id}`}
                  >
                    <FileCheck2 className={`${iconSize.sm} mr-2`} />
                    Leistungsnachweis
                  </DropdownMenuItem>
                  {/* Task #533: Bündel-Druck — Rechnung + Leistungsnachweis als ein PDF. */}
                  <DropdownMenuItem
                    onSelect={() => downloadDocument(`/billing/${invoice.id}/bundle`, "Druck-Bündel")}
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
                      {/* #66 — ERSETZT „Auf Entwurf zurücksetzen". Der generische Rückweg
                          `versendet → entwurf` ist entfernt: er leerte `sentAt`,
                          wodurch die Rechnung wieder als Entwurf löschbar wurde
                          und ihre Belegnummer neu vergeben werden konnte.

                          Übrig bleibt genau ein Fall — versehentlich markiert,
                          nichts versandt. Der verlangt eine Begründung und wird
                          protokolliert. Alles andere läuft über Storno +
                          Neuausstellung. */}
                      {invoice.status === "versendet" && invoice.issuedAt && (
                        <DropdownMenuItem
                          onSelect={() => onRevokeSentMark?.(invoice)}
                          data-testid={`button-revoke-sent-mark-${invoice.id}`}
                        >
                          <Undo2 className={`${iconSize.sm} mr-2`} />
                          Markierung zurücknehmen (Fehlmarkierung)
                        </DropdownMenuItem>
                      )}
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
                  {/* Task #1785 P4: §45b-Kürzung (Superadmin) — storniert + kürzt
                      die ausgestellte §45b-Rechnung auf den gezahlten Betrag und
                      bucht den Überhang um. Eingabe/Bestätigung im Dialog. */}
                  {canReduce45b && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() => onReduce45b(invoice)}
                        className="text-amber-700 focus:text-amber-700"
                        data-testid={`button-reduce-45b-${invoice.id}`}
                      >
                        <Scissors className={`${iconSize.sm} mr-2`} />
                        §45b kürzen (Kasse zahlte weniger)
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
