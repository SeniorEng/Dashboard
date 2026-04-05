import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Wallet, History, AlertTriangle, Calendar, Euro, Clock, ArrowRightLeft } from "lucide-react";
import { iconSize, componentStyles } from "@/design-system/tokens";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { invalidateRelated } from "@/lib/query-invalidation";
import { formatCurrency } from "@shared/utils/format";
import { formatDateForDisplay, parseLocalDate, todayISO } from "@shared/utils/datetime";
import { SectionCard } from "@/components/patterns/section-card";

interface BudgetOverview {
  entlastungsbetrag45b: {
    totalAllocatedCents: number;
    totalUsedCents: number;
    availableCents: number;
    plannedCents: number;
    availableAfterPlannedCents: number;
    currentMonthUsedCents: number;
    monthlyLimitCents: number | null;
    carryoverCents: number;
    carryoverExpiresAt: string | null;
    currentYearAllocatedCents: number;
    isCurrentlyActive: boolean;
  };
  umwandlung45a: {
    monthlyBudgetCents: number;
    currentMonthAllocatedCents: number;
    currentMonthUsedCents: number;
    currentMonthAvailableCents: number;
    isCurrentlyActive: boolean;
    label: string;
  };
  ersatzpflege39_42a: {
    yearlyBudgetCents: number;
    currentYearAllocatedCents: number;
    currentYearUsedCents: number;
    currentYearAvailableCents: number;
    label: string;
  };
}

interface BudgetTypeSetting {
  budgetType: string;
  enabled: boolean;
  priority: number;
  validFrom: string | null;
  validTo: string | null;
}

interface BudgetTransaction {
  id: number;
  customerId: number;
  budgetType: string;
  transactionDate: string;
  transactionType: string;
  amountCents: number;
  hauswirtschaftMinutes: number | null;
  hauswirtschaftCents: number | null;
  alltagsbegleitungMinutes: number | null;
  alltagsbegleitungCents: number | null;
  travelKilometers: number | null;
  travelCents: number | null;
  customerKilometers: number | null;
  customerKilometersCents: number | null;
  appointmentId: number | null;
  notes: string | null;
  createdAt: string;
}

const BUDGET_TYPE_LABELS: Record<string, string> = {
  entlastungsbetrag_45b: "§45b Entlastungsbetrag",
  umwandlung_45a: "§45a Umwandlungsanspruch",
  ersatzpflege_39_42a: "§39/§42a Gemeinsamer Jahresbetrag",
};

const BUDGET_TYPE_ICONS: Record<string, string> = {
  entlastungsbetrag_45b: "45b",
  umwandlung_45a: "45a",
  ersatzpflege_39_42a: "39",
};

function getTransactionTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    consumption: "Leistung",
    expiration: "Verfall",
    write_off: "Verfall",
    reversal: "Storno",
    manual_adjustment: "Manuelle Korrektur",
  };
  return labels[type] || type;
}

interface BudgetLedgerSectionProps {
  customerId: number;
  customerName: string;
  onRefresh?: () => void;
}

export function BudgetLedgerSection({ customerId, customerName, onRefresh }: BudgetLedgerSectionProps) {
  const queryClient = useQueryClient();

  const { data: typeSettings, isLoading: settingsLoading } = useQuery<BudgetTypeSetting[]>({
    queryKey: ["budget-type-settings", customerId],
    queryFn: async () => unwrapResult(await api.get<BudgetTypeSetting[]>(`/budget/${customerId}/type-settings`)),
    staleTime: 30000,
  });

  const { data: overview, isLoading: overviewLoading } = useQuery<BudgetOverview>({
    queryKey: ["budget-overview", customerId],
    queryFn: async () => unwrapResult(await api.get<BudgetOverview>(`/budget/${customerId}/overview`)),
    staleTime: 30000,
  });

  const today = todayISO();
  const enabledTypes = (typeSettings || [])
    .filter(s => s.enabled)
    .sort((a, b) => a.priority - b.priority)
    .map(s => ({
      ...s,
      isCurrentlyActive: (!s.validFrom || today >= s.validFrom) && (!s.validTo || today <= s.validTo),
    }));

  const handleRefresh = () => {
    invalidateRelated(queryClient, "budget");
    onRefresh?.();
  };

  if (settingsLoading || overviewLoading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-32 bg-gray-100 rounded-lg" />
      </div>
    );
  }

  if (enabledTypes.length === 0) {
    return (
      <Card className="border-dashed border-2">
        <CardContent className="py-6 text-center">
          <Wallet className={`${iconSize.xl} text-gray-500 mx-auto mb-3`} />
          <h3 className="font-medium text-gray-900">Noch kein Budget zugewiesen</h3>
          <p className="text-sm text-gray-500 mt-1">
            Aktivieren Sie die Budget-Einstellungen oben und legen Sie ggf. einen Startwert fest.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {enabledTypes.map(setting => {
        const budgetType = setting.budgetType;
        const label = BUDGET_TYPE_LABELS[budgetType] || budgetType;
        const inactiveLabel = !setting.isCurrentlyActive
          ? setting.validFrom && today < setting.validFrom
            ? `(ab ${setting.validFrom} gültig)`
            : `(abgelaufen seit ${setting.validTo})`
          : null;

        const wrapInactive = (content: React.ReactNode) => (
          <div key={budgetType} className={!setting.isCurrentlyActive ? "opacity-60 relative" : ""}>
            {!setting.isCurrentlyActive && (
              <div className="flex items-center gap-2 mb-2">
                <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-300" data-testid={`badge-inactive-${budgetType}`}>
                  {setting.validFrom && today < setting.validFrom ? "Noch nicht aktiv" : "Abgelaufen"}
                </Badge>
                <span className="text-xs text-amber-600 font-medium">{inactiveLabel}</span>
              </div>
            )}
            {content}
          </div>
        );

        if (budgetType === "entlastungsbetrag_45b" && overview) {
          const data = overview.entlastungsbetrag45b;
          return wrapInactive(
            <SectionCard
              title={label}
              icon={<Wallet className={iconSize.sm} />}
            >
              <BudgetPot45b
                customerId={customerId}
                data={data}
                onRefresh={handleRefresh}
              />
            </SectionCard>
          );
        }

        if (budgetType === "umwandlung_45a" && overview) {
          const data = overview.umwandlung45a;
          return wrapInactive(
            <SectionCard
              title={label}
              icon={<Wallet className={iconSize.sm} />}
            >
              <BudgetPot45a customerId={customerId} data={data} onRefresh={handleRefresh} />
            </SectionCard>
          );
        }

        if (budgetType === "ersatzpflege_39_42a" && overview) {
          const data = overview.ersatzpflege39_42a;
          return wrapInactive(
            <SectionCard
              title={label}
              icon={<Wallet className={iconSize.sm} />}
            >
              <BudgetPot39_42a customerId={customerId} data={data} onRefresh={handleRefresh} />
            </SectionCard>
          );
        }

        return null;
      })}
    </div>
  );
}

function BudgetPot45b({
  customerId,
  data,
  onRefresh,
}: {
  customerId: number;
  data: BudgetOverview["entlastungsbetrag45b"];
  onRefresh: () => void;
}) {
  const queryClient = useQueryClient();
  const [showAdjustmentDialog, setShowAdjustmentDialog] = useState(false);

  const { data: transactions } = useQuery<BudgetTransaction[]>({
    queryKey: ["budget-transactions", customerId, "entlastungsbetrag_45b"],
    queryFn: async () => unwrapResult(await api.get<BudgetTransaction[]>(
      `/budget/${customerId}/transactions?limit=10&budgetType=entlastungsbetrag_45b`
    )),
    staleTime: 30000,
  });

  const handleRefresh = () => {
    invalidateRelated(queryClient, "budget");
    onRefresh();
  };

  const usagePercent = data.totalAllocatedCents > 0
    ? Math.min(100, (data.totalUsedCents / data.totalAllocatedCents) * 100)
    : 0;

  const plannedPercent = data.totalAllocatedCents > 0
    ? Math.min(100 - usagePercent, (data.plannedCents / data.totalAllocatedCents) * 100)
    : 0;

  const monthlyUsagePercent = data.monthlyLimitCents
    ? Math.min(100, (data.currentMonthUsedCents / data.monthlyLimitCents) * 100)
    : 0;

  const hasPlanned = data.plannedCents > 0;
  const budgetExceeded = data.availableAfterPlannedCents < 0;

  const hasData = data.totalAllocatedCents > 0;

  if (!hasData) {
    return (
      <p className="text-sm text-gray-500 text-center py-4" data-testid="text-45b-no-data">
        Noch keine Zuweisungen vorhanden
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {budgetExceeded && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 border border-red-200" data-testid="warning-budget-exceeded">
          <AlertTriangle className={`${iconSize.sm} text-red-600 flex-shrink-0`} />
          <p className="text-sm text-red-700 font-medium">
            Budget reicht nicht für alle geplanten Termine ({formatCurrency(Math.abs(data.availableAfterPlannedCents))} über Budget)
          </p>
        </div>
      )}

      <div className={`grid gap-4 ${hasPlanned ? "md:grid-cols-3" : "md:grid-cols-2"}`}>
        <Card className={budgetExceeded ? "bg-red-50 border-red-100" : "bg-green-50 border-green-100"}>
          <CardContent className="pt-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-600">{hasPlanned ? "Verfügbar (nach Planung)" : "Verfügbar"}</p>
              <Euro className={`${iconSize.sm} ${budgetExceeded ? "text-red-600" : "text-green-600"}`} />
            </div>
            <p className={`text-2xl font-bold mt-1 ${budgetExceeded ? "text-red-700" : "text-green-700"}`} data-testid="text-45b-available">
              {formatCurrency(hasPlanned ? data.availableAfterPlannedCents : data.availableCents)}
            </p>
            <div className="mt-2 h-2 w-full rounded-full bg-gray-200 overflow-hidden flex" role="progressbar" data-testid="progress-45b-available">
              <div className="h-full bg-primary transition-all" style={{ width: `${Math.max(0, usagePercent)}%` }} />
              {hasPlanned && (
                <div className="h-full bg-orange-400 transition-all" style={{ width: `${Math.max(0, plannedPercent)}%` }} />
              )}
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {usagePercent.toFixed(0)}% verbraucht{hasPlanned ? ` · ${plannedPercent.toFixed(0)}% geplant` : ""}
            </p>
          </CardContent>
        </Card>

        {hasPlanned && (
          <Card className="bg-orange-50 border-orange-100">
            <CardContent className="pt-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-600">Geplant</p>
                <Clock className={`${iconSize.sm} text-orange-600`} />
              </div>
              <p className="text-2xl font-bold text-orange-700 mt-1" data-testid="text-45b-planned">
                {formatCurrency(data.plannedCents)}
              </p>
              <p className="text-xs text-gray-500 mt-2">
                Offene Termine (noch nicht dokumentiert)
              </p>
            </CardContent>
          </Card>
        )}

        <Card className="bg-blue-50 border-blue-100">
          <CardContent className="pt-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-600">Gesamt zugewiesen</p>
              <Wallet className={`${iconSize.sm} text-blue-600`} />
            </div>
            <p className="text-2xl font-bold text-blue-700 mt-1" data-testid="text-45b-allocated">
              {formatCurrency(data.totalAllocatedCents)}
            </p>
            <p className="text-xs text-gray-500 mt-2">
              Davon {formatCurrency(data.totalUsedCents)} verbraucht
            </p>
          </CardContent>
        </Card>
      </div>

      {data.carryoverCents > 0 && (
        <Card className={`border ${
          data.carryoverExpiresAt && parseLocalDate(data.carryoverExpiresAt) < new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
            ? "bg-amber-50 border-amber-200"
            : "bg-gray-50 border-gray-200"
        }`}>
          <CardContent className="pt-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-600">Übertrag</p>
              {data.carryoverExpiresAt && parseLocalDate(data.carryoverExpiresAt) < new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) && (
                <AlertTriangle className={`${iconSize.sm} text-amber-600`} />
              )}
            </div>
            <p className="text-2xl font-bold text-gray-700 mt-1" data-testid="text-45b-carryover">
              {formatCurrency(data.carryoverCents)}
            </p>
            {data.carryoverExpiresAt && (
              <p className="text-xs text-amber-600 mt-2 flex items-center gap-1">
                <Calendar className="w-3 h-3" />
                Verfällt am {formatDateForDisplay(data.carryoverExpiresAt)}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {data.monthlyLimitCents ? (
        <Card className="bg-purple-50 border-purple-100">
          <CardContent className="pt-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-medium text-gray-700">Monatslimit</p>
              <Badge variant={monthlyUsagePercent > 80 ? "destructive" : "secondary"}>
                {monthlyUsagePercent.toFixed(0)}%
              </Badge>
            </div>
            <div className="h-2 w-full rounded-full bg-gray-200 overflow-hidden" role="progressbar" data-testid="progress-45b-monthly">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.max(0, Math.min(100, monthlyUsagePercent))}%` }} />
            </div>
            <div className="flex justify-between text-xs text-gray-500 mt-1">
              <span>{formatCurrency(data.currentMonthUsedCents)} diesen Monat</span>
              <span>Limit: {formatCurrency(data.monthlyLimitCents)}</span>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <TransactionList
        customerId={customerId}
        budgetType="entlastungsbetrag_45b"
        transactions={transactions}
        onRefresh={handleRefresh}
        showAdjustmentDialog={showAdjustmentDialog}
        setShowAdjustmentDialog={setShowAdjustmentDialog}
      />
    </div>
  );
}

function BudgetPot45a({
  customerId,
  data,
  onRefresh,
}: {
  customerId: number;
  data: BudgetOverview["umwandlung45a"];
  onRefresh: () => void;
}) {
  const queryClient = useQueryClient();
  const [showAdjustmentDialog, setShowAdjustmentDialog] = useState(false);

  const { data: transactions } = useQuery<BudgetTransaction[]>({
    queryKey: ["budget-transactions", customerId, "umwandlung_45a"],
    queryFn: async () => unwrapResult(await api.get<BudgetTransaction[]>(
      `/budget/${customerId}/transactions?limit=10&budgetType=umwandlung_45a`
    )),
    staleTime: 30000,
  });

  const handleRefresh = () => {
    invalidateRelated(queryClient, "budget");
    onRefresh();
  };

  const usagePercent = data.currentMonthAllocatedCents > 0
    ? Math.min(100, (data.currentMonthUsedCents / data.currentMonthAllocatedCents) * 100)
    : 0;

  const hasData = data.currentMonthAllocatedCents > 0 || data.monthlyBudgetCents > 0;

  if (!hasData) {
    return (
      <p className="text-sm text-gray-500 text-center py-4" data-testid="text-45a-no-data">
        Noch keine Zuweisungen vorhanden
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="bg-green-50 border-green-100">
          <CardContent className="pt-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-600">Verfügbar (Monat)</p>
              <Euro className={`${iconSize.sm} text-green-600`} />
            </div>
            <p className="text-2xl font-bold text-green-700 mt-1" data-testid="text-45a-available">
              {formatCurrency(data.currentMonthAvailableCents)}
            </p>
            <div className="mt-2 h-2 w-full rounded-full bg-gray-200 overflow-hidden" role="progressbar" data-testid="progress-45a-available">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.max(0, Math.min(100, 100 - usagePercent))}%` }} />
            </div>
            <p className="text-xs text-gray-500 mt-1">{usagePercent.toFixed(0)}% verbraucht</p>
          </CardContent>
        </Card>

        <Card className="bg-blue-50 border-blue-100">
          <CardContent className="pt-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-600">Monatsbudget</p>
              <Wallet className={`${iconSize.sm} text-blue-600`} />
            </div>
            <p className="text-2xl font-bold text-blue-700 mt-1" data-testid="text-45a-monthly">
              {formatCurrency(data.monthlyBudgetCents)}
            </p>
            <p className="text-xs text-gray-500 mt-2">
              Davon {formatCurrency(data.currentMonthUsedCents)} verbraucht
            </p>
          </CardContent>
        </Card>
      </div>

      <TransactionList
        customerId={customerId}
        budgetType="umwandlung_45a"
        transactions={transactions}
        onRefresh={handleRefresh}
        showAdjustmentDialog={showAdjustmentDialog}
        setShowAdjustmentDialog={setShowAdjustmentDialog}
      />
    </div>
  );
}

function BudgetPot39_42a({
  customerId,
  data,
  onRefresh,
}: {
  customerId: number;
  data: BudgetOverview["ersatzpflege39_42a"];
  onRefresh: () => void;
}) {
  const queryClient = useQueryClient();
  const [showAdjustmentDialog, setShowAdjustmentDialog] = useState(false);

  const { data: transactions } = useQuery<BudgetTransaction[]>({
    queryKey: ["budget-transactions", customerId, "ersatzpflege_39_42a"],
    queryFn: async () => unwrapResult(await api.get<BudgetTransaction[]>(
      `/budget/${customerId}/transactions?limit=10&budgetType=ersatzpflege_39_42a`
    )),
    staleTime: 30000,
  });

  const handleRefresh = () => {
    invalidateRelated(queryClient, "budget");
    onRefresh();
  };

  const usagePercent = data.currentYearAllocatedCents > 0
    ? Math.min(100, (data.currentYearUsedCents / data.currentYearAllocatedCents) * 100)
    : 0;

  const hasData = data.currentYearAllocatedCents > 0 || data.yearlyBudgetCents > 0;

  if (!hasData) {
    return (
      <p className="text-sm text-gray-500 text-center py-4" data-testid="text-39-no-data">
        Noch keine Zuweisungen vorhanden
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="bg-green-50 border-green-100">
          <CardContent className="pt-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-600">Verfügbar (Jahr)</p>
              <Euro className={`${iconSize.sm} text-green-600`} />
            </div>
            <p className="text-2xl font-bold text-green-700 mt-1" data-testid="text-39-available">
              {formatCurrency(data.currentYearAvailableCents)}
            </p>
            <div className="mt-2 h-2 w-full rounded-full bg-gray-200 overflow-hidden" role="progressbar" data-testid="progress-39-available">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.max(0, Math.min(100, 100 - usagePercent))}%` }} />
            </div>
            <p className="text-xs text-gray-500 mt-1">{usagePercent.toFixed(0)}% verbraucht</p>
          </CardContent>
        </Card>

        <Card className="bg-blue-50 border-blue-100">
          <CardContent className="pt-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-600">Jahresbudget</p>
              <Wallet className={`${iconSize.sm} text-blue-600`} />
            </div>
            <p className="text-2xl font-bold text-blue-700 mt-1" data-testid="text-39-yearly">
              {formatCurrency(data.yearlyBudgetCents)}
            </p>
            <p className="text-xs text-gray-500 mt-2">
              Davon {formatCurrency(data.currentYearUsedCents)} verbraucht
            </p>
          </CardContent>
        </Card>
      </div>

      <TransactionList
        customerId={customerId}
        budgetType="ersatzpflege_39_42a"
        transactions={transactions}
        onRefresh={handleRefresh}
        showAdjustmentDialog={showAdjustmentDialog}
        setShowAdjustmentDialog={setShowAdjustmentDialog}
      />
    </div>
  );
}

function TransactionList({
  customerId,
  budgetType,
  transactions,
  onRefresh,
  showAdjustmentDialog,
  setShowAdjustmentDialog,
}: {
  customerId: number;
  budgetType: string;
  transactions?: BudgetTransaction[];
  onRefresh: () => void;
  showAdjustmentDialog: boolean;
  setShowAdjustmentDialog: (v: boolean) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [rebookTx, setRebookTx] = useState<BudgetTransaction | null>(null);
  const [targetBudgetType, setTargetBudgetType] = useState<string>("");

  const rebookMutation = useMutation({
    mutationFn: async ({ transactionId, target }: { transactionId: number; target: string }) => {
      return unwrapResult(await api.post(`/budget/${customerId}/rebook-transaction`, {
        transactionId,
        targetBudgetType: target,
      }));
    },
    onSuccess: () => {
      toast({ title: "Umbuchung erfolgreich" });
      invalidateRelated(queryClient, "budget");
      setRebookTx(null);
      setTargetBudgetType("");
      onRefresh();
    },
    onError: (error: Error) => {
      toast({ variant: "destructive", title: "Fehler bei Umbuchung", description: error.message });
    },
  });

  const { data: typeSettings } = useQuery<BudgetTypeSetting[]>({
    queryKey: ["budget-type-settings", customerId],
    queryFn: async () => unwrapResult(await api.get<BudgetTypeSetting[]>(`/budget/${customerId}/type-settings`)),
    staleTime: 30000,
  });

  const getEligibleTargetPots = (refDate?: string) => {
    const checkDate = refDate ?? todayISO();
    return Object.entries(BUDGET_TYPE_LABELS)
      .filter(([key]) => key !== budgetType)
      .filter(([key]) => {
        const setting = typeSettings?.find(s => s.budgetType === key);
        if (!setting || !setting.enabled) return false;
        if (setting.validFrom && checkDate < setting.validFrom) return false;
        if (setting.validTo && checkDate > setting.validTo) return false;
        return true;
      });
  };
  const otherBudgetTypes = getEligibleTargetPots(rebookTx?.transactionDate);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <History className={iconSize.sm} />
            Letzte Buchungen
          </CardTitle>
          <Dialog open={showAdjustmentDialog} onOpenChange={setShowAdjustmentDialog}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" data-testid={`button-adjustment-${budgetType}`}>
                <Plus className={iconSize.sm} />
                Korrektur
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Manuelle Korrektur</DialogTitle>
              </DialogHeader>
              <ManualAdjustmentForm
                customerId={customerId}
                budgetType={budgetType}
                onSuccess={() => {
                  setShowAdjustmentDialog(false);
                  onRefresh();
                }}
              />
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>
      <CardContent>
        {transactions && transactions.length > 0 ? (
          <div className="space-y-2">
            {transactions.map((tx) => (
              <div
                key={tx.id}
                className="flex items-center justify-between p-3 rounded-lg bg-gray-50"
                data-testid={`row-transaction-${tx.id}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge variant={tx.amountCents < 0 ? "destructive" : "secondary"}>
                      {getTransactionTypeLabel(tx.transactionType)}
                    </Badge>
                    <span className="text-sm text-gray-500">{formatDateForDisplay(tx.transactionDate)}</span>
                  </div>
                  {tx.notes && (
                    <p className="text-xs text-gray-500 mt-1">{tx.notes}</p>
                  )}
                  {tx.transactionType === "consumption" && (
                    <p className="text-xs text-gray-500 mt-1">
                      {tx.hauswirtschaftMinutes ? `HW: ${tx.hauswirtschaftMinutes}min ` : ""}
                      {tx.alltagsbegleitungMinutes ? `AB: ${tx.alltagsbegleitungMinutes}min ` : ""}
                      {tx.travelKilometers ? `Anfahrt: ${Number(tx.travelKilometers).toFixed(1).replace(".", ",")}km ` : ""}
                      {tx.customerKilometers ? `Kunde: ${Number(tx.customerKilometers).toFixed(1).replace(".", ",")}km` : ""}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 ml-2 shrink-0">
                  {tx.transactionType === "consumption" && (
                    <button
                      type="button"
                      onClick={() => { setRebookTx(tx); setTargetBudgetType(""); }}
                      className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded hover:bg-gray-200 text-gray-500 hover:text-gray-600"
                      aria-label="Umbuchen"
                      title="Umbuchen"
                      data-testid={`btn-rebook-${tx.id}`}
                    >
                      <ArrowRightLeft className="h-4 w-4" />
                    </button>
                  )}
                  <span className={`font-medium ${tx.amountCents < 0 ? "text-red-600" : "text-green-600"}`}>
                    {tx.amountCents > 0 ? "+" : ""}{formatCurrency(tx.amountCents)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-500 text-center py-4">
            Noch keine Buchungen vorhanden
          </p>
        )}
      </CardContent>

      <Dialog open={rebookTx !== null} onOpenChange={(open) => { if (!open) { setRebookTx(null); setTargetBudgetType(""); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowRightLeft className="h-5 w-5" />
              Einzelbuchung umbuchen
            </DialogTitle>
          </DialogHeader>
          {rebookTx && (
            <div className="space-y-4">
              <div className="bg-gray-50 rounded-lg p-3 text-sm space-y-1">
                <p><span className="text-gray-500">Datum:</span> {formatDateForDisplay(rebookTx.transactionDate)}</p>
                <p><span className="text-gray-500">Betrag:</span> {formatCurrency(rebookTx.amountCents)}</p>
                <p><span className="text-gray-500">Aktueller Topf:</span> {BUDGET_TYPE_LABELS[budgetType]}</p>
              </div>
              <div>
                <Label className="text-sm">Ziel-Topf</Label>
                <Select value={targetBudgetType} onValueChange={setTargetBudgetType}>
                  <SelectTrigger className="mt-1" data-testid="select-rebook-target">
                    <SelectValue placeholder="Topf auswählen..." />
                  </SelectTrigger>
                  <SelectContent>
                    {otherBudgetTypes.map(([key, label]) => (
                      <SelectItem key={key} value={key} data-testid={`option-rebook-${key}`}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                <p className="text-xs text-amber-800">
                  Die bestehende Buchung wird storniert und der Betrag auf den gewählten Topf neu gebucht.
                </p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => { setRebookTx(null); setTargetBudgetType(""); }}>
              Abbrechen
            </Button>
            <Button
              size="sm"
              disabled={!targetBudgetType || rebookMutation.isPending}
              onClick={() => {
                if (rebookTx && targetBudgetType) {
                  rebookMutation.mutate({ transactionId: rebookTx.id, target: targetBudgetType });
                }
              }}
              data-testid="btn-confirm-single-rebook"
            >
              <ArrowRightLeft className={`h-3.5 w-3.5 mr-1.5 ${rebookMutation.isPending ? "animate-spin" : ""}`} />
              {rebookMutation.isPending ? "Wird umgebucht..." : "Umbuchen"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function ManualAdjustmentForm({ customerId, budgetType, onSuccess }: { customerId: number; budgetType: string; onSuccess: () => void }) {
  const { toast } = useToast();
  const [amount, setAmount] = useState("");
  const [isNegative, setIsNegative] = useState(false);
  const [notes, setNotes] = useState("");

  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (data: { amountCents: number; notes: string; budgetType: string }) => {
      return unwrapResult(await api.post(`/budget/${customerId}/manual-adjustment`, data));
    },
    onSuccess: () => {
      toast({ title: "Korrektur erfolgreich gespeichert" });
      invalidateRelated(queryClient, "budget");
      onSuccess();
    },
    onError: (error) => {
      toast({ variant: "destructive", title: "Fehler", description: error.message });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const amountCents = Math.round(parseFloat(amount || "0") * 100);
    mutation.mutate({
      amountCents: isNegative ? -amountCents : amountCents,
      notes,
      budgetType,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <Label htmlFor="adjustmentType">Art der Korrektur</Label>
        <div className="flex gap-2 mt-2">
          <Button
            type="button"
            variant={!isNegative ? "default" : "outline"}
            onClick={() => setIsNegative(false)}
            className="flex-1"
            data-testid="button-adjustment-add"
          >
            Gutschrift (+)
          </Button>
          <Button
            type="button"
            variant={isNegative ? "default" : "outline"}
            onClick={() => setIsNegative(true)}
            className="flex-1"
            data-testid="button-adjustment-subtract"
          >
            Abzug (-)
          </Button>
        </div>
      </div>
      <div>
        <Label htmlFor="amount">Betrag (€)</Label>
        <Input
          id="amount"
          type="number"
          step="0.01"
          min="0"
          placeholder="0,00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
          data-testid="input-adjustment-amount"
        />
      </div>
      <div>
        <Label htmlFor="notes">Begründung</Label>
        <Textarea
          id="notes"
          placeholder="Grund für die Korrektur..."
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          required
          data-testid="input-adjustment-notes"
        />
      </div>
      <Button type="submit" className={componentStyles.btnPrimary} disabled={mutation.isPending || !notes.trim()} data-testid="button-submit-adjustment">
        {mutation.isPending ? "Speichern..." : "Korrektur speichern"}
      </Button>
    </form>
  );
}
