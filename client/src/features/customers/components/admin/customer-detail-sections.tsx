import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { SectionCard } from "@/components/patterns/section-card";
import { api, unwrapResult } from "@/lib/api";
import { invalidateRelated } from "@/lib/query-invalidation";
import { iconSize, componentStyles } from "@/design-system";
import { Loader2, AlertCircle, AlertTriangle, CheckCircle2, Settings, Euro } from "lucide-react";
import { BudgetLedgerSection } from "@/components/budget/BudgetLedgerSection";
import { BudgetTypeSettings } from "@/components/budget/BudgetTypeSettings";
import { PflegegradBudgetSection } from "@/components/budget/PflegegradBudgetSection";
import { PricingSection } from "./customer-pricing-section";

export interface SetupPendingCustomerLike {
  id: number;
  setupSignaturesPending?: boolean | null;
  setupDocumentsPending?: boolean | null;
  setupBudgetsPending?: boolean | null;
  setupDeliveryPending?: boolean | null;
  setupPendingPayloads?: Record<string, unknown> | null;
}

const PENDING_STEP_LABELS: Record<string, string> = {
  signatures: "Unterschriften",
  documents: "Hochgeladene Dokumente",
  budgets: "Startbudgets",
  delivery: "Dokumentenversand",
};

export function SetupPendingBanner({ customer, onRefresh }: { customer: SetupPendingCustomerLike; onRefresh: () => void }) {
  const { toast } = useToast();
  const [retrying, setRetrying] = useState<Record<string, boolean>>({});

  const pending: Array<{ step: string; label: string }> = [];
  if (customer.setupSignaturesPending) pending.push({ step: "signatures", label: PENDING_STEP_LABELS.signatures });
  if (customer.setupDocumentsPending) pending.push({ step: "documents", label: PENDING_STEP_LABELS.documents });
  if (customer.setupBudgetsPending) pending.push({ step: "budgets", label: PENDING_STEP_LABELS.budgets });
  if (customer.setupDeliveryPending) pending.push({ step: "delivery", label: PENDING_STEP_LABELS.delivery });

  if (pending.length === 0) return null;

  const handleRetry = async (step: string, label: string) => {
    const payloads = (customer.setupPendingPayloads || {}) as Record<string, unknown>;
    const stepPayload = payloads[step] as Record<string, unknown> | undefined;
    if (!stepPayload) {
      toast({ title: "Keine Daten gefunden", description: `Für ${label} liegen keine wiederholbaren Daten vor.`, variant: "destructive" });
      return;
    }
    setRetrying(prev => ({ ...prev, [step]: true }));
    try {
      let result;
      if (step === "signatures") {
        const items = (stepPayload.items as Array<{ templateSlug: string; customerSignatureData: string }>) || [];
        result = await api.post(`/customers/${customer.id}/signatures`, { signatures: items, signingLocation: stepPayload.signingLocation ?? null });
      } else if (step === "documents") {
        const items = (stepPayload.items as Array<{ documentTypeId: number; fileName: string; objectPath: string }>) || [];
        let lastResult;
        for (const d of items) {
          lastResult = await api.post(`/customers/${customer.id}/documents`, d);
          if (!lastResult.success) break;
        }
        result = lastResult;
      } else if (step === "budgets") {
        const items = (stepPayload.items as Array<{ budgetType: string; currentYearAmountCents: number; carryoverAmountCents: number; budgetStartDate: string }>) || [];
        let lastResult;
        for (const b of items) {
          lastResult = await api.post(`/budget/${customer.id}/initial-budget`, b);
          if (!lastResult.success) break;
        }
        result = lastResult;
      } else if (step === "delivery") {
        result = await api.post(`/admin/document-delivery/send-for-customer/${customer.id}`, {});
      }
      if (!result || !result.success) {
        toast({ title: `${label} fehlgeschlagen`, description: result?.error.message || "Bitte erneut versuchen.", variant: "destructive" });
        return;
      }
      // Erfolg → Pending-Flag serverseitig löschen.
      await api.post(`/admin/customers/${customer.id}/setup-pending/${step}/clear`, {});
      toast({ title: `${label} nachgeholt` });
      onRefresh();
    } catch (err) {
      toast({ title: `${label} fehlgeschlagen`, description: err instanceof Error ? err.message : "Unbekannter Fehler", variant: "destructive" });
    } finally {
      setRetrying(prev => ({ ...prev, [step]: false }));
    }
  };

  return (
    <SectionCard className="mb-4 border-amber-300 bg-amber-50" data-testid="banner-setup-pending">
      <div className="flex items-start gap-3">
        <AlertTriangle className={`${iconSize.md} text-amber-600 mt-0.5 shrink-0`} />
        <div className="flex-1">
          <p className="text-sm font-medium text-amber-900 mb-1">
            Einige Folgeschritte aus der Kundenanlage sind nicht abgeschlossen.
          </p>
          <p className="text-xs text-amber-800 mb-3">
            Bitte wiederhole die folgenden Schritte oder trage die Daten manuell nach.
          </p>
          <div className="flex flex-wrap gap-2">
            {pending.map(p => (
              <Button
                key={p.step}
                size="sm"
                variant="outline"
                className="border-amber-400 bg-white hover:bg-amber-100"
                disabled={!!retrying[p.step]}
                onClick={() => handleRetry(p.step, p.label)}
                data-testid={`button-retry-${p.step}`}
              >
                {retrying[p.step] ? <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} /> : null}
                {p.label} erneut versuchen
              </Button>
            ))}
          </div>
        </div>
      </div>
    </SectionCard>
  );
}

export function BackfillSection({ customerId, onRefresh }: { customerId: number; onRefresh: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<{ total: number; created: number; skipped: number; errors: number } | null>(null);

  const backfillDateFrom = "2026-01-01";
  const backfillDateTo = "2026-01-31";

  const { data: preview, isLoading: previewLoading } = useQuery<{
    totalAppointments: number;
    customerBreakdown: Record<string, { count: number; missingSignatures: number; dates: string[] }>;
  }>({
    queryKey: ["backfill-preview", customerId],
    queryFn: async () => {
      const res = await api.get<{
        totalAppointments: number;
        customerBreakdown: Record<string, { count: number; missingSignatures: number; dates: string[] }>;
      }>(`/admin/budget/backfill-preview?customerId=${customerId}&dateFrom=${backfillDateFrom}&dateTo=${backfillDateTo}`);
      return unwrapResult(res);
    },
    staleTime: 60000,
  });

  const count = preview?.totalAppointments || 0;

  if (previewLoading || count === 0) return null;

  const handleBackfill = async () => {
    setIsRunning(true);
    setResult(null);
    try {
      const res = await api.post("/admin/budget/backfill-transactions", { customerId, dateFrom: backfillDateFrom, dateTo: backfillDateTo });
      const data = unwrapResult(res) as { total: number; created: number; skipped: number; errors: number };
      setResult(data);
      invalidateRelated(queryClient, "budget");
      queryClient.invalidateQueries({ queryKey: ["backfill-preview", customerId] });
      onRefresh();
      if (data.errors > 0 && data.created > 0) {
        toast({ variant: "destructive", title: "Teilweise erfolgreich", description: `${data.created} erstellt, ${data.errors} fehlgeschlagen.` });
      } else if (data.errors > 0) {
        toast({ variant: "destructive", title: "Fehler", description: `${data.errors} Termine konnten nicht nachgebucht werden.` });
      } else if (data.created > 0) {
        toast({ title: "Nachbuchung erfolgreich", description: `${data.created} Budget-Buchung${data.created !== 1 ? "en" : ""} erstellt.` });
      } else {
        toast({ title: "Keine Änderungen", description: "Alle Termine wurden übersprungen." });
      }
    } catch (err: unknown) {
      toast({ variant: "destructive", title: "Fehler", description: err instanceof Error ? err.message : "Nachbuchung fehlgeschlagen" });
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <SectionCard
      title="Importierte Termine nachbuchen"
      icon={<AlertCircle className={iconSize.sm} />}
    >
      <div className="space-y-3">
        <div className="p-3 rounded-lg bg-amber-50 border border-amber-200">
          <p className="text-sm text-amber-800">
            <strong>{count} Termin{count !== 1 ? "e" : ""}</strong> aus Januar 2026 ohne Budget-Buchung gefunden.
            Diese Termine wurden importiert und haben den Dokumentationsprozess nicht durchlaufen.
          </p>
          <p className="text-xs text-amber-700 mt-1">
            Die Nachbuchung setzt "SYSTEMGENERIERT" als Unterschrift und erstellt die fehlenden Budget-Transaktionen für Januar.
          </p>
        </div>

        {result && (
          <div className="p-3 rounded-lg bg-green-50 border border-green-200 text-sm text-green-800">
            <p><strong>Ergebnis:</strong> {result.created} erstellt, {result.skipped} übersprungen, {result.errors} Fehler</p>
          </div>
        )}

        <Button
          className={`w-full ${componentStyles.btnPrimary}`}
          onClick={handleBackfill}
          disabled={isRunning}
          data-testid="button-backfill-budgets"
        >
          {isRunning ? (
            <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
          ) : (
            <CheckCircle2 className={`${iconSize.sm} mr-2`} />
          )}
          {count} Termin{count !== 1 ? "e" : ""} nachbuchen
        </Button>
      </div>
    </SectionCard>
  );
}

export function BudgetsTabContent({
  customerId,
  customerDisplayName,
  pflegegrad,
  careLevelHistory,
  billingType,
  onRefresh,
}: {
  customerId: number;
  customerDisplayName: string;
  pflegegrad?: number;
  careLevelHistory?: Array<{ id: number; pflegegrad: number; validFrom: string; validTo: string | null; notes: string | null }>;
  billingType?: string | null;
  onRefresh: () => void;
}) {
  return (
    <>
      <PflegegradBudgetSection
        customerId={customerId}
        pflegegrad={pflegegrad ?? null}
        careLevelHistory={careLevelHistory ?? []}
      />

      <SectionCard
        title="Budget-Einstellungen"
        icon={<Settings className={iconSize.sm} />}
      >
        <BudgetTypeSettings customerId={customerId} pflegegrad={pflegegrad} />
      </SectionCard>

      <BudgetLedgerSection
        customerId={customerId}
        customerName={customerDisplayName}
        onRefresh={onRefresh}
      />

      <SectionCard
        title="Preisvereinbarung"
        icon={<Euro className={iconSize.sm} />}
      >
        <PricingSection
          customerId={customerId}
          customerName={customerDisplayName}
          billingType={billingType ?? undefined}
          onRefresh={onRefresh}
        />
      </SectionCard>

      <BackfillSection customerId={customerId} onRefresh={onRefresh} />
    </>
  );
}
