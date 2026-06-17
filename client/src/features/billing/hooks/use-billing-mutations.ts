import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { invalidateRelated, refetchWithPoll } from "@/lib/query-invalidation";
import type {
  InvoiceItem,
  GenerateInvoiceResponse as GenerateResponse,
  SendInvoiceResponse as SendResponse,
  BatchSendInvoiceResponse as BatchSendResponse,
  BulkSendInvoiceResponse,
  BulkPrintSummary,
  DiscardDraftsResponse,
} from "@shared/api";
import type { GenerateAllResponse } from "../types";

interface UseBillingMutationsArgs {
  selectedMonth: number;
  selectedYear: number;
  statusFilter: string;
  payerFilter: string;
  // Task #1317: optionaler von–bis-Datumsbereich (ISO yyyy-mm-dd, leer = ganzer
  // Monat) — engt die Massenerstellung auf den Bereich ein.
  dateFrom?: string;
  dateTo?: string;
  setStatusFilter: (status: string) => void;
  // Dialog-/Auswahl-State, das die Mutationen bei Erfolg zurücksetzen:
  onGenerateSuccess: () => void;
  onDiscardSettled: () => void;
  onStatusSuccess: () => void;
}

export function useBillingMutations({
  selectedMonth,
  selectedYear,
  statusFilter,
  payerFilter,
  dateFrom = "",
  dateTo = "",
  setStatusFilter,
  onGenerateSuccess,
  onDiscardSettled,
  onStatusSuccess,
}: UseBillingMutationsArgs) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [sendingInvoiceId, setSendingInvoiceId] = useState<number | null>(null);
  const [batchSending, setBatchSending] = useState(false);
  const [generateAllProgress, setGenerateAllProgress] = useState<GenerateAllResponse | null>(null);
  const [bulkSendResult, setBulkSendResult] = useState<BulkSendInvoiceResponse | null>(null);
  const [bulkPrintResult, setBulkPrintResult] = useState<BulkPrintSummary | null>(null);

  const generateMutation = useMutation({
    mutationFn: async (data: { customerId: number; billingMonth: number; billingYear: number }) => {
      // Task #544: harter Client-Timeout (60s) gegen endlose "Wird erstellt..."-Spinner.
      // Der Server rendert das PDF inzwischen im Hintergrund, der Request sollte
      // in < 3s zurückkommen — wenn nicht, ist etwas grundlegend kaputt.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      try {
        const result = await api.post<GenerateResponse>("/billing/generate", data, controller.signal);
        return unwrapResult(result);
      } catch (err) {
        if (err instanceof Error && (err.name === "AbortError" || (err as { code?: string }).code === "ABORTED")) {
          throw new Error(
            "Die Rechnungserstellung dauert ungewöhnlich lange. Bitte später erneut versuchen oder den Support kontaktieren.",
          );
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
    onSuccess: (data: GenerateResponse) => {
      if (data?.splitInvoices) {
        toast({ title: `${data.invoices?.length || 0} Rechnungen erstellt`, description: data.message });
      } else {
        toast({ title: "Rechnung erstellt" });
      }
      invalidateRelated(queryClient, "billing");
      onGenerateSuccess();
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  // Task #817: Verwaiste Entwurfs-Rechnungen verwerfen, damit die Termine
  // wieder frei werden und die Vorschau echte Werte liefert.
  const discardDraftsMutation = useMutation({
    mutationFn: async (data: { customerId: number; month: number; year: number }) => {
      const result = await api.post<DiscardDraftsResponse>("/billing/discard-drafts", data);
      return unwrapResult(result);
    },
    onSuccess: (data: DiscardDraftsResponse) => {
      toast({
        title: data.discarded === 1 ? "Entwurf verworfen" : `${data.discarded} Entwürfe verworfen`,
        description: data.invoiceNumbers.length > 0 ? data.invoiceNumbers.join(", ") : undefined,
      });
      onDiscardSettled();
      invalidateRelated(queryClient, "billing");
    },
    onError: (error: Error) => {
      onDiscardSettled();
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
      onStatusSuccess();

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
        ...(payerFilter !== "alle" ? { insuranceProviderId: parseInt(payerFilter) } : {}),
        ...(dateFrom ? { dateFrom } : {}),
        ...(dateTo ? { dateTo } : {}),
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
      // Task #586 — Server-Code mit anzeigen, damit „HTTP 500:" ohne
      // Kontext nicht mehr beim Nutzer landet. `ApiError` trägt nach
      // `parseErrorResponse` `code` + `status`; bei generischem
      // Netz-/Parsing-Fehler bleibt nur die Message.
      const apiErr = error as Error & { code?: string; status?: number };
      const codePart = apiErr.code && apiErr.code !== "API_ERROR" && apiErr.code !== "NETWORK_ERROR"
        ? ` [${apiErr.code}]`
        : "";
      const statusPart = apiErr.status ? ` (HTTP ${apiErr.status})` : "";
      toast({
        title: "Massenerstellung fehlgeschlagen",
        description: `${error.message}${codePart}${statusPart}`,
        variant: "destructive",
      });
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

  // Task #996: Sammeldruck — bündelt alle Entwurfs-Rechnungen des Monats
  // (Rechnung + Leistungsnachweis) in ein PDF (bzw. ZIP je Krankenkasse),
  // löst den Datei-Download im Browser aus und markiert die enthaltenen
  // Rechnungen serverseitig als „versendet". Das Ergebnis-Summary kommt im
  // `X-Bulk-Print-Summary`-Header und wird im Dialog angezeigt.
  const bulkPrintMutation = useMutation({
    mutationFn: async (opts: { groupByPayer: boolean }) => {
      setBulkPrintResult(null);
      const result = await api.postBlob<BulkPrintSummary>(
        "/billing/bulk-print",
        {
          billingMonth: selectedMonth,
          billingYear: selectedYear,
          groupByPayer: opts.groupByPayer,
          ...(payerFilter !== "alle" ? { insuranceProviderId: parseInt(payerFilter) } : {}),
        },
        "X-Bulk-Print-Summary",
      );
      return unwrapResult(result);
    },
    onSuccess: async (data) => {
      // Browser-Download des gebündelten PDF/ZIP auslösen.
      const url = URL.createObjectURL(data.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = data.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      setBulkPrintResult(data.summary);
      const s = data.summary;
      toast({
        title: "Sammeldruck erstellt",
        description: s
          ? `${s.printed} gedruckt, ${s.marked} als versendet markiert, ${s.errors} Fehler`
          : "Download wurde gestartet.",
      });

      invalidateRelated(queryClient, "billing");

      // Replika-Lag-Schutz: erfolgreich markierte Rechnungen dürfen nicht mehr
      // als `entwurf` in der Liste auftauchen.
      if (s) {
        const markedIds = new Set(
          s.results.filter((r) => r.status === "printed").map((r) => r.invoiceId),
        );
        if (markedIds.size > 0) {
          await refetchWithPoll<InvoiceItem[]>(
            queryClient,
            ["billing-invoices", selectedYear, selectedMonth, statusFilter],
            (list) => {
              if (!list) return true;
              return !list.some((inv) => markedIds.has(inv.id) && inv.status === "entwurf");
            },
          );
        }
      }
    },
    onError: (error: Error) => {
      toast({ title: "Sammeldruck fehlgeschlagen", description: error.message, variant: "destructive" });
    },
  });

  return {
    generateMutation,
    discardDraftsMutation,
    statusMutation,
    sendInvoiceMutation,
    markSentMutation,
    generateAllMutation,
    batchSendMutation,
    bulkSendMutation,
    bulkPrintMutation,
    sendingInvoiceId,
    batchSending,
    generateAllProgress,
    setGenerateAllProgress,
    bulkSendResult,
    setBulkSendResult,
    bulkPrintResult,
    setBulkPrintResult,
  };
}
