import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { iconSize, componentStyles } from "@/design-system";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { api, unwrapResult } from "@/lib/api/client";
import {
  ArrowLeft, CheckCircle2, Lock, ChevronRight, Loader2,
  PenLine, CalendarCheck, FileCheck, Receipt, Landmark, FileSpreadsheet,
} from "lucide-react";
import { useAdminMonthClosingReadiness } from "@/features/time-tracking/hooks/use-month-closing";
import { usePendingProofs } from "@/features/admin/hooks/use-admin-work-queues";
import { useEligibleCustomers } from "@/features/billing";
import { useQontoStatus, useQontoTransactions } from "@/features/qonto/hooks/use-qonto-queries";

const MONTH_NAMES = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

type RawStatus = "loading" | "done" | "open" | "na";

interface StationModel {
  n: number;
  testId: string;
  title: string;
  desc: string;
  icon: React.ReactNode;
  href: string;
  open: number;
  raw: RawStatus;
  /** Hinweistext für n/a- oder Erledigt-Zustände. */
  note?: string;
}

interface LexwareRow {
  unsignedAppointmentCount: number;
}
interface LexwareOverview {
  rows: LexwareRow[];
}

function isGreen(raw: RawStatus): boolean {
  return raw === "done" || raw === "na";
}

export default function AdminMonthCloseRun() {
  const { user } = useAuth();
  const isSuperAdmin = !!user?.isSuperAdmin;

  const now = new Date();
  const prevMonth = now.getMonth() === 0 ? 12 : now.getMonth();
  const prevYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const [year, setYear] = useState(prevYear);
  const [month, setMonth] = useState(prevMonth);

  // ① + ② Dokumentation/Unterschriften & Monatsabschluss — eine SSoT (Readiness).
  const readiness = useAdminMonthClosingReadiness(year, month);
  const employees = readiness.data?.employees ?? [];
  const docOpen = employees.reduce(
    (sum, e) => sum + e.openAppointments.length + e.unsignedAppointments.length,
    0,
  );
  const closeOpen = employees.filter((e) => e.hasTimeEntries && !e.isClosed).length;

  // ③ Leistungsnachweis-Prüfung.
  const proofs = usePendingProofs();
  const proofOpen = proofs.data?.length ?? 0;

  // ④ Rechnungslauf — Kunden mit unterschriebenen Nachweisen ohne Rechnung.
  const eligible = useEligibleCustomers(year, month, "alle");
  const invoiceOpen = eligible.data?.length ?? 0;

  // ⑤ Qonto-Zahlungsabgleich (nur Geschäftsführung & konfiguriert).
  const qontoStatus = useQontoStatus(isSuperAdmin);
  const qontoConfigured = qontoStatus.data?.configured ?? false;
  const qontoApplicable = isSuperAdmin && qontoConfigured;
  const qontoTx = useQontoTransactions("unmatched", qontoApplicable);
  const qontoOpen = qontoTx.data?.total ?? 0;

  // ⑥ Lexware-Export — gleiche Query wie die Stundenübersicht.
  const lexware = useQuery<LexwareOverview>({
    queryKey: ["hours-overview", String(year), String(month)],
    queryFn: async () =>
      unwrapResult(await api.get<LexwareOverview>(`/admin/hours-overview?year=${year}&month=${month}`)),
  });
  const lexOpen = lexware.data?.rows.filter((r) => r.unsignedAppointmentCount > 0).length ?? 0;

  const stations: StationModel[] = useMemo(() => {
    const docRaw: RawStatus = readiness.isLoading ? "loading" : docOpen > 0 ? "open" : "done";
    const closeRaw: RawStatus = readiness.isLoading ? "loading" : closeOpen > 0 ? "open" : "done";
    const proofRaw: RawStatus = proofs.isLoading ? "loading" : proofOpen > 0 ? "open" : "done";
    const invoiceRaw: RawStatus = eligible.isLoading ? "loading" : invoiceOpen > 0 ? "open" : "done";
    const qontoRaw: RawStatus = !isSuperAdmin
      ? "na"
      : qontoStatus.isLoading
        ? "loading"
        : !qontoConfigured
          ? "na"
          : qontoTx.isLoading
            ? "loading"
            : qontoOpen > 0
              ? "open"
              : "done";
    const lexRaw: RawStatus = lexware.isLoading ? "loading" : lexOpen > 0 ? "open" : "done";

    return [
      {
        n: 1,
        testId: "station-documentation",
        title: "Dokumentation & Unterschriften",
        desc: "Offene und nicht unterschriebene Termine je Mitarbeiter abarbeiten",
        icon: <PenLine className={`${iconSize.lg} text-rose-600`} />,
        href: "/admin/time-entries",
        open: docOpen,
        raw: docRaw,
      },
      {
        n: 2,
        testId: "station-month-close",
        title: "Monatsabschluss",
        desc: "Monat für alle Mitarbeiter mit Aktivität abschließen",
        icon: <CalendarCheck className={`${iconSize.lg} text-teal-600`} />,
        href: "/admin/month-closing",
        open: closeOpen,
        raw: closeRaw,
      },
      {
        n: 3,
        testId: "station-proof-review",
        title: "Leistungsnachweise prüfen",
        desc: "Eingereichte Leistungsnachweise prüfen und freigeben",
        icon: <FileCheck className={`${iconSize.lg} text-sky-600`} />,
        href: "/admin/proof-review",
        open: proofOpen,
        raw: proofRaw,
      },
      {
        n: 4,
        testId: "station-billing",
        title: "Rechnungslauf",
        desc: "Rechnungen für abrechenbare Kunden erstellen",
        icon: <Receipt className={`${iconSize.lg} text-emerald-600`} />,
        href: "/admin/billing",
        open: invoiceOpen,
        raw: invoiceRaw,
      },
      {
        n: 5,
        testId: "station-qonto",
        title: "Zahlungen zuordnen (Qonto)",
        desc: "Zahlungseingänge mit Rechnungen abgleichen",
        icon: <Landmark className={`${iconSize.lg} text-indigo-600`} />,
        href: "/admin/qonto",
        open: qontoOpen,
        raw: qontoRaw,
        note: !isSuperAdmin
          ? "Wird von der Geschäftsführung erledigt"
          : !qontoConfigured
            ? "Qonto ist nicht eingerichtet"
            : undefined,
      },
      {
        n: 6,
        testId: "station-lexware",
        title: "Lexware-Export",
        desc: "Stunden prüfen und für den Lohn-Export bereitstellen",
        icon: <FileSpreadsheet className={`${iconSize.lg} text-cyan-600`} />,
        href: "/admin/hours-overview",
        open: lexOpen,
        raw: lexRaw,
      },
    ];
  }, [
    readiness.isLoading, docOpen, closeOpen,
    proofs.isLoading, proofOpen,
    eligible.isLoading, invoiceOpen,
    qontoStatus.isLoading, qontoTx.isLoading, qontoOpen, isSuperAdmin, qontoConfigured,
    lexware.isLoading, lexOpen,
  ]);

  // Staged Disclosure: Station ist freigeschaltet, wenn ALLE vorherigen grün sind.
  let prevGreen = true;
  const computed = stations.map((s) => {
    const unlocked = prevGreen;
    prevGreen = prevGreen && isGreen(s.raw);
    return { station: s, unlocked };
  });

  const doneCount = stations.filter((s) => isGreen(s.raw)).length;
  const activeIndex = computed.findIndex((c) => c.unlocked && !isGreen(c.station.raw));

  const yearOptions = useMemo(() => {
    const cy = new Date().getFullYear();
    return Array.from({ length: 5 }, (_, i) => cy - 2 + i);
  }, []);

  return (
    <Layout variant="admin">
      <div className={componentStyles.pageHeader}>
        <div className={componentStyles.pageHeaderTop}>
          <Link href="/admin">
            <Button variant="ghost" size="icon" aria-label="Zurück" data-testid="button-back">
              <ArrowLeft className={iconSize.md} />
            </Button>
          </Link>
          <div className={componentStyles.pageHeaderTitleWrap}>
            <h1 className={componentStyles.pageTitle} data-testid="text-page-title">
              Monatsabschluss & Abrechnung
            </h1>
            <p className="text-sm text-gray-600">
              Der geführte Lauf durch alle Schritte – einer nach dem anderen.
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <Select value={year.toString()} onValueChange={(v) => setYear(parseInt(v))}>
          <SelectTrigger className="w-[100px]" data-testid="select-year">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {yearOptions.map((y) => (
              <SelectItem key={y} value={y.toString()}>{y}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={month.toString()} onValueChange={(v) => setMonth(parseInt(v))}>
          <SelectTrigger className="w-[140px]" data-testid="select-month">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MONTH_NAMES.map((name, idx) => (
              <SelectItem key={idx + 1} value={(idx + 1).toString()}>{name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="ml-auto text-sm text-gray-600" data-testid="text-progress">
          <span className="font-semibold text-gray-900">{doneCount}</span> von {stations.length} erledigt
        </span>
      </div>

      <div className="flex flex-col gap-3" data-testid="station-list">
        {computed.map(({ station, unlocked }, idx) => (
          <StationCard
            key={station.testId}
            station={station}
            unlocked={unlocked}
            isActive={idx === activeIndex}
          />
        ))}
      </div>
    </Layout>
  );
}

function StationStatus({ station, unlocked }: { station: StationModel; unlocked: boolean }) {
  if (!unlocked) {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 bg-gray-100 border border-gray-200 rounded-full px-2 py-0.5"
        data-testid={`status-${station.testId}`}
      >
        <Lock className="h-3 w-3" />
        Gesperrt
      </span>
    );
  }
  if (station.raw === "loading") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-gray-500" data-testid={`status-${station.testId}`}>
        <Loader2 className="h-3 w-3 animate-spin" />
        Lädt…
      </span>
    );
  }
  if (station.raw === "na") {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 bg-gray-100 border border-gray-200 rounded-full px-2 py-0.5"
        data-testid={`status-${station.testId}`}
      >
        <CheckCircle2 className="h-3 w-3" />
        Nicht erforderlich
      </span>
    );
  }
  if (station.raw === "done") {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5"
        data-testid={`status-${station.testId}`}
      >
        <CheckCircle2 className="h-3 w-3" />
        Erledigt
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-xs font-medium text-rose-700 bg-rose-50 border border-rose-200 rounded-full px-2 py-0.5"
      data-testid={`status-${station.testId}`}
    >
      {station.open} offen
    </span>
  );
}

function StationCard({
  station,
  unlocked,
  isActive,
}: {
  station: StationModel;
  unlocked: boolean;
  isActive: boolean;
}) {
  // Klickbar, sobald freigeschaltet und es etwas zu tun/anzusehen gibt.
  const clickable = unlocked && station.raw !== "na" && station.raw !== "loading";

  const body = (
    <Card
      className={cn(
        "h-full transition-shadow",
        clickable && "cursor-pointer hover:shadow-lg",
        !unlocked && "opacity-60",
        isActive && "ring-2 ring-teal-500",
      )}
      data-testid={station.testId}
    >
      <CardContent className="flex items-center gap-4 p-4">
        <div className="flex items-center justify-center h-8 w-8 shrink-0 rounded-full bg-gray-100 text-sm font-semibold text-gray-700" data-testid={`station-number-${station.n}`}>
          {station.n}
        </div>
        <div className="shrink-0">{station.icon}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="font-semibold text-gray-900 truncate" data-testid={`title-${station.testId}`}>
              {station.title}
            </h2>
            <StationStatus station={station} unlocked={unlocked} />
          </div>
          <p className="text-sm text-gray-600">{station.desc}</p>
          {unlocked && station.note && (
            <p className="text-xs text-gray-500 mt-0.5" data-testid={`note-${station.testId}`}>{station.note}</p>
          )}
          {!unlocked && (
            <p className="text-xs text-gray-500 mt-0.5" data-testid={`hint-${station.testId}`}>
              Vorherigen Schritt zuerst abschließen
            </p>
          )}
        </div>
        {clickable && (
          <div className="shrink-0 flex items-center gap-2">
            {isActive && (
              <span className="hidden sm:inline text-sm font-medium text-teal-700">Öffnen</span>
            )}
            <ChevronRight className={`${iconSize.md} text-gray-400`} />
          </div>
        )}
      </CardContent>
    </Card>
  );

  if (!clickable) {
    return body;
  }

  return (
    <Link href={station.href} className="block" data-testid={`link-${station.testId}`}>
      {body}
    </Link>
  );
}
