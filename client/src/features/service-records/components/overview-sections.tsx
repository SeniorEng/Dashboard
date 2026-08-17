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
  monthlyRecords: { id: number; status: string }[];
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

type Tone = "amber" | "primary" | "green" | "yellow";

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
  awaitingSignature: CustomerOverviewItem[];
  completed: CustomerOverviewItem[];
  orphans: CustomerOverviewItem[];
}

export function bucketize(items: CustomerOverviewItem[]): BucketedOverview {
  const needsDoc: CustomerOverviewItem[] = [];
  const ready: CustomerOverviewItem[] = [];
  const awaitingSignature: CustomerOverviewItem[] = [];
  const completed: CustomerOverviewItem[] = [];
  const orphans: CustomerOverviewItem[] = [];
  for (const it of items) {
    // Die beiden Aktions-Kategorien schliessen sich NICHT aus.
    //
    // Vorher war das eine `continue`-Kette: ein einziger offener Termin liess
    // die Einordnung bei `needsDoc` abbrechen, und `uncoveredDocumentedCount`
    // wurde zwar berechnet, aber nie angezeigt. Ein dokumentierter, noch nicht
    // gebuendelter Termin fiel damit in gar keine sichtbare Kategorie — er war
    // weder als „zu dokumentieren" noch als „bereit" zu sehen. Genau in dem
    // Mischzustand, der im laufenden Monat der Normalfall ist.
    //
    // Jetzt darf derselbe Kunde in BEIDEN Listen stehen: „noch 2 Termine
    // dokumentieren" UND „3 dokumentierte buendeln". Zwei verschiedene
    // Handlungen, beide moeglich, beide sichtbar.
    const hatOffene = it.undocumentedCount > 0;
    const hatBuendelbare = it.uncoveredDocumentedCount > 0;
    if (hatOffene) needsDoc.push(it);
    if (hatBuendelbare) ready.push(it);
    // Die Zustands-Kategorien unten gelten weiterhin nur, wenn NICHTS zu tun
    // ist — sonst stuende ein Kunde mit offener Arbeit zusaetzlich unter
    // „wartet auf Unterschrift" und die Uebersicht verloere ihre Ordnung.
    if (hatOffene || hatBuendelbare) continue;
    // No open work. Records still awaiting signatures (pending/employee_signed)
    // get their own bucket so the customer never disappears completely — even
    // if there is also a finished single-record alongside the pending monthly
    // one (Rosali-Demirev case). Customers with ONLY completed records stay in
    // the completed bucket.
    const hasPendingRecord =
      it.monthlyRecords.some((r) => r.status !== "completed") ||
      it.singleRecords.some((r) => r.status !== "completed");
    if (hasPendingRecord) {
      awaitingSignature.push(it);
      continue;
    }

    const hasCompletedRecord =
      it.monthlyRecords.some((r) => r.status === "completed") ||
      it.singleRecords.some((r) => r.status === "completed");
    // Without a completed record there is nothing to show in the completed
    // bucket — the customer simply has no relevant activity this month.
    if (!hasCompletedRecord) continue;

    if (it.totalAppointments === 0) {
      orphans.push(it);
    } else {
      completed.push(it);
    }
  }
  needsDoc.sort(byNachname);
  ready.sort(byNachname);
  awaitingSignature.sort(byNachname);
  completed.sort(byNachname);
  orphans.sort(byNachname);
  return { needsDoc, ready, awaitingSignature, completed, orphans };
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
  yellow: "text-yellow-700",
};

const toneBadgeClass: Record<Tone, string> = {
  amber: "bg-amber-100 text-amber-700 border-amber-200",
  primary: "bg-primary/10 text-primary border-primary/20",
  green: "bg-green-100 text-green-700 border-green-200",
  yellow: "bg-yellow-100 text-yellow-700 border-yellow-200",
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
  // „N dokumentierte buendeln" statt „Leistungsnachweis erstellen": seit der
  // Lockerung kann die Kachel neben einer `needsDoc`-Kachel desselben Kunden
  // stehen. Dann muss auf einen Blick klar sein, dass sie sich auf die BEREITS
  // dokumentierten Termine bezieht und nicht auf den ganzen Monat.
  const ctaLabel = isNeedsDoc
    ? "Termine dokumentieren"
    : `${count} ${count === 1 ? "dokumentierten Termin" : "dokumentierte Termine"} bündeln`;

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
  const monthlyCount = item.monthlyRecords.length;
  const periodHref = `/service-records?customerId=${item.customerId}&year=${selectedYear}&month=${selectedMonth}`;
  // A single monthly proof links straight to it; multiple proofs link to the
  // period view so every one stays reachable.
  const href = monthlyCount === 1
    ? `/service-records/${item.monthlyRecords[0].id}`
    : periodHref;

  const parts: string[] = [
    `${item.totalAppointments} ${item.totalAppointments === 1 ? "Termin" : "Termine"}`,
  ];
  if (monthlyCount > 0) parts.push(`${monthlyCount} Sammel-LN`);
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

interface PendingProof {
  id: number;
  status: string;
  kind: "monthly" | "single";
}

// Each not-yet-completed proof becomes its own card so two pending monthly LNs
// for the same customer (Task #1526) never collapse into one invisible entry.
function pendingProofsOf(item: CustomerOverviewItem): PendingProof[] {
  return [
    ...item.monthlyRecords
      .filter((r) => r.status !== "completed")
      .map((r) => ({ id: r.id, status: r.status, kind: "monthly" as const })),
    ...item.singleRecords
      .filter((r) => r.status !== "completed")
      .map((r) => ({ id: r.id, status: r.status, kind: "single" as const })),
  ];
}

function statusLabel(status: string): string {
  return status === "employee_signed" ? "Kunden-Unterschrift offen" : "Unterschrift offen";
}

function AwaitingSignatureCard({ item, proof }: { item: CustomerOverviewItem; proof: PendingProof }) {
  const href = `/service-records/${proof.id}`;
  const kindLabel = proof.kind === "monthly" ? "Sammel-LN" : "Einzel-LN";

  return (
    <Link href={href}>
      <Card
        className="border-yellow-200 bg-yellow-50/40"
        data-testid={`card-awaiting-${proof.id}`}
      >
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
                className="text-xs text-yellow-700"
                data-testid={`text-awaiting-${proof.id}`}
              >
                {kindLabel} · {statusLabel(proof.status)}
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
  const href = item.monthlyRecords.length > 0
    ? `/service-records/${item.monthlyRecords[0].id}`
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
  const awaitingProofs = useMemo(
    () =>
      buckets.awaitingSignature.flatMap((item) =>
        pendingProofsOf(item).map((proof) => ({ item, proof })),
      ),
    [buckets.awaitingSignature],
  );
  const completedTotal = buckets.completed.length + buckets.orphans.length;
  const allEmpty =
    buckets.needsDoc.length === 0 &&
    buckets.ready.length === 0 &&
    buckets.awaitingSignature.length === 0 &&
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

      {awaitingProofs.length > 0 && (
        <OverviewSection
          title="Wartet auf Unterschrift"
          tone="yellow"
          count={awaitingProofs.length}
          testId="section-awaiting-signature"
        >
          {awaitingProofs.map(({ item, proof }) => (
            <AwaitingSignatureCard
              key={`${proof.kind}-${proof.id}`}
              item={item}
              proof={proof}
            />
          ))}
        </OverviewSection>
      )}

      {completedTotal > 0 && (
        <OverviewSection
          title="Leistungsnachweise erstellt"
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
