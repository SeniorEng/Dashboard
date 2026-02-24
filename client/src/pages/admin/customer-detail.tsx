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
import { formatDateForDisplay } from "@shared/utils/datetime";
import { DEACTIVATION_REASON_SELECT_OPTIONS, DEACTIVATION_REASON_LABELS, type DeactivationReason } from "@shared/domain/customers";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Layout } from "@/components/layout";
import { PageHeader } from "@/components/patterns/page-header";
import { SectionCard } from "@/components/patterns/section-card";
import { StatusBadge } from "@/components/patterns/status-badge";
import { ResponsiveTabs, TabsContent } from "@/components/patterns/responsive-tabs";
import { useCustomer, customerKeys } from "@/features/customers";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api";
import { iconSize, componentStyles } from "@/design-system";
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
} from "lucide-react";
import { BudgetLedgerSection } from "@/components/budget/BudgetLedgerSection";
import { BudgetTypeSettings } from "@/components/budget/BudgetTypeSettings";
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

function ErstberatungConversionSection({
  customerId,
  onActivate,
  onReject,
  isUpdating,
}: {
  customerId: number;
  onActivate: () => void;
  onReject: () => void;
  isUpdating: boolean;
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

            <div className="flex items-center gap-2 pt-1">
              <Button
                onClick={onActivate}
                disabled={isUpdating || !readiness.ready}
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
                onClick={onReject}
                disabled={isUpdating}
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

  const { data: preview, isLoading: previewLoading } = useQuery<{
    totalAppointments: number;
    customerBreakdown: Record<string, { count: number; missingSignatures: number; dates: string[] }>;
  }>({
    queryKey: ["backfill-preview", customerId],
    queryFn: async () => {
      const res = await api.get(`/admin/budget/backfill-preview?customerId=${customerId}`);
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
      const res = await api.post("/admin/budget/backfill-transactions", { customerId });
      const data = unwrapResult(res) as { total: number; created: number; skipped: number; errors: number };
      setResult(data);
      queryClient.invalidateQueries({ queryKey: ["budget-summary", customerId] });
      queryClient.invalidateQueries({ queryKey: ["budget-transactions", customerId] });
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
    } catch (err: any) {
      toast({ variant: "destructive", title: "Fehler", description: err.message || "Nachbuchung fehlgeschlagen" });
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
            <strong>{count} Termin{count !== 1 ? "e" : ""}</strong> ohne Budget-Buchung gefunden.
            Diese Termine wurden importiert und haben den Dokumentationsprozess nicht durchlaufen.
          </p>
          <p className="text-xs text-amber-700 mt-1">
            Die Nachbuchung setzt "SYSTEMGENERIERT" als Unterschrift und erstellt die fehlenden Budget-Transaktionen.
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
  onRefresh,
}: {
  customerId: number;
  customerDisplayName: string;
  pflegegrad?: number;
  onRefresh: () => void;
}) {
  return (
    <>
      <SectionCard
        title="Budget-Einstellungen"
        icon={<Settings className={iconSize.sm} />}
      >
        <BudgetTypeSettings customerId={customerId} pflegegrad={pflegegrad} />
      </SectionCard>

      <SectionCard
        title="§45b Entlastungsbetrag"
        icon={<Wallet className={iconSize.sm} />}
      >
        <BudgetLedgerSection
          customerId={customerId}
          customerName={customerDisplayName}
          onRefresh={onRefresh}
        />
      </SectionCard>

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
  const [deactivationReason, setDeactivationReason] = useState<string>("");
  const [deactivationNote, setDeactivationNote] = useState<string>("");

  const updateStatus = useMutation({
    mutationFn: async (payload: { status: string; deactivationReason?: string; deactivationNote?: string }) => {
      const result = await api.patch(`/admin/customers/${customerId}`, payload);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: customerKeys.detail(customerId) });
      queryClient.invalidateQueries({ queryKey: customerKeys.lists() });
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      queryClient.invalidateQueries({ queryKey: ["conversion-readiness", customerId] });
      toast({ title: "Kundenstatus aktualisiert" });
      setShowDeactivateDialog(false);
      setDeactivationReason("");
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
              </>
            }
          />

          {customer.status === "erstberatung" && (
            <ErstberatungConversionSection
              customerId={customerId}
              onActivate={() => updateStatus.mutate({ status: "aktiv" })}
              onReject={() => {
                setDeactivationReason("kein_interesse");
                setDeactivationNote("");
                setShowDeactivateDialog(true);
              }}
              isUpdating={updateStatus.isPending}
            />
          )}

          {customer.status === "aktiv" && (
            <SectionCard className="mb-4 border-gray-200 bg-gray-50">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="font-medium text-gray-900">Aktiver Kunde</p>
                  <p className="text-sm text-gray-600 mt-0.5">
                    Kunde deaktivieren, wenn keine weiteren Leistungen mehr erbracht werden.
                  </p>
                </div>
                <Button
                  variant="outline"
                  onClick={() => {
                    setDeactivationReason("");
                    setDeactivationNote("");
                    setShowDeactivateDialog(true);
                  }}
                  disabled={updateStatus.isPending}
                  data-testid="button-deactivate-customer"
                >
                  <UserX className={`${iconSize.sm} mr-2`} />
                  Deaktivieren
                </Button>
              </div>
            </SectionCard>
          )}

          {customer.status === "aktiv" && customer.inaktivAb && (
            <SectionCard className="mb-4 border-blue-200 bg-blue-50">
              <div className="flex items-center gap-2">
                <p className="text-sm text-blue-800">
                  <span className="font-medium">Inaktiv ab {formatDateForDisplay(customer.inaktivAb)}:</span>{" "}
                  Ab diesem Datum können keine neuen Termine erstellt werden.
                </p>
              </div>
            </SectionCard>
          )}

          {customer.status === "inaktiv" && (
            <SectionCard className="mb-4 border-amber-200 bg-amber-50">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="font-medium text-amber-900">Inaktiver Kunde</p>
                  <p className="text-sm text-amber-700 mt-0.5">
                    {customer.inaktivAb
                      ? `Inaktiv ab ${formatDateForDisplay(customer.inaktivAb)}. Keine neuen Termine ab diesem Datum.`
                      : "Dieser Kunde ist deaktiviert und kann keine neuen Termine erhalten."}
                  </p>
                  {customer.deactivationReason && (
                    <p className="text-sm text-amber-700 mt-1" data-testid="text-deactivation-reason">
                      <span className="font-medium">Grund:</span>{" "}
                      {DEACTIVATION_REASON_LABELS[customer.deactivationReason as DeactivationReason] || customer.deactivationReason}
                      {customer.deactivationReason === "sonstiges" && customer.deactivationNote && (
                        <span> — {customer.deactivationNote}</span>
                      )}
                    </p>
                  )}
                  {customer.deactivationReason !== "sonstiges" && customer.deactivationNote && (
                    <p className="text-sm text-amber-700 mt-0.5" data-testid="text-deactivation-note">
                      <span className="font-medium">Anmerkung:</span> {customer.deactivationNote}
                    </p>
                  )}
                </div>
                <Button
                  variant="outline"
                  onClick={() => updateStatus.mutate({ status: "aktiv", deactivationReason: null as any, deactivationNote: null as any })}
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

          <Dialog open={showDeactivateDialog} onOpenChange={(open) => {
            if (!open) {
              setShowDeactivateDialog(false);
              setDeactivationReason("");
              setDeactivationNote("");
            }
          }}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Kunde deaktivieren</DialogTitle>
                <DialogDescription>
                  Bitte geben Sie einen Grund an, warum dieser Kunde deaktiviert wird. Dies dient der späteren Analyse.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-2">
                <div className="space-y-2">
                  <Label htmlFor="deactivation-reason">Grund *</Label>
                  <Select value={deactivationReason} onValueChange={setDeactivationReason}>
                    <SelectTrigger id="deactivation-reason" data-testid="select-deactivation-reason">
                      <SelectValue placeholder="Grund auswählen..." />
                    </SelectTrigger>
                    <SelectContent>
                      {DEACTIVATION_REASON_SELECT_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value} data-testid={`option-reason-${opt.value}`}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="deactivation-note">
                    {deactivationReason === "sonstiges" ? "Beschreibung *" : "Anmerkung (optional)"}
                  </Label>
                  <Textarea
                    id="deactivation-note"
                    value={deactivationNote}
                    onChange={(e) => setDeactivationNote(e.target.value)}
                    placeholder={deactivationReason === "sonstiges" ? "Bitte beschreiben Sie den Grund..." : "Optionale Anmerkung..."}
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
                    setDeactivationReason("");
                    setDeactivationNote("");
                  }}
                  data-testid="button-cancel-deactivation"
                >
                  Abbrechen
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    updateStatus.mutate({
                      status: "inaktiv",
                      deactivationReason: deactivationReason || undefined,
                      deactivationNote: deactivationNote.trim() || undefined,
                    });
                  }}
                  disabled={
                    !deactivationReason ||
                    (deactivationReason === "sonstiges" && !deactivationNote.trim()) ||
                    updateStatus.isPending
                  }
                  data-testid="button-confirm-deactivation"
                >
                  {updateStatus.isPending ? (
                    <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                  ) : (
                    <UserX className={`${iconSize.sm} mr-2`} />
                  )}
                  Deaktivieren
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
    </Layout>
  );
}
