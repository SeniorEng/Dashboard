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
import { iconSize } from "@/design-system";
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

interface CustomerListItem {
  id: number;
  name: string;
  vorname: string | null;
  nachname: string | null;
  billingType: string;
}

interface InvoiceItem {
  id: number;
  invoiceNumber: string;
  customerId: number;
  billingType: string;
  invoiceType: string;
  billingMonth: number;
  billingYear: number;
  recipientName: string;
  grossAmountCents: number;
  status: string;
}

interface InvoiceLineItem {
  id: number;
  appointmentDate: string;
  serviceDescription: string;
  startTime: string | null;
  endTime: string | null;
  durationMinutes: number;
  totalCents: number;
  employeeName: string | null;
}

interface InvoiceDetail extends InvoiceItem {
  lineItems: InvoiceLineItem[];
}

function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",") + " €";
}

function formatDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-");
  return `${d}.${m}.${y}`;
}

function getCustomerName(c: CustomerListItem): string {
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
  const [batchResult, setBatchResult] = useState<{ created: number; skipped: { customerName: string; reason: string }[]; errors: { customerName: string; reason: string }[]; message?: string } | null>(null);

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
    queryKey: ["billing-customers"],
    queryFn: async ({ signal }) => {
      const result = await api.get<CustomerListItem[]>("/customers", signal);
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

  const generateMutation = useMutation({
    mutationFn: async (data: { customerId: number; billingMonth: number; billingYear: number }) => {
      const customer = customers?.find((c) => c.id === data.customerId);
      const result = await api.post("/billing/generate", {
        ...data,
        billingType: customer?.billingType || "selbstzahler",
        recipientName: customer ? getCustomerName(customer) : "Unbekannt",
      });
      return unwrapResult(result);
    },
    onSuccess: () => {
      toast({ title: "Rechnung erstellt" });
      queryClient.invalidateQueries({ queryKey: ["billing-invoices"] });
      setDialogOpen(false);
      setSelectedCustomerId("");
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const batchMutation = useMutation({
    mutationFn: async (data: { billingMonth: number; billingYear: number }) => {
      const result = await api.post<{ created: number; skipped: { customerName: string; reason: string }[]; errors: { customerName: string; reason: string }[]; message?: string }>("/billing/generate-batch", data);
      return unwrapResult(result);
    },
    onSuccess: (data) => {
      setBatchResult(data);
      queryClient.invalidateQueries({ queryKey: ["billing-invoices"] });
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

  const handleGenerate = () => {
    if (selectedCustomerId === "alle") {
      batchMutation.mutate({
        billingMonth: selectedMonth,
        billingYear: selectedYear,
      });
      return;
    }
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
    <Layout>
      <div className="min-h-screen bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]" data-testid="page-billing">
        <div className="container mx-auto px-4 py-6 max-w-6xl">
          <div className="flex items-center gap-4 mb-6">
            <Link href="/admin">
              <Button variant="ghost" size="icon" aria-label="Zurück" data-testid="button-back">
                <ArrowLeft className={iconSize.md} />
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Abrechnung</h1>
              <p className="text-gray-600">Rechnungen erstellen und verwalten</p>
            </div>
          </div>

          <Card className="mb-6">
            <CardContent className="p-4">
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-500">Monat:</span>
                  <Select value={selectedMonth.toString()} onValueChange={(v) => setSelectedMonth(parseInt(v))}>
                    <SelectTrigger className="w-[140px]" data-testid="select-billing-month">
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
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-500">Jahr:</span>
                  <Select value={selectedYear.toString()} onValueChange={(v) => setSelectedYear(parseInt(v))}>
                    <SelectTrigger className="w-[100px]" data-testid="select-billing-year">
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
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-500">Status:</span>
                  <Select value={statusFilter} onValueChange={setStatusFilter}>
                    <SelectTrigger className="w-[140px]" data-testid="select-billing-status">
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

                <div className="ml-auto">
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
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
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

                          {invoice.status === "entwurf" && (
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

                          {invoice.status !== "storniert" && (
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
                                  <th className="pb-2 pr-3 text-right">Betrag</th>
                                  <th className="pb-2">Mitarbeiter</th>
                                </tr>
                              </thead>
                              <tbody>
                                {expandedDetail.lineItems.map((item) => (
                                  <tr key={item.id} className="border-b last:border-0">
                                    <td className="py-2 pr-3">{formatDate(item.appointmentDate)}</td>
                                    <td className="py-2 pr-3">
                                      {item.startTime && item.endTime
                                        ? `${item.startTime.slice(0, 5)} - ${item.endTime.slice(0, 5)}`
                                        : "-"}
                                    </td>
                                    <td className="py-2 pr-3">{item.serviceDescription}</td>
                                    <td className="py-2 pr-3 text-right">{item.durationMinutes} Min.</td>
                                    <td className={`py-2 pr-3 text-right ${item.totalCents < 0 ? "text-red-600" : ""}`}>
                                      {formatAmount(item.totalCents)}
                                    </td>
                                    <td className="py-2">{item.employeeName || "-"}</td>
                                  </tr>
                                ))}
                              </tbody>
                              <tfoot>
                                <tr className="border-t-2 font-medium">
                                  <td colSpan={4} className="pt-2 pr-3 text-right">Gesamt:</td>
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
        </div>
      </div>

      <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) { setBatchResult(null); setSelectedCustomerId(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Neue Rechnung erstellen</DialogTitle>
            <DialogDescription>
              Rechnung für {MONTH_NAMES[selectedMonth - 1]} {selectedYear} generieren
            </DialogDescription>
          </DialogHeader>

          {batchResult ? (
            <div className="space-y-4 pt-2">
              <div className="rounded-lg border p-4 space-y-3">
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2 text-green-700">
                    <Check className={iconSize.sm} />
                    <span className="font-medium">{batchResult.created} Rechnung(en) erstellt</span>
                  </div>
                </div>
                {batchResult.skipped.length > 0 && (
                  <div className="space-y-1">
                    <span className="text-sm text-gray-500 font-medium">{batchResult.skipped.length} übersprungen:</span>
                    {batchResult.skipped.map((s, i) => (
                      <div key={i} className="text-sm text-gray-500 pl-2">
                        {s.customerName} – {s.reason}
                      </div>
                    ))}
                  </div>
                )}
                {batchResult.created === 0 && batchResult.skipped.length === 0 && batchResult.message && (
                  <div className="text-sm text-amber-600">{batchResult.message}</div>
                )}
                {batchResult.errors.length > 0 && (
                  <div className="space-y-1">
                    <span className="text-sm font-medium text-red-600">Fehler:</span>
                    {batchResult.errors.map((err, i) => (
                      <div key={i} className="text-sm text-red-600 pl-2">
                        {err.customerName}: {err.reason}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <DialogFooter>
                <Button onClick={() => { setDialogOpen(false); setBatchResult(null); setSelectedCustomerId(""); }}>
                  Schließen
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <>
              <div className="space-y-4 pt-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-700">Kunde</label>
                  <Select value={selectedCustomerId} onValueChange={setSelectedCustomerId}>
                    <SelectTrigger data-testid="select-invoice-customer">
                      <SelectValue placeholder="Kunden auswählen..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="alle" className="font-medium border-b">
                        Alle Kunden (Sammelabrechnung)
                      </SelectItem>
                      {customers?.map((c) => (
                        <SelectItem key={c.id} value={c.id.toString()}>
                          {getCustomerName(c)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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

                {selectedCustomerId === "alle" && (
                  <div className="text-sm text-teal-700 bg-teal-50 border border-teal-200 rounded-md p-3">
                    Es werden automatisch Rechnungen für alle Kunden mit abgeschlossenen Terminen im gewählten Monat erstellt. Kunden mit bestehender Rechnung werden übersprungen.
                  </div>
                )}
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setDialogOpen(false)}>
                  Abbrechen
                </Button>
                <Button
                  onClick={handleGenerate}
                  disabled={generateMutation.isPending || batchMutation.isPending || !selectedCustomerId}
                  className="bg-teal-600 hover:bg-teal-700 text-white"
                  data-testid="button-generate-invoice"
                >
                  {(generateMutation.isPending || batchMutation.isPending) ? (
                    <>
                      <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                      {selectedCustomerId === "alle" ? "Wird erstellt..." : "Wird erstellt..."}
                    </>
                  ) : (
                    <>
                      <FileText className={`${iconSize.sm} mr-1`} />
                      {selectedCustomerId === "alle" ? "Alle Rechnungen erstellen" : "Rechnung erstellen"}
                    </>
                  )}
                </Button>
              </DialogFooter>
            </>
          )}
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
