import { useState } from "react";
import { Link, useSearch } from "wouter";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, BarChart3 } from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { MONTH_NAMES } from "@/features/time-tracking/constants";
import { CockpitTab } from "./statistics/cockpit-tab";
import { CockpitV2Tab } from "./statistics/v2/cockpit-v2-tab";
import { ProcessHealthSection } from "./statistics/v2/process-health-page";
import { TeamTab } from "./statistics/team-tab";
import { KundenTab } from "./statistics/kunden-tab";
import { PlanungTab } from "./statistics/planung-tab";

const VALID_TABS = ["cockpit-v2", "process-health", "cockpit", "team", "customers", "planning"] as const;

export default function AdminStatistics() {
  const currentYear = new Date().getFullYear();
  const searchString = useSearch();
  const urlTab = new URLSearchParams(searchString).get("tab");
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [selectedMonth, setSelectedMonth] = useState<string>("all");
  const [activeTab, setActiveTab] = useState<string>(urlTab && (VALID_TABS as readonly string[]).includes(urlTab) ? urlTab : "cockpit-v2");

  const periodLabel = selectedMonth !== "all"
    ? `${MONTH_NAMES[parseInt(selectedMonth) - 1]} ${selectedYear}`
    : `${selectedYear}`;

  return (
    <Layout variant="wide">
        <div className="flex items-center gap-3 mb-6">
          <Link href="/admin" data-testid="link-back-admin">
            <Button variant="ghost" size="sm">
              <ArrowLeft className={iconSize.md} />
            </Button>
          </Link>
          <div className="flex-1">
            <h1 className={`${componentStyles.pageTitle} flex items-center gap-2`} data-testid="text-page-title">
              <BarChart3 className={iconSize.lg} />
              Statistiken
            </h1>
            <p className="text-sm text-muted-foreground">Unternehmens- und Mitarbeiter-Kennzahlen</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 mb-6">
          <Select value={String(selectedYear)} onValueChange={v => setSelectedYear(Number(v))}>
            <SelectTrigger className="w-[100px]" data-testid="select-year">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[currentYear - 1, currentYear, currentYear + 1].map(y => (
                <SelectItem key={y} value={String(y)}>{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={selectedMonth} onValueChange={setSelectedMonth}>
            <SelectTrigger className="w-[140px]" data-testid="select-month">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Gesamtjahr</SelectItem>
              {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
                <SelectItem key={m} value={String(m)}>{MONTH_NAMES[m - 1]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="mb-6 flex-wrap h-auto gap-1">
            <TabsTrigger value="cockpit-v2" data-testid="tab-cockpit-v2">Cockpit</TabsTrigger>
            <TabsTrigger value="process-health" data-testid="tab-process-health">Prozess-Gesundheit</TabsTrigger>
            <TabsTrigger value="cockpit" data-testid="tab-cockpit">Cockpit (alt)</TabsTrigger>
            <TabsTrigger value="team" data-testid="tab-team">Team</TabsTrigger>
            <TabsTrigger value="customers" data-testid="tab-customers">Kunden</TabsTrigger>
            <TabsTrigger value="planning" data-testid="tab-planning">Planung</TabsTrigger>
          </TabsList>

          <TabsContent value="cockpit-v2">
            <CockpitV2Tab selectedYear={selectedYear} selectedMonth={selectedMonth} />
          </TabsContent>

          <TabsContent value="process-health">
            <ProcessHealthSection selectedYear={selectedYear} selectedMonth={selectedMonth} />
          </TabsContent>

          <TabsContent value="cockpit">
            <CockpitTab selectedYear={selectedYear} selectedMonth={selectedMonth} />
          </TabsContent>

          <TabsContent value="team">
            <TeamTab selectedYear={selectedYear} selectedMonth={selectedMonth} />
          </TabsContent>

          <TabsContent value="customers">
            <KundenTab selectedYear={selectedYear} selectedMonth={selectedMonth} />
          </TabsContent>

          <TabsContent value="planning">
            <PlanungTab selectedYear={selectedYear} selectedMonth={selectedMonth} periodLabel={periodLabel} />
          </TabsContent>
        </Tabs>
    </Layout>
  );
}
