import { useMemo, useState } from "react";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/patterns/empty-state";
import {
  ChevronDown,
  ChevronRight,
  User,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import { iconSize } from "@/design-system";
import { computeDeadlineInfo, DeadlineHint } from "./deadline-hint";

export interface CustomerOverviewItem {
  customerId: number;
  customerName: string;
  existingRecord: { id: number; status: string } | null;
  singleRecords: { id: number; status: string; recordType: string }[];
  documentedCount: number;
  undocumentedCount: number;
  totalAppointments: number;
  coveredBySingleCount: number;
  coveredByMonthlyCount: number;
  uncoveredDocumentedCount: number;
  status: "undocumented" | "ready" | "pending" | "employee_signed" | "completed";
  canCreateRecord: boolean;
}

type Tone = "amber" | "primary" | "green";

function lastNameOf(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts.length > 0 ? parts[parts.length - 1] : fullName;
}

function byNachname(a: CustomerOverviewItem, b: CustomerOverviewItem) {
  const cmp = lastNameOf(a.customerName).localeCompare(lastNameOf(b.customerName), "de");
  if (cmp !== 0) return cmp;
  return a.customerName.localeCompare(b.customerName, "de");
}

interface BucketedOverview {
  needsDoc: CustomerOverviewItem[];
  ready: CustomerOverviewItem[];
  completed: CustomerOverviewItem[];
  orphans: CustomerOverviewItem[];
}

function bucketize(items: CustomerOverviewItem[]): BucketedOverview {
  const needsDoc: CustomerOverviewItem[] = [];
  const ready: CustomerOverviewItem[] = [];
  const completed: CustomerOverviewItem[] = [];
  const orphans: CustomerOverviewItem[] = [];
  for (const it of items) {
    if (it.undocumentedCount > 0) {
      needsDoc.push(it);
      continue;
    }
    if (it.uncoveredDocumentedCount > 0) {
      ready.push(it);
      continue;
    }
    const hasCompletedRecord =
      it.existingRecord?.status === "completed" ||
      it.singleRecords.some((r) => r.status === "completed");
    if (it.totalAppointments === 0 && hasCompletedRecord) {
      orphans.push(it);
    } else {
      completed.push(it);
    }
  }
  needsDoc.sort(byNachname);
  ready.sort(byNachname);
  completed.sort(byNachname);
  orphans.sort(byNachname);
  return { needsDoc, ready, completed, orphans };
}

interface OverviewSectionProps {
  title: string;
  tone: Tone;
  count: number;
  testId: string;
  defaultExpanded?: boolean;
  children: React.ReactNode;
}

const toneTextClass: Record<Tone, string> = {
  amber: "text-amber-700",
  primary: "text-primary",
  green: "text-green-700",
};

const toneBadgeClass: Record<Tone, string> = {
  amber: "bg-amber-100 text-amber-700 border-amber-200",
  primary: "bg-primary/10 text-primary border-primary/20",
  green: "bg-green-100 text-green-700 border-green-200",
};

function OverviewSection({
  title,
  tone,
  count,
  testId,
  defaultExpanded = true,
  children,
}: OverviewSectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <section className="flex flex-col gap-2" data-testid={testId}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 px-1 text-left hover:opacity-80"
        data-testid={`${testId}-toggle`}
        aria-expanded={expanded}
      >
        <ChevronDown
          className={`${iconSize.sm} text-muted-foreground transition-transform ${
            expanded ? "" : "-rotate-90"
          }`}
        />
        <h2 className={`text-sm font-semibold ${toneTextClass[tone]}`}>{title}</h2>
        <Badge variant="outline" className={`text-xs ${toneBadgeClass[tone]}`}>
          {count}
        </Badge>
      </button>
      {expanded && <div className="flex flex-col gap-2">{children}</div>}
    </section>
  );
}

interface ActionCardProps {
  item: CustomerOverviewItem;
  selectedYear: number;
  selectedMonth: number;
  variant: "needsDoc" | "ready";
}

function ActionCustomerCard({ item, selectedYear, selectedMonth, variant }: ActionCardProps) {
  const deadline = computeDeadlineInfo(selectedYear, selectedMonth);
  const href = `/service-records?customerId=${item.customerId}&year=${selectedYear}&month=${selectedMonth}`;
  const isNeedsDoc = variant === "needsDoc";
  const count = isNeedsDoc ? item.undocumentedCount : item.uncoveredDocumentedCount;
  const counterLabel = isNeedsDoc
    ? `${count} ${count === 1 ? "Termin" : "Termine"} offen`
    : `${count} ${count === 1 ? "Termin" : "Termine"} bereit`;
  const counterTestId = isNeedsDoc
    ? `text-undocumented-${item.customerId}`
    : `text-ready-${item.customerId}`;
  const counterClass = isNeedsDoc
    ? deadline?.tone === "red"
      ? "text-red-600"
      : "text-amber-700"
    : "text-primary";
  const ctaLabel = isNeedsDoc ? "Termine dokumentieren" : "Leistungsnachweis erstellen";

  return (
    <Link href={href}>
      <Card data-testid={`card-overview-${item.customerId}`}>
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-1 min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <User className={`${iconSize.sm} text-muted-foreground`} />
                <span
                  className="font-medium"
                  data-testid={`text-customer-${item.customerId}`}
                >
                  {item.customerName}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className={`font-medium ${counterClass}`} data-testid={counterTestId}>
                  {counterLabel}
                </span>
                <span className="text-muted-foreground">{ctaLabel}</span>
              </div>
              {deadline && (
                <div className="mt-1">
                  <DeadlineHint info={deadline} />
                </div>
              )}
            </div>
            <ChevronRight className={`${iconSize.sm} text-muted-foreground shrink-0`} />
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

interface CompletedCardProps {
  item: CustomerOverviewItem;
  selectedYear: number;
  selectedMonth: number;
}

function CompletedCustomerCard({ item, selectedYear, selectedMonth }: CompletedCardProps) {
  const singleCount = item.singleRecords.length;
  const hasMonthly = !!item.existingRecord;
  const href = hasMonthly && item.existingRecord
    ? `/service-records/${item.existingRecord.id}`
    : `/service-records?customerId=${item.customerId}&year=${selectedYear}&month=${selectedMonth}`;

  const parts: string[] = [
    `${item.totalAppointments} ${item.totalAppointments === 1 ? "Termin" : "Termine"}`,
  ];
  if (hasMonthly) parts.push("1 monatl. LN");
  if (singleCount > 0) parts.push(`${singleCount} Einzel-LN`);

  return (
    <Link href={href}>
      <Card data-testid={`card-overview-${item.customerId}`}>
        <CardContent className="p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5 min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <User className={`${iconSize.sm} text-muted-foreground`} />
                <span
                  className="font-medium truncate"
                  data-testid={`text-customer-${item.customerId}`}
                >
                  {item.customerName}
                </span>
              </div>
              <p
                className="text-xs text-muted-foreground"
                data-testid={`text-completed-${item.customerId}`}
              >
                {parts.join(" · ")}
              </p>
            </div>
            <ChevronRight className={`${iconSize.sm} text-muted-foreground shrink-0`} />
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function OrphanRecordCard({ item, selectedYear, selectedMonth }: CompletedCardProps) {
  const href = item.existingRecord
    ? `/service-records/${item.existingRecord.id}`
    : `/service-records?customerId=${item.customerId}&year=${selectedYear}&month=${selectedMonth}`;
  return (
    <Link href={href}>
      <Card className="border-amber-200 bg-amber-50/40" data-testid={`card-orphan-${item.customerId}`}>
        <CardContent className="p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-start gap-2 min-w-0 flex-1">
              <AlertTriangle className={`${iconSize.sm} text-amber-600 mt-0.5 shrink-0`} />
              <div className="space-y-0.5 min-w-0">
                <span
                  className="font-medium text-sm block"
                  data-testid={`text-customer-${item.customerId}`}
                >
                  {item.customerName}
                </span>
                <p className="text-xs text-amber-700">
                  Leistungsnachweis ohne aktive Termine — bitte prüfen.
                </p>
              </div>
            </div>
            <ChevronRight className={`${iconSize.sm} text-muted-foreground shrink-0`} />
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

export interface OverviewSectionsProps {
  overview: CustomerOverviewItem[];
  selectedYear: number;
  selectedMonth: number;
  monthLabel: string;
}

export function OverviewSections({
  overview,
  selectedYear,
  selectedMonth,
  monthLabel,
}: OverviewSectionsProps) {
  const buckets = useMemo(() => bucketize(overview), [overview]);
  const completedTotal = buckets.completed.length + buckets.orphans.length;
  const allEmpty =
    buckets.needsDoc.length === 0 &&
    buckets.ready.length === 0 &&
    completedTotal === 0;

  if (allEmpty) {
    return (
      <Card className="border-dashed">
        <CardContent className="py-10">
          <EmptyState
            icon={<CheckCircle2 className={`${iconSize["2xl"]} text-green-600/60`} />}
            title={`Alles erledigt für ${monthLabel}`}
            description="Keine offenen Termine und keine ausstehenden Leistungsnachweise."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {buckets.needsDoc.length > 0 && (
        <OverviewSection
          title="Termine noch nicht dokumentiert"
          tone="amber"
          count={buckets.needsDoc.length}
          testId="section-needs-doc"
        >
          {buckets.needsDoc.map((item) => (
            <ActionCustomerCard
              key={item.customerId}
              item={item}
              selectedYear={selectedYear}
              selectedMonth={selectedMonth}
              variant="needsDoc"
            />
          ))}
        </OverviewSection>
      )}

      {buckets.ready.length > 0 && (
        <OverviewSection
          title="Bereit für Leistungsnachweis"
          tone="primary"
          count={buckets.ready.length}
          testId="section-ready"
        >
          {buckets.ready.map((item) => (
            <ActionCustomerCard
              key={item.customerId}
              item={item}
              selectedYear={selectedYear}
              selectedMonth={selectedMonth}
              variant="ready"
            />
          ))}
        </OverviewSection>
      )}

      {completedTotal > 0 && (
        <OverviewSection
          title="Abgeschlossen"
          tone="green"
          count={completedTotal}
          testId="section-completed"
          defaultExpanded={completedTotal <= 5}
        >
          {buckets.orphans.map((item) => (
            <OrphanRecordCard
              key={`orphan-${item.customerId}`}
              item={item}
              selectedYear={selectedYear}
              selectedMonth={selectedMonth}
            />
          ))}
          {buckets.completed.map((item) => (
            <CompletedCustomerCard
              key={item.customerId}
              item={item}
              selectedYear={selectedYear}
              selectedMonth={selectedMonth}
            />
          ))}
        </OverviewSection>
      )}
    </div>
  );
}
