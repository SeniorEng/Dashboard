import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Plus, Wallet, History, AlertTriangle, Calendar, Settings, Euro } from "lucide-react";
import { iconSize, componentStyles } from "@/design-system/tokens";
import { toast } from "sonner";
import { api } from "@/lib/api/client";

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

function formatCurrency(cents: number): string {
  return (cents / 100).toLocaleString("de-DE", {
    style: "currency",
    currency: "EUR",
  });
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function getTransactionTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    consumption: "Leistung",
    expiration: "Verfall",
    reversal: "Storno",
    manual_adjustment: "Manuelle Korrektur",
  };
  return labels[type] || type;
}

interface BudgetLedgerSectionProps {
  customerId: number;
  customerName: string;
}

export function BudgetLedgerSection({ customerId, customerName }: BudgetLedgerSectionProps) {
  const queryClient = useQueryClient();
  const [showInitialBudgetDialog, setShowInitialBudgetDialog] = useState(false);
  const [showAdjustmentDialog, setShowAdjustmentDialog] = useState(false);
  const [showPreferencesDialog, setShowPreferencesDialog] = useState(false);

  const { data: summary, isLoading: summaryLoading } = useQuery<BudgetSummary>({
    queryKey: ["budget-summary", customerId],
    queryFn: async () => {
      const response = await fetch(`/api/budget/${customerId}/summary`);
      if (!response.ok) throw new Error("Failed to fetch budget summary");
      return response.json();
    },
  });

  const { data: transactions } = useQuery<BudgetTransaction[]>({
    queryKey: ["budget-transactions", customerId],
    queryFn: async () => {
      const response = await fetch(`/api/budget/${customerId}/transactions?limit=10`);
      if (!response.ok) throw new Error("Failed to fetch transactions");
      return response.json();
    },
  });

  const usagePercent = summary && summary.totalAllocatedCents > 0
    ? Math.min(100, (summary.totalUsedCents / summary.totalAllocatedCents) * 100)
    : 0;

  const monthlyUsagePercent = summary && summary.monthlyLimitCents
    ? Math.min(100, (summary.currentMonthUsedCents / summary.monthlyLimitCents) * 100)
    : 0;

  if (summaryLoading) {
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
                    queryClient.invalidateQueries({ queryKey: ["budget-summary", customerId] });
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
                <Progress value={100 - usagePercent} className="mt-2 h-2" />
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
                summary!.carryoverExpiresAt && new Date(summary!.carryoverExpiresAt) < new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
                  ? "bg-amber-50 border-amber-200"
                  : "bg-gray-50 border-gray-200"
              }`}>
                <CardContent className="pt-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-gray-600">Übertrag</p>
                    {summary!.carryoverExpiresAt && new Date(summary!.carryoverExpiresAt) < new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) && (
                      <AlertTriangle className={`${iconSize.sm} text-amber-600`} />
                    )}
                  </div>
                  <p className="text-2xl font-bold text-gray-700 mt-1" data-testid="text-budget-carryover">
                    {formatCurrency(summary!.carryoverCents)}
                  </p>
                  {summary!.carryoverExpiresAt && (
                    <p className="text-xs text-amber-600 mt-2 flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      Verfällt am {formatDate(summary!.carryoverExpiresAt)}
                    </p>
                  )}
                </CardContent>
              </Card>
            )}
          </div>

          <Card className={summary!.monthlyLimitCents ? "bg-purple-50 border-purple-100" : "border-dashed"}>
            <CardContent className="pt-4">
              {summary!.monthlyLimitCents ? (
                <>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-medium text-gray-700">Monatliches Wunschlimit</p>
                    <div className="flex items-center gap-2">
                      <Badge variant={monthlyUsagePercent > 80 ? "destructive" : "secondary"}>
                        {monthlyUsagePercent.toFixed(0)}%
                      </Badge>
                      <Dialog open={showPreferencesDialog} onOpenChange={setShowPreferencesDialog}>
                        <DialogTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" data-testid="button-edit-preferences">
                            <Settings className="w-3.5 h-3.5" />
                          </Button>
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>Wunschlimit bearbeiten</DialogTitle>
                          </DialogHeader>
                          <PreferencesForm
                            customerId={customerId}
                            currentLimit={summary!.monthlyLimitCents}
                            onSuccess={() => {
                              setShowPreferencesDialog(false);
                              queryClient.invalidateQueries({ queryKey: ["budget-summary", customerId] });
                            }}
                          />
                        </DialogContent>
                      </Dialog>
                    </div>
                  </div>
                  <Progress value={monthlyUsagePercent} className="h-2" />
                  <div className="flex justify-between text-xs text-gray-500 mt-1">
                    <span>{formatCurrency(summary!.currentMonthUsedCents)} diesen Monat</span>
                    <span>Limit: {formatCurrency(summary!.monthlyLimitCents)}</span>
                  </div>
                </>
              ) : (
                <div className="text-center py-2">
                  <p className="text-sm text-gray-500 mb-2">Kein monatliches Limit festgelegt</p>
                  <Dialog open={showPreferencesDialog} onOpenChange={setShowPreferencesDialog}>
                    <DialogTrigger asChild>
                      <Button variant="outline" size="sm" data-testid="button-set-monthly-limit">
                        <Settings className={iconSize.sm} />
                        Limit festlegen
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Monatliches Wunschlimit</DialogTitle>
                      </DialogHeader>
                      <PreferencesForm
                        customerId={customerId}
                        currentLimit={null}
                        onSuccess={() => {
                          setShowPreferencesDialog(false);
                          queryClient.invalidateQueries({ queryKey: ["budget-summary", customerId] });
                        }}
                      />
                    </DialogContent>
                  </Dialog>
                </div>
              )}
            </CardContent>
          </Card>

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
                        queryClient.invalidateQueries({ queryKey: ["budget-summary", customerId] });
                        queryClient.invalidateQueries({ queryKey: ["budget-transactions", customerId] });
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
                          <span className="text-sm text-gray-500">{formatDate(tx.transactionDate)}</span>
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
  const [currentYearAmount, setCurrentYearAmount] = useState("");
  const [carryoverAmount, setCarryoverAmount] = useState("");
  const [budgetStartDate, setBudgetStartDate] = useState(new Date().toISOString().slice(0, 10));

  const mutation = useMutation({
    mutationFn: async (data: { currentYearAmountCents: number; carryoverAmountCents: number; budgetStartDate: string }) => {
      return await api.post(`/budget/${customerId}/initial-budget`, data);
    },
    onSuccess: () => {
      toast.success("Startbudget erfolgreich erfasst");
      onSuccess();
    },
    onError: (error) => {
      toast.error("Fehler beim Erfassen des Startbudgets");
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
        <Label htmlFor="budgetStartDate">Startdatum</Label>
        <Input
          id="budgetStartDate"
          type="date"
          value={budgetStartDate}
          onChange={(e) => setBudgetStartDate(e.target.value)}
          required
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
  const [amount, setAmount] = useState("");
  const [isNegative, setIsNegative] = useState(false);
  const [notes, setNotes] = useState("");

  const mutation = useMutation({
    mutationFn: async (data: { amountCents: number; notes: string }) => {
      return await api.post(`/budget/${customerId}/manual-adjustment`, data);
    },
    onSuccess: () => {
      toast.success("Korrektur erfolgreich gespeichert");
      onSuccess();
    },
    onError: (error) => {
      toast.error("Fehler bei der Korrektur");
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
  const [monthlyLimit, setMonthlyLimit] = useState(currentLimit ? (currentLimit / 100).toString() : "");

  const mutation = useMutation({
    mutationFn: async (data: { monthlyLimitCents: number | null }) => {
      return await api.put(`/budget/${customerId}/preferences`, data);
    },
    onSuccess: () => {
      toast.success("Einstellungen gespeichert");
      onSuccess();
    },
    onError: (error) => {
      toast.error("Fehler beim Speichern");
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
