/**
 * Admin Customer Detail Page
 * 
 * Displays comprehensive customer information with tabbed interface
 * for contacts, insurance, budgets, services, and history.
 * Uses design system patterns for consistent styling.
 */

import { useState, useMemo, useCallback } from "react";
import { useParams, useSearch, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDateForDisplay, isChild } from "@shared/utils/datetime";
import { DEACTIVATION_REASON_LABELS, type DeactivationReason } from "@shared/domain/customers";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Layout } from "@/components/layout";
import { PageHeader } from "@/components/patterns/page-header";
import { SectionCard } from "@/components/patterns/section-card";
import { StatusBadge } from "@/components/patterns/status-badge";
import { ResponsiveTabs, TabsContent } from "@/components/patterns/responsive-tabs";
import { useCustomer, customerKeys } from "@/features/customers";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api";
import { invalidateRelated } from "@/lib/query-invalidation";
import { iconSize, componentStyles } from "@/design-system";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Loader2,
  Wallet,
  Euro,
  AlertCircle,
  Settings,
  FileCheck2,
  UserCheck,
  UserX,
  CheckCircle2,
  XCircle,
  Ban,
  Merge,
} from "lucide-react";
import { BudgetLedgerSection } from "@/components/budget/BudgetLedgerSection";
import { BudgetTypeSettings } from "@/components/budget/BudgetTypeSettings";
import { PflegegradBudgetSection } from "@/components/budget/PflegegradBudgetSection";
import { CustomerOverviewTab } from "./components/customer-overview-tab";
import { CustomerInsuranceTab } from "./components/customer-insurance-tab";
import { PricingSection } from "./components/customer-pricing-section";
import { CustomerDocumentsSection } from "./components/customer-documents-section";
import { CustomerContactsTab } from "./components/customer-contacts-tab";
import { CustomerContractTab } from "./components/customer-contract-tab";

const MISSING_LABELS: Record<string, string> = {
  pflegegrad: "Pflegegrad",
  billingType: "Abrechnungsart",
  primaryEmployee: "Zuständiger Mitarbeiter",
  insurance: "Versicherung / Pflegekasse",
  contract: "Aktiver Vertrag",
};

interface CustomerListItem {
  id: number;
  name: string;
  status: string;
  address: string;
}

function ErstberatungConversionSection({
  customerId,
  onActivate,
  onReject,
  onMerge,
  isUpdating,
  isMerging,
}: {
  customerId: number;
  onActivate: () => void;
  onReject: () => void;
  onMerge: () => void;
  isUpdating: boolean;
  isMerging: boolean;
}) {
  const { data: readiness, isLoading } = useQuery<{
    ready: boolean;
    missing: string[];
    customerStatus: string;
  }>({
    queryKey: ["conversion-readiness", customerId],
    queryFn: async () => {
      const result = await api.get<{ ready: boolean; missing: string[]; customerStatus: string }>(`/admin/customers/${customerId}/conversion-readiness`);
      return unwrapResult(result);
    },
    staleTime: 10000,
  });

  return (
    <SectionCard className="mb-4 border-teal-200 bg-teal-50">
      <div className="space-y-3">
        <div>
          <p className="font-medium text-teal-900">Erstberatungskunde</p>
          <p className="text-sm text-teal-700 mt-0.5">
            Prüfen Sie die Vollständigkeit und aktivieren Sie den Kunden für reguläre Termine.
          </p>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-teal-600">
            <Loader2 className={`${iconSize.sm} animate-spin`} />
            <span>Daten werden geprüft...</span>
          </div>
        ) : readiness ? (
          <>
            <div className="space-y-1.5">
              {Object.entries(MISSING_LABELS).map(([key, label]) => {
                const isMissing = readiness.missing.includes(key);
                return (
                  <div
                    key={key}
                    className={`flex items-center gap-2 text-sm ${isMissing ? "text-red-700" : "text-teal-700"}`}
                    data-testid={`readiness-${key}`}
                  >
                    {isMissing ? (
                      <XCircle className={`${iconSize.sm} text-red-500 shrink-0`} />
                    ) : (
                      <CheckCircle2 className={`${iconSize.sm} text-green-600 shrink-0`} />
                    )}
                    <span>{label}</span>
                  </div>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                onClick={onActivate}
                disabled={isUpdating || isMerging || !readiness.ready}
                className={componentStyles.btnPrimary}
                data-testid="button-activate-customer"
              >
                {isUpdating ? (
                  <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                ) : (
                  <UserCheck className={`${iconSize.sm} mr-2`} />
                )}
                Kunde aktivieren
              </Button>
              <Button
                variant="outline"
                onClick={onMerge}
                disabled={isUpdating || isMerging}
                className="text-teal-700 border-teal-200 hover:bg-teal-100"
                data-testid="button-merge-customer"
              >
                {isMerging ? (
                  <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                ) : (
                  <Merge className={`${iconSize.sm} mr-2`} />
                )}
                Zusammenführen
              </Button>
              <Button
                variant="outline"
                onClick={onReject}
                disabled={isUpdating || isMerging}
                className="text-red-700 border-red-200 hover:bg-red-50"
                data-testid="button-reject-customer"
              >
                {isUpdating ? (
                  <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                ) : (
                  <Ban className={`${iconSize.sm} mr-2`} />
                )}
                Kein Interesse
              </Button>
            </div>

            {!readiness.ready && (
              <p className="text-xs text-teal-600 mt-1">
                Bitte ergänzen Sie die fehlenden Daten über "Bearbeiten", bevor Sie den Kunden aktivieren.
              </p>
            )}
          </>
        ) : null}
      </div>
    </SectionCard>
  );
}

function BackfillSection({ customerId, onRefresh }: { customerId: number; onRefresh: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<{ total: number; created: number; skipped: number; errors: number } | null>(null);

  const backfillDateFrom = "2026-01-01";
  const backfillDateTo = "2026-01-31";

  const { data: preview, isLoading: previewLoading } = useQuery<{
    totalAppointments: number;
    customerBreakdown: Record<string, { count: number; missingSignatures: number; dates: string[] }>;
  }>({
    queryKey: ["backfill-preview", customerId],
    queryFn: async () => {
      const res = await api.get<{
        totalAppointments: number;
        customerBreakdown: Record<string, { count: number; missingSignatures: number; dates: string[] }>;
      }>(`/admin/budget/backfill-preview?customerId=${customerId}&dateFrom=${backfillDateFrom}&dateTo=${backfillDateTo}`);
      return unwrapResult(res);
    },
    staleTime: 60000,
  });

  const count = preview?.totalAppointments || 0;

  if (previewLoading || count === 0) return null;

  const handleBackfill = async () => {
    setIsRunning(true);
    setResult(null);
    try {
      const res = await api.post("/admin/budget/backfill-transactions", { customerId, dateFrom: backfillDateFrom, dateTo: backfillDateTo });
      const data = unwrapResult(res) as { total: number; created: number; skipped: number; errors: number };
      setResult(data);
      invalidateRelated(queryClient, "budget");
      queryClient.invalidateQueries({ queryKey: ["backfill-preview", customerId] });
      onRefresh();
      if (data.errors > 0 && data.created > 0) {
        toast({ variant: "destructive", title: "Teilweise erfolgreich", description: `${data.created} erstellt, ${data.errors} fehlgeschlagen.` });
      } else if (data.errors > 0) {
        toast({ variant: "destructive", title: "Fehler", description: `${data.errors} Termine konnten nicht nachgebucht werden.` });
      } else if (data.created > 0) {
        toast({ title: "Nachbuchung erfolgreich", description: `${data.created} Budget-Buchung${data.created !== 1 ? "en" : ""} erstellt.` });
      } else {
        toast({ title: "Keine Änderungen", description: "Alle Termine wurden übersprungen." });
      }
    } catch (err: unknown) {
      toast({ variant: "destructive", title: "Fehler", description: err instanceof Error ? err.message : "Nachbuchung fehlgeschlagen" });
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <SectionCard
      title="Importierte Termine nachbuchen"
      icon={<AlertCircle className={iconSize.sm} />}
    >
      <div className="space-y-3">
        <div className="p-3 rounded-lg bg-amber-50 border border-amber-200">
          <p className="text-sm text-amber-800">
            <strong>{count} Termin{count !== 1 ? "e" : ""}</strong> aus Januar 2026 ohne Budget-Buchung gefunden.
            Diese Termine wurden importiert und haben den Dokumentationsprozess nicht durchlaufen.
          </p>
          <p className="text-xs text-amber-700 mt-1">
            Die Nachbuchung setzt "SYSTEMGENERIERT" als Unterschrift und erstellt die fehlenden Budget-Transaktionen für Januar.
          </p>
        </div>

        {result && (
          <div className="p-3 rounded-lg bg-green-50 border border-green-200 text-sm text-green-800">
            <p><strong>Ergebnis:</strong> {result.created} erstellt, {result.skipped} übersprungen, {result.errors} Fehler</p>
          </div>
        )}

        <Button
          className={`w-full ${componentStyles.btnPrimary}`}
          onClick={handleBackfill}
          disabled={isRunning}
          data-testid="button-backfill-budgets"
        >
          {isRunning ? (
            <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
          ) : (
            <CheckCircle2 className={`${iconSize.sm} mr-2`} />
          )}
          {count} Termin{count !== 1 ? "e" : ""} nachbuchen
        </Button>
      </div>
    </SectionCard>
  );
}

function BudgetsTabContent({
  customerId,
  customerDisplayName,
  pflegegrad,
  careLevelHistory,
  onRefresh,
}: {
  customerId: number;
  customerDisplayName: string;
  pflegegrad?: number;
  careLevelHistory?: Array<{ id: number; pflegegrad: number; validFrom: string; validTo: string | null; notes: string | null }>;
  onRefresh: () => void;
}) {
  return (
    <>
      <PflegegradBudgetSection
        customerId={customerId}
        pflegegrad={pflegegrad ?? null}
        careLevelHistory={careLevelHistory ?? []}
      />

      <SectionCard
        title="Budget-Einstellungen"
        icon={<Settings className={iconSize.sm} />}
      >
        <BudgetTypeSettings customerId={customerId} pflegegrad={pflegegrad} />
      </SectionCard>

      <BudgetLedgerSection
        customerId={customerId}
        customerName={customerDisplayName}
        onRefresh={onRefresh}
      />

      <SectionCard
        title="Preisvereinbarung"
        icon={<Euro className={iconSize.sm} />}
      >
        <PricingSection
          customerId={customerId}
          customerName={customerDisplayName}
          onRefresh={onRefresh}
        />
      </SectionCard>

      <BackfillSection customerId={customerId} onRefresh={onRefresh} />
    </>
  );
}

const VALID_TABS = ["overview", "vertrag", "documents", "contacts", "budgets", "insurance"] as const;

export default function AdminCustomerDetail() {
  const { id } = useParams<{ id: string }>();
  const customerId = parseInt(id || "0");
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const activeTab = useMemo(() => {
    const params = new URLSearchParams(searchString);
    const tab = params.get("tab");
    if (tab && (VALID_TABS as readonly string[]).includes(tab)) return tab;
    return "overview";
  }, [searchString]);

  const handleTabChange = useCallback((tab: string) => {
    if (tab === "overview") {
      setLocation(`/admin/customers/${customerId}`);
    } else {
      setLocation(`/admin/customers/${customerId}?tab=${tab}`);
    }
  }, [customerId, setLocation]);

  const { data: customer, isLoading, error, refetch } = useCustomer(customerId);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showDeactivateDialog, setShowDeactivateDialog] = useState(false);
  const [deactivationNote, setDeactivationNote] = useState<string>("");
  const [showMergeDialog, setShowMergeDialog] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState<string>("");
  const [mergeNote, setMergeNote] = useState<string>("");

  const { data: activeCustomersData } = useQuery<{ data: CustomerListItem[] }>({
    queryKey: customerKeys.list({ status: "aktiv", limit: 500 }),
    queryFn: async () => {
      const result = await api.get<{ data: CustomerListItem[] }>("/admin/customers?status=aktiv&limit=500");
      return unwrapResult(result);
    },
    enabled: showMergeDialog,
  });

  const mergeCustomerOptions = useMemo(() => {
    if (!activeCustomersData?.data) return [];
    return activeCustomersData.data
      .filter((c) => c.id !== customerId)
      .map((c) => ({
        value: c.id.toString(),
        label: c.name,
        sublabel: c.address,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, "de"));
  }, [activeCustomersData, customerId]);

  const declineErstberatung = useMutation({
    mutationFn: async (payload: { note?: string }) => {
      const result = await api.post(`/admin/customers/${customerId}/decline-erstberatung`, payload);
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "customers");
      queryClient.invalidateQueries({ queryKey: ["conversion-readiness", customerId] });
      toast({ title: "Erstberatung abgelehnt", description: "Der Kunde wurde als inaktiv markiert." });
      setShowDeactivateDialog(false);
      setDeactivationNote("");
    },
    onError: (err: Error) => {
      toast({ title: "Fehler", description: err.message, variant: "destructive" });
    },
  });

  const mergeErstberatung = useMutation({
    mutationFn: async (payload: { targetCustomerId: number; note?: string }) => {
      const result = await api.post(`/admin/customers/${customerId}/merge-erstberatung`, payload);
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "customers");
      queryClient.invalidateQueries({ queryKey: ["conversion-readiness", customerId] });
      toast({ title: "Erfolgreich zusammengeführt", description: "Der Erstberatungskunde wurde mit dem bestehenden Kunden zusammengeführt." });
      setShowMergeDialog(false);
      setMergeTargetId("");
      setMergeNote("");
    },
    onError: (err: Error) => {
      toast({ title: "Fehler", description: err.message, variant: "destructive" });
    },
  });

  const updateStatus = useMutation({
    mutationFn: async (payload: { status: string; deactivationReason?: string | null; deactivationNote?: string | null; inaktivAb?: string | null }) => {
      const result = await api.patch(`/admin/customers/${customerId}`, payload);
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "customers");
      queryClient.invalidateQueries({ queryKey: ["conversion-readiness", customerId] });
      queryClient.invalidateQueries({ queryKey: ["deactivation-readiness", customerId] });
      toast({ title: "Kundenstatus aktualisiert" });
      setShowDeactivateDialog(false);
      setDeactivationNote("");
    },
    onError: (err: Error) => {
      toast({ title: "Fehler", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <Layout variant="admin">
        <div className="flex items-center justify-center min-h-[50vh]">
          <Loader2 className={`${iconSize.lg} animate-spin text-teal-600`} />
        </div>
      </Layout>
    );
  }

  if (error || !customer) {
    return (
      <Layout variant="admin">
        <PageHeader
          title="Fehler"
          backHref="/admin/customers"
        />
        <SectionCard className="border-red-200 bg-red-50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <AlertCircle className={`${iconSize.lg} text-red-600`} />
              <div>
                <p className="font-medium text-red-800">Fehler beim Laden</p>
                <p className="text-red-700">
                  {error instanceof Error ? error.message : "Kunde konnte nicht geladen werden"}
                </p>
              </div>
            </div>
            <Button variant="outline" onClick={() => refetch()}>
              Erneut versuchen
            </Button>
          </div>
        </SectionCard>
      </Layout>
    );
  }

  const customerDisplayName = customer.vorname && customer.nachname 
    ? `${customer.vorname} ${customer.nachname}` 
    : customer.name;

  return (
    <Layout variant="admin">
          <PageHeader
            title={customerDisplayName}
            backHref="/admin/customers"
            badge={
              <>
                {customer.status === "erstberatung" && (
                  <StatusBadge type="status" value="Erstberatung" />
                )}
                {customer.status === "inaktiv" && (
                  <StatusBadge type="warning" value="Inaktiv" />
                )}
                {customer.status === "aktiv" && customer.inaktivAb && (
                  <StatusBadge type="info" value="Auslaufend" data-testid="badge-auslaufend" />
                )}
                {customer.billingType && (
                  <StatusBadge type="billingType" value={customer.billingType} data-testid="badge-billingtype" />
                )}
                {customer.pflegegrad !== null && customer.pflegegrad > 0 && (
                  <>
                    <StatusBadge type="pflegegrad" value={customer.pflegegrad} />
                    {(() => {
                      const current = customer.careLevelHistory?.find((h: { validTo: string | null }) => !h.validTo);
                      if (current?.validFrom) {
                        return (
                          <span className="text-xs text-gray-500" data-testid="text-pflegegrad-seit">
                            seit {formatDateForDisplay(current.validFrom, { month: "2-digit", year: "numeric" })}
                          </span>
                        );
                      }
                      return null;
                    })()}
                  </>
                )}
                {isChild(customer.geburtsdatum) && (
                  <StatusBadge type="warning" value="Minderjährig" data-testid="badge-minor" />
                )}
              </>
            }
            actions={undefined}
          />

          {customer.status === "erstberatung" && (
            <ErstberatungConversionSection
              customerId={customerId}
              onActivate={() => updateStatus.mutate({ status: "aktiv" })}
              onReject={() => {
                setDeactivationNote("");
                setShowDeactivateDialog(true);
              }}
              onMerge={() => setShowMergeDialog(true)}
              isUpdating={updateStatus.isPending}
              isMerging={mergeErstberatung.isPending}
            />
          )}

          {customer.status === "aktiv" && customer.inaktivAb && (
            <SectionCard className="mb-4 border-blue-200 bg-blue-50">
              <div className="flex items-center gap-2">
                <p className="text-sm text-blue-800">
                  <span className="font-medium">Vertragsende {formatDateForDisplay(customer.inaktivAb)}:</span>{" "}
                  Vertrag läuft aus. Details und Deaktivierungsstatus im Vertrag-Tab.
                </p>
              </div>
            </SectionCard>
          )}

          {customer.status === "inaktiv" && (
            <SectionCard className={`mb-4 ${customer.deactivationReason === "zusammengefuehrt" ? "border-green-200 bg-green-50" : "border-amber-200 bg-amber-50"}`}>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className={`font-medium ${customer.deactivationReason === "zusammengefuehrt" ? "text-green-900" : "text-amber-900"}`}>
                    {customer.deactivationReason === "zusammengefuehrt" ? "Erfolgreich übernommen" : "Inaktiver Kunde"}
                  </p>
                  <p className={`text-sm mt-0.5 ${customer.deactivationReason === "zusammengefuehrt" ? "text-green-700" : "text-amber-700"}`}>
                    {customer.deactivationReason === "zusammengefuehrt"
                      ? "Dieser Erstberatungskunde wurde mit einem bestehenden Kunden zusammengeführt."
                      : customer.inaktivAb
                        ? `Inaktiv ab ${formatDateForDisplay(customer.inaktivAb)}. Keine neuen Termine ab diesem Datum.`
                        : "Dieser Kunde ist deaktiviert und kann keine neuen Termine erhalten."}
                  </p>
                  {customer.deactivationReason === "zusammengefuehrt" && customer.mergedIntoCustomerId && (
                    <p className="text-sm text-green-700 mt-1" data-testid="text-merged-into">
                      <span className="font-medium">Zusammengeführt mit:</span>{" "}
                      <a
                        href={`/admin/customers/${customer.mergedIntoCustomerId}`}
                        className="underline hover:text-green-900"
                        data-testid="link-merged-customer"
                      >
                        Kunde #{customer.mergedIntoCustomerId} anzeigen
                      </a>
                    </p>
                  )}
                  {customer.deactivationReason && customer.deactivationReason !== "zusammengefuehrt" && (
                    <p className="text-sm text-amber-700 mt-1" data-testid="text-deactivation-reason">
                      <span className="font-medium">Grund:</span>{" "}
                      {DEACTIVATION_REASON_LABELS[customer.deactivationReason as DeactivationReason] || customer.deactivationReason}
                      {customer.deactivationReason === "sonstiges" && customer.deactivationNote && (
                        <span> — {customer.deactivationNote}</span>
                      )}
                    </p>
                  )}
                  {customer.deactivationReason !== "sonstiges" && customer.deactivationReason !== "zusammengefuehrt" && customer.deactivationNote && (
                    <p className="text-sm text-amber-700 mt-0.5" data-testid="text-deactivation-note">
                      <span className="font-medium">Anmerkung:</span> {customer.deactivationNote}
                    </p>
                  )}
                  {customer.deactivationReason === "zusammengefuehrt" && customer.deactivationNote && (
                    <p className="text-sm text-green-700 mt-0.5" data-testid="text-merge-note">
                      <span className="font-medium">Anmerkung:</span> {customer.deactivationNote}
                    </p>
                  )}
                </div>
                {customer.deactivationReason !== "zusammengefuehrt" && (
                  <Button
                    variant="outline"
                    onClick={() => updateStatus.mutate({ status: "aktiv", deactivationReason: null, deactivationNote: null })}
                    disabled={updateStatus.isPending}
                    data-testid="button-reactivate-customer"
                  >
                    {updateStatus.isPending ? (
                      <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                    ) : (
                      <UserCheck className={`${iconSize.sm} mr-2`} />
                    )}
                    Reaktivieren
                  </Button>
                )}
              </div>
            </SectionCard>
          )}

          <ResponsiveTabs
            tabs={[
              { value: "overview", label: "Übersicht", testId: "tab-overview" },
              { value: "vertrag", label: "Vertrag", testId: "tab-vertrag" },
              { value: "documents", label: "Dokumente", testId: "tab-documents" },
              { value: "contacts", label: "Kontakte", testId: "tab-contacts" },
              { value: "budgets", label: "Budgets", testId: "tab-budgets" },
              { value: "insurance", label: "Versicherung", testId: "tab-insurance" },
            ]}
            value={activeTab}
            onValueChange={handleTabChange}
            mobileVisibleCount={6}
          >

            <TabsContent value="overview" className="space-y-4">
              <CustomerOverviewTab customer={customer} customerId={customerId} />
            </TabsContent>

            <TabsContent value="vertrag" className="space-y-4">
              <CustomerContractTab customer={customer} customerId={customerId} />
            </TabsContent>

            <TabsContent value="documents" className="space-y-4">
              <SectionCard
                title="Kundendokumente"
                icon={<FileCheck2 className={iconSize.sm} />}
              >
                <CustomerDocumentsSection
                  customerId={customerId}
                  customerName={customerDisplayName}
                />
              </SectionCard>
            </TabsContent>

            <TabsContent value="contacts" className="space-y-4">
              <CustomerContactsTab
                customerId={customerId}
                initialContacts={customer.contacts}
              />
            </TabsContent>

            <TabsContent value="budgets" className="space-y-4">
              <BudgetsTabContent
                customerId={customerId}
                customerDisplayName={customerDisplayName}
                pflegegrad={customer.pflegegrad ?? undefined}
                careLevelHistory={customer.careLevelHistory}
                onRefresh={refetch}
              />
            </TabsContent>

            <TabsContent value="insurance" className="space-y-4">
              <CustomerInsuranceTab
                customerId={customerId}
                currentInsurance={customer.currentInsurance}
              />
            </TabsContent>
          </ResponsiveTabs>

          <Dialog open={showMergeDialog} onOpenChange={(open) => {
            if (!open) {
              setShowMergeDialog(false);
              setMergeTargetId("");
              setMergeNote("");
            }
          }}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Mit bestehendem Kunden zusammenführen</DialogTitle>
                <DialogDescription>
                  Wählen Sie den aktiven Kunden aus, mit dem dieser Erstberatungskunde zusammengeführt werden soll. Der Erstberatungskunde wird als erfolgreich übernommen markiert.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-2">
                <div className="space-y-2">
                  <Label>Bestehender Kunde *</Label>
                  <SearchableSelect
                    options={mergeCustomerOptions}
                    value={mergeTargetId}
                    onValueChange={setMergeTargetId}
                    placeholder="Kunde auswählen..."
                    searchPlaceholder="Kunde suchen..."
                    emptyText="Keine aktiven Kunden gefunden."
                    data-testid="select-merge-target"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="merge-note">Anmerkung (optional)</Label>
                  <Textarea
                    id="merge-note"
                    value={mergeNote}
                    onChange={(e) => setMergeNote(e.target.value)}
                    placeholder="z.B. Bereits bestehender Kunde aus früherer Betreuung..."
                    maxLength={500}
                    rows={2}
                    data-testid="textarea-merge-note"
                  />
                </div>
              </div>
              <DialogFooter className="gap-2 sm:gap-0">
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowMergeDialog(false);
                    setMergeTargetId("");
                    setMergeNote("");
                  }}
                  data-testid="button-cancel-merge"
                >
                  Abbrechen
                </Button>
                <Button
                  onClick={() => {
                    mergeErstberatung.mutate({
                      targetCustomerId: parseInt(mergeTargetId),
                      note: mergeNote.trim() || undefined,
                    });
                  }}
                  disabled={!mergeTargetId || mergeErstberatung.isPending}
                  className={componentStyles.btnPrimary}
                  data-testid="button-confirm-merge"
                >
                  {mergeErstberatung.isPending ? (
                    <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                  ) : (
                    <Merge className={`${iconSize.sm} mr-2`} />
                  )}
                  Zusammenführen
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog open={showDeactivateDialog} onOpenChange={(open) => {
            if (!open) {
              setShowDeactivateDialog(false);
              setDeactivationNote("");
            }
          }}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Erstberatung ablehnen</DialogTitle>
                <DialogDescription>
                  Bitte geben Sie einen Grund an, warum dieser Erstberatungskunde abgelehnt wird.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-2">
                <div className="space-y-2">
                  <Label htmlFor="deactivation-note">Anmerkung (optional)</Label>
                  <Textarea
                    id="deactivation-note"
                    value={deactivationNote}
                    onChange={(e) => setDeactivationNote(e.target.value)}
                    placeholder="Optionale Anmerkung..."
                    maxLength={1000}
                    rows={3}
                    data-testid="textarea-deactivation-note"
                  />
                </div>
              </div>
              <DialogFooter className="gap-2 sm:gap-0">
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowDeactivateDialog(false);
                    setDeactivationNote("");
                  }}
                  data-testid="button-cancel-deactivation"
                >
                  Abbrechen
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    declineErstberatung.mutate({
                      note: deactivationNote.trim() || undefined,
                    });
                  }}
                  disabled={declineErstberatung.isPending}
                  data-testid="button-confirm-deactivation"
                >
                  {declineErstberatung.isPending ? (
                    <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                  ) : (
                    <UserX className={`${iconSize.sm} mr-2`} />
                  )}
                  Ablehnen
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
    </Layout>
  );
}
