/**
 * Admin Customer Detail Page
 * 
 * Displays comprehensive customer information with tabbed interface
 * for contacts, insurance, budgets, services, and history.
 * Uses design system patterns for consistent styling.
 */

import { Link, useParams } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Layout } from "@/components/layout";
import { PageHeader } from "@/components/patterns/page-header";
import { SectionCard } from "@/components/patterns/section-card";
import { EmptyState } from "@/components/patterns/empty-state";
import { StatusBadge } from "@/components/patterns/status-badge";
import { ResponsiveTabs, TabsContent } from "@/components/patterns/responsive-tabs";
import { useCustomer } from "@/features/customers";
import { iconSize, componentStyles } from "@/design-system";
import {
  Loader2,
  Users,
  Wallet,
  Edit,
  Euro,
  AlertCircle,
  Settings,
  FileCheck2,
} from "lucide-react";
import { BudgetLedgerSection } from "@/components/budget/BudgetLedgerSection";
import { BudgetTypeSettings } from "@/components/budget/BudgetTypeSettings";
import { CustomerOverviewTab } from "./components/customer-overview-tab";
import { CustomerInsuranceTab } from "./components/customer-insurance-tab";
import { PricingSection } from "./components/customer-pricing-section";
import { CustomerDocumentsSection } from "./components/customer-documents-section";

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
              <SectionCard
                title="Ansprechpartner & Notfallkontakte"
                icon={<Users className={iconSize.sm} />}
                actions={
                  <Button size="sm" variant="outline" data-testid="button-add-contact">
                    Hinzufügen
                  </Button>
                }
              >
                {customer.contacts && customer.contacts.length > 0 ? (
                  <div className="space-y-3">
                    {customer.contacts.map((contact) => (
                      <div
                        key={contact.id}
                        className="flex items-center justify-between p-3 rounded-lg bg-gray-50"
                      >
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="font-medium">{contact.vorname} {contact.nachname}</p>
                            {contact.isPrimary && (
                              <Badge variant="secondary" className="text-xs">
                                Hauptkontakt
                              </Badge>
                            )}
                          </div>
                          <p className="text-sm text-gray-500">{contact.contactType}</p>
                          <p className="text-sm text-gray-600">{contact.telefon}</p>
                          {contact.email && (
                            <p className="text-sm text-gray-600">{contact.email}</p>
                          )}
                        </div>
                        <Button variant="ghost" size="sm">
                          <Edit className={iconSize.sm} />
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    icon={<Users className={iconSize.xl} />}
                    title="Keine Kontakte"
                    description="Noch keine Kontakte hinterlegt"
                    action={
                      <Button size="sm" className={componentStyles.btnPrimary}>
                        Kontakt hinzufügen
                      </Button>
                    }
                    className="py-6"
                  />
                )}
              </SectionCard>
            </TabsContent>

            <TabsContent value="budgets" className="space-y-4">
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
