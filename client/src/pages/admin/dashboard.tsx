import { Link } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { Layout } from "@/components/layout";
import { Users, UserCog, ArrowLeft, LogOut, Contact2 } from "lucide-react";

export default function AdminDashboard() {
  const { user, logout } = useAuth();

  return (
    <Layout>
      <div className="min-h-screen bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]">
        <div className="container mx-auto px-4 py-6 max-w-4xl">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-4">
              <Link href="/">
                <Button variant="ghost" size="icon" data-testid="button-back">
                  <ArrowLeft className="h-5 w-5" />
                </Button>
              </Link>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">Administration</h1>
                <p className="text-gray-600">Willkommen, {user?.displayName}</p>
              </div>
            </div>
            <Button
              variant="outline"
              onClick={logout}
              data-testid="button-logout"
            >
              <LogOut className="h-4 w-4 mr-2" />
              Abmelden
            </Button>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Link href="/admin/users">
              <Card className="cursor-pointer hover:shadow-lg transition-shadow" data-testid="card-users">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-teal-100 rounded-lg">
                      <Users className="h-6 w-6 text-teal-600" />
                    </div>
                    <div>
                      <CardTitle>Benutzerverwaltung</CardTitle>
                      <CardDescription>
                        Mitarbeiter hinzufügen, bearbeiten und Rollen zuweisen
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-gray-600">
                    Verwalten Sie alle Benutzerkonten und deren Berechtigungen.
                  </p>
                </CardContent>
              </Card>
            </Link>

            <Link href="/admin/customer-assignments">
              <Card className="cursor-pointer hover:shadow-lg transition-shadow" data-testid="card-assignments">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-orange-100 rounded-lg">
                      <UserCog className="h-6 w-6 text-orange-600" />
                    </div>
                    <div>
                      <CardTitle>Kundenzuordnung</CardTitle>
                      <CardDescription>
                        Kunden zu Mitarbeitern zuweisen
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-gray-600">
                    Legen Sie fest, welcher Mitarbeiter für welchen Kunden zuständig ist.
                  </p>
                </CardContent>
              </Card>
            </Link>

            <Link href="/admin/customers">
              <Card className="cursor-pointer hover:shadow-lg transition-shadow" data-testid="card-customers">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-blue-100 rounded-lg">
                      <Contact2 className="h-6 w-6 text-blue-600" />
                    </div>
                    <div>
                      <CardTitle>Kundenverwaltung</CardTitle>
                      <CardDescription>
                        Kunden anlegen, bearbeiten und verwalten
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-gray-600">
                    Vollständige Kundendaten inkl. Versicherung, Kontakte, Budgets und Verträge.
                  </p>
                </CardContent>
              </Card>
            </Link>
          </div>
        </div>
      </div>
    </Layout>
  );
}
