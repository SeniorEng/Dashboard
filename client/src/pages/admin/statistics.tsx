import { useState } from "react";
import { Link, useSearch } from "wouter";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, BarChart3 } from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { MONTH_NAMES } from "@/features/time-tracking/constants";
import { CockpitV2Tab } from "./statistics/v2/cockpit-v2-tab";
import { ProcessHealthSection } from "./statistics/v2/process-health-page";
import { CustomersSection } from "./statistics/v2/customers-page";
import { RevenueSection } from "./statistics/v2/revenue-page";
import { PerformanceSection } from "./statistics/v2/performance-page";
import { BudgetsSection } from "./statistics/v2/budgets-page";

const VALID_TABS = ["cockpit-v2", "customers", "revenue", "performance", "budgets", "process-health"] as const;

export default function AdminStatistics() {
  const currentYear = new Date().getFullYear();
  const searchString = useSearch();
  const urlTab = new URLSearchParams(searchString).get("tab");
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [selectedMonth, setSelectedMonth] = useState<string>("all");
  const [activeTab, setActiveTab] = useState<string>(urlTab && (VALID_TABS as readonly string[]).includes(urlTab) ? urlTab : "cockpit-v2");

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
          <TabsTrigger value="customers" data-testid="tab-customers">Kunden</TabsTrigger>
          <TabsTrigger value="revenue" data-testid="tab-revenue">Umsatz</TabsTrigger>
          <TabsTrigger value="performance" data-testid="tab-performance">Leistung</TabsTrigger>
          <TabsTrigger value="budgets" data-testid="tab-budgets">Budget</TabsTrigger>
          <TabsTrigger value="process-health" data-testid="tab-process-health">Prozess-Gesundheit</TabsTrigger>
        </TabsList>

        <TabsContent value="cockpit-v2">
          <CockpitV2Tab selectedYear={selectedYear} selectedMonth={selectedMonth} />
        </TabsContent>

        <TabsContent value="customers">
          <CustomersSection selectedYear={selectedYear} selectedMonth={selectedMonth} />
        </TabsContent>

        <TabsContent value="revenue">
          <RevenueSection selectedYear={selectedYear} selectedMonth={selectedMonth} />
        </TabsContent>

        <TabsContent value="performance">
          <PerformanceSection selectedYear={selectedYear} selectedMonth={selectedMonth} />
        </TabsContent>

        <TabsContent value="budgets">
          <BudgetsSection selectedYear={selectedYear} selectedMonth={selectedMonth} />
        </TabsContent>

        <TabsContent value="process-health">
          <ProcessHealthSection selectedYear={selectedYear} selectedMonth={selectedMonth} />
        </TabsContent>
      </Tabs>
    </Layout>
  );
}
