import { ReactNode, useState } from "react";
import { Link, useSearch } from "wouter";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, AlertCircle, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { iconSize, componentStyles } from "@/design-system";
import { MONTH_NAMES } from "@/features/time-tracking/constants";

export interface StatsPagePeriod {
  year: number;
  month: string;
  qs: string;
}

interface StatsPageShellProps {
  title: string;
  description: string;
  icon: ReactNode;
  testId: string;
  children: (period: StatsPagePeriod) => ReactNode;
}

export function buildPeriodQs(year: number, month: string): string {
  const p = new URLSearchParams({ year: String(year) });
  if (month !== "all") p.set("month", month);
  return p.toString();
}

export function StatsPageShell({ title, description, icon, testId, children }: StatsPageShellProps) {
  const currentYear = new Date().getFullYear();
  const search = useSearch();
  const sp = new URLSearchParams(search);
  const initialYear = parseInt(sp.get("year") || "") || currentYear;
  const initialMonth = sp.get("month") || "all";

  const [year, setYear] = useState(initialYear);
  const [month, setMonth] = useState(initialMonth);
  const qs = buildPeriodQs(year, month);
  const back = "/admin/statistics?tab=cockpit-v2";

  return (
    <Layout variant="wide">
      <div className="flex items-center gap-3 mb-6">
        <Link href={back} data-testid="link-back-statistics">
          <Button variant="ghost" size="sm">
            <ArrowLeft className={iconSize.md} />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className={`${componentStyles.pageTitle} flex items-center gap-2`} data-testid="text-page-title">
            {icon}
            {title}
          </h1>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
          <SelectTrigger className="w-[100px]" data-testid="select-year">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[currentYear - 1, currentYear, currentYear + 1].map((y) => (
              <SelectItem key={y} value={String(y)}>{y}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={month} onValueChange={setMonth}>
          <SelectTrigger className="w-[140px]" data-testid="select-month">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Gesamtjahr</SelectItem>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <SelectItem key={m} value={String(m)}>{MONTH_NAMES[m - 1]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div data-testid={testId}>
        {children({ year, month, qs })}
      </div>
    </Layout>
  );
}

export function StatsLoading({ testId }: { testId: string }) {
  return (
    <div className="flex justify-center py-16" data-testid={testId}>
      <Loader2 className={`${iconSize.lg} animate-spin text-teal-600`} />
    </div>
  );
}

export function StatsError({ testId, message }: { testId: string; message?: string }) {
  return (
    <Card className="border-red-200 bg-red-50/50" data-testid={testId}>
      <CardContent className="p-4 flex items-center gap-3 text-red-700">
        <AlertCircle className={iconSize.md} />
        <span>{message ?? "Daten konnten nicht geladen werden. Bitte erneut versuchen."}</span>
      </CardContent>
    </Card>
  );
}
