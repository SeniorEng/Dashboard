import { useQuery } from "@tanstack/react-query";
import { SectionCard } from "@/components/patterns";
import { api, unwrapResult } from "@/lib/api/client";
import { Clock, Loader2 } from "lucide-react";
import { iconSize } from "@/design-system";

interface HoursAccountCategory {
  category: string;
  saldo: number;
}

interface HoursAccountData {
  hasAccount: boolean;
  year: number;
  month: number;
  stundenkontoSaldo: number;
  categories: HoursAccountCategory[];
}

const CATEGORY_LABELS: Record<string, string> = {
  hw: "Hauswirtschaft",
  ab: "Alltagsbegleitung",
  feiertage: "Feiertage",
};

function fmtHours(n: number): string {
  return n.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
}

export function HoursAccountSection() {
  const { data, isLoading } = useQuery<HoursAccountData>({
    queryKey: ["profile", "hours-account"],
    queryFn: async () => {
      const result = await api.get<HoursAccountData>("/profile/hours-account");
      return unwrapResult(result);
    },
  });

  if (isLoading) {
    return (
      <SectionCard title="Mein Stundenkonto" icon={<Clock className={iconSize.sm} />}>
        <div className="flex items-center justify-center py-4">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </SectionCard>
    );
  }

  if (!data || !data.hasAccount) return null;

  const hasBalance = data.stundenkontoSaldo !== 0;
  const nonZero = data.categories.filter((c) => c.saldo !== 0);

  return (
    <SectionCard title="Mein Stundenkonto" icon={<Clock className={iconSize.sm} />}>
      <div className="space-y-3">
        <div>
          <div className="text-xs text-muted-foreground">Offene Stunden (werden monatlich weitergeführt)</div>
          <div
            className={`text-2xl font-semibold tabular-nums ${hasBalance ? "text-amber-700" : "text-gray-500"}`}
            data-testid="text-hours-account-saldo"
          >
            {fmtHours(data.stundenkontoSaldo)} h
          </div>
        </div>

        {hasBalance ? (
          <div className="space-y-1 border-t pt-3">
            {nonZero.map((c) => (
              <div key={c.category} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{CATEGORY_LABELS[c.category] ?? c.category}</span>
                <span
                  className="tabular-nums font-medium text-amber-700"
                  data-testid={`text-hours-account-${c.category}`}
                >
                  {fmtHours(c.saldo)} h
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="text-hours-account-empty">
            Aktuell haben Sie keine offenen Stunden. Erfasste und ausgezahlte Stunden sind ausgeglichen.
          </p>
        )}

        <p className="text-xs text-muted-foreground">
          Ihr Stundenkonto zeigt die Differenz zwischen den Stunden, die Sie erfasst haben, und den Stunden,
          die Ihnen bereits ausgezahlt wurden. Ein Plus bedeutet, dass noch Stunden offen sind – der Stand
          wird automatisch in den nächsten Monat übertragen.
        </p>
      </div>
    </SectionCard>
  );
}
