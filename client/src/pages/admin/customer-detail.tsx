/**
 * Admin Customer Detail Page
 * 
 * Displays comprehensive customer information with tabbed interface
 * for contacts, insurance, budgets, and history.
 */

import { Link, useParams } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Layout } from "@/components/layout";
import { useCustomer } from "@/features/customers";
import {
  ArrowLeft,
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

// Helper functions
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
  return new Date(dateStr).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export default function AdminCustomerDetail() {
  const { id } = useParams<{ id: string }>();
  const customerId = parseInt(id || "0");

  const { data: customer, isLoading, error, refetch } = useCustomer(customerId);

  if (isLoading) {
    return (
      <Layout>
        <div className="min-h-screen bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4] flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
        </div>
      </Layout>
    );
  }

  if (error || !customer) {
    return (
      <Layout>
        <div className="min-h-screen bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]">
          <div className="container mx-auto px-4 py-6 max-w-4xl">
            <Link href="/admin/customers">
              <Button variant="ghost" size="icon">
                <ArrowLeft className="h-5 w-5" />
              </Button>
            </Link>
            <Card className="mt-6 border-red-200 bg-red-50">
              <CardContent className="flex items-center justify-between p-6">
                <div className="flex items-center gap-3">
                  <AlertCircle className="h-6 w-6 text-red-600" />
                  <div>
                    <p className="font-medium text-red-800">Fehler</p>
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
              </CardContent>
            </Card>
          </div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="min-h-screen bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]">
        <div className="container mx-auto px-4 py-6 max-w-4xl">
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-4">
              <Link href="/admin/customers">
                <Button variant="ghost" size="icon" data-testid="button-back">
                  <ArrowLeft className="h-5 w-5" />
                </Button>
              </Link>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">
                  {customer.vorname} {customer.nachname}
                </h1>
                <div className="flex items-center gap-2 mt-1">
                  {customer.pflegegrad !== null && customer.pflegegrad > 0 && (
                    <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">
                      Pflegegrad {customer.pflegegrad}
                    </Badge>
                  )}
                  {customer.activeContractCount > 0 && (
                    <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                      {customer.activeContractCount} aktive{" "}
                      {customer.activeContractCount === 1 ? "Vertrag" : "Verträge"}
                    </Badge>
                  )}
                </div>
              </div>
            </div>
            <Button variant="outline" className="bg-white" data-testid="button-edit-customer">
              <Edit className="h-4 w-4 mr-2" />
              Bearbeiten
            </Button>
          </div>

          {/* Tabbed Content */}
          <Tabs defaultValue="overview" className="space-y-4">
            <TabsList className="bg-white">
              <TabsTrigger value="overview" data-testid="tab-overview">Übersicht</TabsTrigger>
              <TabsTrigger value="contacts" data-testid="tab-contacts">Kontakte</TabsTrigger>
              <TabsTrigger value="insurance" data-testid="tab-insurance">Versicherung</TabsTrigger>
              <TabsTrigger value="budgets" data-testid="tab-budgets">Budgets</TabsTrigger>
              <TabsTrigger value="history" data-testid="tab-history">Historie</TabsTrigger>
            </TabsList>

            {/* Overview Tab */}
            <TabsContent value="overview" className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <Card className="bg-white">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-gray-500 flex items-center gap-2">
                      <User2 className="h-4 w-4" />
                      Kontaktdaten
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex items-center gap-2 text-gray-700">
                      <MapPin className="h-4 w-4 text-gray-400" />
                      {formatAddress(customer)}
                    </div>
                    {(customer.telefon || customer.festnetz) && (
                      <div className="flex items-center gap-2 text-gray-700">
                        <Phone className="h-4 w-4 text-gray-400" />
                        {customer.telefon || customer.festnetz}
                      </div>
                    )}
                    {customer.email && (
                      <div className="flex items-center gap-2 text-gray-700">
                        <Mail className="h-4 w-4 text-gray-400" />
                        {customer.email}
                      </div>
                    )}
                  </CardContent>
                </Card>

                <Card className="bg-white">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-gray-500 flex items-center gap-2">
                      <Heart className="h-4 w-4" />
                      Pflegekasse
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
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
                  </CardContent>
                </Card>
              </div>

              {customer.needs && customer.needs.length > 0 && (
                <Card className="bg-white">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-gray-500 flex items-center gap-2">
                      <Shield className="h-4 w-4" />
                      Besondere Bedürfnisse
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-wrap gap-2">
                      {customer.needs.map((need, index) => (
                        <Badge key={index} variant="secondary">
                          {need}
                        </Badge>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            {/* Contacts Tab */}
            <TabsContent value="contacts" className="space-y-4">
              <Card className="bg-white">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-gray-500 flex items-center gap-2">
                    <Users className="h-4 w-4" />
                    Ansprechpartner & Notfallkontakte
                  </CardTitle>
                  <Button size="sm" variant="outline" data-testid="button-add-contact">
                    Hinzufügen
                  </Button>
                </CardHeader>
                <CardContent>
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
                            <Edit className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-gray-500 text-center py-4">
                      Noch keine Kontakte hinterlegt
                    </p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Insurance Tab */}
            <TabsContent value="insurance" className="space-y-4">
              <Card className="bg-white">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-gray-500 flex items-center gap-2">
                    <Heart className="h-4 w-4" />
                    Aktuelle Pflegekasse
                  </CardTitle>
                  <Button size="sm" variant="outline" data-testid="button-change-insurance">
                    Kasse wechseln
                  </Button>
                </CardHeader>
                <CardContent>
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
                    <div className="text-center py-6">
                      <Heart className="h-12 w-12 text-gray-300 mx-auto mb-3" />
                      <p className="text-gray-500">Keine Pflegekasse hinterlegt</p>
                      <Button size="sm" className="mt-3 bg-teal-600 hover:bg-teal-700">
                        Pflegekasse hinzufügen
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Budgets Tab */}
            <TabsContent value="budgets" className="space-y-4">
              <Card className="bg-white">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-gray-500 flex items-center gap-2">
                    <Wallet className="h-4 w-4" />
                    Budgets & Leistungsansprüche
                  </CardTitle>
                  <Button size="sm" variant="outline" data-testid="button-update-budgets">
                    Aktualisieren
                  </Button>
                </CardHeader>
                <CardContent>
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
                    <div className="text-center py-6">
                      <Wallet className="h-12 w-12 text-gray-300 mx-auto mb-3" />
                      <p className="text-gray-500">Keine Budgets hinterlegt</p>
                      <Button size="sm" className="mt-3 bg-teal-600 hover:bg-teal-700">
                        Budgets erfassen
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* History Tab */}
            <TabsContent value="history" className="space-y-4">
              <Card className="bg-white">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-gray-500 flex items-center gap-2">
                    <History className="h-4 w-4" />
                    Pflegegrad-Verlauf
                  </CardTitle>
                </CardHeader>
                <CardContent>
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
                                <Badge variant="outline">Pflegegrad {entry.pflegegrad}</Badge>
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
                    <p className="text-gray-500 text-center py-4">
                      Kein Pflegegrad-Verlauf vorhanden
                    </p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </Layout>
  );
}
