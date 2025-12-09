import { Link } from "wouter";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { Layout } from "@/components/layout";
import { Users, UserCog, ArrowLeft, Contact2, Clock } from "lucide-react";

export default function AdminDashboard() {
  const { user } = useAuth();

  return (
    <Layout>
      <div className="min-h-screen bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]">
        <div className="container mx-auto px-4 py-6 max-w-4xl">
          <div className="flex items-center gap-4 mb-6">
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

          <div className="grid gap-4 md:grid-cols-2 auto-rows-fr">
            <Link href="/admin/users" className="block h-full">
              <Card className="cursor-pointer hover:shadow-lg transition-shadow h-full" data-testid="card-users">
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
              </Card>
            </Link>

            <Link href="/admin/customer-assignments" className="block h-full">
              <Card className="cursor-pointer hover:shadow-lg transition-shadow h-full" data-testid="card-assignments">
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
              </Card>
            </Link>

            <Link href="/admin/customers" className="block h-full">
              <Card className="cursor-pointer hover:shadow-lg transition-shadow h-full" data-testid="card-customers">
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
              </Card>
            </Link>

            <Link href="/admin/time-entries" className="block h-full">
              <Card className="cursor-pointer hover:shadow-lg transition-shadow h-full" data-testid="card-time-entries">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-green-100 rounded-lg">
                      <Clock className="h-6 w-6 text-green-600" />
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
          </div>
        </div>
      </div>
    </Layout>
  );
}
