/**
 * Admin Customer Detail Page
 * 
 * Displays comprehensive customer information with tabbed interface
 * for contacts, insurance, budgets, services, and history.
 * Uses design system patterns for consistent styling.
 */

import { useState } from "react";
import { Link, useParams } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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

export default function AdminCustomerDetail() {
  const { id } = useParams<{ id: string }>();
  const customerId = parseInt(id || "0");

  const { data: customer, isLoading, error, refetch } = useCustomer(customerId);

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

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isToggling, setIsToggling] = useState(false);
  const budget = customer.budgetSummary;

  const togglePrivatePayment = useMutation({
    mutationFn: async (accepts: boolean) => {
      setIsToggling(true);
      const result = await api.patch(`/admin/customers/${customer.id}`, {
        acceptsPrivatePayment: accepts,
      });
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: customerKeys.detail(customer.id) });
      toast({ title: "Abrechnungseinstellung aktualisiert" });
      setIsToggling(false);
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
      setIsToggling(false);
    },
  });

  return (
    <Layout>
      <div className="min-h-screen bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]">
        <div className="container mx-auto px-4 py-6 max-w-4xl">
          <PageHeader
            title={customerDisplayName}
            backHref="/admin/customers"
            badge={
              <>
                {customer.pflegegrad !== null && customer.pflegegrad > 0 && (
                  <StatusBadge type="pflegegrad" value={customer.pflegegrad} />
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
                      checked={customer.acceptsPrivatePayment ?? false}
                      onCheckedChange={(checked) => togglePrivatePayment.mutate(checked)}
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
                      {budget.availableCents <= 0 && customer.acceptsPrivatePayment && (
                        <div className="mt-2 p-2 rounded bg-amber-50 border border-amber-200">
                          <p className="text-xs text-amber-800 font-medium">
                            <Wallet className="inline h-3 w-3 mr-1" />
                            Budget aufgebraucht — weitere Leistungen werden privat berechnet
                          </p>
                        </div>
                      )}
                      {budget.availableCents <= 0 && !customer.acceptsPrivatePayment && (
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
                <BudgetTypeSettings customerId={customerId} pflegegrad={customer.pflegegrad ?? undefined} />
              </SectionCard>

              <SectionCard
                title="§45b Entlastungsbetrag"
                icon={<Wallet className={iconSize.sm} />}
              >
                <BudgetLedgerSection 
                  customerId={customerId} 
                  customerName={customerDisplayName}
                  initialSummary={customer.budgetSummary}
                  onRefresh={refetch}
                />
              </SectionCard>

              <SectionCard
                title="Preisvereinbarung"
                icon={<Euro className={iconSize.sm} />}
              >
                <PricingSection 
                  customerId={customerId} 
                  customerName={customerDisplayName}
                  onRefresh={refetch}
                />
              </SectionCard>
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
