import { useState } from "react";
import { Link } from "wouter";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/use-auth";
import { Layout } from "@/components/layout";
import {
  Users, ArrowLeft, Contact2, Clock, Settings,
  Building2, ClipboardList, FileText, Shield, Receipt, Gift, BarChart3, UserPlus,
  GraduationCap, Landmark, MessageSquare, FileSpreadsheet, CalendarCheck, CalendarClock, Repeat,
  ChevronDown,
} from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { cn } from "@/lib/utils";
import { usePendingProofs, usePlannedConsultations } from "@/features/admin/hooks/use-admin-work-queues";
import { useBudgetSetupMissingCount } from "@/features/customers/hooks/use-customers";
import { useQontoStatus, useQontoTransactions } from "@/features/qonto/hooks/use-qonto-queries";
import { AdminCockpit } from "@/features/admin/components/admin-cockpit";

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

// Ein „Hub" ist eine Prozess-Gruppe. Die 5 Hubs sind das einzige
// Navigationssystem des Admin-Bereichs (Phase 4): jede Admin-Seite ist genau
// einem Hub zugeordnet. Sichtbarkeit ist rollen-/berechtigungsgebunden — ein
// Hub erscheint nur, wenn der Admin mindestens eine seiner Karten sehen darf
// (Berechtigungsschlüssel aus der Benutzerverwaltung). Superadmins sehen alles.
interface Hub {
  id: string;
  title: string;
  icon: React.ReactNode;
  cards: AdminCardData[];
  // Selten genutzte Hubs werden hinter Progressive Disclosure eingeklappt.
  collapsible?: boolean;
}

interface HubSectionProps {
  hub: Hub;
  cards: AdminCardData[];
  counts: Record<string, number | undefined>;
}

function HubSection({ hub, cards, counts }: HubSectionProps) {
  const [open, setOpen] = useState(false);
  const grid = (
    <div className="grid gap-4 md:grid-cols-2 auto-rows-fr">
      {cards.map((card) => (
        <AdminCard key={card.testId} {...card} count={counts[card.testId]} />
      ))}
    </div>
  );

  if (hub.collapsible) {
    return (
      <div className="space-y-3">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex items-center gap-2 w-full text-left group"
          data-testid={`section-toggle-${hub.id}`}
        >
          <span className="text-gray-500">{hub.icon}</span>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider" data-testid={`section-${hub.id}`}>
            {hub.title}
          </h2>
          <Badge variant="secondary" className="shrink-0">{cards.length}</Badge>
          <ChevronDown
            className={cn(
              "h-4 w-4 text-gray-400 ml-auto transition-transform group-hover:text-gray-600",
              open && "rotate-180",
            )}
          />
        </button>
        {open && grid}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-gray-500">{hub.icon}</span>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider" data-testid={`section-${hub.id}`}>
          {hub.title}
        </h2>
      </div>
      {grid}
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

  // Hub-Definitionen (Reihenfolge = Prozess-Reihenfolge). Jede Admin-Seite
  // genau einmal; Sichtbarkeit über die Berechtigungsschlüssel aus der
  // Benutzerverwaltung (siehe ADMIN_PERMISSION_KEYS).
  const hubs: Hub[] = [
    {
      id: "aufnahme",
      title: "Aufnahme",
      icon: <UserPlus className={iconSize.md} />,
      cards: [
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
          href: "/admin/planned-consultations",
          testId: "card-planned-consultations",
          icon: <CalendarClock className={`${iconSize.lg} text-teal-600`} />,
          iconBg: "bg-teal-100",
          title: "Erstberatungen",
          description: "Geplante und überfällige Erstberatungstermine im Blick",
          permissionKey: "customers",
        },
        {
          href: "/admin/availability",
          testId: "card-availability",
          icon: <CalendarCheck className={`${iconSize.lg} text-emerald-600`} />,
          iconBg: "bg-emerald-100",
          title: "Verfügbarkeiten",
          description: "Wochenübersicht freie Zeiten für Erstberatungen",
          permissionKey: "users",
        },
      ],
    },
    {
      id: "betrieb",
      title: "Betrieb",
      icon: <CalendarCheck className={iconSize.md} />,
      cards: [
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
          href: "/admin/proof-review",
          testId: "card-document-review",
          icon: <GraduationCap className={`${iconSize.lg} text-orange-600`} />,
          iconBg: "bg-orange-100",
          title: "Dokument-Prüfung",
          description: "Hochgeladene Dokumentennachweise prüfen und freigeben",
          permissionKey: "users",
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
        {
          href: "/admin/import-appointments",
          testId: "card-import-appointments",
          icon: <FileSpreadsheet className={`${iconSize.lg} text-amber-600`} />,
          iconBg: "bg-amber-100",
          title: "Termin-Import",
          description: "Historische Termine aus Excel-Datei importieren",
          permissionKey: "super_admin_only",
        },
      ],
    },
    {
      id: "abrechnung",
      title: "Monatsabschluss & Abrechnung",
      icon: <Receipt className={iconSize.md} />,
      cards: [
        {
          href: "/admin/billing",
          testId: "card-billing",
          icon: <Receipt className={`${iconSize.lg} text-emerald-600`} />,
          iconBg: "bg-emerald-100",
          title: "Abrechnung",
          description: "Monatsabschluss, Rechnungen, Leistungsnachweise und Storno",
          permissionKey: "billing",
        },
        {
          href: "/admin/mitarbeiterabrechnung",
          testId: "card-mitarbeiterabrechnung",
          icon: <Clock className={`${iconSize.lg} text-cyan-600`} />,
          iconBg: "bg-cyan-100",
          title: "Mitarbeiterabrechnung & Stundenkonto",
          description: "Lohnzeiten, Kilometer, Auszahl-Rückstände und Monatsabschluss je Mitarbeiter",
          // Wage-/Minijob-Daten pro Mitarbeiter sind Superadmin-only.
          permissionKey: "super_admin_only",
        },
      ],
    },
    {
      id: "stammdaten",
      title: "Stammdaten",
      icon: <Contact2 className={iconSize.md} />,
      cards: [
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
          href: "/admin/users",
          testId: "card-users",
          icon: <Users className={`${iconSize.lg} text-teal-600`} />,
          iconBg: "bg-teal-100",
          title: "Benutzerverwaltung",
          description: "Mitarbeiter hinzufügen, bearbeiten und Rollen zuweisen",
          permissionKey: "users",
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
          href: "/admin/services",
          testId: "card-services",
          icon: <ClipboardList className={`${iconSize.lg} text-cyan-600`} />,
          iconBg: "bg-cyan-100",
          title: "Dienstleistungen",
          description: "Leistungskatalog und Standardpreise verwalten",
          permissionKey: "services",
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
      ],
    },
    {
      id: "system",
      title: "System & Auswertung",
      icon: <Settings className={iconSize.md} />,
      collapsible: true,
      cards: [
        {
          href: "/admin/statistics",
          testId: "card-statistics",
          icon: <BarChart3 className={`${iconSize.lg} text-indigo-600`} />,
          iconBg: "bg-indigo-100",
          title: "Statistiken",
          description: "Kennzahlen, Umsatz und Performance-Analysen",
          permissionKey: "statistics",
        },
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
      ],
    },
  ];

  // Zahlungen & Qonto bleibt Geschäftsführung (Superadmin) vorbehalten und
  // wird in den Abrechnungs-Hub eingehängt, sobald ein Superadmin angemeldet ist.
  if (isSuperAdmin) {
    const abrechnung = hubs.find((h) => h.id === "abrechnung");
    abrechnung?.cards.push({
      href: "/admin/qonto",
      testId: "card-qonto",
      icon: <Landmark className={`${iconSize.lg} text-sky-600`} />,
      iconBg: "bg-sky-100",
      title: "Zahlungen & Qonto",
      description: "Zahlungseingänge, Rechnungsabgleich und Avise",
      permissionKey: "billing",
    });
  }

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

      <AdminCockpit isSuperAdmin={isSuperAdmin} can={hasAdminPermission} />

      <div className="space-y-8 mt-8">
        {hubs.map((hub) => {
          const visibleCards = hub.cards.filter((card) => hasAdminPermission(card.permissionKey));
          if (visibleCards.length === 0) return null;
          return (
            <HubSection key={hub.id} hub={hub} cards={visibleCards} counts={tileCounts} />
          );
        })}
      </div>
    </Layout>
  );
}
