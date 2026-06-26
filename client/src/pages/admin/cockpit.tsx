import { useState } from "react";
import { Link } from "wouter";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { iconSize, componentStyles } from "@/design-system";
import { ArrowLeft, Loader2 } from "lucide-react";
import type { CockpitFunnelStage } from "@shared/api";
import type { CockpitGroupDimension } from "@shared/domain/billing-cockpit";
import {
  useBillingCockpit,
  CockpitFunnelBar,
  CockpitDrillTable,
  CockpitReviewBuckets,
  MONTH_NAMES,
} from "@/features/billing";

// Task #1444 — Abrechnung-Cockpit (PHASE 1, READ-ONLY). Dünner Wrapper: liest
// ausschließlich `GET /billing/cockpit` und rendert die drei Zonen
// (A: Trichter, B: Drill-down, C: „Zu prüfen"-Buckets). KEINE Mutationen,
// KEINE Rechnungserstellung (→ Phase 5). Die alten Tabs (`/admin/proof-review`,
// `/admin/month-close-run`, `/admin/month-closing`) bleiben separat erreichbar.

// Späte Stufen werden standardmäßig nach Rechnung gruppiert, frühe nach
// Mitarbeiter (reine Anzeige-Voreinstellung; der Toggle überschreibt sie).
function defaultDimensionForStage(stage: CockpitFunnelStage | null): CockpitGroupDimension {
  if (stage === "abgerechnet" || stage === "bezahlt") return "rechnung";
  return "mitarbeiter";
}

export default function AdminCockpit() {
  const today = new Date();
  const [selectedMonth, setSelectedMonth] = useState(today.getMonth() + 1);
  const [selectedYear, setSelectedYear] = useState(today.getFullYear());
  const [activeStage, setActiveStage] = useState<CockpitFunnelStage | null>(null);
  // null = der stufen-abhängige Default greift; sonst explizite Nutzer-Wahl.
  const [groupOverride, setGroupOverride] = useState<CockpitGroupDimension | null>(null);

  const currentYear = today.getFullYear();
  const years = [currentYear, currentYear - 1, currentYear - 2];

  const { data: cockpit, isLoading } = useBillingCockpit(selectedYear, selectedMonth);

  const dimension = groupOverride ?? defaultDimensionForStage(activeStage);

  const handleStageClick = (stage: CockpitFunnelStage) => {
    setActiveStage((prev) => (prev === stage ? null : stage));
    setGroupOverride(null);
  };

  const visibleRows = cockpit
    ? activeStage
      ? cockpit.rows.filter((row) => row.stage === activeStage)
      : cockpit.rows
    : [];

  return (
    <Layout variant="wide">
      <div className="flex items-center gap-4 mb-6">
        <Link href="/admin">
          <Button variant="ghost" size="icon" aria-label="Zurück" data-testid="button-back">
            <ArrowLeft className={iconSize.md} />
          </Button>
        </Link>
        <div>
          <h1 className={componentStyles.pageTitle}>Abrechnung-Cockpit</h1>
          <p className="text-gray-600">Überblick über den Abrechnungs-Trichter (nur Lesen)</p>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-6 flex-wrap" data-testid="filter-cockpit-period">
        <Select value={String(selectedMonth)} onValueChange={(v) => setSelectedMonth(Number(v))}>
          <SelectTrigger className="w-40" data-testid="select-month">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MONTH_NAMES.map((name, idx) => (
              <SelectItem key={idx} value={String(idx + 1)} data-testid={`option-month-${idx + 1}`}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={String(selectedYear)} onValueChange={(v) => setSelectedYear(Number(v))}>
          <SelectTrigger className="w-28" data-testid="select-year">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {years.map((y) => (
              <SelectItem key={y} value={String(y)} data-testid={`option-year-${y}`}>
                {y}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading || !cockpit ? (
        <div className="flex items-center justify-center py-16" data-testid="status-cockpit-loading">
          <Loader2 className={`${iconSize.lg} animate-spin text-gray-400`} />
        </div>
      ) : (
        <>
          <CockpitFunnelBar
            funnel={cockpit.funnel}
            ampel={cockpit.ampel}
            lohnReadiness={cockpit.lohnReadiness}
            activeStage={activeStage}
            onStageClick={handleStageClick}
          />

          <CockpitDrillTable
            rows={visibleRows}
            activeStage={activeStage}
            dimension={dimension}
            onDimensionChange={setGroupOverride}
            onClearStage={() => {
              setActiveStage(null);
              setGroupOverride(null);
            }}
          />

          <CockpitReviewBuckets buckets={cockpit.buckets} />
        </>
      )}
    </Layout>
  );
}
