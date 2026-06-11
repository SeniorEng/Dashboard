/**
 * Task #1177 (Phase 3) — Anlage-Checkliste (GOV.UK Task-List).
 *
 * Zeigt nach der Minimal-Anlage die noch offenen Onboarding-Schritte als
 * Checkliste. Der Status jedes Schritts wird über die reine SSoT
 * `computeIntakeChecklist` aus bereits vorhandenen Kundendaten abgeleitet —
 * kein eigener Status-Store. Jeder Schritt verlinkt auf den passenden
 * Detail-Tab (bestehende Editoren).
 */
import { useQuery } from "@tanstack/react-query";
import { SectionCard } from "@/components/patterns/section-card";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { iconSize } from "@/design-system";
import { CheckCircle2, Circle, ChevronRight, ClipboardList } from "lucide-react";
import {
  computeIntakeChecklist,
  type IntakeStepKey,
} from "@shared/domain/customers/intake-checklist";
import type { BillingType } from "@shared/domain/customers";
import type { CustomerDetail } from "@/lib/api/types";

interface IntakeChecklistProps {
  customer: CustomerDetail;
  customerId: number;
  onOpenStep: (tab: string) => void;
}

const STEP_LABELS: Record<IntakeStepKey, string> = {
  personal: "Stammdaten",
  insurance: "Versicherung",
  contract: "Vertrag",
  budgets: "Budgets einrichten",
  matching: "Mitarbeiter zuordnen",
  documents: "Dokumente & Unterschriften",
};

// Verlinkung auf den jeweils zuständigen Detail-Tab.
const STEP_TAB: Record<IntakeStepKey, string> = {
  personal: "overview",
  insurance: "insurance",
  contract: "vertrag",
  budgets: "budgets",
  matching: "overview",
  documents: "documents",
};

interface GroupedDoc {
  currentBatches?: unknown[];
}

export function IntakeChecklist({ customer, customerId, onOpenStep }: IntakeChecklistProps) {
  // Dokument-Vorhandensein für den "documents"-Schritt ableiten.
  const { data: groupedDocs } = useQuery<GroupedDoc[]>({
    queryKey: ["admin", "customers", customerId, "documents", "grouped"],
    queryFn: async () => {
      const result = await api.get<GroupedDoc[]>(`/admin/customers/${customerId}/documents?grouped=true`);
      return result.success ? result.data : [];
    },
  });

  const hasDocuments = (groupedDocs ?? []).some(
    (g) => Array.isArray(g.currentBatches) && g.currentBatches.length > 0,
  );

  const checklist = computeIntakeChecklist({
    billingType: (customer.billingType ?? null) as BillingType | null,
    pflegegrad: customer.pflegegrad ?? null,
    hasPersonalData: true, // Datensatz existiert → Stammdaten erfasst.
    hasInsurance: !!customer.currentInsurance,
    hasContract: !!customer.currentContract,
    budgetSetupMissing: customer.budgetSetupMissing,
    hasPrimaryEmployee: !!customer.primaryEmployee,
    hasDocuments,
  });

  // Vollständig abgeschlossen → Checkliste ausblenden (Tabs bleiben nutzbar).
  if (checklist.complete) return null;

  const openSteps = checklist.steps.filter((s) => s.status !== "not_applicable");

  return (
    <div data-testid="card-intake-checklist">
    <SectionCard className="mb-4 border-teal-200">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <ClipboardList className={`${iconSize.md} text-teal-700`} />
          <h2 className="font-semibold text-gray-900">Anlage abschließen</h2>
        </div>
        <span className="text-sm text-gray-500" data-testid="text-intake-progress">
          {checklist.doneCount} von {checklist.applicableCount} erledigt
        </span>
      </div>

      <ul className="divide-y divide-gray-100">
        {openSteps.map((step) => {
          const isDone = step.status === "done";
          return (
            <li
              key={step.key}
              className="flex items-center justify-between gap-3 py-2"
              data-testid={`row-intake-${step.key}`}
            >
              <div className="flex items-center gap-2 min-w-0">
                {isDone ? (
                  <CheckCircle2 className={`${iconSize.sm} text-green-600 shrink-0`} />
                ) : (
                  <Circle className={`${iconSize.sm} text-gray-300 shrink-0`} />
                )}
                <span className={`text-sm truncate ${isDone ? "text-gray-500" : "text-gray-900 font-medium"}`}>
                  {STEP_LABELS[step.key]}
                </span>
                <span
                  className={`text-xs rounded px-1.5 py-0.5 shrink-0 ${
                    isDone ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"
                  }`}
                  data-testid={`status-intake-${step.key}`}
                >
                  {isDone ? "Erledigt" : "Offen"}
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onOpenStep(STEP_TAB[step.key])}
                data-testid={`button-open-intake-${step.key}`}
              >
                {isDone ? "Ansehen" : "Öffnen"}
                <ChevronRight className={`${iconSize.sm} ml-1`} />
              </Button>
            </li>
          );
        })}
      </ul>
    </SectionCard>
    </div>
  );
}
