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
import { DEACTIVATION_REASON_LABELS, isPflegekasseCustomer, getVisibleTabs, getEffectiveTab, CUSTOMER_DETAIL_TABS, type DeactivationReason } from "@shared/domain/customers";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
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
  Trash2,
  AlertTriangle,
  ChevronRight,
} from "lucide-react";
import { BudgetLedgerSection } from "@/components/budget/BudgetLedgerSection";
import { BudgetTypeSettings } from "@/components/budget/BudgetTypeSettings";
import { PflegegradBudgetSection } from "@/components/budget/PflegegradBudgetSection";
import { CustomerOverviewTab } from "@/features/customers/components/admin/customer-overview-tab";
import { CustomerInsuranceTab } from "@/features/customers/components/admin/customer-insurance-tab";
import { PricingSection } from "@/features/customers/components/admin/customer-pricing-section";
import { CustomerDocumentsSection } from "@/features/customers/components/admin/customer-documents-section-admin";
import { CustomerContactsTab } from "@/features/customers/components/admin/customer-contacts-tab";
import { CustomerContractTab } from "@/features/customers/components/admin/customer-contract-tab";
import { CustomerTimeline } from "@/features/customers/components/customer-timeline";


interface CustomerListItem {
  id: number;
  name: string;
  status: string;
  address: string;
}

import {
  type SetupPendingCustomerLike,
  SetupPendingBanner,
  BudgetsTabContent,
} from "@/features/customers/components/admin/customer-detail-sections";

export default function AdminCustomerDetail() {
  const { id } = useParams<{ id: string }>();
  const customerId = parseInt(id || "0");
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const activeTab = useMemo(() => {
    const params = new URLSearchParams(searchString);
    const tab = params.get("tab");
    if (tab && (CUSTOMER_DETAIL_TABS as readonly string[]).includes(tab)) return tab;
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

  const isSelbstzahler = customer?.billingType === "selbstzahler";
  const visibleTabs = useMemo(() => getVisibleTabs(customer?.billingType), [isSelbstzahler]);

  const effectiveTab = useMemo(() => getEffectiveTab(activeTab, customer?.billingType), [activeTab, isSelbstzahler]);

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isSuperAdmin = user?.isSuperAdmin ?? false;
  const [dangerZoneOpen, setDangerZoneOpen] = useState(false);
  const [hardDeleteDialogOpen, setHardDeleteDialogOpen] = useState(false);
  const [hardDeleteReason, setHardDeleteReason] = useState("");
  const [hardDeleteConfirmName, setHardDeleteConfirmName] = useState("");
  const [hardDeleting, setHardDeleting] = useState(false);
  const [hardDeleteConflict, setHardDeleteConflict] = useState<Array<{ key: string; label: string; count: number; met: boolean }> | null>(null);
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


  interface HardDeleteCheck { key: string; label: string; count: number; met: boolean }
  interface HardDeleteReadiness { ready: boolean; checks: HardDeleteCheck[] }

  const { data: hardDeleteReadiness, isLoading: hardDeleteLoading, refetch: refetchHardDeleteReadiness } = useQuery<HardDeleteReadiness>({
    queryKey: ["hard-delete-readiness", customerId],
    queryFn: async () => {
      const result = await api.get<HardDeleteReadiness>(`/admin/customers/${customerId}/hard-delete-readiness`);
      return unwrapResult(result);
    },
    enabled: !!customerId && isSuperAdmin && dangerZoneOpen,
  });

  const handleHardDelete = async () => {
    if (!customerId || !customer) return;
    setHardDeleting(true);
    setHardDeleteConflict(null);
    try {
      const response = await fetch(`/api/admin/customers/${customerId}`, {
        method: "DELETE",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": document.cookie.split("; ").find((c) => c.startsWith("careconnect_csrf="))?.split("=")[1] ?? "",
        },
        body: JSON.stringify({ reason: hardDeleteReason, confirmName: hardDeleteConfirmName }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 409 && data?.details?.checks) {
          setHardDeleteConflict(data.details.checks);
          await refetchHardDeleteReadiness();
        }
        toast({
          title: "Löschen fehlgeschlagen",
          description: data?.message || `Fehler ${response.status}`,
          variant: "destructive",
        });
        return;
      }
      toast({
        title: "Kunde gelöscht",
        description: `"${customer.name}" wurde dauerhaft entfernt.`,
      });
      queryClient.removeQueries({ queryKey: ["customer", customerId] });
      invalidateRelated(queryClient, "customers");
      setHardDeleteDialogOpen(false);
      setLocation("/admin/customers");
    } catch (e) {
      toast({
        title: "Fehler",
        description: e instanceof Error ? e.message : "Unbekannter Fehler",
        variant: "destructive",
      });
    } finally {
      setHardDeleting(false);
    }
  };

  const updateStatus = useMutation({
    mutationFn: async (payload: { status: string; deactivationReason?: string | null; deactivationNote?: string | null; inaktivAb?: string | null }) => {
      const result = await api.patch(`/admin/customers/${customerId}`, payload);
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "customers");
      // invalidate-direct-allowed: customer-scoped readiness keys not covered by a domain
      // eslint-disable-next-line no-restricted-syntax
      queryClient.invalidateQueries({ queryKey: ["conversion-readiness", customerId] });
      // invalidate-direct-allowed: customer-scoped readiness keys not covered by a domain
      // eslint-disable-next-line no-restricted-syntax
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
                {customer.status === "inaktiv" && (
                  <StatusBadge type="warning" value="Inaktiv" />
                )}
                {customer.status === "aktiv" && customer.inaktivAb && (
                  <StatusBadge type="info" value="Auslaufend" data-testid="badge-auslaufend" />
                )}
                {customer.billingType && (
                  <StatusBadge type="billingType" value={customer.billingType} data-testid="badge-billingtype" />
                )}
                {!isSelbstzahler && customer.pflegegrad !== null && customer.pflegegrad > 0 && (
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

          <SetupPendingBanner customer={customer as unknown as SetupPendingCustomerLike} onRefresh={refetch} />

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
                      ? "Dieser Kunde wurde mit einem bestehenden Kunden zusammengeführt."
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
              { value: "timeline", label: "Verlauf", testId: "tab-timeline" },
            ].filter((t) => (visibleTabs as readonly string[]).includes(t.value))}
            value={effectiveTab}
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
                billingType={customer.billingType}
                onRefresh={refetch}
              />
            </TabsContent>

            <TabsContent value="insurance" className="space-y-4">
              <CustomerInsuranceTab
                customerId={customerId}
                customerBillingType={customer.billingType}
                currentInsurance={customer.currentInsurance}
              />
            </TabsContent>

            <TabsContent value="timeline" className="space-y-4">
              <CustomerTimeline customerId={customerId} />
            </TabsContent>
          </ResponsiveTabs>

          {isSuperAdmin && (
            <Card className="mt-4 border-red-200" data-testid="card-danger-zone">
              <CardContent className="p-4">
                <button
                  type="button"
                  onClick={() => setDangerZoneOpen((v) => !v)}
                  className="w-full flex items-center justify-between text-left"
                  data-testid="button-toggle-danger-zone"
                >
                  <h2 className="text-sm font-semibold flex items-center gap-2 text-red-700">
                    <AlertTriangle className="h-4 w-4" />
                    Gefahrenzone
                  </h2>
                  <ChevronRight className={`h-4 w-4 text-red-700 transition-transform ${dangerZoneOpen ? "rotate-90" : ""}`} />
                </button>

                {dangerZoneOpen && (
                  <div className="mt-3 space-y-3" data-testid="danger-zone-content">
                    <p className="text-xs text-muted-foreground">
                      Karteileichen (versehentlich angelegte Dubletten ohne operative Daten) können hier dauerhaft gelöscht werden. Diese Aktion ist <strong>nicht umkehrbar</strong>.
                    </p>

                    {hardDeleteLoading && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Voraussetzungen werden geprüft …
                      </div>
                    )}

                    {hardDeleteReadiness && (
                      <ul className="space-y-1 text-xs" data-testid="list-hard-delete-checks">
                        {hardDeleteReadiness.checks.map((c) => (
                          <li
                            key={c.key}
                            className={c.met ? "text-green-700" : "text-red-700"}
                            data-testid={`check-${c.key}`}
                          >
                            {c.met ? "✓" : "✗"} {c.label}
                            {c.count > 0 && !c.met && ` (${c.count})`}
                          </li>
                        ))}
                      </ul>
                    )}

                    {hardDeleteConflict && (
                      <div className="rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800" data-testid="text-hard-delete-conflict">
                        Löschen blockiert. Aktuelle Voraussetzungen:
                        <ul className="mt-1 space-y-0.5">
                          {hardDeleteConflict.map((c) => (
                            <li key={c.key}>
                              {c.met ? "✓" : "✗"} {c.label}
                              {c.count > 0 && !c.met && ` (${c.count})`}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {hardDeleteReadiness?.ready && (
                      <AlertDialog open={hardDeleteDialogOpen} onOpenChange={(o) => {
                        setHardDeleteDialogOpen(o);
                        if (!o) {
                          setHardDeleteReason("");
                          setHardDeleteConfirmName("");
                          setHardDeleteConflict(null);
                        }
                      }}>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="destructive"
                            size="sm"
                            data-testid="button-open-hard-delete"
                          >
                            <Trash2 className="h-4 w-4 mr-2" />
                            Kunde dauerhaft löschen
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Kunde endgültig löschen</AlertDialogTitle>
                            <AlertDialogDescription>
                              Du löschst <strong>{customer.name}</strong> dauerhaft aus der Datenbank. Diese Aktion ist nicht umkehrbar. Bitte gib einen Grund an und tippe den Namen zur Bestätigung.
                            </AlertDialogDescription>
                          </AlertDialogHeader>

                          <div className="space-y-3 py-2">
                            <div>
                              <Label htmlFor="hard-delete-reason" className="text-xs">Grund (mind. 10 Zeichen)</Label>
                              <Textarea
                                id="hard-delete-reason"
                                value={hardDeleteReason}
                                onChange={(e) => setHardDeleteReason(e.target.value)}
                                placeholder="Versehentlich angelegte Dublette …"
                                className="mt-1 text-xs"
                                rows={2}
                                data-testid="input-hard-delete-reason"
                              />
                            </div>
                            <div>
                              <Label htmlFor="hard-delete-confirm" className="text-xs">Name zur Bestätigung tippen</Label>
                              <Input
                                id="hard-delete-confirm"
                                value={hardDeleteConfirmName}
                                onChange={(e) => setHardDeleteConfirmName(e.target.value)}
                                placeholder={customer.name}
                                className="mt-1 text-xs"
                                data-testid="input-hard-delete-confirm-name"
                              />
                            </div>
                          </div>

                          <AlertDialogFooter>
                            <AlertDialogCancel data-testid="button-hard-delete-cancel">Abbrechen</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={(e) => {
                                e.preventDefault();
                                handleHardDelete();
                              }}
                              disabled={
                                hardDeleting ||
                                hardDeleteReason.trim().length < 10 ||
                                hardDeleteConfirmName.trim() !== customer.name.trim()
                              }
                              className="bg-red-600 hover:bg-red-700"
                              data-testid="button-hard-delete-confirm"
                            >
                              {hardDeleting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                              Endgültig löschen
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

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
                  Wählen Sie den aktiven Kunden aus, mit dem dieser Kunde zusammengeführt werden soll. Der Kunde wird als erfolgreich übernommen markiert.
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
                    updateStatus.mutate(
                      { status: "inaktiv", deactivationReason: "zusammengefuehrt" as DeactivationReason, deactivationNote: mergeNote.trim() || null },
                      {
                        onSuccess: () => {
                          setShowMergeDialog(false);
                          setMergeTargetId("");
                          setMergeNote("");
                        },
                      }
                    );
                  }}
                  disabled={!mergeTargetId || updateStatus.isPending}
                  className={componentStyles.btnPrimary}
                  data-testid="button-confirm-merge"
                >
                  {updateStatus.isPending ? (
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
                <DialogTitle>Kunden deaktivieren</DialogTitle>
                <DialogDescription>
                  Bitte geben Sie einen Grund an, warum dieser Kunde deaktiviert wird.
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
                    updateStatus.mutate(
                      { status: "inaktiv", deactivationReason: "kein_interesse" as DeactivationReason, deactivationNote: deactivationNote.trim() || null },
                      {
                        onSuccess: () => {
                          setShowDeactivateDialog(false);
                          setDeactivationNote("");
                        },
                      }
                    );
                  }}
                  disabled={updateStatus.isPending}
                  data-testid="button-confirm-deactivation"
                >
                  {updateStatus.isPending ? (
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
