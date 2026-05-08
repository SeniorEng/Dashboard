import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { api, unwrapResult } from "@/lib/api/client";
import { CalendarClock, Lock, AlertTriangle } from "lucide-react";

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

const MONTH_NAMES = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

export function MonthCloseBanner() {
  const { data } = useQuery<{ banner: BannerData | null }>({
    queryKey: ["month-close-banner"],
    queryFn: async () => {
      const r = await api.get<{ banner: BannerData | null }>("/time-entries/month-close/banner");
      return unwrapResult(r);
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
  });

  const banner = data?.banner;
  if (!banner) return null;

  const monthLabel = `${MONTH_NAMES[banner.month - 1]} ${banner.year}`;
  const cutoffDe = banner.cutoff.split("-").reverse().join(".");
  const blockerTotal = banner.openCount + banner.unsignedCount;

  // Show countdown for all employees during cutoff window, even without blockers
  if (banner.isClosed) {
    return (
      <div
        className="bg-gray-100 border-b border-gray-200 px-4 py-2 flex items-center gap-2 text-sm"
        data-testid="banner-month-closed"
      >
        <Lock className="h-4 w-4 text-gray-600 shrink-0" />
        <span className="text-gray-700">
          {monthLabel} ist abgeschlossen.{" "}
          {banner.expiredCount > 0 && (
            <span className="text-rose-700 font-medium">
              {banner.expiredCount} Termin{banner.expiredCount === 1 ? "" : "e"} nicht abgerechnet.
            </span>
          )}
        </span>
      </div>
    );
  }

  const isUrgent = banner.daysUntilCutoff <= 1;
  const headline =
    banner.daysUntilCutoff === 0
      ? `Heute ist Cutoff (${cutoffDe}, 23:00) für ${monthLabel}`
      : `Monatsabschluss ${monthLabel} in ${banner.daysUntilCutoff} Tag${banner.daysUntilCutoff === 1 ? "" : "en"} (${cutoffDe})`;

  // No blockers: still show a calm countdown row so all employees see the cutoff date.
  if (blockerTotal === 0) {
    return (
      <div
        className="bg-teal-50 border-b border-teal-200 px-4 py-2 flex items-center gap-2 text-sm text-teal-800"
        data-testid="banner-month-close-countdown"
      >
        <CalendarClock className="h-4 w-4 shrink-0" />
        <span>{headline} — keine offenen Punkte</span>
      </div>
    );
  }

  return (
    <Link
      href="/time-entries"
      className={`block px-4 py-2 border-b text-sm hover:opacity-90 ${
        isUrgent
          ? "bg-rose-50 border-rose-200 text-rose-800"
          : "bg-amber-50 border-amber-200 text-amber-800"
      }`}
      data-testid="banner-month-close-reminder"
    >
      <div className="flex items-center gap-2">
        {isUrgent ? <AlertTriangle className="h-4 w-4 shrink-0" /> : <CalendarClock className="h-4 w-4 shrink-0" />}
        <div className="flex-1 min-w-0">
          <div className="font-medium">{headline}</div>
          <div className="text-xs opacity-90">
            {banner.openCount > 0 && <span>{banner.openCount} offene Termine</span>}
            {banner.openCount > 0 && banner.unsignedCount > 0 && <span> · </span>}
            {banner.unsignedCount > 0 && <span>{banner.unsignedCount} ohne Unterschrift</span>}
            {" — jetzt erledigen"}
          </div>
        </div>
      </div>
    </Link>
  );
}
