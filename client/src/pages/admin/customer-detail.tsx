/**
 * Admin Customer Detail Page
 * 
 * Displays comprehensive customer information with tabbed interface
 * for contacts, insurance, budgets, and history.
 * Uses design system patterns for consistent styling.
 */

import { Link, useParams } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatDateForDisplay } from "@shared/utils/date";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Layout } from "@/components/layout";
import { PageHeader } from "@/components/patterns/page-header";
import { SectionCard } from "@/components/patterns/section-card";
import { EmptyState } from "@/components/patterns/empty-state";
import { StatusBadge } from "@/components/patterns/status-badge";
import { useCustomer } from "@/features/customers";
import { iconSize, getPflegegradColors, componentStyles } from "@/design-system";
import {
  Loader2,
  User2,
  MapPin,
  Phone,
  Mail,
  Heart,
  AlertCircle,
  Shield,
  Edit,
  History,
  Users,
  Wallet,
} from "lucide-react";

function formatAddress(customer: {
  strasse: string | null;
  nr: string | null;
  plz: string | null;
  stadt: string | null;
}): string {
  const parts = [];
  if (customer.strasse) {
    parts.push(`${customer.strasse}${customer.nr ? ` ${customer.nr}` : ""}`);
  }
  if (customer.plz || customer.stadt) {
    parts.push(`${customer.plz || ""} ${customer.stadt || ""}`.trim());
  }
  return parts.join(", ") || "Keine Adresse hinterlegt";
}

function formatBudget(cents: number): string {
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
  }).format(cents / 100);
}

function formatDate(dateStr: string): string {
  return formatDateForDisplay(dateStr);
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
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => refetch()}
                  data-testid="button-retry"
                >
                  Erneut versuchen
                </Button>
              </div>
            </SectionCard>
          </div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="min-h-screen bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]">
        <div className="container mx-auto px-4 py-6 max-w-4xl">
          <PageHeader
            title={customer.vorname && customer.nachname ? `${customer.vorname} ${customer.nachname}` : customer.name}
            backHref="/admin/customers"
            badge={
              <>
                {customer.pflegegrad !== null && customer.pflegegrad > 0 && (
                  <StatusBadge type="pflegegrad" value={customer.pflegegrad} />
                )}
                {customer.activeContractCount > 0 && (
                  <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                    {customer.activeContractCount} aktive{" "}
                    {customer.activeContractCount === 1 ? "Vertrag" : "Verträge"}
                  </Badge>
                )}
              </>
            }
            actions={
              <Button variant="outline" className="bg-white" data-testid="button-edit-customer">
                <Edit className={`${iconSize.sm} mr-2`} />
                Bearbeiten
              </Button>
            }
          />

          <Tabs defaultValue="overview" className="space-y-4">
            <div className="overflow-x-auto -mx-4 px-4">
              <TabsList className="bg-white w-max">
                <TabsTrigger value="overview" data-testid="tab-overview">Übersicht</TabsTrigger>
                <TabsTrigger value="contacts" data-testid="tab-contacts">Kontakte</TabsTrigger>
                <TabsTrigger value="insurance" data-testid="tab-insurance">Versicherung</TabsTrigger>
                <TabsTrigger value="budgets" data-testid="tab-budgets">Budgets</TabsTrigger>
                <TabsTrigger value="history" data-testid="tab-history">Historie</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="overview" className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <SectionCard
                  title="Kontaktdaten"
                  icon={<User2 className={iconSize.sm} />}
                >
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-gray-700">
                      <MapPin className={`${iconSize.sm} text-gray-400`} />
                      {formatAddress(customer)}
                    </div>
                    {(customer.telefon || customer.festnetz) && (
                      <div className="flex items-center gap-2 text-gray-700">
                        <Phone className={`${iconSize.sm} text-gray-400`} />
                        {customer.telefon || customer.festnetz}
                      </div>
                    )}
                    {customer.email && (
                      <div className="flex items-center gap-2 text-gray-700">
                        <Mail className={`${iconSize.sm} text-gray-400`} />
                        {customer.email}
                      </div>
                    )}
                  </div>
                </SectionCard>

                <SectionCard
                  title="Pflegekasse"
                  icon={<Heart className={iconSize.sm} />}
                >
                  {customer.currentInsurance ? (
                    <div className="space-y-2">
                      <p className="font-medium text-gray-900">
                        {customer.currentInsurance.providerName}
                      </p>
                      <p className="text-sm text-gray-600">
                        Vers.-Nr.: {customer.currentInsurance.versichertennummer}
                      </p>
                      <p className="text-xs text-gray-500">
                        Seit {formatDate(customer.currentInsurance.validFrom)}
                      </p>
                    </div>
                  ) : (
                    <p className="text-gray-500">Keine Pflegekasse hinterlegt</p>
                  )}
                </SectionCard>
              </div>

              {customer.needs && customer.needs.length > 0 && (
                <SectionCard
                  title="Besondere Bedürfnisse"
                  icon={<Shield className={iconSize.sm} />}
                >
                  <div className="flex flex-wrap gap-2">
                    {customer.needs.map((need, index) => (
                      <Badge key={index} variant="secondary">
                        {need}
                      </Badge>
                    ))}
                  </div>
                </SectionCard>
              )}
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
                    className="py-6"
                  />
                )}
              </SectionCard>
            </TabsContent>

            <TabsContent value="insurance" className="space-y-4">
              <SectionCard
                title="Aktuelle Pflegekasse"
                icon={<Heart className={iconSize.sm} />}
                actions={
                  <Button size="sm" variant="outline" data-testid="button-change-insurance">
                    Kasse wechseln
                  </Button>
                }
              >
                {customer.currentInsurance ? (
                  <div className="p-4 rounded-lg bg-blue-50 border border-blue-100">
                    <p className="font-medium text-gray-900">
                      {customer.currentInsurance.providerName}
                    </p>
                    <p className="text-sm text-gray-600 mt-1">
                      Versichertennummer: {customer.currentInsurance.versichertennummer}
                    </p>
                    <p className="text-xs text-gray-500 mt-2">
                      Gültig seit {formatDate(customer.currentInsurance.validFrom)}
                    </p>
                  </div>
                ) : (
                  <EmptyState
                    icon={<Heart className={iconSize.xl} />}
                    title="Keine Pflegekasse"
                    description="Keine Pflegekasse hinterlegt"
                    action={
                      <Button size="sm" className={componentStyles.btnPrimary}>
                        Pflegekasse hinzufügen
                      </Button>
                    }
                    className="py-6"
                  />
                )}
              </SectionCard>
            </TabsContent>

            <TabsContent value="budgets" className="space-y-4">
              <SectionCard
                title="Budgets & Leistungsansprüche"
                icon={<Wallet className={iconSize.sm} />}
                actions={
                  <Button size="sm" variant="outline" data-testid="button-update-budgets">
                    Aktualisieren
                  </Button>
                }
              >
                {customer.currentBudgets ? (
                  <div className="grid gap-4 md:grid-cols-3">
                    <div className="p-4 rounded-lg bg-green-50 border border-green-100">
                      <p className="text-sm text-gray-600">§45b Entlastungsbetrag</p>
                      <p className="text-xl font-semibold text-gray-900 mt-1">
                        {formatBudget(customer.currentBudgets.entlastungsbetrag45b)}
                      </p>
                      <p className="text-xs text-gray-500 mt-1">pro Monat</p>
                    </div>
                    <div className="p-4 rounded-lg bg-blue-50 border border-blue-100">
                      <p className="text-sm text-gray-600">§39 Verhinderungspflege</p>
                      <p className="text-xl font-semibold text-gray-900 mt-1">
                        {formatBudget(customer.currentBudgets.verhinderungspflege39)}
                      </p>
                      <p className="text-xs text-gray-500 mt-1">pro Jahr</p>
                    </div>
                    <div className="p-4 rounded-lg bg-purple-50 border border-purple-100">
                      <p className="text-sm text-gray-600">§36 Pflegesachleistungen</p>
                      <p className="text-xl font-semibold text-gray-900 mt-1">
                        {formatBudget(customer.currentBudgets.pflegesachleistungen36)}
                      </p>
                      <p className="text-xs text-gray-500 mt-1">pro Monat</p>
                    </div>
                  </div>
                ) : (
                  <EmptyState
                    icon={<Wallet className={iconSize.xl} />}
                    title="Keine Budgets"
                    description="Keine Budgets hinterlegt"
                    action={
                      <Button size="sm" className={componentStyles.btnPrimary}>
                        Budgets erfassen
                      </Button>
                    }
                    className="py-6"
                  />
                )}
              </SectionCard>
            </TabsContent>

            <TabsContent value="history" className="space-y-4">
              <SectionCard
                title="Pflegegrad-Verlauf"
                icon={<History className={iconSize.sm} />}
              >
                {customer.careLevelHistory && customer.careLevelHistory.length > 0 ? (
                  <div className="relative">
                    <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-gray-200" />
                    <div className="space-y-4">
                      {customer.careLevelHistory.map((entry, index) => (
                        <div key={entry.id} className="relative pl-10">
                          <div
                            className={`absolute left-2.5 w-3 h-3 rounded-full ${
                              index === 0 ? "bg-teal-500" : "bg-gray-300"
                            }`}
                          />
                          <div className="p-3 rounded-lg bg-gray-50">
                            <div className="flex items-center justify-between">
                              <StatusBadge type="pflegegrad" value={entry.pflegegrad} />
                              <span className="text-xs text-gray-500">
                                {formatDate(entry.validFrom)}
                                {entry.validTo && ` - ${formatDate(entry.validTo)}`}
                              </span>
                            </div>
                            {entry.notes && (
                              <p className="text-sm text-gray-600 mt-2">{entry.notes}</p>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <EmptyState
                    icon={<History className={iconSize.xl} />}
                    title="Kein Verlauf"
                    description="Kein Pflegegrad-Verlauf vorhanden"
                    className="py-6"
                  />
                )}
              </SectionCard>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </Layout>
  );
}
