import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2, ChevronRight, FileCheck, FileText,
  Landmark, CalendarClock, Contact2, Receipt, Banknote, ShieldAlert,
  CalendarDays, UserPlus, TrendingUp, TrendingDown, ClipboardList,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { iconSize } from "@/design-system";
import { cn } from "@/lib/utils";
import { api, unwrapResult } from "@/lib/api/client";
import { formatCurrency } from "@shared/utils/format";
import type { CockpitResponse } from "@shared/statistics";
import type { AlertItem } from "@/pages/admin/statistics/helpers";
import { usePendingProofs, usePlannedConsultations } from "@/features/admin/hooks/use-admin-work-queues";
import { useBudgetSetupMissingCount, useInIntakeCount } from "@/features/customers/hooks/use-customers";
import { useQontoStatus, useQontoTransactions, useMatchableInvoices } from "@/features/qonto/hooks/use-qonto-queries";
import { useAppointments } from "@/features/appointments/hooks/use-appointments";
import { useAppointmentCoverage } from "@/features/appointments/hooks/use-appointment-coverage";
import { useProspectStats } from "@/features/prospects";

const MONTH_NAMES = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

interface BannerData {
  year: number;
  month: number;
  cutoff: string;
  daysUntilCutoff: number;
  openCount: number;
  unsignedCount: number;
  isClosed: boolean;
  expiredCount: number;
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

interface AdminCockpitProps {
  isSuperAdmin: boolean;
  can: (permissionKey: string) => boolean;
}

export function AdminCockpit({ isSuperAdmin, can }: AdminCockpitProps) {
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonthNum = now.getMonth() + 1;
  const curMonthStr = String(curMonthNum);

  // Alle Zähler stammen aus exakt derselben Query, die auch die jeweilige
  // Zielliste speist (Anti-Dualismus, keine parallele "offene Arbeit"-Logik).
  // Wo möglich werden identische queryKeys wie in den Zielseiten verwendet,
  // damit derselbe Cache geteilt wird.
  const { data: bannerData } = useQuery<{ banner: BannerData | null }>({
    queryKey: ["month-close-banner"],
    queryFn: async () => unwrapResult(await api.get<{ banner: BannerData | null }>("/time-entries/month-close/banner")),
    staleTime: 5 * 60 * 1000,
  });
  const banner = bannerData?.banner ?? null;

  const { data: alerts } = useQuery<AlertItem[]>({
    queryKey: ["statistics-alerts"],
    queryFn: async () => unwrapResult(await api.get<AlertItem[]>("/statistics/v2/alerts")),
    staleTime: 120_000,
  });
  const findAlert = (title: string) => alerts?.find((a) => a.title === title);
  const undocumentedAlert = findAlert("Undokumentierte Termine");
  const missingRecordsAlert = findAlert("Fehlende Leistungsnachweise");
  const overspendAlert = findAlert("Budget-Überschreitung");

  const { data: pendingProofs } = usePendingProofs();
  const { data: overdueConsultations } = usePlannedConsultations("overdue");
  const { data: budgetSetupMissing } = useBudgetSetupMissingCount();
  const { data: inIntake } = useInIntakeCount();

  const { data: qontoStatus } = useQontoStatus(isSuperAdmin);
  const qontoConfigured = qontoStatus?.configured ?? false;
  const { data: qontoUnmatched } = useQontoTransactions("unmatched", isSuperAdmin && qontoConfigured);

  const { data: matchableInvoices } = useMatchableInvoices(can("billing"));

  const billingEnabled = can("billing") || can("statistics");
  const { data: cockpit } = useQuery<CockpitResponse>({
    queryKey: ["statistics-v2-cockpit", curYear, curMonthStr],
    queryFn: async () =>
      unwrapResult(await api.get<CockpitResponse>(`/statistics/v2/cockpit?year=${curYear}&month=${curMonthStr}`)),
    staleTime: 60_000,
    enabled: billingEnabled,
  });

  const { data: appointmentsToday } = useAppointments(todayIso());
  const { data: coverage } = useAppointmentCoverage();
  const { data: prospectStats } = useProspectStats();

  // ---- "Jetzt fällig"-Inbox -------------------------------------------------
  const monthCloseCount = banner ? banner.openCount + banner.unsignedCount : 0;
  const monthLabel = banner ? `${MONTH_NAMES[banner.month - 1]} ${banner.year}` : "";

  interface InboxItem {
    testId: string;
    icon: React.ReactNode;
    label: string;
    subtitle: string;
    count: number;
    href: string;
    show: boolean;
  }

  const inboxItems: InboxItem[] = [
    {
      testId: "inbox-month-close",
      icon: <CalendarClock className={iconSize.md} />,
      label: "Monatsabschluss",
      subtitle: banner
        ? banner.isClosed
          ? `${monthLabel} abgeschlossen`
          : `${monthLabel} – ${banner.daysUntilCutoff < 0 ? "überfällig" : `${banner.daysUntilCutoff} Tage bis Cutoff`}`
        : "Kein offener Abschluss",
      count: monthCloseCount,
      href: "/admin/month-closing",
      show: can("time_entries"),
    },
    {
      testId: "inbox-undocumented",
      icon: <FileText className={iconSize.md} />,
      label: "Nicht dokumentierte Termine",
      subtitle: "Abgeschlossene Termine ohne Dokumentation",
      count: undocumentedAlert?.count ?? 0,
      href: undocumentedAlert?.link ?? "/admin/statistics/process-health/undocumented-appointments",
      show: can("time_entries") || can("statistics"),
    },
    {
      testId: "inbox-missing-records",
      icon: <Receipt className={iconSize.md} />,
      label: "Fehlende Leistungsnachweise",
      subtitle: "Kunden ohne Leistungsnachweis im Vormonat",
      count: missingRecordsAlert?.count ?? 0,
      href: missingRecordsAlert?.link ?? "/admin/billing",
      show: can("billing"),
    },
    {
      testId: "inbox-proof-review",
      icon: <FileCheck className={iconSize.md} />,
      label: "Dokumentnachweise prüfen",
      subtitle: "Hochgeladene Mitarbeiter-Nachweise zur Freigabe",
      count: pendingProofs?.length ?? 0,
      href: "/admin/proof-review",
      show: can("users"),
    },
    {
      testId: "inbox-qonto",
      icon: <Landmark className={iconSize.md} />,
      label: "Offene Qonto-Zahlungen",
      subtitle: "Zahlungseingänge ohne Rechnungszuordnung",
      count: qontoUnmatched?.total ?? 0,
      href: "/admin/qonto",
      show: isSuperAdmin && qontoConfigured,
    },
    {
      testId: "inbox-budget-setup",
      icon: <Contact2 className={iconSize.md} />,
      label: "Kunden mit offenem Setup",
      subtitle: "Budget-Einrichtung noch unvollständig",
      count: budgetSetupMissing?.count ?? 0,
      href: "/admin/customers",
      show: can("customers"),
    },
    {
      testId: "inbox-in-intake",
      icon: <ClipboardList className={iconSize.md} />,
      label: "Kunden in Anlage",
      subtitle: "Aktive Kunden ohne abgeschlossenen Vertrag",
      count: inIntake?.count ?? 0,
      href: "/admin/customers",
      show: can("customers"),
    },
    {
      testId: "inbox-consultations",
      icon: <CalendarClock className={iconSize.md} />,
      label: "Überfällige Erstberatungen",
      subtitle: "Geplante Erstberatungstermine in der Vergangenheit",
      count: overdueConsultations?.length ?? 0,
      href: "/admin/planned-consultations",
      show: can("customers"),
    },
  ];

  const visibleInbox = inboxItems.filter((i) => i.show);

  // ---- 6 Statuskarten -------------------------------------------------------
  const openInvoiceCount = matchableInvoices?.length ?? 0;
  const openInvoiceSum = (matchableInvoices ?? []).reduce((sum, inv) => sum + (inv.grossAmountCents ?? 0), 0);

  const provenCents = cockpit?.revenueByStage.proven.current ?? 0;
  const invoicedCents = cockpit?.revenueByStage.invoiced.current ?? 0;
  const invoicedDelta = cockpit?.revenueByStage.invoiced.deltaAbs ?? null;
  const billingPct = provenCents > 0 ? Math.min(100, Math.round((invoicedCents / provenCents) * 100)) : 0;

  const qontoUnmatchedTotal = qontoUnmatched?.total ?? 0;

  const overspendCount = overspendAlert?.count ?? 0;

  const todayCount = appointmentsToday?.length ?? 0;
  const uncoveredCount = coverage?.currentMonth.uncoveredCustomers.length ?? 0;

  const s = prospectStats ?? {};
  const openProspects = (s.neu ?? 0) + (s.kontaktiert ?? 0) + (s.wiedervorlage ?? 0) + (s.qualifiziert ?? 0);
  const erstberatungCount = (s.erstberatung_vereinbart ?? 0) + (s.erstberatung_durchgeführt ?? 0);
  const gewonnenCount = s.gewonnen ?? 0;

  interface StatusCard {
    testId: string;
    icon: React.ReactNode;
    iconBg: string;
    title: string;
    value: string;
    subtitle: string;
    trend?: { up: boolean; label: string } | null;
    href: string;
    show: boolean;
  }

  const statusCards: StatusCard[] = [
    {
      testId: "status-open-invoices",
      icon: <Receipt className={`${iconSize.lg} text-emerald-600`} />,
      iconBg: "bg-emerald-100",
      title: "Offene Rechnungen",
      value: formatCurrency(openInvoiceSum),
      subtitle: `${openInvoiceCount} versendet, noch offen`,
      href: "/admin/billing",
      show: can("billing"),
    },
    {
      testId: "status-billing-progress",
      icon: <TrendingUp className={`${iconSize.lg} text-indigo-600`} />,
      iconBg: "bg-indigo-100",
      title: "Abrechnungsfortschritt",
      value: `${billingPct} %`,
      subtitle: `${formatCurrency(invoicedCents)} berechnet von ${formatCurrency(provenCents)} nachgewiesen`,
      trend:
        invoicedDelta != null && invoicedDelta !== 0
          ? { up: invoicedDelta > 0, label: `${invoicedDelta > 0 ? "+" : ""}${formatCurrency(invoicedDelta)} vs. Vormonat` }
          : null,
      href: "/admin/billing",
      show: can("billing"),
    },
    {
      testId: "status-qonto",
      icon: <Banknote className={`${iconSize.lg} text-sky-600`} />,
      iconBg: "bg-sky-100",
      title: "Offene Zahlungen (Qonto)",
      value: String(qontoUnmatchedTotal),
      subtitle: "Zahlungseingänge ohne Zuordnung",
      href: "/admin/qonto",
      show: isSuperAdmin && qontoConfigured,
    },
    {
      testId: "status-budget-45b",
      icon: <ShieldAlert className={`${iconSize.lg} text-rose-600`} />,
      iconBg: "bg-rose-100",
      title: "§45b-Budget-Warnungen",
      value: String(overspendCount),
      subtitle: `Kunden mit §45b-Überschreitung ${curYear}`,
      href: "/admin/statistics/budgets",
      show: can("statistics"),
    },
    {
      testId: "status-appointments-today",
      icon: <CalendarDays className={`${iconSize.lg} text-teal-600`} />,
      iconBg: "bg-teal-100",
      title: "Termine heute",
      value: String(todayCount),
      subtitle: `${uncoveredCount} Kunden ohne Termin diesen Monat`,
      href: "/",
      show: can("customers"),
    },
    {
      testId: "status-pipeline",
      icon: <UserPlus className={`${iconSize.lg} text-violet-600`} />,
      iconBg: "bg-violet-100",
      title: "Pipeline",
      value: String(openProspects),
      subtitle: `${erstberatungCount} in Erstberatung · ${gewonnenCount} gewonnen`,
      href: "/admin/prospects",
      show: can("prospects"),
    },
  ];

  const visibleCards = statusCards.filter((c) => c.show);

  if (visibleInbox.length === 0 && visibleCards.length === 0) return null;

  return (
    <div className="space-y-6" data-testid="admin-cockpit">
      {visibleInbox.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider" data-testid="section-jetzt-faellig">
            Jetzt fällig
          </h2>
          <Card>
            <CardContent className="p-0 divide-y">
              {visibleInbox.map((item) => {
                const isEmpty = item.count === 0;
                return (
                  <Link key={item.testId} href={item.href} className="block" data-testid={item.testId}>
                    <div className={cn("flex items-center gap-3 px-4 py-3 hover:bg-gray-50", isEmpty && "opacity-60")}>
                      <div className="text-gray-500 shrink-0">{item.icon}</div>
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-gray-900 truncate">{item.label}</div>
                        <div className="text-xs text-gray-500 truncate">{item.subtitle}</div>
                      </div>
                      {isEmpty ? (
                        <span className="flex items-center gap-1 text-xs text-emerald-600 shrink-0" data-testid={`empty-${item.testId}`}>
                          <CheckCircle2 className="h-4 w-4" />
                          Nichts zu tun
                        </span>
                      ) : (
                        <Badge variant="destructive" className="shrink-0" data-testid={`count-${item.testId}`}>
                          {item.count}
                        </Badge>
                      )}
                      <ChevronRight className="h-4 w-4 text-gray-400 shrink-0" />
                    </div>
                  </Link>
                );
              })}
            </CardContent>
          </Card>
        </div>
      )}

      {visibleCards.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider" data-testid="section-status">
            Status
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 auto-rows-fr">
            {visibleCards.map((card) => (
              <Link key={card.testId} href={card.href} className="block h-full" data-testid={card.testId}>
                <Card className="cursor-pointer hover:shadow-lg transition-shadow h-full">
                  <CardContent className="p-5">
                    <div className="flex items-start gap-3">
                      <div className={`p-2 rounded-lg ${card.iconBg}`}>{card.icon}</div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-gray-500 truncate">{card.title}</div>
                        <div className="text-2xl font-bold text-gray-900" data-testid={`value-${card.testId}`}>
                          {card.value}
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5">{card.subtitle}</div>
                        {card.trend && (
                          <div
                            className={cn("flex items-center gap-1 text-xs mt-1", card.trend.up ? "text-emerald-600" : "text-rose-600")}
                            data-testid={`trend-${card.testId}`}
                          >
                            {card.trend.up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                            {card.trend.label}
                          </div>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
