import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api";
import type {
  BillingCustomerItem,
  BillingInvoicePreview,
  BlockingDraftInvoice,
  InvoiceItem,
  InvoiceDetail,
  DeliveryRecord,
  PayerSummary,
  BillingPipelineResponse,
  BillingBreakdownResponse,
  BillingBlockersResponse,
  BillingReviewClustersResponse,
  BillingEconomicsResponse,
  BillingTermineResponse,
} from "@shared/api";

// Task #1473: aktive Mitarbeiter:innen für den Mitarbeiter-Filter der
// Abrechnungsseite (gleiche Quelle wie die Termin-/Zeit-Übersicht).
export interface ActiveEmployee {
  id: number;
  displayName: string;
  isTeamLead: boolean;
  roles: string[];
}

// Task #1434: Wirtschafts-Überblick oben auf der Abrechnungsseite. Liest
// AUSSCHLIESSLICH den bestehenden Pipeline-Reader (`GET /billing/pipeline`) —
// keine eigene Berechnung. Der QueryKey beginnt mit "billing", damit
// `invalidateRelated(qc, "billing")` (nach jedem Statuswechsel/Versand) auch
// diese Kachel automatisch neu lädt.
export function useBillingPipeline(selectedYear: number, selectedMonth: number) {
  return useQuery({
    queryKey: ["billing", "pipeline", selectedYear, selectedMonth],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      params.set("year", selectedYear.toString());
      params.set("month", selectedMonth.toString());
      const result = await api.get<BillingPipelineResponse>(`/billing/pipeline?${params.toString()}`, signal);
      return unwrapResult(result);
    },
  });
}

// Task #1453: Abrechnungs-Breakdown (Phase 1, READ-ONLY). Liest ausschließlich
// den neuen Breakdown-Reader (`GET /billing/breakdown`) — er spiegelt dieselbe
// Hybrid-Bruchkante wie die Pipeline (keine Doppelzählung) und liefert die
// Stunden je Leistungsart inkl. der abgerechneten Termine (Fix des 0,0h-Bugs).
// Vor-aggregiert pro (Kunde × Abrechnungstyp); die Gruppierung nach Kunde/Kasse
// passiert clientseitig (kein Refetch beim Umschalten). QueryKey beginnt mit
// "billing", damit `invalidateRelated(qc, "billing")` die Tabelle mit aktualisiert.
export function useBillingBreakdown(selectedYear: number, selectedMonth: number) {
  return useQuery({
    queryKey: ["billing", "breakdown", selectedYear, selectedMonth],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      params.set("year", selectedYear.toString());
      params.set("month", selectedMonth.toString());
      const result = await api.get<BillingBreakdownResponse>(`/billing/breakdown?${params.toString()}`, signal);
      return unwrapResult(result);
    },
  });
}

// Task #1462: „Was hängt"-Panel (Phase 4, Teil A, READ-ONLY). Liest
// AUSSCHLIESSLICH den neuen Blocker-Reader (`GET /billing/blockers`), der genau
// ZWEI bestehende SSoTs komponiert (Doku-Readiness + Budget-Konservierung) und
// die beiden Blocker-Gruppen mit Anzahl + Posten liefert. QueryKey beginnt mit
// "billing", damit `invalidateRelated(qc, "billing")` (nach Statuswechsel/
// Doku/Budget-Mutation) das Panel automatisch neu lädt. Keine Mutation.
export function useBillingBlockers(selectedYear: number, selectedMonth: number) {
  return useQuery({
    queryKey: ["billing", "blockers", selectedYear, selectedMonth],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      params.set("year", selectedYear.toString());
      params.set("month", selectedMonth.toString());
      const result = await api.get<BillingBlockersResponse>(`/billing/blockers?${params.toString()}`, signal);
      return unwrapResult(result);
    },
  });
}

// Task #1456: Pre-Commit-Review-Cluster (Phase 2). Liest AUSSCHLIESSLICH den
// neuen Review-Reader (`GET /billing/review-clusters`) — pro Kunde die
// Phase-1-Spalten plus Eligibilität (eligible/blocked + Begründung). Der Client
// gruppiert clientseitig nach Kunde ODER Kasse, daher kein Refetch beim
// Umschalten. QueryKey beginnt mit "billing" ⇒ `invalidateRelated(qc,"billing")`
// nach jeder Erstellung lädt die Kachel automatisch neu.
export function useBillingReviewClusters(selectedYear: number, selectedMonth: number) {
  return useQuery({
    queryKey: ["billing", "review-clusters", selectedYear, selectedMonth],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      params.set("year", selectedYear.toString());
      params.set("month", selectedMonth.toString());
      const result = await api.get<BillingReviewClustersResponse>(`/billing/review-clusters?${params.toString()}`, signal);
      return unwrapResult(result);
    },
  });
}

export function useBillingInvoices(
  selectedYear: number,
  selectedMonth: number,
  statusFilter: string,
  payerFilter: string,
  // Task #1317: Optionaler von–bis-Datumsbereich (ISO yyyy-mm-dd). Leer = ganzer
  // Monat. Liegt im QueryKey NACH payerFilter, damit die `refetchWithPoll`-
  // Prefix-Keys aus den Mutations weiterhin matchen.
  dateFrom = "",
  dateTo = "",
) {
  return useQuery({
    queryKey: ["billing-invoices", selectedYear, selectedMonth, statusFilter, payerFilter, dateFrom, dateTo],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      params.set("year", selectedYear.toString());
      params.set("month", selectedMonth.toString());
      if (statusFilter !== "alle") params.set("status", statusFilter);
      if (payerFilter !== "alle") params.set("insuranceProviderId", payerFilter);
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      const result = await api.get<InvoiceItem[]>(`/billing?${params.toString()}`, signal);
      return unwrapResult(result);
    },
  });
}

export function useEligibleCustomers(
  selectedYear: number,
  selectedMonth: number,
  payerFilter: string,
  // Task #1317: siehe useBillingInvoices — Datumsbereich am Ende des QueryKeys.
  dateFrom = "",
  dateTo = "",
) {
  return useQuery({
    queryKey: ["billing-eligible-customers", selectedYear, selectedMonth, payerFilter, dateFrom, dateTo],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      params.set("month", selectedMonth.toString());
      params.set("year", selectedYear.toString());
      if (payerFilter !== "alle") params.set("insuranceProviderId", payerFilter);
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      const result = await api.get<BillingCustomerItem[]>(`/billing/eligible-customers?${params.toString()}`, signal);
      return unwrapResult(result);
    },
  });
}

// Task #750: Vorschau-Block im „Neue Rechnung erstellen"-Dialog.
// Lädt sobald ein Kunde ausgewählt ist; QueryKey beginnt mit "billing",
// sodass `invalidateRelated(qc, "billing")` (z.B. nach Generate) die
// Vorschau automatisch invalidiert.
export function useInvoicePreview(
  previewCustomerId: number | null,
  selectedYear: number,
  selectedMonth: number,
  enabled: boolean,
  // Task #1320: optionaler von–bis-Datumsbereich (ISO yyyy-mm-dd). Leer = ganzer
  // Monat. Spiegelt das Fenster, das der nachfolgende `POST /generate` abrechnet,
  // damit Vorschau und erzeugte Rechnung nicht auseinanderdriften.
  dateFrom = "",
  dateTo = "",
) {
  return useQuery({
    queryKey: ["billing", "preview", previewCustomerId, selectedYear, selectedMonth, dateFrom, dateTo],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      params.set("customerId", String(previewCustomerId));
      params.set("month", String(selectedMonth));
      params.set("year", String(selectedYear));
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      const result = await api.get<BillingInvoicePreview>(`/billing/preview?${params.toString()}`, signal);
      return unwrapResult(result);
    },
    enabled: enabled && previewCustomerId !== null,
    retry: false,
  });
}

// Task #817: Verwaiste Entwurfs-Rechnungen, die die Termine blockieren.
// Wird nur geladen, wenn die Vorschau einen Fehler liefert (typisch:
// „Alle Termine … bereits abgerechnet"). QueryKey beginnt mit "billing",
// damit `invalidateRelated(qc, "billing")` nach dem Verwerfen neu lädt.
export function useBlockingDrafts(
  previewCustomerId: number | null,
  selectedYear: number,
  selectedMonth: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["billing", "blocking-drafts", previewCustomerId, selectedYear, selectedMonth],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      params.set("customerId", String(previewCustomerId));
      params.set("month", String(selectedMonth));
      params.set("year", String(selectedYear));
      const result = await api.get<BlockingDraftInvoice[]>(`/billing/blocking-drafts?${params.toString()}`, signal);
      return unwrapResult(result);
    },
    enabled: enabled && previewCustomerId !== null,
    retry: false,
  });
}

// Krankenkassen-Dropdown — Liste der Pflegekassen mit Rechnungen im Monat.
export function usePayers(selectedYear: number, selectedMonth: number) {
  return useQuery({
    queryKey: ["billing-payers", selectedYear, selectedMonth],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      params.set("year", selectedYear.toString());
      params.set("month", selectedMonth.toString());
      const result = await api.get<PayerSummary[]>(`/billing/payers?${params.toString()}`, signal);
      return unwrapResult(result);
    },
  });
}

export function useInvoiceDetail(expandedInvoiceId: number | null) {
  return useQuery({
    queryKey: ["billing-invoice-detail", expandedInvoiceId],
    queryFn: async ({ signal }) => {
      if (!expandedInvoiceId) return null;
      const result = await api.get<InvoiceDetail>(`/billing/${expandedInvoiceId}`, signal);
      return unwrapResult(result);
    },
    enabled: !!expandedInvoiceId,
  });
}

// Task #1473: billing-scoped Wirtschaftlicher Überblick (per-Leistung +
// per-Mitarbeiter inkl. Drill). Liest AUSSCHLIESSLICH den neuen Economics-Reader
// (`GET /billing/economics`), der die bestehende Economics-SSoT billing-scoped
// aggregiert. Monat/Jahr + Mitarbeiter:in + Kasse scopen die Sicht. QueryKey
// beginnt mit "billing" ⇒ `invalidateRelated(qc,"billing")` lädt die Kachel neu.
export function useBillingEconomics(
  selectedYear: number,
  selectedMonth: number,
  employeeFilter: string,
  payerFilter: string,
) {
  return useQuery({
    queryKey: ["billing", "economics", selectedYear, selectedMonth, employeeFilter, payerFilter],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      params.set("year", selectedYear.toString());
      params.set("month", selectedMonth.toString());
      if (employeeFilter !== "alle") params.set("employeeId", employeeFilter);
      if (payerFilter !== "alle") params.set("insuranceProviderId", payerFilter);
      const result = await api.get<BillingEconomicsResponse>(`/billing/economics?${params.toString()}`, signal);
      return unwrapResult(result);
    },
  });
}

// Task #1473: „Termine End-to-End"-Liste (pro Mitarbeiter:in). Liest
// AUSSCHLIESSLICH den neuen Termine-Reader (`GET /billing/termine`); Stufe je
// Termin folgt der Pipeline-/Attribution-SSoT. Monat/Jahr + Mitarbeiter:in +
// Kasse scopen die Liste. QueryKey beginnt mit "billing".
export function useBillingTermine(
  selectedYear: number,
  selectedMonth: number,
  employeeFilter: string,
  payerFilter: string,
) {
  return useQuery({
    queryKey: ["billing", "termine", selectedYear, selectedMonth, employeeFilter, payerFilter],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      params.set("year", selectedYear.toString());
      params.set("month", selectedMonth.toString());
      if (employeeFilter !== "alle") params.set("employeeId", employeeFilter);
      if (payerFilter !== "alle") params.set("insuranceProviderId", payerFilter);
      const result = await api.get<BillingTermineResponse>(`/billing/termine?${params.toString()}`, signal);
      return unwrapResult(result);
    },
  });
}

// Task #1473: aktive Mitarbeiter:innen für das Mitarbeiter-Dropdown des
// Filters. Quelle = bestehender `GET /appointments/active-employees`.
export function useActiveEmployees() {
  return useQuery({
    queryKey: ["billing", "active-employees"],
    queryFn: async ({ signal }) => {
      const result = await api.get<ActiveEmployee[]>(`/appointments/active-employees`, signal);
      return unwrapResult(result);
    },
  });
}

export function useDeliveryHistory(expandedInvoiceId: number | null) {
  return useQuery({
    queryKey: ["billing-delivery-history", expandedInvoiceId],
    queryFn: async ({ signal }) => {
      if (!expandedInvoiceId) return [];
      const result = await api.get<DeliveryRecord[]>(`/billing/deliveries/${expandedInvoiceId}`, signal);
      return unwrapResult(result);
    },
    enabled: !!expandedInvoiceId,
  });
}
