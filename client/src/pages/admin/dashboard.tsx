import { Link } from "wouter";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { Layout } from "@/components/layout";
import {
  Users, UserCog, ArrowLeft, Contact2, Clock, Settings,
  Building2, ClipboardList, FileText, Shield, Receipt, Gift, BarChart3,
} from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";

interface AdminCardProps {
  href: string;
  testId: string;
  icon: React.ReactNode;
  iconBg: string;
  title: string;
  description: string;
}

function AdminCard({ href, testId, icon, iconBg, title, description }: AdminCardProps) {
  return (
    <Link href={href} className="block h-full">
      <Card className="cursor-pointer hover:shadow-lg transition-shadow h-full" data-testid={testId}>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${iconBg}`}>
              {icon}
            </div>
            <div>
              <CardTitle>{title}</CardTitle>
              <CardDescription>{description}</CardDescription>
            </div>
          </div>
        </CardHeader>
      </Card>
    </Link>
  );
}

interface SectionProps {
  title: string;
  children: React.ReactNode;
}

function Section({ title, children }: SectionProps) {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider" data-testid={`section-${title.toLowerCase().replace(/\s+/g, "-")}`}>
        {title}
      </h2>
      <div className="grid gap-4 md:grid-cols-2 auto-rows-fr">
        {children}
      </div>
    </div>
  );
}

export default function AdminDashboard() {
  const { user } = useAuth();

  return (
    <Layout variant="admin">
      <div className="flex items-center gap-4 mb-6">
        <Link href="/">
          <Button variant="ghost" size="icon" aria-label="Zurück" data-testid="button-back">
            <ArrowLeft className={iconSize.md} />
          </Button>
        </Link>
        <div>
          <h1 className={componentStyles.pageTitle}>Administration</h1>
          <p className="text-gray-600">Willkommen, {user?.displayName}</p>
        </div>
      </div>

      <div className="space-y-8">
        <Section title="Personal & Team">
          <AdminCard
            href="/admin/users"
            testId="card-users"
            icon={<Users className={`${iconSize.lg} text-teal-600`} />}
            iconBg="bg-teal-100"
            title="Benutzerverwaltung"
            description="Mitarbeiter hinzufügen, bearbeiten und Rollen zuweisen"
          />
          <AdminCard
            href="/admin/customer-assignments"
            testId="card-assignments"
            icon={<UserCog className={`${iconSize.lg} text-orange-600`} />}
            iconBg="bg-orange-100"
            title="Kundenzuordnung"
            description="Kunden zu Mitarbeitern zuweisen"
          />
          <AdminCard
            href="/admin/time-entries"
            testId="card-time-entries"
            icon={<Clock className={`${iconSize.lg} text-green-600`} />}
            iconBg="bg-green-100"
            title="Zeiterfassung"
            description="Urlaub, Krankheit und Arbeitszeiten"
          />
          <AdminCard
            href="/admin/birthday-cards"
            testId="card-birthday-cards"
            icon={<Gift className={`${iconSize.lg} text-rose-600`} />}
            iconBg="bg-rose-100"
            title="Geburtstagskarten"
            description="Versandstatus von Geburtstagskarten verwalten"
          />
          <AdminCard
            href="/admin/statistics"
            testId="card-statistics"
            icon={<BarChart3 className={`${iconSize.lg} text-indigo-600`} />}
            iconBg="bg-indigo-100"
            title="Statistiken"
            description="Kennzahlen, Umsatz und Performance-Analysen"
          />
        </Section>

        <Section title="Kunden & Verträge">
          <AdminCard
            href="/admin/customers"
            testId="card-customers"
            icon={<Contact2 className={`${iconSize.lg} text-blue-600`} />}
            iconBg="bg-blue-100"
            title="Kundenverwaltung"
            description="Kunden anlegen, bearbeiten und verwalten"
          />
          <AdminCard
            href="/admin/insurance-providers"
            testId="card-insurance-providers"
            icon={<Building2 className={`${iconSize.lg} text-pink-600`} />}
            iconBg="bg-pink-100"
            title="Kostenträger"
            description="Pflegekassen anlegen und verwalten"
          />
          <AdminCard
            href="/admin/documents"
            testId="card-documents"
            icon={<FileText className={`${iconSize.lg} text-amber-600`} />}
            iconBg="bg-amber-100"
            title="Dokumente & Vorlagen"
            description="Dokumententypen, Vertragsvorlagen und Prüffristen"
          />
          <AdminCard
            href="/admin/services"
            testId="card-services"
            icon={<ClipboardList className={`${iconSize.lg} text-cyan-600`} />}
            iconBg="bg-cyan-100"
            title="Dienstleistungen"
            description="Leistungskatalog und Standardpreise verwalten"
          />
        </Section>

        <Section title="Abrechnung & Finanzen">
          <AdminCard
            href="/admin/billing"
            testId="card-billing"
            icon={<Receipt className={`${iconSize.lg} text-emerald-600`} />}
            iconBg="bg-emerald-100"
            title="Abrechnung"
            description="Rechnungen erstellen, Leistungsnachweise und Storno"
          />
          <AdminCard
            href="/admin/hours-overview"
            testId="card-hours-overview"
            icon={<Clock className={`${iconSize.lg} text-cyan-600`} />}
            iconBg="bg-cyan-100"
            title="Stundenübersicht"
            description="Monatliche Stunden, KM, Urlaub und Krankheit je Mitarbeiter"
          />
        </Section>

        <Section title="System & Sicherheit">
          <AdminCard
            href="/admin/settings"
            testId="card-settings"
            icon={<Settings className={`${iconSize.lg} text-purple-600`} />}
            iconBg="bg-purple-100"
            title="Einstellungen"
            description="Firmendaten, E-Mail-Versand und Systemkonfiguration"
          />
          <AdminCard
            href="/admin/audit-log"
            testId="card-audit-log"
            icon={<Shield className={`${iconSize.lg} text-red-600`} />}
            iconBg="bg-red-100"
            title="Audit-Log"
            description="Unveränderliches Protokoll aller Unterschriften und Änderungen"
          />
        </Section>
      </div>
    </Layout>
  );
}
