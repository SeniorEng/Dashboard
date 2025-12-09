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
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateForDisplay } from "@shared/utils/date";
import { Layout } from "@/components/layout";
import { PageHeader } from "@/components/patterns/page-header";
import { SectionCard } from "@/components/patterns/section-card";
import { EmptyState } from "@/components/patterns/empty-state";
import { StatusBadge } from "@/components/patterns/status-badge";
import { ResponsiveTabs, TabsContent } from "@/components/patterns/responsive-tabs";
import { useCustomer } from "@/features/customers";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { iconSize, componentStyles } from "@/design-system";
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
  FileText,
  Calendar,
  ClipboardList,
  Euro,
  Car,
  Plus,
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

function formatRate(cents: number): string {
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
  }).format(cents / 100);
}

function formatDate(dateStr: string): string {
  return formatDateForDisplay(dateStr);
}

function formatPeriodType(type: string): string {
  switch (type) {
    case "week": return "Woche";
    case "month": return "Monat";
    case "year": return "Jahr";
    default: return type;
  }
}

interface PricingData {
  id: number;
  customerId: number;
  hauswirtschaftRateCents: number | null;
  alltagsbegleitungRateCents: number | null;
  kilometerRateCents: number | null;
  validFrom: string;
  validTo: string | null;
  createdAt: string;
}

function formatCentsToEuro(cents: number | null): string {
  if (cents === null) return "-";
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
  }).format(cents / 100);
}

function PricingSection({ customerId, customerName }: { customerId: number; customerName: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [newHauswirtschaftRate, setNewHauswirtschaftRate] = useState("");
  const [newAlltagsbegleitungRate, setNewAlltagsbegleitungRate] = useState("");
  const [newKilometerRate, setNewKilometerRate] = useState("");
  const todayDate = new Date().toISOString().split("T")[0];
  const [newValidFrom, setNewValidFrom] = useState(todayDate);

  const { data: pricingHistory, isLoading } = useQuery<PricingData[]>({
    queryKey: ["admin", "customers", customerId, "pricing"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/customers/${customerId}/pricing`, { credentials: "include" });
      if (!res.ok) throw new Error("Preishistorie konnte nicht geladen werden");
      return res.json();
    },
  });

  const addPricingMutation = useMutation({
    mutationFn: async (data: {
      hauswirtschaftRateCents?: number;
      alltagsbegleitungRateCents?: number;
      kilometerRateCents?: number;
      validFrom: string;
    }) => {
      const result = await api.post(`/admin/customers/${customerId}/pricing`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "customers", customerId, "pricing"] });
      setIsAddOpen(false);
      setNewHauswirtschaftRate("");
      setNewAlltagsbegleitungRate("");
      setNewKilometerRate("");
      setNewValidFrom(new Date().toISOString().split("T")[0]);
      toast({ title: "Preise hinzugefügt" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    addPricingMutation.mutate({
      hauswirtschaftRateCents: newHauswirtschaftRate ? Math.round(parseFloat(newHauswirtschaftRate) * 100) : undefined,
      alltagsbegleitungRateCents: newAlltagsbegleitungRate ? Math.round(parseFloat(newAlltagsbegleitungRate) * 100) : undefined,
      kilometerRateCents: newKilometerRate ? Math.round(parseFloat(newKilometerRate) * 100) : undefined,
      validFrom: newValidFrom,
    });
  };

  const today = new Date().toISOString().split("T")[0];
  const currentPricing = pricingHistory?.find(p => 
    p.validFrom <= today && (!p.validTo || p.validTo >= today)
  );

  return (
    <div className="mt-6 pt-6 border-t">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
          <Euro className={iconSize.sm} />
          Preise
        </h3>
        <Button 
          variant="outline" 
          size="sm" 
          onClick={() => setIsAddOpen(!isAddOpen)}
          data-testid="button-add-pricing"
        >
          <Plus className={`${iconSize.sm} mr-1`} />
          Neue Preise
        </Button>
      </div>

      {isAddOpen && (
        <form onSubmit={handleAddSubmit} className="mb-4 p-4 bg-gray-50 rounded-lg space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="new-hauswirtschaft-rate">Hauswirtschaft</Label>
              <div className="relative">
                <Input
                  id="new-hauswirtschaft-rate"
                  type="number"
                  step="0.01"
                  min="0"
                  value={newHauswirtschaftRate}
                  onChange={(e) => setNewHauswirtschaftRate(e.target.value)}
                  placeholder="z.B. 35.00"
                  className="pr-10"
                  data-testid="input-new-hauswirtschaft-rate"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">€/h</span>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-alltagsbegleitung-rate">Alltagsbegleitung</Label>
              <div className="relative">
                <Input
                  id="new-alltagsbegleitung-rate"
                  type="number"
                  step="0.01"
                  min="0"
                  value={newAlltagsbegleitungRate}
                  onChange={(e) => setNewAlltagsbegleitungRate(e.target.value)}
                  placeholder="z.B. 35.00"
                  className="pr-10"
                  data-testid="input-new-alltagsbegleitung-rate"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">€/h</span>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-kilometer-rate">Kilometerpreis</Label>
              <div className="relative">
                <Input
                  id="new-kilometer-rate"
                  type="number"
                  step="0.01"
                  min="0"
                  value={newKilometerRate}
                  onChange={(e) => setNewKilometerRate(e.target.value)}
                  placeholder="z.B. 0.50"
                  className="pr-12"
                  data-testid="input-new-kilometer-rate"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">€/km</span>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-pricing-valid-from">Gültig ab *</Label>
            <Input
              id="new-pricing-valid-from"
              type="date"
              value={newValidFrom}
              onChange={(e) => setNewValidFrom(e.target.value)}
              min={todayDate}
              required
              data-testid="input-new-pricing-valid-from"
            />
            <p className="text-xs text-gray-500">Nur ab heute oder in der Zukunft möglich</p>
          </div>

          <div className="flex gap-2">
            <Button 
              type="submit" 
              disabled={addPricingMutation.isPending}
              data-testid="button-submit-pricing"
            >
              {addPricingMutation.isPending ? (
                <><Loader2 className={`mr-2 ${iconSize.sm} animate-spin`} />Speichern...</>
              ) : "Speichern"}
            </Button>
            <Button type="button" variant="outline" onClick={() => setIsAddOpen(false)}>
              Abbrechen
            </Button>
          </div>
        </form>
      )}

      {isLoading ? (
        <div className="flex justify-center py-4">
          <Loader2 className={`${iconSize.md} animate-spin text-teal-600`} />
        </div>
      ) : pricingHistory && pricingHistory.length > 0 ? (
        <div className="space-y-3">
          {currentPricing && (
            <div className="p-3 bg-teal-50 border border-teal-200 rounded-lg">
              <div className="flex items-center gap-2 mb-3">
                <Badge variant="secondary" className="bg-teal-100 text-teal-800">Aktuell</Badge>
                <span className="text-sm text-gray-500">seit {formatDate(currentPricing.validFrom)}</span>
              </div>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div>
                  <div className="text-gray-500 text-xs">Hauswirtschaft</div>
                  <div className="font-medium">{formatCentsToEuro(currentPricing.hauswirtschaftRateCents)}/h</div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs">Alltagsbegleitung</div>
                  <div className="font-medium">{formatCentsToEuro(currentPricing.alltagsbegleitungRateCents)}/h</div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs">Kilometer</div>
                  <div className="font-medium">{formatCentsToEuro(currentPricing.kilometerRateCents)}/km</div>
                </div>
              </div>
            </div>
          )}

          {pricingHistory.filter(p => p.validTo).length > 0 && (
            <div className="mt-4">
              <h4 className="text-xs font-medium text-gray-500 mb-2">Vergangene Preise</h4>
              <div className="space-y-2">
                {pricingHistory.filter(p => p.validTo).map((pricing) => (
                  <div key={pricing.id} className="p-2 bg-gray-50 rounded text-sm">
                    <div className="text-gray-500 text-xs mb-1">
                      {formatDate(pricing.validFrom)} - {formatDate(pricing.validTo!)}
                    </div>
                    <div className="grid grid-cols-3 gap-1 text-xs">
                      <span>HW: {formatCentsToEuro(pricing.hauswirtschaftRateCents)}/h</span>
                      <span>AB: {formatCentsToEuro(pricing.alltagsbegleitungRateCents)}/h</span>
                      <span>Km: {formatCentsToEuro(pricing.kilometerRateCents)}/km</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-gray-500 py-4 text-center">Noch keine Preise hinterlegt</p>
      )}
    </div>
  );
}

const SERVICE_LABELS: Record<string, string> = {
  serviceHaushaltHilfe: "Haushaltshilfe",
  serviceMahlzeiten: "Mahlzeiten",
  serviceReinigung: "Reinigung",
  serviceWaeschePflege: "Wäschepflege",
  serviceEinkauf: "Einkauf",
  serviceTagesablauf: "Tagesablauf",
  serviceAlltagsverrichtungen: "Alltagsverrichtungen",
  serviceTerminbegleitung: "Terminbegleitung",
  serviceBotengaenge: "Botengänge",
  serviceGrundpflege: "Grundpflege",
  serviceFreizeitbegleitung: "Freizeitbegleitung",
  serviceDemenzbetreuung: "Demenzbetreuung",
  serviceGesellschaft: "Gesellschaft",
  serviceSozialeKontakte: "Soziale Kontakte",
  serviceFreizeitgestaltung: "Freizeitgestaltung",
  serviceKreativ: "Kreative Beschäftigung",
};

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

  const selectedServices = customer.needsAssessment 
    ? Object.entries(customer.needsAssessment)
        .filter(([key, value]) => key.startsWith("service") && value === true)
        .map(([key]) => SERVICE_LABELS[key] || key)
    : [];

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
              { value: "services", label: "Leistungen", testId: "tab-services" },
              { value: "contacts", label: "Kontakte", testId: "tab-contacts" },
              { value: "budgets", label: "Budgets", testId: "tab-budgets" },
              { value: "insurance", label: "Versicherung", testId: "tab-insurance" },
              { value: "history", label: "Historie", testId: "tab-history" },
            ]}
            defaultValue="overview"
            mobileVisibleCount={3}
          >

            <TabsContent value="overview" className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <SectionCard
                  title="Kontaktdaten"
                  icon={<User2 className={iconSize.sm} />}
                >
                  <div className="space-y-3">
                    {customer.geburtsdatum && (
                      <div className="flex items-center gap-2 text-gray-700">
                        <Calendar className={`${iconSize.sm} text-gray-400`} />
                        Geb.: {formatDate(customer.geburtsdatum)}
                      </div>
                    )}
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
                  title="Zuständige Mitarbeiter"
                  icon={<Users className={iconSize.sm} />}
                >
                  <div className="space-y-3">
                    <div>
                      <p className="text-sm text-gray-500">Hauptzuständig</p>
                      <p className="font-medium">
                        {customer.primaryEmployee?.displayName || "Nicht zugewiesen"}
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-500">Vertretung</p>
                      <p className="font-medium">
                        {customer.backupEmployee?.displayName || "Nicht zugewiesen"}
                      </p>
                    </div>
                  </div>
                </SectionCard>
              </div>

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

              {customer.needsAssessment?.anamnese && (
                <SectionCard
                  title="Anamnese / Besonderheiten"
                  icon={<Shield className={iconSize.sm} />}
                >
                  <p className="text-gray-700 whitespace-pre-wrap">
                    {customer.needsAssessment.anamnese}
                  </p>
                </SectionCard>
              )}
            </TabsContent>

            <TabsContent value="services" className="space-y-4">
              <SectionCard
                title="Vertrag & Preise"
                icon={<FileText className={iconSize.sm} />}
              >
                {customer.currentContract ? (
                  <div className="space-y-4">
                    <div className="grid gap-4 md:grid-cols-2">
                      <div>
                        <p className="text-sm text-gray-500">Vertragsumfang</p>
                        <p className="font-medium text-lg">
                          {customer.currentContract.hoursPerPeriod} Std. / {formatPeriodType(customer.currentContract.periodType)}
                        </p>
                      </div>
                      <div>
                        <p className="text-sm text-gray-500">Vertragsbeginn</p>
                        <p className="font-medium">
                          {formatDate(customer.currentContract.contractStart)}
                        </p>
                      </div>
                    </div>
                    
                    <div className="border-t pt-4">
                      <p className="text-sm font-medium text-gray-700 mb-3">Vereinbarte Stundensätze</p>
                      <div className="grid gap-3 md:grid-cols-3">
                        <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-100">
                          <p className="text-sm text-gray-600">Hauswirtschaft</p>
                          <p className="text-xl font-semibold text-gray-900">
                            {formatRate(customer.currentContract.hauswirtschaftRateCents)}/Std.
                          </p>
                        </div>
                        <div className="p-3 rounded-lg bg-sky-50 border border-sky-100">
                          <p className="text-sm text-gray-600">Alltagsbegleitung</p>
                          <p className="text-xl font-semibold text-gray-900">
                            {formatRate(customer.currentContract.alltagsbegleitungRateCents)}/Std.
                          </p>
                        </div>
                        <div className="p-3 rounded-lg bg-amber-50 border border-amber-100">
                          <div className="flex items-center gap-1">
                            <Car className={`${iconSize.xs} text-gray-400`} />
                            <p className="text-sm text-gray-600">Kilometer</p>
                          </div>
                          <p className="text-xl font-semibold text-gray-900">
                            {formatRate(customer.currentContract.kilometerRateCents)}/km
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <EmptyState
                    icon={<FileText className={iconSize.xl} />}
                    title="Kein Vertrag"
                    description="Kein aktiver Vertrag hinterlegt"
                    action={
                      <Button size="sm" className={componentStyles.btnPrimary}>
                        Vertrag anlegen
                      </Button>
                    }
                    className="py-6"
                  />
                )}
              </SectionCard>

              <SectionCard
                title="Leistungsumfang"
                icon={<ClipboardList className={iconSize.sm} />}
              >
                {selectedServices.length > 0 ? (
                  <div className="space-y-4">
                    <div className="flex flex-wrap gap-2">
                      {selectedServices.map((service, index) => (
                        <Badge key={index} variant="secondary" className="bg-teal-50 text-teal-700 border-teal-200">
                          {service}
                        </Badge>
                      ))}
                    </div>
                    {customer.needsAssessment?.sonstigeLeistungen && (
                      <div className="pt-3 border-t">
                        <p className="text-sm text-gray-500 mb-1">Sonstige Leistungen</p>
                        <p className="text-gray-700">{customer.needsAssessment.sonstigeLeistungen}</p>
                      </div>
                    )}
                    {customer.needsAssessment?.householdSize && (
                      <div className="pt-3 border-t">
                        <p className="text-sm text-gray-500">Haushaltsgröße</p>
                        <p className="text-gray-700">{customer.needsAssessment.householdSize} Person(en)</p>
                      </div>
                    )}
                  </div>
                ) : (
                  <EmptyState
                    icon={<ClipboardList className={iconSize.xl} />}
                    title="Keine Leistungen"
                    description="Keine Leistungen erfasst"
                    className="py-6"
                  />
                )}
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

                <PricingSection 
                  customerId={customerId} 
                  customerName={customer.vorname && customer.nachname ? `${customer.vorname} ${customer.nachname}` : customer.name}
                />
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
          </ResponsiveTabs>
        </div>
      </div>
    </Layout>
  );
}
