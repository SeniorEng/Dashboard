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
  SinglePdfExportSummary,
  DiscardDraftsResponse,
  BulkDeleteResponse,
  BulkStatusResponse,
  RepairPdfsResponse,
} from "@shared/api";
import type { GenerateAllResponse, Reduce45bResponse, Reduce45bTargetPot } from "../types";

// Task #1380: Sammelaktionen (Löschen / Statuswechsel) verarbeiten bis zu 200
// Rechnungen pro Aufruf. Um bei großen Auswahlen ein laufendes Fortschritts-
// Feedback zu geben (statt eines einzigen langen Requests ohne Rückmeldung),
// zerlegen wir die Auswahl in Blöcke und melden nach jedem Block den
// Fortschritt. Die Block-Ergebnisse werden zu einem Gesamt-Summary
// zusammengeführt, sodass der Abschluss-Toast weiterhin "X aktualisiert,
// Y übersprungen" über die komplette Auswahl berichtet.
const BULK_CHUNK_SIZE = 25;

export interface BulkActionProgress {
  processed: number;
  total: number;
}

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
  // Task #1376: Auswahl zurücksetzen, nachdem eine Sammelaktion durchlief.
  onBulkActionSuccess?: () => void;
  // Task #1785 P4: Dialog schließen, nachdem die §45b-Kürzung durchlief.
  onReduce45bSuccess?: () => void;
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
  onBulkActionSuccess,
  onReduce45bSuccess,
}: UseBillingMutationsArgs) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [sendingInvoiceId, setSendingInvoiceId] = useState<number | null>(null);
  const [batchSending, setBatchSending] = useState(false);
  const [generateAllProgress, setGenerateAllProgress] = useState<GenerateAllResponse | null>(null);
  const [bulkSendResult, setBulkSendResult] = useState<BulkSendInvoiceResponse | null>(null);
  const [bulkPrintResult, setBulkPrintResult] = useState<BulkPrintSummary | null>(null);
  // Task #1695: Ergebnis des letzten Einzel-PDF-Exports (READ-ONLY, kein State-Change).
  const [singlePdfExportResult, setSinglePdfExportResult] = useState<SinglePdfExportSummary | null>(null);
  // Task #1380: laufender Fortschritt der blockweisen Sammelaktionen
  // (Löschen / Statuswechsel). `null` = keine Aktion läuft.
  const [bulkActionProgress, setBulkActionProgress] = useState<BulkActionProgress | null>(null);

  const generateMutation = useMutation({
    mutationFn: async (data: { customerId: number; billingMonth: number; billingYear: number; dateFrom?: string; dateTo?: string }) => {
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
    // Task #1771: `readyOnly` steuert (Dialog-Checkbox, default an), ob NUR Kunden
    // ohne offene (geplante) Termine abgerechnet werden („Bereit zum Abrechnen").
    // Aus = alle berechtigten Kunden (Bestandsverhalten des Servers). Nutzt
    // dieselbe „offene Termine"-SSoT wie die Karten-Gruppierung.
    mutationFn: async ({
      readyOnly,
    }: {
      readyOnly: boolean;
    }) => {
      setGenerateAllProgress(null);
      const result = await api.post<GenerateAllResponse>("/billing/generate-all", {
        billingMonth: selectedMonth,
        billingYear: selectedYear,
        ...(payerFilter !== "alle" ? { insuranceProviderId: parseInt(payerFilter) } : {}),
        ...(dateFrom ? { dateFrom } : {}),
        ...(dateTo ? { dateTo } : {}),
        readyOnly,
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
        description: `${summary.markedSent} als versendet markiert, ${summary.skipped} übersprungen, ${summary.errors} Fehler`,
      });

      const expectMonth = selectedMonth;
      const expectYear = selectedYear;
      const sentIds = new Set(
        data.results
          .filter((r) => r.status === "marked_sent")
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

  // Task #1473: Print-only Sammeldruck. Erzeugt EXAKT dasselbe gebündelte
  // PDF/ZIP wie `bulk-print`, ändert aber KEINEN Status (kein „versendet"). Der
  // Statuswechsel bleibt den expliziten Aktionen „An Kasse senden" / „Als
  // versendet markieren" vorbehalten. Zwei Optionen: nur Rechnungen oder
  // Rechnungen + Leistungsnachweise. READ-ONLY ⇒ kein invalidate/refetch.
  const bulkPrintPreviewMutation = useMutation({
    mutationFn: async (opts: { groupByPayer: boolean; includeLeistungsnachweise: boolean; invoiceIds?: number[] }) => {
      setBulkPrintResult(null);
      const result = await api.postBlob<BulkPrintSummary>(
        "/billing/bulk-print-preview",
        {
          billingMonth: selectedMonth,
          billingYear: selectedYear,
          groupByPayer: opts.groupByPayer,
          includeLeistungsnachweise: opts.includeLeistungsnachweise,
          // Task #1630: Auswahl-basierter Druck — nur wenn IDs übergeben werden,
          // sonst bleibt der Monats-Sammeldruck unverändert.
          ...(opts.invoiceIds && opts.invoiceIds.length > 0 ? { invoiceIds: opts.invoiceIds } : {}),
          ...(payerFilter !== "alle" ? { insuranceProviderId: parseInt(payerFilter) } : {}),
        },
        "X-Bulk-Print-Summary",
      );
      return unwrapResult(result);
    },
    onSuccess: (data) => {
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
        description: s ? `${s.printed} gedruckt, ${s.errors} Fehler` : "Download wurde gestartet.",
      });
    },
    onError: (error: Error) => {
      toast({ title: "Sammeldruck fehlgeschlagen", description: error.message, variant: "destructive" });
    },
  });

  // Task #1695: Einzel-PDF-Export („Einzeln (ZIP)"-Variante des „Drucken"-Menüs).
  // Lädt ein ZIP mit je einer PDF pro ausgewählter Rechnung (Dateiname
  // Rechnungsnummer_Kunde_Datum.pdf). Über `includeLeistungsnachweise` wird je
  // Rechnung der Leistungsnachweis in DIESELBE Einzel-PDF gemergt. READ-ONLY:
  // KEIN Status-Change, KEINE Markierung als „versendet", daher bewusst KEIN
  // invalidateRelated/refetch (nichts hat sich serverseitig geändert). Auswahl
  // per Rechnungs-IDs.
  const singlePdfExportMutation = useMutation({
    mutationFn: async (opts: { invoiceIds: number[]; includeLeistungsnachweise: boolean }) => {
      setSinglePdfExportResult(null);
      const result = await api.postBlob<SinglePdfExportSummary>(
        "/billing/single-pdf-export",
        { invoiceIds: opts.invoiceIds, includeLeistungsnachweise: opts.includeLeistungsnachweise },
        "X-Single-Pdf-Export-Summary",
      );
      return unwrapResult(result);
    },
    onSuccess: (data) => {
      // Browser-Download des ZIP auslösen.
      const url = URL.createObjectURL(data.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = data.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      setSinglePdfExportResult(data.summary);
      const s = data.summary;
      toast({
        title: "Einzel-PDF-Export erstellt",
        description: s
          ? `${s.exported} exportiert, ${s.errors} Fehler`
          : "Download wurde gestartet.",
      });
    },
    onError: (error: Error) => {
      toast({ title: "Einzel-PDF-Export fehlgeschlagen", description: error.message, variant: "destructive" });
    },
  });

  // Task #1376: Sammel-Löschen (nur Entwürfe). Finalisierte Rechnungen werden
  // serverseitig übersprungen und im Summary als "übersprungen" gemeldet.
  const bulkDeleteMutation = useMutation({
    mutationFn: async (invoiceIds: number[]) => {
      // Task #1380: blockweise verarbeiten + Fortschritt melden, Block-Summaries
      // zu einem Gesamt-Summary zusammenführen.
      setBulkActionProgress({ processed: 0, total: invoiceIds.length });
      const merged: BulkDeleteResponse = {
        summary: { deleted: 0, skipped: 0, total: invoiceIds.length },
        invoiceNumbers: [],
        results: [],
      };
      for (let i = 0; i < invoiceIds.length; i += BULK_CHUNK_SIZE) {
        const chunk = invoiceIds.slice(i, i + BULK_CHUNK_SIZE);
        const result = await api.post<BulkDeleteResponse>("/billing/bulk-delete", { invoiceIds: chunk });
        const data = unwrapResult(result);
        merged.summary.deleted += data.summary.deleted;
        merged.summary.skipped += data.summary.skipped;
        merged.invoiceNumbers.push(...data.invoiceNumbers);
        merged.results.push(...data.results);
        setBulkActionProgress({ processed: Math.min(i + chunk.length, invoiceIds.length), total: invoiceIds.length });
      }
      return merged;
    },
    onSuccess: (data: BulkDeleteResponse) => {
      const { summary } = data;
      toast({
        title: "Sammel-Löschen abgeschlossen",
        description: `${summary.deleted} gelöscht, ${summary.skipped} übersprungen`,
      });
      invalidateRelated(queryClient, "billing");
      onBulkActionSuccess?.();
    },
    onError: (error: Error) => {
      toast({ title: "Sammel-Löschen fehlgeschlagen", description: error.message, variant: "destructive" });
    },
    onSettled: () => {
      setBulkActionProgress(null);
    },
  });

  // Task #1376: Sammel-Statuswechsel (versendet/avis_erhalten/bezahlt). Nutzt
  // serverseitig dieselbe Übergangs-SSoT wie der Einzel-Statuswechsel; ungültige
  // Übergänge werden übersprungen und gemeldet.
  const bulkStatusMutation = useMutation({
    mutationFn: async ({ invoiceIds, status }: { invoiceIds: number[]; status: string }) => {
      // Task #1380: blockweise verarbeiten + Fortschritt melden, Block-Summaries
      // zu einem Gesamt-Summary zusammenführen.
      setBulkActionProgress({ processed: 0, total: invoiceIds.length });
      const merged: BulkStatusResponse = {
        summary: { updated: 0, skipped: 0, total: invoiceIds.length },
        results: [],
      };
      for (let i = 0; i < invoiceIds.length; i += BULK_CHUNK_SIZE) {
        const chunk = invoiceIds.slice(i, i + BULK_CHUNK_SIZE);
        const result = await api.post<BulkStatusResponse>("/billing/bulk-status", { invoiceIds: chunk, status });
        const data = unwrapResult(result);
        merged.summary.updated += data.summary.updated;
        merged.summary.skipped += data.summary.skipped;
        merged.results.push(...data.results);
        setBulkActionProgress({ processed: Math.min(i + chunk.length, invoiceIds.length), total: invoiceIds.length });
      }
      return merged;
    },
    onSuccess: async (data: BulkStatusResponse) => {
      const { summary } = data;
      toast({
        title: "Sammel-Statuswechsel abgeschlossen",
        description: `${summary.updated} aktualisiert, ${summary.skipped} übersprungen`,
      });
      invalidateRelated(queryClient, "billing");
      onBulkActionSuccess?.();

      // Replika-Lag-Schutz: aktualisierte IDs auf den neuen Status pollen.
      const updatedIds = new Set(
        data.results.filter((r) => r.status === "updated").map((r) => r.invoiceId),
      );
      if (updatedIds.size > 0) {
        await refetchWithPoll<InvoiceItem[]>(
          queryClient,
          ["billing-invoices", selectedYear, selectedMonth, statusFilter],
          (list) => {
            if (!list) return true;
            return !list.some((inv) => updatedIds.has(inv.id) && inv.status === "entwurf");
          },
        );
      }
    },
    onError: (error: Error) => {
      toast({ title: "Sammel-Statuswechsel fehlgeschlagen", description: error.message, variant: "destructive" });
    },
  });

  // Task #1785 P4: §45b-Kürzung — Superadmin reduziert EINE ausgestellte
  // §45b-Rechnung auf den tatsächlich von der Kasse gezahlten Betrag (Y); der
  // Überhang (X−Y) wird in EINEN Ziel-Topf umgebucht. GoBD-konform als Storno +
  // §45b-Reset + Neu-Buchung + Re-Rechnung. Der Server meldet `reissue`/`warnings`
  // separat vom committeten Ledger-Teil — beides wird dem Nutzer als Toast
  // gezeigt (Re-Rechnung-Fehler destruktiv, Hinweise/Warnungen neutral).
  const reduce45bMutation = useMutation({
    mutationFn: async ({
      id,
      paidCents,
      targetPot,
    }: {
      id: number;
      paidCents: number;
      targetPot: Reduce45bTargetPot;
    }) => {
      const result = await api.post<Reduce45bResponse>(`/billing/${id}/reduce-45b`, {
        paidCents,
        targetPot,
      });
      return unwrapResult(result);
    },
    onSuccess: (data: Reduce45bResponse) => {
      if (data.reissue.ok) {
        toast({
          title: "§45b-Rechnung gekürzt",
          description: `Storniert, neu ausgestellt. Überhang ${(data.overflowCents / 100).toFixed(2)} € umgebucht.`,
        });
      } else {
        toast({
          title: "§45b gekürzt — Re-Rechnung fehlgeschlagen",
          description: `${data.reissue.error} Der Budget-Stand ist korrekt; die Rechnung bitte über „Rechnung erstellen" erneut ausstellen.`,
          variant: "destructive",
        });
      }
      // Serverseitige Hinweise (z. B. gebundene Qonto-Zahlung) einzeln zeigen.
      for (const warning of data.warnings) {
        toast({ title: "Hinweis", description: warning });
      }
      invalidateRelated(queryClient, "billing");
      onReduce45bSuccess?.();
    },
    onError: (error: Error) => {
      toast({ title: "§45b-Kürzung fehlgeschlagen", description: error.message, variant: "destructive" });
    },
  });

  // Task #1834 — Sammel-Reparatur der als „PDF-Fehler"/„PDF…" markierten
  // Rechnungen. Ersetzt das manuelle Einzel-Anklicken jeder betroffenen
  // Rechnung. Der Server verarbeitet pro Aufruf einen beschränkten Block und
  // meldet `remaining`; wir rufen so lange erneut auf, bis der Rückstand
  // abgearbeitet ist, und melden dabei den Fortschritt („X von Y verarbeitet").
  // Ohne `invoiceIds` repariert der Server den gesamten Rückstand, mit
  // `invoiceIds` nur die aktuelle Auswahl.
  const repairPdfsMutation = useMutation({
    mutationFn: async (invoiceIds?: number[]) => {
      const merged: RepairPdfsResponse = {
        summary: { repaired: 0, failed: 0, remaining: 0, total: 0 },
        results: [],
      };
      let knownTotal = 0;
      let guard = 0;
      // Sicherheits-Deckel gegen Endlos-Schleifen (z. B. dauerhaft fehlschlagende
      // Rechnungen, die im Rückstand verbleiben).
      const MAX_ROUNDS = 500;
      while (guard++ < MAX_ROUNDS) {
        const body = invoiceIds && invoiceIds.length > 0 ? { invoiceIds } : {};
        const result = await api.post<RepairPdfsResponse>("/billing/repair-pdfs", body);
        const data = unwrapResult(result);
        merged.summary.repaired += data.summary.repaired;
        merged.summary.failed += data.summary.failed;
        merged.results.push(...data.results);
        // Gesamt beim ersten Block festhalten (Nenner für den Fortschritt).
        if (knownTotal === 0) knownTotal = data.summary.total;
        knownTotal = Math.max(knownTotal, merged.summary.repaired + merged.summary.failed + data.summary.remaining);
        setBulkActionProgress({
          processed: merged.summary.repaired + merged.summary.failed,
          total: knownTotal,
        });
        // Fertig, wenn nichts mehr aussteht oder dieser Block nichts erledigen
        // konnte (nur Fehler / Chromium weg → sonst Endlos-Schleife).
        if (data.summary.remaining === 0 || data.summary.repaired === 0) {
          merged.summary.remaining = data.summary.remaining;
          break;
        }
      }
      merged.summary.total = knownTotal;
      return merged;
    },
    onSuccess: (data: RepairPdfsResponse) => {
      const { summary } = data;
      if (summary.total === 0) {
        toast({ title: "Keine PDF-Fehler gefunden", description: "Alle Rechnungen haben bereits ein PDF." });
      } else if (summary.failed === 0 && summary.remaining === 0) {
        toast({ title: "PDF-Fehler behoben", description: `${summary.repaired} Rechnung(en) repariert.` });
      } else {
        toast({
          title: "PDF-Reparatur abgeschlossen",
          description: `${summary.repaired} repariert, ${summary.failed} fehlgeschlagen${summary.remaining > 0 ? `, ${summary.remaining} verbleibend` : ""}.`,
          variant: summary.failed > 0 ? "destructive" : undefined,
        });
      }
      invalidateRelated(queryClient, "billing");
      onBulkActionSuccess?.();
    },
    onError: (error: Error) => {
      toast({ title: "PDF-Reparatur fehlgeschlagen", description: error.message, variant: "destructive" });
    },
    onSettled: () => {
      setBulkActionProgress(null);
    },
  });

  return {
    generateMutation,
    discardDraftsMutation,
    statusMutation,
    reduce45bMutation,
    bulkDeleteMutation,
    bulkStatusMutation,
    repairPdfsMutation,
    sendInvoiceMutation,
    markSentMutation,
    generateAllMutation,
    batchSendMutation,
    bulkSendMutation,
    bulkPrintPreviewMutation,
    singlePdfExportMutation,
    sendingInvoiceId,
    batchSending,
    generateAllProgress,
    setGenerateAllProgress,
    bulkSendResult,
    setBulkSendResult,
    bulkPrintResult,
    setBulkPrintResult,
    singlePdfExportResult,
    setSinglePdfExportResult,
    bulkActionProgress,
  };
}
