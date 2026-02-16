/**
 * Admin Customer Detail Page
 * 
 * Displays comprehensive customer information with tabbed interface
 * for contacts, insurance, budgets, services, and history.
 * Uses design system patterns for consistent styling.
 */

import { useState } from "react";
import { Link, useParams } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
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
  Edit,
  Euro,
  AlertCircle,
  Settings,
  FileCheck2,
  CreditCard,
  UserCheck,
  UserX,
} from "lucide-react";
import { BudgetLedgerSection } from "@/components/budget/BudgetLedgerSection";
import { BudgetTypeSettings } from "@/components/budget/BudgetTypeSettings";
import { CustomerOverviewTab } from "./components/customer-overview-tab";
import { CustomerInsuranceTab } from "./components/customer-insurance-tab";
import { PricingSection } from "./components/customer-pricing-section";
import { CustomerDocumentsSection } from "./components/customer-documents-section";
import { CustomerContactsTab } from "./components/customer-contacts-tab";

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

interface BudgetSummary {
  availableCents: number;
  totalUsedCents: number;
  monthlyLimitCents: number | null;
  currentMonthUsedCents: number;
}

function BudgetsTabContent({
  customerId,
  customerDisplayName,
  acceptsPrivatePayment,
  pflegegrad,
  isToggling,
  onTogglePrivatePayment,
  onRefresh,
}: {
  customerId: number;
  customerDisplayName: string;
  acceptsPrivatePayment: boolean;
  pflegegrad?: number;
  isToggling: boolean;
  onTogglePrivatePayment: (checked: boolean) => void;
  onRefresh: () => void;
}) {
  const { data: budget } = useQuery<BudgetSummary>({
    queryKey: ["budget-summary", customerId],
    queryFn: async () => {
      const response = await fetch(`/api/budget/${customerId}/summary`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Budget-Zusammenfassung konnte nicht geladen werden");
      return response.json();
    },
    staleTime: 30000,
  });

  return (
    <>
      <SectionCard
        title="Abrechnung"
        icon={<CreditCard className={iconSize.sm} />}
      >
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <p className="text-sm font-medium text-gray-700">Private Zuzahlung</p>
              <p className="text-xs text-gray-500">
                Restbeträge über das Budget hinaus werden privat mit MwSt. berechnet
              </p>
            </div>
            <Switch
              checked={acceptsPrivatePayment}
              onCheckedChange={onTogglePrivatePayment}
              disabled={isToggling}
              data-testid="switch-accepts-private-payment"
            />
          </div>

          {budget && (
            <div className="border-t pt-3">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <p className="text-gray-500">Budget verfügbar</p>
                  <p className={`font-semibold ${budget.availableCents > 0 ? "text-green-700" : "text-red-600"}`} data-testid="text-budget-available">
                    {formatCents(budget.availableCents)}
                  </p>
                </div>
                <div>
                  <p className="text-gray-500">Verbraucht (gesamt)</p>
                  <p className="font-semibold text-gray-800" data-testid="text-budget-used">
                    {formatCents(budget.totalUsedCents)}
                  </p>
                </div>
                {budget.monthlyLimitCents !== null && (
                  <>
                    <div>
                      <p className="text-gray-500">Monatslimit</p>
                      <p className="font-medium text-gray-700">{formatCents(budget.monthlyLimitCents)}</p>
                    </div>
                    <div>
                      <p className="text-gray-500">Diesen Monat verbraucht</p>
                      <p className="font-medium text-gray-700">{formatCents(budget.currentMonthUsedCents)}</p>
                    </div>
                  </>
                )}
              </div>
              {budget.availableCents <= 0 && acceptsPrivatePayment && (
                <div className="mt-2 p-2 rounded bg-amber-50 border border-amber-200">
                  <p className="text-xs text-amber-800 font-medium">
                    <Wallet className="inline h-3 w-3 mr-1" />
                    Budget aufgebraucht — weitere Leistungen werden privat berechnet
                  </p>
                </div>
              )}
              {budget.availableCents <= 0 && !acceptsPrivatePayment && (
                <div className="mt-2 p-2 rounded bg-red-50 border border-red-200">
                  <p className="text-xs text-red-800 font-medium">
                    Budget aufgebraucht — private Zuzahlung ist nicht aktiviert
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </SectionCard>

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
    </>
  );
}

export default function AdminCustomerDetail() {
  const { id } = useParams<{ id: string }>();
  const customerId = parseInt(id || "0");

  const { data: customer, isLoading, error, refetch } = useCustomer(customerId);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isToggling, setIsToggling] = useState(false);

  const updateStatus = useMutation({
    mutationFn: async (status: string) => {
      const result = await api.patch(`/admin/customers/${customerId}`, { status });
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: customerKeys.detail(customerId) });
      queryClient.invalidateQueries({ queryKey: customerKeys.lists() });
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      toast({ title: "Kundenstatus aktualisiert" });
    },
    onError: (err: Error) => {
      toast({ title: "Fehler", description: err.message, variant: "destructive" });
    },
  });

  const togglePrivatePayment = useMutation({
    mutationFn: async (accepts: boolean) => {
      setIsToggling(true);
      const result = await api.patch(`/admin/customers/${customerId}`, {
        acceptsPrivatePayment: accepts,
      });
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: customerKeys.detail(customerId) });
      toast({ title: "Abrechnungseinstellung aktualisiert" });
      setIsToggling(false);
    },
    onError: (err: Error) => {
      toast({ title: "Fehler", description: err.message, variant: "destructive" });
      setIsToggling(false);
    },
  });

  if (isLoading) {
    return (
      <Layout>
        <div className="min-h-screen bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4] flex items-center justify-center">
          <Loader2 className={`${iconSize.lg} animate-spin text-teal-600`} />
        </div>
      </Layout>
    );
  }

  if (error || !customer) {
    return (
      <Layout>
        <div className="min-h-screen bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]">
          <div className="container mx-auto px-4 py-6 max-w-4xl">
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
          </div>
        </div>
      </Layout>
    );
  }

  const customerDisplayName = customer.vorname && customer.nachname 
    ? `${customer.vorname} ${customer.nachname}` 
    : customer.name;

  return (
    <Layout>
      <div className="min-h-screen bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]">
        <div className="container mx-auto px-4 py-6 max-w-4xl">
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
                        const d = new Date(current.validFrom);
                        return (
                          <span className="text-xs text-gray-500" data-testid="text-pflegegrad-seit">
                            seit {d.toLocaleDateString("de-DE", { month: "2-digit", year: "numeric" })}
                          </span>
                        );
                      }
                      return null;
                    })()}
                  </>
                )}
              </>
            }
            actions={
              <Link href={`/admin/customers/${customerId}/edit`}>
                <Button variant="outline" className={`bg-white ${componentStyles.pageHeaderActionBtn}`} data-testid="button-edit-customer">
                  <Edit className={`${iconSize.sm} mr-2`} />
                  Bearbeiten
                </Button>
              </Link>
            }
          />

          {customer.status === "erstberatung" && (
            <SectionCard className="mb-4 border-teal-200 bg-teal-50">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="font-medium text-teal-900">Erstberatungskunde</p>
                  <p className="text-sm text-teal-700 mt-0.5">
                    Diesen Kunden aktivieren, um reguläre Kundentermine erstellen zu können.
                  </p>
                </div>
                <Button
                  onClick={() => updateStatus.mutate("aktiv")}
                  disabled={updateStatus.isPending}
                  className={componentStyles.btnPrimary}
                  data-testid="button-activate-customer"
                >
                  {updateStatus.isPending ? (
                    <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                  ) : (
                    <UserCheck className={`${iconSize.sm} mr-2`} />
                  )}
                  Kunde aktivieren
                </Button>
              </div>
            </SectionCard>
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
                    if (window.confirm("Möchten Sie diesen Kunden wirklich deaktivieren? Er kann keine neuen Termine mehr erhalten.")) {
                      updateStatus.mutate("inaktiv");
                    }
                  }}
                  disabled={updateStatus.isPending}
                  data-testid="button-deactivate-customer"
                >
                  {updateStatus.isPending ? (
                    <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                  ) : (
                    <UserX className={`${iconSize.sm} mr-2`} />
                  )}
                  Deaktivieren
                </Button>
              </div>
            </SectionCard>
          )}

          {customer.status === "inaktiv" && (
            <SectionCard className="mb-4 border-amber-200 bg-amber-50">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="font-medium text-amber-900">Inaktiver Kunde</p>
                  <p className="text-sm text-amber-700 mt-0.5">
                    Dieser Kunde ist deaktiviert und kann keine neuen Termine erhalten.
                  </p>
                </div>
                <Button
                  variant="outline"
                  onClick={() => updateStatus.mutate("aktiv")}
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
              { value: "documents", label: "Dokumente", testId: "tab-documents" },
              { value: "contacts", label: "Kontakte", testId: "tab-contacts" },
              { value: "budgets", label: "Budgets", testId: "tab-budgets" },
              { value: "insurance", label: "Versicherung", testId: "tab-insurance" },
            ]}
            defaultValue="overview"
            mobileVisibleCount={5}
          >

            <TabsContent value="overview" className="space-y-4">
              <CustomerOverviewTab customer={customer} />
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
                acceptsPrivatePayment={customer.acceptsPrivatePayment ?? false}
                pflegegrad={customer.pflegegrad ?? undefined}
                isToggling={isToggling}
                onTogglePrivatePayment={(checked) => togglePrivatePayment.mutate(checked)}
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
        </div>
      </div>
    </Layout>
  );
}
