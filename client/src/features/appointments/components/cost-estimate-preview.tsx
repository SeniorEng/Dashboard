import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { displayPriceCents } from "@shared/domain/customers";

export type CostEstimate = {
  totalCents: number;
  warning: string | null;
  noPricing?: boolean;
  availableCents?: number;
  isHardBlock?: boolean;
  isSelbstzahler?: boolean;
  bruttoCents?: number;
  vatCents?: number;
  vatRate?: number;
};

interface CostEstimatePreviewProps {
  costEstimate: CostEstimate | null | undefined;
  billingType: string | null | undefined;
}

export function CostEstimatePreview({ costEstimate, billingType }: CostEstimatePreviewProps) {
  if (costEstimate?.noPricing) {
    return (
      <div className="rounded-lg border bg-amber-50 border-amber-200 p-4 text-sm flex items-start gap-3" data-testid="budget-no-pricing">
        <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
        <div>
          <p className="text-amber-800 font-semibold">Keine Preisvereinbarung</p>
          <p className="text-amber-700 text-xs mt-1">Bitte hinterlegen Sie eine Preisvereinbarung für diesen Kunden.</p>
        </div>
      </div>
    );
  }

  if (!costEstimate || costEstimate.noPricing || costEstimate.totalCents <= 0) {
    return null;
  }

  const cost = costEstimate;
  const isSelbstzahler = cost.isSelbstzahler || billingType === "selbstzahler";

  if (isSelbstzahler) {
    const bruttoEuro = ((cost.bruttoCents ?? displayPriceCents(cost.totalCents, "selbstzahler")) / 100).toFixed(2).replace(".", ",");
    const vatPct = cost.vatRate ?? 19;
    return (
      <div className="rounded-lg border bg-blue-50 border-blue-200 p-3 text-sm flex items-start gap-3" data-testid="selbstzahler-cost-estimate">
        <CheckCircle2 className="h-5 w-5 text-blue-600 mt-0.5 flex-shrink-0" />
        <div>
          <p className="text-blue-800 font-medium">Kosten: {bruttoEuro} € (inkl. {vatPct} % MwSt.)</p>
          <p className="text-blue-600 text-xs mt-1">Privatabrechnung — wird dem Kunden direkt in Rechnung gestellt</p>
        </div>
      </div>
    );
  }

  const displayCents = displayPriceCents(cost.totalCents, billingType);
  const costEuro = (displayCents / 100).toFixed(2).replace(".", ",");
  const availEuro = cost.availableCents !== undefined ? (cost.availableCents / 100).toFixed(2).replace(".", ",") : null;

  if (cost.isHardBlock) {
    return (
      <div className="rounded-lg border bg-red-50 border-red-300 p-4 text-sm flex items-start gap-3" data-testid="budget-hard-block">
        <XCircle className="h-5 w-5 text-red-600 mt-0.5 flex-shrink-0" />
        <div>
          <p className="text-red-800 font-semibold">Budget reicht nicht</p>
          <p className="text-red-700 mt-1">Kosten: {costEuro} € — {availEuro !== null ? `verfügbar: ${availEuro} €` : "kein Budget"}</p>
          <p className="text-red-600 text-xs mt-1">{cost.warning}</p>
        </div>
      </div>
    );
  }

  if (cost.warning) {
    return (
      <div className="rounded-lg border bg-amber-50 border-amber-200 p-4 text-sm flex items-start gap-3" data-testid="budget-warning">
        <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
        <div>
          <p className="text-amber-800 font-semibold">Kosten: {costEuro} € {availEuro !== null && <span className="font-normal">— verfügbar: {availEuro} €</span>}</p>
          <p className="text-amber-700 text-xs mt-1">{cost.warning}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-green-50 border-green-200 p-3 text-sm flex items-start gap-3" data-testid="budget-cost-estimate">
      <CheckCircle2 className="h-5 w-5 text-green-600 mt-0.5 flex-shrink-0" />
      <div>
        <p className="text-green-800 font-medium">Kosten: {costEuro} € {availEuro !== null && <span className="font-normal text-green-600">— verfügbar: {availEuro} €</span>}</p>
      </div>
    </div>
  );
}
