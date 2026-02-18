import { Link } from "wouter";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { Layout } from "@/components/layout";
import { Users, UserCog, ArrowLeft, Contact2, Clock, Settings, Building2, ClipboardList, FileCheck2, Shield, FileText, Receipt } from "lucide-react";
import { iconSize } from "@/design-system";

export default function AdminDashboard() {
  const { user } = useAuth();

  return (
    <Layout>
      <div className="min-h-screen bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]">
        <div className="container mx-auto px-4 py-6 max-w-4xl">
          <div className="flex items-center gap-4 mb-6">
            <Link href="/">
              <Button variant="ghost" size="icon" aria-label="Zurück" data-testid="button-back">
                <ArrowLeft className={iconSize.md} />
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Administration</h1>
              <p className="text-gray-600">Willkommen, {user?.displayName}</p>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2 auto-rows-fr">
            <Link href="/admin/users" className="block h-full">
              <Card className="cursor-pointer hover:shadow-lg transition-shadow h-full" data-testid="card-users">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-teal-100 rounded-lg">
                      <Users className={`${iconSize.lg} text-teal-600`} />
                    </div>
                    <div>
                      <CardTitle>Benutzerverwaltung</CardTitle>
                      <CardDescription>
                        Mitarbeiter hinzufügen, bearbeiten und Rollen zuweisen
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
              </Card>
            </Link>

            <Link href="/admin/customer-assignments" className="block h-full">
              <Card className="cursor-pointer hover:shadow-lg transition-shadow h-full" data-testid="card-assignments">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-orange-100 rounded-lg">
                      <UserCog className={`${iconSize.lg} text-orange-600`} />
                    </div>
                    <div>
                      <CardTitle>Kundenzuordnung</CardTitle>
                      <CardDescription>
                        Kunden zu Mitarbeitern zuweisen
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
              </Card>
            </Link>

            <Link href="/admin/customers" className="block h-full">
              <Card className="cursor-pointer hover:shadow-lg transition-shadow h-full" data-testid="card-customers">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-blue-100 rounded-lg">
                      <Contact2 className={`${iconSize.lg} text-blue-600`} />
                    </div>
                    <div>
                      <CardTitle>Kundenverwaltung</CardTitle>
                      <CardDescription>
                        Kunden anlegen, bearbeiten und verwalten
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
              </Card>
            </Link>

            <Link href="/admin/services" className="block h-full">
              <Card className="cursor-pointer hover:shadow-lg transition-shadow h-full" data-testid="card-services">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-cyan-100 rounded-lg">
                      <ClipboardList className={`${iconSize.lg} text-cyan-600`} />
                    </div>
                    <div>
                      <CardTitle>Dienstleistungen</CardTitle>
                      <CardDescription>
                        Leistungskatalog und Standardpreise verwalten
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
              </Card>
            </Link>

            <Link href="/admin/insurance-providers" className="block h-full">
              <Card className="cursor-pointer hover:shadow-lg transition-shadow h-full" data-testid="card-insurance-providers">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-pink-100 rounded-lg">
                      <Building2 className={`${iconSize.lg} text-pink-600`} />
                    </div>
                    <div>
                      <CardTitle>Kostenträger</CardTitle>
                      <CardDescription>
                        Pflegekassen anlegen und verwalten
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
              </Card>
            </Link>

            <Link href="/admin/time-entries" className="block h-full">
              <Card className="cursor-pointer hover:shadow-lg transition-shadow h-full" data-testid="card-time-entries">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-green-100 rounded-lg">
                      <Clock className={`${iconSize.lg} text-green-600`} />
                    </div>
                    <div>
                      <CardTitle>Zeiterfassung</CardTitle>
                      <CardDescription>
                        Urlaub, Krankheit und Arbeitszeiten
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
              </Card>
            </Link>

            <Link href="/admin/document-types" className="block h-full">
              <Card className="cursor-pointer hover:shadow-lg transition-shadow h-full" data-testid="card-document-types">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-amber-100 rounded-lg">
                      <FileCheck2 className={`${iconSize.lg} text-amber-600`} />
                    </div>
                    <div>
                      <CardTitle>Dokumententypen</CardTitle>
                      <CardDescription>
                        Dokumentenarten und Prüffristen für Mitarbeiter definieren
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
              </Card>
            </Link>

            <Link href="/admin/document-templates" className="block h-full">
              <Card className="cursor-pointer hover:shadow-lg transition-shadow h-full" data-testid="card-document-templates">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-teal-100 rounded-lg">
                      <FileText className={`${iconSize.lg} text-teal-600`} />
                    </div>
                    <div>
                      <CardTitle>Vertragsvorlagen</CardTitle>
                      <CardDescription>
                        HTML-Vorlagen für Verträge und Dokumente im Kundenanlage-Flow
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
              </Card>
            </Link>

            <Link href="/admin/billing" className="block h-full">
              <Card className="cursor-pointer hover:shadow-lg transition-shadow h-full" data-testid="card-billing">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-emerald-100 rounded-lg">
                      <Receipt className={`${iconSize.lg} text-emerald-600`} />
                    </div>
                    <div>
                      <CardTitle>Abrechnung</CardTitle>
                      <CardDescription>
                        Rechnungen erstellen, Leistungsnachweise und Storno
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
              </Card>
            </Link>

            <Link href="/admin/audit-log" className="block h-full">
              <Card className="cursor-pointer hover:shadow-lg transition-shadow h-full" data-testid="card-audit-log">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-red-100 rounded-lg">
                      <Shield className={`${iconSize.lg} text-red-600`} />
                    </div>
                    <div>
                      <CardTitle>Audit-Log</CardTitle>
                      <CardDescription>
                        Unveränderliches Protokoll aller Unterschriften und Änderungen
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
              </Card>
            </Link>

            <Link href="/admin/settings" className="block h-full">
              <Card className="cursor-pointer hover:shadow-lg transition-shadow h-full" data-testid="card-settings">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-purple-100 rounded-lg">
                      <Settings className={`${iconSize.lg} text-purple-600`} />
                    </div>
                    <div>
                      <CardTitle>Einstellungen</CardTitle>
                      <CardDescription>
                        Systemweite Konfiguration und automatische Pausen
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
              </Card>
            </Link>
          </div>
        </div>
      </div>
    </Layout>
  );
}
