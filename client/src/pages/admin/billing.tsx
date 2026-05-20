import { useState } from "react";
import { formatEuroDE } from "@shared/utils/money";
import { Link } from "wouter";
import { Layout } from "@/components/layout";
import { invalidateRelated, refetchWithPoll } from "@/lib/query-invalidation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { displayPriceCents } from "@shared/domain/customers";
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
  BulkSendInvoiceResponse,
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
  AlertTriangle,
  Printer,
  Layers,
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
  return formatEuroDE(cents);
}

function formatDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-");
  return `${d}.${m}.${y}`;
}

function getCustomerName(c: BillingCustomerItem): string {
  return c.vorname && c.nachname ? `${c.vorname} ${c.nachname}` : c.name;
}

function getInvoiceCustomerDisplayName(inv: InvoiceItem): string {
  if (inv.customerVorname && inv.customerNachname) {
    return `${inv.customerVorname} ${inv.customerNachname}`;
  }
  return inv.customerName || "";
}

function formatSentAt(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

interface GenerateAllResponse {
  summary: { total: number; created: number; skipped: number; errors: number };
  results: Array<{ customerId: number; status: "created" | "skipped" | "error"; invoiceCount?: number; message?: string }>;
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
  const [generateAllOpen, setGenerateAllOpen] = useState(false);
  const [generateAllProgress, setGenerateAllProgress] = useState<GenerateAllResponse | null>(null);
  // Task #534: Bulk-Versand-Dialog (typenübergreifend).
  const [bulkSendOpen, setBulkSendOpen] = useState(false);
  const [bulkSendResult, setBulkSendResult] = useState<BulkSendInvoiceResponse | null>(null);

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
      invalidateRelated(queryClient, "billing");
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
    onSuccess: async (_data, variables) => {
      toast({ title: "Status aktualisiert" });

      // Task #543: Beim Stornieren entstehen serverseitig zusätzlich eine
      // neue Stornorechnung (Status `entwurf`) sowie ggf. eine
      // Nachberechnung. Damit der Anwender beide Folge-Rechnungen direkt
      // sieht, setzen wir einen restriktiven Status-Filter defensiv auf
      // "alle" zurück.
      const expectMonth = selectedMonth;
      const expectYear = selectedYear;
      let nextStatusFilter = statusFilter;
      if (
        variables.status === "storniert"
        && statusFilter !== "alle"
        && statusFilter !== "entwurf"
        && statusFilter !== "storniert"
      ) {
        nextStatusFilter = "alle";
        setStatusFilter("alle");
      }

      invalidateRelated(queryClient, "billing");
      setStornoTarget(null);

      // Task #543: Replika-Lag-Schutz — auf Folge-Rechnung (Storno-Entwurf)
      // bzw. den aktualisierten Status der Original-Rechnung pollen.
      await refetchWithPoll<InvoiceItem[]>(
        queryClient,
        ["billing-invoices", expectYear, expectMonth, nextStatusFilter],
        (list) => {
          if (!list) return false;
          const target = list.find((inv) => inv.id === variables.id);
          return !!target && target.status === variables.status;
        },
      );
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
      invalidateRelated(queryClient, "billing");
      setSendingInvoiceId(null);
    },
    onError: (error: Error) => {
      toast({ title: "Versand fehlgeschlagen", description: error.message, variant: "destructive" });
      setSendingInvoiceId(null);
    },
  });

  // Task #533: Manuelles Markieren als versendet (Pflegekassen-Drafts).
  const markSentMutation = useMutation({
    mutationFn: async (invoiceId: number) => {
      const result = await api.post(`/billing/${invoiceId}/mark-sent`, {});
      return unwrapResult(result);
    },
    onSuccess: () => {
      toast({ title: "Als versendet markiert", description: "Die Rechnung wurde manuell auf versendet gesetzt." });
      invalidateRelated(queryClient, "billing");
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  // Task #533: Massenerstellung — sequenzielle Erstellung aller berechtigten
  // Kunden des Monats. Fortschritt + Summary werden im Dialog angezeigt.
  const generateAllMutation = useMutation({
    mutationFn: async () => {
      setGenerateAllProgress(null);
      const result = await api.post<GenerateAllResponse>("/billing/generate-all", {
        billingMonth: selectedMonth,
        billingYear: selectedYear,
      });
      return unwrapResult(result);
    },
    onSuccess: async (data: GenerateAllResponse) => {
      setGenerateAllProgress(data);
      toast({
        title: "Massenerstellung abgeschlossen",
        description: `${data.summary.created} erstellt, ${data.summary.skipped} übersprungen, ${data.summary.errors} Fehler`,
      });

      // Task #540: Status-Filter defensiv auf "alle" zurücksetzen, damit
      // frisch erstellte Entwürfe garantiert sichtbar sind, auch wenn der
      // Benutzer vorher z.B. "Versendet" gefiltert hatte.
      const createdCustomerIds = new Set(
        data.results.filter((r) => r.status === "created").map((r) => r.customerId),
      );
      const expectMonth = selectedMonth;
      const expectYear = selectedYear;
      let nextStatusFilter = statusFilter;
      if (createdCustomerIds.size > 0 && statusFilter !== "alle" && statusFilter !== "entwurf") {
        nextStatusFilter = "alle";
        setStatusFilter("alle");
      }

      invalidateRelated(queryClient, "billing");

      // Task #540/#543: Neon-Serverless hat gelegentlich kurze Replika-Lag —
      // ein einzelner Refetch direkt nach Massen-Mutationen kann eine
      // veraltete Liste liefern. `refetchWithPoll` refetcht daher gezielt
      // mit kurzem Polling, bis der erwartete Zustand sichtbar ist (oder
      // das Timeout erreicht ist).
      if (createdCustomerIds.size > 0) {
        await refetchWithPoll<InvoiceItem[]>(
          queryClient,
          ["billing-invoices", expectYear, expectMonth, nextStatusFilter],
          (list) => !!list && list.some((inv) => createdCustomerIds.has(inv.customerId)),
        );
      }
    },
    onError: (error: Error) => {
      toast({ title: "Massenerstellung fehlgeschlagen", description: error.message, variant: "destructive" });
    },
  });

  const batchSendMutation = useMutation({
    mutationFn: async (invoiceIds: number[]) => {
      setBatchSending(true);
      const result = await api.post<BatchSendResponse>("/billing/send-batch", { invoiceIds });
      return unwrapResult(result);
    },
    onSuccess: async (data: BatchSendResponse) => {
      const { summary } = data;
      toast({
        title: `Stapelversand abgeschlossen`,
        description: `${summary.sent} versendet, ${summary.errors} Fehler, ${summary.skipped} übersprungen`,
      });

      const expectMonth = selectedMonth;
      const expectYear = selectedYear;
      const sentIds = new Set(
        data.results.filter((r) => r.status === "sent").map((r) => r.invoiceId),
      );

      invalidateRelated(queryClient, "billing");
      setBatchSending(false);

      // Task #543: Replika-Lag-Schutz — auf Statuswechsel der versendeten
      // Rechnungen (`entwurf` -> `versendet`) im aktuell sichtbaren Filter
      // pollen.
      if (sentIds.size > 0) {
        await refetchWithPoll<InvoiceItem[]>(
          queryClient,
          ["billing-invoices", expectYear, expectMonth, statusFilter],
          (list) => {
            if (!list) return true;
            return !list.some((inv) => sentIds.has(inv.id) && inv.status === "entwurf");
          },
        );
      }
    },
    onError: (error: Error) => {
      toast({ title: "Stapelversand fehlgeschlagen", description: error.message, variant: "destructive" });
      setBatchSending(false);
    },
  });

  const draftPflegekasseInvoices = invoices?.filter(
    (inv) => inv.status === "entwurf" && inv.billingType === "pflegekasse_gesetzlich"
  ) || [];

  // Task #534: Alle Entwürfe, die im typenübergreifenden Bulk-Versand
  // verarbeitet werden — Selbstzahler + beide Pflegekassen-Varianten.
  const draftBulkInvoices = invoices?.filter(
    (inv) => inv.status === "entwurf" && (
      inv.billingType === "selbstzahler"
      || inv.billingType === "pflegekasse_gesetzlich"
      || inv.billingType === "pflegekasse_privat"
    )
  ) || [];

  const bulkSendMutation = useMutation({
    mutationFn: async (invoiceIds: number[]) => {
      const result = await api.post<BulkSendInvoiceResponse>("/billing/send-bulk", { invoiceIds });
      return unwrapResult(result);
    },
    onSuccess: async (data) => {
      setBulkSendResult(data);
      const { summary } = data;
      toast({
        title: "Bulk-Versand abgeschlossen",
        description: `${summary.sent + summary.markedSent} versendet, ${summary.skipped} übersprungen, ${summary.errors} Fehler`,
      });

      const expectMonth = selectedMonth;
      const expectYear = selectedYear;
      const sentIds = new Set(
        data.results
          .filter((r) => r.status === "sent" || r.status === "marked_sent")
          .map((r) => r.invoiceId),
      );

      invalidateRelated(queryClient, "billing");

      // Task #543: Replika-Lag-Schutz — auf Statuswechsel der versendeten
      // Rechnungen pollen (keine der versendeten IDs darf noch als
      // `entwurf` in der Liste auftauchen).
      if (sentIds.size > 0) {
        await refetchWithPoll<InvoiceItem[]>(
          queryClient,
          ["billing-invoices", expectYear, expectMonth, statusFilter],
          (list) => {
            if (!list) return true;
            return !list.some((inv) => sentIds.has(inv.id) && inv.status === "entwurf");
          },
        );
      }
    },
    onError: (error: Error) => {
      toast({ title: "Bulk-Versand fehlgeschlagen", description: error.message, variant: "destructive" });
    },
  });

  const handleBatchSend = () => {
    if (draftPflegekasseInvoices.length === 0) {
      toast({ title: "Keine Rechnungen zum Versenden", description: "Es gibt keine Entwurfs-Rechnungen an Pflegekassen.", variant: "destructive" });
      return;
    }
    batchSendMutation.mutate(draftPflegekasseInvoices.map((inv) => inv.id));
  };

  const handleBulkSend = () => {
    if (draftBulkInvoices.length === 0) return;
    bulkSendMutation.mutate(draftBulkInvoices.map((inv) => inv.id));
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

                {/* Task #533: Mobil-fix — Aktionsleiste bricht auf schmalen
                    Viewports um (flex-wrap), Buttons nehmen volle Breite und
                    Beschriftungen sind auf Mobile kürzer (sm:inline-Zusatz). */}
                <div className="flex flex-wrap justify-end gap-2">
                  {draftBulkInvoices.length > 0 && (
                    <Button
                      variant="outline"
                      className="text-purple-700 border-purple-200 hover:bg-purple-50 w-full sm:w-auto"
                      onClick={() => { setBulkSendResult(null); setBulkSendOpen(true); }}
                      data-testid="button-bulk-send"
                    >
                      <Send className={`${iconSize.sm} mr-1`} />
                      <span className="hidden sm:inline">Alle </span>versenden ({draftBulkInvoices.length})
                    </Button>
                  )}
                  {draftPflegekasseInvoices.length > 0 && (
                    <Button
                      variant="outline"
                      className="text-blue-600 border-blue-200 hover:bg-blue-50 w-full sm:w-auto"
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
                          <span className="hidden sm:inline">Alle an </span>Pflegekassen senden ({draftPflegekasseInvoices.length})
                        </>
                      )}
                    </Button>
                  )}
                  {customers && customers.length > 0 && (
                    <Button
                      variant="outline"
                      className="text-teal-700 border-teal-200 hover:bg-teal-50 w-full sm:w-auto"
                      onClick={() => { setGenerateAllProgress(null); setGenerateAllOpen(true); }}
                      data-testid="button-generate-all"
                    >
                      <Layers className={`${iconSize.sm} mr-1`} />
                      <span className="hidden sm:inline">Alle offenen erstellen </span>
                      <span className="sm:hidden">Alle erstellen </span>
                      ({customers.length})
                    </Button>
                  )}
                  <Button
                    onClick={() => setDialogOpen(true)}
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
                                      {item.serviceCode === "travel_km" || item.serviceCode === "customer_km"
                                        ? `${item.durationMinutes} km`
                                        : `${item.durationMinutes} Min.`}
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

      {/* Task #534: Bulk-Versand-Dialog mit Fortschritt + Ergebnis-Summary.
          Pflegekassen-Entwürfe werden als „versendet" markiert (kein TI),
          Selbstzahler erhalten den Status „versendet". Reuse der bestehenden
          Pfade (mark-sent / status-update), kein neuer Versandweg. */}
      <Dialog
        open={bulkSendOpen}
        onOpenChange={(open) => {
          if (bulkSendMutation.isPending) return;
          setBulkSendOpen(open);
          if (!open) setBulkSendResult(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Alle Rechnungen versenden</DialogTitle>
            <DialogDescription>
              Für {MONTH_NAMES[selectedMonth - 1]} {selectedYear} werden alle Entwürfe sequenziell verarbeitet.
              Selbstzahler werden auf „versendet" gesetzt, Pflegekassen-Entwürfe manuell als versendet markiert
              (solange kein TI-Anschluss besteht). Bereits versendete Rechnungen werden übersprungen.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 pt-2 text-sm">
            <div className="text-gray-700">
              Zu verarbeitende Entwürfe: <span className="font-medium" data-testid="text-bulk-send-count">{draftBulkInvoices.length}</span>
            </div>

            {bulkSendMutation.isPending && (
              <div className="flex items-center gap-2 text-purple-700">
                <Loader2 className={`${iconSize.sm} animate-spin`} />
                <span>Versende — bitte nicht schließen ...</span>
              </div>
            )}

            {bulkSendResult && (
              <div
                className="rounded border border-gray-200 bg-gray-50 px-3 py-2 space-y-2"
                data-testid="bulk-send-summary"
              >
                <div>
                  <div className="font-medium text-gray-800 mb-1">Ergebnis</div>
                  <ul className="text-gray-700 space-y-0.5">
                    <li>
                      <span className="text-green-700 font-medium">{bulkSendResult.summary.sent}</span> versendet (Selbstzahler)
                    </li>
                    <li>
                      <span className="text-blue-700 font-medium">{bulkSendResult.summary.markedSent}</span> als versendet markiert (Pflegekassen)
                    </li>
                    <li>
                      <span className="text-gray-600 font-medium">{bulkSendResult.summary.skipped}</span> übersprungen
                    </li>
                    <li>
                      <span className={bulkSendResult.summary.errors > 0 ? "text-red-700 font-medium" : "text-gray-600 font-medium"}>
                        {bulkSendResult.summary.errors}
                      </span>{" "}
                      Fehler
                    </li>
                  </ul>
                </div>

                {bulkSendResult.results.length > 0 && (
                  <div>
                    <div className="font-medium text-gray-800 mb-1 mt-2">Pro Rechnung</div>
                    <ul className="max-h-48 overflow-y-auto divide-y divide-gray-200 border border-gray-200 rounded bg-white">
                      {bulkSendResult.results.map((r) => {
                        const dotColor =
                          r.status === "sent" ? "bg-green-500"
                          : r.status === "marked_sent" ? "bg-blue-500"
                          : r.status === "skipped" ? "bg-gray-400"
                          : "bg-red-500";
                        const labelColor =
                          r.status === "sent" ? "text-green-700"
                          : r.status === "marked_sent" ? "text-blue-700"
                          : r.status === "skipped" ? "text-gray-600"
                          : "text-red-700";
                        const labelText =
                          r.status === "sent" ? "versendet"
                          : r.status === "marked_sent" ? "als versendet markiert"
                          : r.status === "skipped" ? "übersprungen"
                          : "Fehler";
                        const label = r.invoiceNumber || `Rechnung #${r.invoiceId}`;
                        return (
                          <li
                            key={r.invoiceId}
                            className="px-2 py-1.5 text-sm flex items-start gap-2"
                            data-testid={`bulk-send-result-${r.invoiceId}`}
                          >
                            <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`} aria-hidden="true" />
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-baseline gap-x-2">
                                <span className="font-medium text-gray-800 truncate">{label}</span>
                                <span className={`text-xs font-medium ${labelColor}`}>{labelText}</span>
                              </div>
                              {r.message && (r.status === "error" || r.status === "skipped") && (
                                <div className="text-xs text-gray-600 mt-0.5 break-words">{r.message}</div>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { setBulkSendOpen(false); setBulkSendResult(null); }}
              disabled={bulkSendMutation.isPending}
            >
              Schließen
            </Button>
            <Button
              onClick={handleBulkSend}
              disabled={bulkSendMutation.isPending || draftBulkInvoices.length === 0 || !!bulkSendResult}
              className="bg-purple-600 hover:bg-purple-700 text-white"
              data-testid="button-confirm-bulk-send"
            >
              {bulkSendMutation.isPending ? (
                <>
                  <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                  Wird versendet...
                </>
              ) : (
                <>
                  <Send className={`${iconSize.sm} mr-1`} />
                  Jetzt versenden
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Task #533: Massenerstellung-Dialog mit Fortschritt + Summary. */}
      <Dialog
        open={generateAllOpen}
        onOpenChange={(open) => {
          if (generateAllMutation.isPending) return;
          setGenerateAllOpen(open);
          if (!open) setGenerateAllProgress(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Alle offenen Leistungsnachweise abrechnen</DialogTitle>
            <DialogDescription>
              Für {MONTH_NAMES[selectedMonth - 1]} {selectedYear} werden alle Kunden mit unterschriebenem Leistungsnachweis sequenziell in Rechnung gestellt. Kunden mit bereits vorhandener Rechnung werden übersprungen.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 pt-2 text-sm">
            <div className="text-gray-700">
              Berechtigte Kunden: <span className="font-medium" data-testid="text-generate-all-count">{customers?.length ?? 0}</span>
            </div>

            {generateAllMutation.isPending && (
              <div className="flex items-center gap-2 text-teal-700">
                <Loader2 className={`${iconSize.sm} animate-spin`} />
                <span>Erstelle Rechnungen — bitte nicht schließen ...</span>
              </div>
            )}

            {generateAllProgress && (
              <div
                className="rounded border border-gray-200 bg-gray-50 px-3 py-2 space-y-2"
                data-testid="generate-all-summary"
              >
                <div>
                  <div className="font-medium text-gray-800 mb-1">Ergebnis</div>
                  <ul className="text-gray-700 space-y-0.5">
                    <li>
                      <span className="text-green-700 font-medium">{generateAllProgress.summary.created}</span> erstellt
                    </li>
                    <li>
                      <span className="text-gray-600 font-medium">{generateAllProgress.summary.skipped}</span> übersprungen (bereits abgerechnet)
                    </li>
                    <li>
                      <span className={generateAllProgress.summary.errors > 0 ? "text-red-700 font-medium" : "text-gray-600 font-medium"}>
                        {generateAllProgress.summary.errors}
                      </span>{" "}
                      Fehler
                    </li>
                  </ul>
                </div>

                {generateAllProgress.results.length > 0 && (
                  <div>
                    <div className="font-medium text-gray-800 mb-1 mt-2">Pro Kunde</div>
                    <ul className="max-h-48 overflow-y-auto divide-y divide-gray-200 border border-gray-200 rounded bg-white">
                      {generateAllProgress.results.map((r) => {
                        const cust = customers?.find((c) => c.id === r.customerId);
                        const name = cust ? getCustomerName(cust) : `Kunde #${r.customerId}`;
                        const dotColor =
                          r.status === "created" ? "bg-green-500"
                          : r.status === "skipped" ? "bg-gray-400"
                          : "bg-red-500";
                        const labelColor =
                          r.status === "created" ? "text-green-700"
                          : r.status === "skipped" ? "text-gray-600"
                          : "text-red-700";
                        const labelText =
                          r.status === "created" ? `erstellt${r.invoiceCount && r.invoiceCount > 1 ? ` (${r.invoiceCount} Rechnungen)` : ""}`
                          : r.status === "skipped" ? "übersprungen"
                          : "Fehler";
                        return (
                          <li
                            key={r.customerId}
                            className="px-2 py-1.5 text-sm flex items-start gap-2"
                            data-testid={`generate-all-result-${r.customerId}`}
                          >
                            <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`} aria-hidden="true" />
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-baseline gap-x-2">
                                <span className="font-medium text-gray-800 truncate">{name}</span>
                                <span className={`text-xs font-medium ${labelColor}`}>{labelText}</span>
                              </div>
                              {r.message && (r.status === "error" || r.status === "skipped") && (
                                <div className="text-xs text-gray-600 mt-0.5 break-words">{r.message}</div>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { setGenerateAllOpen(false); setGenerateAllProgress(null); }}
              disabled={generateAllMutation.isPending}
            >
              Schließen
            </Button>
            <Button
              onClick={() => generateAllMutation.mutate()}
              disabled={generateAllMutation.isPending || !customers || customers.length === 0}
              className="bg-teal-600 hover:bg-teal-700 text-white"
              data-testid="button-confirm-generate-all"
            >
              {generateAllMutation.isPending ? (
                <>
                  <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                  Wird erstellt...
                </>
              ) : (
                <>
                  <Layers className={`${iconSize.sm} mr-1`} />
                  Jetzt erstellen
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
