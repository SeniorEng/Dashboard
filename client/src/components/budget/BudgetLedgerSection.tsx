import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { DatePicker } from "@/components/ui/date-picker";
import { Plus, Wallet, History, AlertTriangle, Calendar, Settings, Euro } from "lucide-react";
import { iconSize, componentStyles } from "@/design-system/tokens";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { formatCurrency } from "@shared/utils/format";
import { formatDateForDisplay, todayISO, parseLocalDate } from "@shared/utils/datetime";

interface BudgetSummary {
  customerId: number;
  totalAllocatedCents: number;
  totalUsedCents: number;
  availableCents: number;
  carryoverCents: number;
  carryoverExpiresAt: string | null;
  currentYearAllocatedCents: number;
  monthlyLimitCents: number | null;
  currentMonthUsedCents: number;
}

interface BudgetTransaction {
  id: number;
  customerId: number;
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
  initialSummary?: BudgetSummary | null;
  onRefresh?: () => void;
}

export function BudgetLedgerSection({ customerId, customerName, initialSummary, onRefresh }: BudgetLedgerSectionProps) {
  const queryClient = useQueryClient();
  const [showInitialBudgetDialog, setShowInitialBudgetDialog] = useState(false);
  const [showAdjustmentDialog, setShowAdjustmentDialog] = useState(false);


  const hasInitialSummary = initialSummary !== undefined;
  
  const { data: fetchedSummary, isLoading: summaryLoading } = useQuery<BudgetSummary>({
    queryKey: ["budget-summary", customerId],
    queryFn: async () => {
      const result = await api.get<BudgetSummary>(`/budget/${customerId}/summary`);
      return unwrapResult(result);
    },
    enabled: !hasInitialSummary,
    staleTime: 30000,
  });

  const summary = hasInitialSummary ? initialSummary : fetchedSummary;

  const { data: transactions } = useQuery<BudgetTransaction[]>({
    queryKey: ["budget-transactions", customerId],
    queryFn: async () => {
      const result = await api.get<BudgetTransaction[]>(`/budget/${customerId}/transactions?limit=10`);
      return unwrapResult(result);
    },
    staleTime: 30000,
  });

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ["budget-summary", customerId] });
    queryClient.invalidateQueries({ queryKey: ["budget-transactions", customerId] });
    onRefresh?.();
  };

  const usagePercent = summary && summary.totalAllocatedCents > 0
    ? Math.min(100, (summary.totalUsedCents / summary.totalAllocatedCents) * 100)
    : 0;

  const monthlyUsagePercent = summary && summary.monthlyLimitCents
    ? Math.min(100, (summary.currentMonthUsedCents / summary.monthlyLimitCents) * 100)
    : 0;

  if (!hasInitialSummary && summaryLoading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-32 bg-gray-100 rounded-lg" />
        <div className="h-48 bg-gray-100 rounded-lg" />
      </div>
    );
  }

  const hasNoBudget = !summary || summary.totalAllocatedCents === 0;

  return (
    <div className="space-y-6">
      {hasNoBudget ? (
        <Card className="border-dashed border-2">
          <CardContent className="py-8 text-center">
            <Wallet className={`${iconSize.xl} text-gray-400 mx-auto mb-3`} />
            <h3 className="font-medium text-gray-900">Kein Budget erfasst</h3>
            <p className="text-sm text-gray-500 mt-1 mb-4">
              Erfassen Sie das Startbudget für {customerName}
            </p>
            <Dialog open={showInitialBudgetDialog} onOpenChange={setShowInitialBudgetDialog}>
              <DialogTrigger asChild>
                <Button className={componentStyles.btnPrimary} data-testid="button-add-initial-budget">
                  <Plus className={iconSize.sm} />
                  Startbudget erfassen
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Startbudget erfassen</DialogTitle>
                </DialogHeader>
                <InitialBudgetForm
                  customerId={customerId}
                  onSuccess={() => {
                    setShowInitialBudgetDialog(false);
                    handleRefresh();
                  }}
                />
              </DialogContent>
            </Dialog>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <Card className="bg-green-50 border-green-100">
              <CardContent className="pt-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-gray-600">Verfügbar</p>
                  <Euro className={`${iconSize.sm} text-green-600`} />
                </div>
                <p className="text-2xl font-bold text-green-700 mt-1" data-testid="text-budget-available">
                  {formatCurrency(summary!.availableCents)}
                </p>
                <div className="mt-2 h-2 w-full rounded-full bg-gray-200 overflow-hidden" role="progressbar" aria-valuenow={100 - usagePercent} aria-valuemin={0} aria-valuemax={100} data-testid="progress-budget-available">
                  <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.max(0, Math.min(100, 100 - usagePercent))}%` }} />
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  {usagePercent.toFixed(0)}% verbraucht
                </p>
              </CardContent>
            </Card>

            <Card className="bg-blue-50 border-blue-100">
              <CardContent className="pt-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-gray-600">Gesamt zugewiesen</p>
                  <Wallet className={`${iconSize.sm} text-blue-600`} />
                </div>
                <p className="text-2xl font-bold text-blue-700 mt-1" data-testid="text-budget-allocated">
                  {formatCurrency(summary!.totalAllocatedCents)}
                </p>
                <p className="text-xs text-gray-500 mt-2">
                  Davon {formatCurrency(summary!.totalUsedCents)} verbraucht
                </p>
              </CardContent>
            </Card>

            {summary!.carryoverCents > 0 && (
              <Card className={`border ${
                summary!.carryoverExpiresAt && parseLocalDate(summary!.carryoverExpiresAt) < new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
                  ? "bg-amber-50 border-amber-200"
                  : "bg-gray-50 border-gray-200"
              }`}>
                <CardContent className="pt-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-gray-600">Übertrag</p>
                    {summary!.carryoverExpiresAt && parseLocalDate(summary!.carryoverExpiresAt) < new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) && (
                      <AlertTriangle className={`${iconSize.sm} text-amber-600`} />
                    )}
                  </div>
                  <p className="text-2xl font-bold text-gray-700 mt-1" data-testid="text-budget-carryover">
                    {formatCurrency(summary!.carryoverCents)}
                  </p>
                  {summary!.carryoverExpiresAt && (
                    <p className="text-xs text-amber-600 mt-2 flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      Verfällt am {formatDateForDisplay(summary!.carryoverExpiresAt!)}
                    </p>
                  )}
                </CardContent>
              </Card>
            )}
          </div>

          {summary!.monthlyLimitCents ? (
            <Card className="bg-purple-50 border-purple-100">
              <CardContent className="pt-4">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-medium text-gray-700">Monatslimit</p>
                  <Badge variant={monthlyUsagePercent > 80 ? "destructive" : "secondary"}>
                    {monthlyUsagePercent.toFixed(0)}%
                  </Badge>
                </div>
                <div className="h-2 w-full rounded-full bg-gray-200 overflow-hidden" role="progressbar" aria-valuenow={monthlyUsagePercent} aria-valuemin={0} aria-valuemax={100} data-testid="progress-budget-monthly">
                  <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.max(0, Math.min(100, monthlyUsagePercent))}%` }} />
                </div>
                <div className="flex justify-between text-xs text-gray-500 mt-1">
                  <span>{formatCurrency(summary!.currentMonthUsedCents)} diesen Monat</span>
                  <span>Limit: {formatCurrency(summary!.monthlyLimitCents)}</span>
                </div>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <History className={iconSize.sm} />
                  Letzte Buchungen
                </CardTitle>
                <Dialog open={showAdjustmentDialog} onOpenChange={setShowAdjustmentDialog}>
                  <DialogTrigger asChild>
                    <Button variant="outline" size="sm" data-testid="button-manual-adjustment">
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
                      onSuccess={() => {
                        setShowAdjustmentDialog(false);
                        handleRefresh();
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
                      <div>
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
                          <p className="text-xs text-gray-400 mt-1">
                            {tx.hauswirtschaftMinutes ? `HW: ${tx.hauswirtschaftMinutes}min ` : ""}
                            {tx.alltagsbegleitungMinutes ? `AB: ${tx.alltagsbegleitungMinutes}min ` : ""}
                            {tx.travelKilometers ? `Anfahrt: ${(tx.travelKilometers / 10).toFixed(1)}km ` : ""}
                            {tx.customerKilometers ? `Kunde: ${(tx.customerKilometers / 10).toFixed(1)}km` : ""}
                          </p>
                        )}
                      </div>
                      <span className={`font-medium ${tx.amountCents < 0 ? "text-red-600" : "text-green-600"}`}>
                        {tx.amountCents > 0 ? "+" : ""}{formatCurrency(tx.amountCents)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-500 text-center py-4">
                  Noch keine Buchungen vorhanden
                </p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function InitialBudgetForm({ customerId, onSuccess }: { customerId: number; onSuccess: () => void }) {
  const { toast } = useToast();
  const [currentYearAmount, setCurrentYearAmount] = useState("");
  const [carryoverAmount, setCarryoverAmount] = useState("");
  const [budgetStartDate, setBudgetStartDate] = useState(todayISO());

  const mutation = useMutation({
    mutationFn: async (data: { currentYearAmountCents: number; carryoverAmountCents: number; budgetStartDate: string }) => {
      return unwrapResult(await api.post(`/budget/${customerId}/initial-budget`, data));
    },
    onSuccess: () => {
      toast({ title: "Startbudget erfolgreich erfasst" });
      onSuccess();
    },
    onError: (error) => {
      toast({ variant: "destructive", title: "Fehler", description: error.message });
      console.error(error);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const currentYearCents = Math.round(parseFloat(currentYearAmount || "0") * 100);
    const carryoverCents = Math.round(parseFloat(carryoverAmount || "0") * 100);
    mutation.mutate({
      currentYearAmountCents: currentYearCents,
      carryoverAmountCents: carryoverCents,
      budgetStartDate,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <Label>Startdatum</Label>
        <DatePicker
          value={budgetStartDate || null}
          onChange={(val) => setBudgetStartDate(val || "")}
          data-testid="input-budget-start-date"
        />
        <p className="text-xs text-gray-500 mt-1">
          Ab wann wird das Budget genutzt?
        </p>
      </div>
      <div>
        <Label htmlFor="currentYearAmount">Guthaben laufendes Jahr (€)</Label>
        <Input
          id="currentYearAmount"
          type="number"
          step="0.01"
          min="0"
          placeholder="z.B. 524,00 (4 Monate × 131€)"
          value={currentYearAmount}
          onChange={(e) => setCurrentYearAmount(e.target.value)}
          data-testid="input-current-year-amount"
        />
        <p className="text-xs text-gray-500 mt-1">
          Bereits angesammeltes Budget im laufenden Jahr
        </p>
      </div>
      <div>
        <Label htmlFor="carryoverAmount">Übertrag Vorjahr (€)</Label>
        <Input
          id="carryoverAmount"
          type="number"
          step="0.01"
          min="0"
          placeholder="z.B. 786,00 (6 Monate Übertrag)"
          value={carryoverAmount}
          onChange={(e) => setCarryoverAmount(e.target.value)}
          data-testid="input-carryover-amount"
        />
        <p className="text-xs text-gray-500 mt-1">
          Restbudget aus dem Vorjahr (verfällt am 30.06.)
        </p>
      </div>
      <Button type="submit" className={componentStyles.btnPrimary} disabled={mutation.isPending} data-testid="button-submit-initial-budget">
        {mutation.isPending ? "Speichern..." : "Startbudget erfassen"}
      </Button>
    </form>
  );
}

function ManualAdjustmentForm({ customerId, onSuccess }: { customerId: number; onSuccess: () => void }) {
  const { toast } = useToast();
  const [amount, setAmount] = useState("");
  const [isNegative, setIsNegative] = useState(false);
  const [notes, setNotes] = useState("");

  const mutation = useMutation({
    mutationFn: async (data: { amountCents: number; notes: string }) => {
      return unwrapResult(await api.post(`/budget/${customerId}/manual-adjustment`, data));
    },
    onSuccess: () => {
      toast({ title: "Korrektur erfolgreich gespeichert" });
      onSuccess();
    },
    onError: (error) => {
      toast({ variant: "destructive", title: "Fehler", description: error.message });
      console.error(error);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const amountCents = Math.round(parseFloat(amount || "0") * 100);
    mutation.mutate({
      amountCents: isNegative ? -amountCents : amountCents,
      notes,
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

function PreferencesForm({ customerId, currentLimit, onSuccess }: { customerId: number; currentLimit: number | null; onSuccess: () => void }) {
  const { toast } = useToast();
  const [monthlyLimit, setMonthlyLimit] = useState(currentLimit ? (currentLimit / 100).toString() : "");

  const mutation = useMutation({
    mutationFn: async (data: { monthlyLimitCents: number | null }) => {
      return unwrapResult(await api.put(`/budget/${customerId}/preferences`, data));
    },
    onSuccess: () => {
      toast({ title: "Einstellungen gespeichert" });
      onSuccess();
    },
    onError: (error) => {
      toast({ variant: "destructive", title: "Fehler", description: error.message });
      console.error(error);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const limitCents = monthlyLimit ? Math.round(parseFloat(monthlyLimit) * 100) : null;
    mutation.mutate({ monthlyLimitCents: limitCents });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <Label htmlFor="monthlyLimit">Monatliches Wunschlimit (€)</Label>
        <Input
          id="monthlyLimit"
          type="number"
          step="0.01"
          min="0"
          placeholder="z.B. 100,00 (leer = kein Limit)"
          value={monthlyLimit}
          onChange={(e) => setMonthlyLimit(e.target.value)}
          data-testid="input-monthly-limit"
        />
        <p className="text-xs text-gray-500 mt-1">
          Das Wunschlimit dient als Orientierung. Bei Überschreitung erfolgt ein Hinweis.
        </p>
      </div>
      <div className="flex gap-2">
        <Button type="submit" className={componentStyles.btnPrimary} disabled={mutation.isPending} data-testid="button-submit-preferences">
          {mutation.isPending ? "Speichern..." : "Speichern"}
        </Button>
        {currentLimit && (
          <Button 
            type="button" 
            variant="outline" 
            onClick={() => {
              setMonthlyLimit("");
              mutation.mutate({ monthlyLimitCents: null });
            }}
            disabled={mutation.isPending}
            data-testid="button-remove-limit"
          >
            Limit entfernen
          </Button>
        )}
      </div>
    </form>
  );
}
