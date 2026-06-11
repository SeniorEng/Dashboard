import { Link } from "wouter";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/use-auth";
import { Layout } from "@/components/layout";
import {
  Users, ArrowLeft, Contact2, Clock, Settings,
  Building2, ClipboardList, FileText, Shield, Receipt, Gift, BarChart3, UserPlus,
  GraduationCap, FileCheck, Landmark, MessageSquare, FileSpreadsheet, CalendarCheck, CalendarClock, Lock, Repeat,
} from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { cn } from "@/lib/utils";
import { usePendingProofs, usePlannedConsultations } from "@/features/admin/hooks/use-admin-work-queues";
import { useBudgetSetupMissingCount } from "@/features/customers/hooks/use-customers";
import { useQontoStatus, useQontoTransactions } from "@/features/qonto/hooks/use-qonto-queries";

interface AdminCardData {
  href: string;
  testId: string;
  icon: React.ReactNode;
  iconBg: string;
  title: string;
  description: string;
  permissionKey: string;
}

interface AdminCardProps {
  href: string;
  testId: string;
  icon: React.ReactNode;
  iconBg: string;
  title: string;
  description: string;
  // Anzahl offener Vorgänge für diese Kachel. `undefined` = keine
  // Arbeitsliste hinterlegt (normale Navigationskachel, kein Badge/Dimmen).
  // Quelle ist immer dieselbe Query, die auch die Zielliste speist.
  count?: number;
}

function AdminCard({ href, testId, icon, iconBg, title, description, count }: AdminCardProps) {
  const hasQueue = count !== undefined;
  const isEmpty = hasQueue && count === 0;
  return (
    <Link href={href} className="block h-full">
      <Card
        className={cn(
          "cursor-pointer hover:shadow-lg transition-shadow h-full",
          isEmpty && "opacity-60",
        )}
        data-testid={testId}
      >
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${iconBg}`}>
              {icon}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <CardTitle>{title}</CardTitle>
                {hasQueue && count > 0 && (
                  <Badge variant="destructive" className="shrink-0" data-testid={`badge-count-${testId}`}>
                    {count}
                  </Badge>
                )}
              </div>
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
  const { user, hasAdminPermission } = useAuth();
  const isSuperAdmin = user?.isSuperAdmin ?? false;

  // Offene-Arbeit-Zähler: Jeder Zähler stammt aus exakt derselben Query, die
  // auch die jeweilige Zielliste speist (Anti-Dualismus, kein zweiter Pfad).
  const { data: pendingProofs } = usePendingProofs();
  const { data: overdueConsultations } = usePlannedConsultations("overdue");
  const { data: budgetSetupMissing } = useBudgetSetupMissingCount();
  const { data: qontoStatus } = useQontoStatus(isSuperAdmin);
  const qontoConfigured = qontoStatus?.configured ?? false;
  const { data: qontoUnmatched } = useQontoTransactions("unmatched", isSuperAdmin && qontoConfigured);

  const tileCounts: Record<string, number | undefined> = {
    "card-document-review": pendingProofs?.length,
    "card-proof-review": pendingProofs?.length,
    "card-planned-consultations": overdueConsultations?.length,
    "card-customers": budgetSetupMissing?.count,
    "card-qonto": qontoUnmatched?.total,
  };

  const personalCards: AdminCardData[] = [
    {
      href: "/admin/users",
      testId: "card-users",
      icon: <Users className={`${iconSize.lg} text-teal-600`} />,
      iconBg: "bg-teal-100",
      title: "Benutzerverwaltung",
      description: "Mitarbeiter hinzufügen, bearbeiten und Rollen zuweisen",
      permissionKey: "users",
    },
    {
      href: "/admin/time-entries",
      testId: "card-time-entries",
      icon: <Clock className={`${iconSize.lg} text-green-600`} />,
      iconBg: "bg-green-100",
      title: "Zeiterfassung",
      description: "Zeiten nachtragen, Urlaub & Krankheit verwalten",
      permissionKey: "time_entries",
    },
    {
      href: "/admin/proof-review",
      testId: "card-document-review",
      icon: <GraduationCap className={`${iconSize.lg} text-orange-600`} />,
      iconBg: "bg-orange-100",
      title: "Dokument-Prüfung",
      description: "Hochgeladene Dokumentennachweise prüfen und freigeben",
      permissionKey: "users",
    },
  ];

  const schedulingCards: AdminCardData[] = [
    {
      href: "/admin/availability",
      testId: "card-availability",
      icon: <CalendarCheck className={`${iconSize.lg} text-emerald-600`} />,
      iconBg: "bg-emerald-100",
      title: "Verfügbarkeiten",
      description: "Wochenübersicht freie Zeiten für Erstberatungen",
      permissionKey: "users",
    },
    {
      href: "/admin/planned-consultations",
      testId: "card-planned-consultations",
      icon: <CalendarClock className={`${iconSize.lg} text-teal-600`} />,
      iconBg: "bg-teal-100",
      title: "Erstberatungen",
      description: "Geplante und überfällige Erstberatungstermine im Blick",
      permissionKey: "customers",
    },
    {
      href: "/admin/appointment-series",
      testId: "card-appointment-series",
      icon: <Repeat className={`${iconSize.lg} text-purple-600`} />,
      iconBg: "bg-purple-100",
      title: "Serientermine",
      description: "Aktive Terminserien pro Kunde verwalten, verlängern oder beenden",
      permissionKey: "customers",
    },
    {
      href: "/admin/import-appointments",
      testId: "card-import-appointments",
      icon: <FileSpreadsheet className={`${iconSize.lg} text-amber-600`} />,
      iconBg: "bg-amber-100",
      title: "Termin-Import",
      description: "Historische Termine aus Excel-Datei importieren",
      permissionKey: "super_admin_only",
    },
  ];

  const kundenCards: AdminCardData[] = [
    {
      href: "/admin/prospects",
      testId: "card-prospects",
      icon: <UserPlus className={`${iconSize.lg} text-violet-600`} />,
      iconBg: "bg-violet-100",
      title: "Interessenten",
      description: "Lead-Pipeline, Kontaktverfolgung und Erstberatungs-Konvertierung",
      permissionKey: "prospects",
    },
    {
      href: "/admin/customers",
      testId: "card-customers",
      icon: <Contact2 className={`${iconSize.lg} text-blue-600`} />,
      iconBg: "bg-blue-100",
      title: "Kundenverwaltung",
      description: "Kunden anlegen, bearbeiten und verwalten",
      permissionKey: "customers",
    },
    {
      href: "/admin/insurance-providers",
      testId: "card-insurance-providers",
      icon: <Building2 className={`${iconSize.lg} text-pink-600`} />,
      iconBg: "bg-pink-100",
      title: "Kostenträger",
      description: "Pflegekassen anlegen und verwalten",
      permissionKey: "insurance_providers",
    },
    {
      href: "/admin/documents",
      testId: "card-documents",
      icon: <FileText className={`${iconSize.lg} text-amber-600`} />,
      iconBg: "bg-amber-100",
      title: "Dokumente & Vorlagen",
      description: "Dokumententypen, Vertragsvorlagen und Prüffristen",
      permissionKey: "documents",
    },
    {
      href: "/admin/services",
      testId: "card-services",
      icon: <ClipboardList className={`${iconSize.lg} text-cyan-600`} />,
      iconBg: "bg-cyan-100",
      title: "Dienstleistungen",
      description: "Leistungskatalog und Standardpreise verwalten",
      permissionKey: "services",
    },
    {
      href: "/admin/birthday-cards",
      testId: "card-birthday-cards",
      icon: <Gift className={`${iconSize.lg} text-rose-600`} />,
      iconBg: "bg-rose-100",
      title: "Geburtstage",
      description: "Karten & Gutscheine verwalten",
      permissionKey: "birthday_cards",
    },
  ];

  const abrechnungCards: AdminCardData[] = [
    {
      href: "/admin/month-closing",
      testId: "card-month-closing",
      icon: <Lock className={`${iconSize.lg} text-teal-600`} />,
      iconBg: "bg-teal-100",
      title: "Monatsabschluss",
      description: "Monate zentral für alle Mitarbeiter prüfen und abschließen",
      permissionKey: "time_entries",
    },
    {
      href: "/admin/billing",
      testId: "card-billing",
      icon: <Receipt className={`${iconSize.lg} text-emerald-600`} />,
      iconBg: "bg-emerald-100",
      title: "Abrechnung",
      description: "Rechnungen erstellen, Leistungsnachweise und Storno",
      permissionKey: "billing",
    },
    {
      href: "/admin/hours-overview",
      testId: "card-hours-overview",
      icon: <Clock className={`${iconSize.lg} text-cyan-600`} />,
      iconBg: "bg-cyan-100",
      title: "Stundenübersicht",
      description: "Monatliche Stunden, KM, Urlaub und Krankheit je Mitarbeiter",
      permissionKey: "hours_overview",
    },
    {
      href: "/admin/proof-review",
      testId: "card-proof-review",
      icon: <FileCheck className={`${iconSize.lg} text-sky-600`} />,
      iconBg: "bg-sky-100",
      title: "Leistungsnachweis-Prüfung",
      description: "Eingereichte Leistungsnachweise prüfen und freigeben",
      permissionKey: "billing",
    },
    {
      href: "/admin/statistics",
      testId: "card-statistics",
      icon: <BarChart3 className={`${iconSize.lg} text-indigo-600`} />,
      iconBg: "bg-indigo-100",
      title: "Statistiken",
      description: "Kennzahlen, Umsatz und Performance-Analysen",
      permissionKey: "statistics",
    },
  ];

  const systemCards: AdminCardData[] = [
    {
      href: "/admin/settings",
      testId: "card-settings",
      icon: <Settings className={`${iconSize.lg} text-purple-600`} />,
      iconBg: "bg-purple-100",
      title: "Einstellungen",
      description: "Firmendaten, E-Mail-Versand und Systemkonfiguration",
      permissionKey: "settings",
    },
    {
      href: "/admin/whatsapp",
      testId: "card-whatsapp",
      icon: <MessageSquare className={`${iconSize.lg} text-green-600`} />,
      iconBg: "bg-green-100",
      title: "WhatsApp",
      description: "WhatsApp-Benachrichtigungen konfigurieren und verwalten",
      permissionKey: "whatsapp",
    },
    {
      href: "/admin/audit-log",
      testId: "card-audit-log",
      icon: <Shield className={`${iconSize.lg} text-red-600`} />,
      iconBg: "bg-red-100",
      title: "Audit-Log",
      description: "Unveränderliches Protokoll aller Unterschriften und Änderungen",
      permissionKey: "audit_log",
    },
  ];

  const filterCards = (cards: AdminCardData[]) =>
    cards.filter((card) => hasAdminPermission(card.permissionKey));

  if (isSuperAdmin) {
    abrechnungCards.push({
      href: "/admin/qonto",
      testId: "card-qonto",
      icon: <Landmark className={`${iconSize.lg} text-sky-600`} />,
      iconBg: "bg-sky-100",
      title: "Zahlungen & Qonto",
      description: "Zahlungseingänge, Rechnungsabgleich und Avise",
      permissionKey: "billing",
    });
  }

  const visiblePersonal = filterCards(personalCards);
  const visibleScheduling = filterCards(schedulingCards);
  const visibleKunden = filterCards(kundenCards);
  const visibleAbrechnung = filterCards(abrechnungCards);
  const visibleSystem = filterCards(systemCards);

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
        {visiblePersonal.length > 0 && (
          <Section title="Personal & Team">
            {visiblePersonal.map((card) => (
              <AdminCard key={card.testId} {...card} count={tileCounts[card.testId]} />
            ))}
          </Section>
        )}

        {visibleScheduling.length > 0 && (
          <Section title="Terminplanung">
            {visibleScheduling.map((card) => (
              <AdminCard key={card.testId} {...card} count={tileCounts[card.testId]} />
            ))}
          </Section>
        )}

        {visibleKunden.length > 0 && (
          <Section title="Kunden & Verträge">
            {visibleKunden.map((card) => (
              <AdminCard key={card.testId} {...card} count={tileCounts[card.testId]} />
            ))}
          </Section>
        )}

        {visibleAbrechnung.length > 0 && (
          <Section title="Abrechnung & Finanzen">
            {visibleAbrechnung.map((card) => (
              <AdminCard key={card.testId} {...card} count={tileCounts[card.testId]} />
            ))}
          </Section>
        )}

        {visibleSystem.length > 0 && (
          <Section title="System & Sicherheit">
            {visibleSystem.map((card) => (
              <AdminCard key={card.testId} {...card} count={tileCounts[card.testId]} />
            ))}
          </Section>
        )}
      </div>
    </Layout>
  );
}
