import { useState } from "react";
import { Link } from "wouter";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api";
import { iconSize, componentStyles } from "@/design-system";
import type {
  BillingCustomerItem,
  InvoiceItem,
  InvoiceDetail,
  DeliveryRecord,
  GenerateInvoiceResponse as GenerateResponse,
  SendInvoiceResponse as SendResponse,
  BatchSendInvoiceResponse as BatchSendResponse,
} from "@shared/api";
import {
  ArrowLeft,
  Plus,
  Eye,
  Send,
  Check,
  Ban,
  Loader2,
  FileText,
  FileCheck2,
  Receipt,
  Mail,
  Clock,
  MapPin,
} from "lucide-react";

const MONTH_NAMES = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

const STATUS_LABELS: Record<string, string> = {
  entwurf: "Entwurf",
  versendet: "Versendet",
  bezahlt: "Bezahlt",
  storniert: "Storniert",
};

const STATUS_COLORS: Record<string, string> = {
  entwurf: "bg-amber-50 text-amber-700 border-amber-200",
  versendet: "bg-blue-50 text-blue-700 border-blue-200",
  bezahlt: "bg-green-50 text-green-700 border-green-200",
  storniert: "bg-red-50 text-red-700 border-red-200",
};

const TYPE_LABELS: Record<string, string> = {
  rechnung: "Rechnung",
  stornorechnung: "Stornorechnung",
  nachberechnung: "Nachberechnung",
};

const TYPE_COLORS: Record<string, string> = {
  rechnung: "bg-teal-50 text-teal-700 border-teal-200",
  stornorechnung: "bg-red-50 text-red-700 border-red-200",
  nachberechnung: "bg-amber-50 text-amber-700 border-amber-200",
};

function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",") + " €";
}

function formatDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-");
  return `${d}.${m}.${y}`;
}

function getCustomerName(c: BillingCustomerItem): string {
  return c.vorname && c.nachname ? `${c.vorname} ${c.nachname}` : c.name;
}

export default function AdminBilling() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const today = new Date();
  const [selectedMonth, setSelectedMonth] = useState(today.getMonth() + 1);
  const [selectedYear, setSelectedYear] = useState(today.getFullYear());
  const [statusFilter, setStatusFilter] = useState("alle");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>("");
  const [expandedInvoiceId, setExpandedInvoiceId] = useState<number | null>(null);
  const [stornoTarget, setStornoTarget] = useState<InvoiceItem | null>(null);
  const [sendingInvoiceId, setSendingInvoiceId] = useState<number | null>(null);
  const [batchSending, setBatchSending] = useState(false);

  const currentYear = today.getFullYear();
  const years = Array.from({ length: 5 }, (_, i) => currentYear - 2 + i);

  const { data: invoices, isLoading: invoicesLoading } = useQuery({
    queryKey: ["billing-invoices", selectedYear, selectedMonth, statusFilter],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      params.set("year", selectedYear.toString());
      params.set("month", selectedMonth.toString());
      if (statusFilter !== "alle") params.set("status", statusFilter);
      const result = await api.get<InvoiceItem[]>(`/billing?${params.toString()}`, signal);
      return unwrapResult(result);
    },
  });

  const { data: customers } = useQuery({
    queryKey: ["billing-eligible-customers", selectedYear, selectedMonth],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      params.set("month", selectedMonth.toString());
      params.set("year", selectedYear.toString());
      const result = await api.get<BillingCustomerItem[]>(`/billing/eligible-customers?${params.toString()}`, signal);
      return unwrapResult(result);
    },
  });

  const { data: expandedDetail, isLoading: detailLoading } = useQuery({
    queryKey: ["billing-invoice-detail", expandedInvoiceId],
    queryFn: async ({ signal }) => {
      if (!expandedInvoiceId) return null;
      const result = await api.get<InvoiceDetail>(`/billing/${expandedInvoiceId}`, signal);
      return unwrapResult(result);
    },
    enabled: !!expandedInvoiceId,
  });

  const { data: deliveryHistory } = useQuery({
    queryKey: ["billing-delivery-history", expandedInvoiceId],
    queryFn: async ({ signal }) => {
      if (!expandedInvoiceId) return [];
      const result = await api.get<DeliveryRecord[]>(`/billing/deliveries/${expandedInvoiceId}`, signal);
      return unwrapResult(result);
    },
    enabled: !!expandedInvoiceId,
  });

  const generateMutation = useMutation({
    mutationFn: async (data: { customerId: number; billingMonth: number; billingYear: number }) => {
      const result = await api.post<GenerateResponse>("/billing/generate", data);
      return unwrapResult(result);
    },
    onSuccess: (data: GenerateResponse) => {
      if (data?.splitInvoices) {
        toast({ title: `${data.invoices?.length || 0} Rechnungen erstellt`, description: data.message });
      } else {
        toast({ title: "Rechnung erstellt" });
      }
      queryClient.invalidateQueries({ queryKey: ["billing-invoices"] });
      setDialogOpen(false);
      setSelectedCustomerId("");
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const statusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: string }) => {
      const result = await api.patch(`/billing/${id}/status`, { status });
      return unwrapResult(result);
    },
    onSuccess: () => {
      toast({ title: "Status aktualisiert" });
      queryClient.invalidateQueries({ queryKey: ["billing-invoices"] });
      queryClient.invalidateQueries({ queryKey: ["billing-invoice-detail"] });
      setStornoTarget(null);
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const sendInvoiceMutation = useMutation({
    mutationFn: async (invoiceId: number) => {
      setSendingInvoiceId(invoiceId);
      const result = await api.post<SendResponse>(`/billing/${invoiceId}/send`, {});
      return unwrapResult(result);
    },
    onSuccess: (data: SendResponse) => {
      toast({ title: "Rechnung versendet", description: data.message || "E-Mail wurde erfolgreich gesendet" });
      queryClient.invalidateQueries({ queryKey: ["billing-invoices"] });
      queryClient.invalidateQueries({ queryKey: ["billing-delivery-history"] });
      setSendingInvoiceId(null);
    },
    onError: (error: Error) => {
      toast({ title: "Versand fehlgeschlagen", description: error.message, variant: "destructive" });
      setSendingInvoiceId(null);
    },
  });

  const batchSendMutation = useMutation({
    mutationFn: async (invoiceIds: number[]) => {
      setBatchSending(true);
      const result = await api.post<BatchSendResponse>("/billing/send-batch", { invoiceIds });
      return unwrapResult(result);
    },
    onSuccess: (data: BatchSendResponse) => {
      const { summary } = data;
      toast({
        title: `Stapelversand abgeschlossen`,
        description: `${summary.sent} versendet, ${summary.errors} Fehler, ${summary.skipped} übersprungen`,
      });
      queryClient.invalidateQueries({ queryKey: ["billing-invoices"] });
      queryClient.invalidateQueries({ queryKey: ["billing-delivery-history"] });
      setBatchSending(false);
    },
    onError: (error: Error) => {
      toast({ title: "Stapelversand fehlgeschlagen", description: error.message, variant: "destructive" });
      setBatchSending(false);
    },
  });

  const draftPflegekasseInvoices = invoices?.filter(
    (inv) => inv.status === "entwurf" && inv.billingType === "pflegekasse_gesetzlich"
  ) || [];

  const handleBatchSend = () => {
    if (draftPflegekasseInvoices.length === 0) {
      toast({ title: "Keine Rechnungen zum Versenden", description: "Es gibt keine Entwurfs-Rechnungen an Pflegekassen.", variant: "destructive" });
      return;
    }
    batchSendMutation.mutate(draftPflegekasseInvoices.map((inv) => inv.id));
  };

  const handleGenerate = () => {
    if (!selectedCustomerId) {
      toast({ title: "Bitte Kunden auswählen", variant: "destructive" });
      return;
    }
    generateMutation.mutate({
      customerId: parseInt(selectedCustomerId),
      billingMonth: selectedMonth,
      billingYear: selectedYear,
    });
  };

  const handleToggleDetail = (invoiceId: number) => {
    setExpandedInvoiceId(expandedInvoiceId === invoiceId ? null : invoiceId);
  };

  return (
    <Layout variant="wide">
          <div className="flex items-center gap-4 mb-6">
            <Link href="/admin">
              <Button variant="ghost" size="icon" aria-label="Zurück" data-testid="button-back">
                <ArrowLeft className={iconSize.md} />
              </Button>
            </Link>
            <div>
              <h1 className={componentStyles.pageTitle}>Abrechnung</h1>
              <p className="text-gray-600">Rechnungen erstellen und verwalten</p>
            </div>
          </div>

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
                </div>

                <div className="flex justify-end gap-2">
                  {draftPflegekasseInvoices.length > 0 && (
                    <Button
                      variant="outline"
                      className="text-blue-600 border-blue-200 hover:bg-blue-50"
                      onClick={handleBatchSend}
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
                          Alle an Pflegekassen senden ({draftPflegekasseInvoices.length})
                        </>
                      )}
                    </Button>
                  )}
                  <Button
                    onClick={() => setDialogOpen(true)}
                    className="bg-teal-600 hover:bg-teal-700 text-white"
                    data-testid="button-new-invoice"
                  >
                    <Plus className={`${iconSize.sm} mr-1`} />
                    Neue Rechnung
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {invoicesLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className={`${iconSize.xl} animate-spin text-teal-600`} />
            </div>
          ) : invoices && invoices.length > 0 ? (
            <div className="flex flex-col gap-3">
              {invoices.map((invoice) => (
                <div key={invoice.id}>
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
                          </div>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-500">
                            <span>{invoice.recipientName}</span>
                            <span className={`font-medium ${invoice.grossAmountCents < 0 ? "text-red-600" : "text-gray-900"}`}>
                              {formatAmount(invoice.grossAmountCents)}
                              {invoice.billingType === "selbstzahler" && (
                                <span className="text-xs text-gray-400 font-normal ml-1">inkl. MwSt.</span>
                              )}
                            </span>
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
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleToggleDetail(invoice.id)}
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
                              onClick={() => setStornoTarget(invoice)}
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

                  {expandedInvoiceId === invoice.id && (
                    <Card className="mt-1 border-l-4 border-l-teal-500">
                      <CardContent className="py-4">
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
                                  const displayTotal = expandedDetail.billingType === "selbstzahler"
                                    ? Math.round(item.totalCents * 1.19)
                                    : item.totalCents;
                                  return (
                                  <tr key={item.id} className="border-b last:border-0">
                                    <td className="py-2 pr-3">{formatDate(item.appointmentDate)}</td>
                                    <td className="py-2 pr-3">
                                      {item.startTime && item.endTime
                                        ? `${item.startTime.slice(0, 5)} - ${item.endTime.slice(0, 5)}`
                                        : "-"}
                                    </td>
                                    <td className="py-2 pr-3">{item.serviceDescription}</td>
                                    <td className="py-2 pr-3 text-right">{item.durationMinutes} Min.</td>
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
                  )}
                </div>
              ))}
            </div>
          ) : (
            <Card>
              <CardContent className="p-12 text-center">
                <Receipt className={`${iconSize["2xl"]} mx-auto mb-4 text-gray-300`} />
                <p className="text-gray-500">Keine Rechnungen für diesen Zeitraum</p>
              </CardContent>
            </Card>
          )}

      <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) { setSelectedCustomerId(""); } }}>
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
                    {customers?.map((c) => (
                      <SelectItem key={c.id} value={c.id.toString()}>
                        {getCustomerName(c)}{c.status === "inaktiv" ? " (inaktiv)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

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
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Abbrechen
            </Button>
            <Button
              onClick={handleGenerate}
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

      <AlertDialog open={!!stornoTarget} onOpenChange={(open) => !open && setStornoTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rechnung stornieren?</AlertDialogTitle>
            <AlertDialogDescription>
              Die Rechnung <span className="font-medium">{stornoTarget?.invoiceNumber}</span> wird
              storniert und eine Stornorechnung wird automatisch erstellt. Dieser Vorgang kann nicht
              rückgängig gemacht werden.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => {
                if (stornoTarget) {
                  statusMutation.mutate({ id: stornoTarget.id, status: "storniert" });
                }
              }}
              disabled={statusMutation.isPending}
              data-testid="button-confirm-storno"
            >
              {statusMutation.isPending ? (
                <>
                  <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                  Wird storniert...
                </>
              ) : (
                <>
                  <Ban className={`${iconSize.sm} mr-1`} />
                  Stornieren
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Layout>
  );
}
