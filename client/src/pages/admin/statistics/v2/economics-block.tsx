import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Gauge, Calendar, Users, Route, TrendingUp } from "lucide-react";
import { api, unwrapResult } from "@/lib/api/client";
import type { EconomicsBreakdown, EconomicsNonBillableDrillRow, RevenueStageHours } from "@shared/statistics";
import { cents, hours } from "../helpers";
import { StatsLoading, StatsError } from "./page-shell";
import { DrillDownTable } from "./drill-down-table";

const NON_BILLABLE_LABEL = "Nicht-abrechenbar (Büro, Vertrieb, Sonstiges, Krankheit, Urlaub)";

/**
 * Wirtschaftlichkeits-Aufstellung (Personalkosten-Split, km-Block, Ergebnis)
 * aus der gemeinsamen SSoT (shared/domain/statistics/economics.ts). Wird vom
 * Umsatz- UND vom Leistungs-Dashboard verwendet — eine Darstellung, keine
 * zweite parallele Aufstellung. Der Erlös-Trichter (Stunden) ist optional und
 * wird nur gerendert, wenn `stageHours` übergeben wird (nur Umsatz-Dashboard).
 */
export function EconomicsBlock({
  economics,
  stageHours,
  qs,
  year,
  testId = "economics",
}: {
  economics: EconomicsBreakdown;
  stageHours?: RevenueStageHours;
  qs: string;
  year: number;
  testId?: string;
}) {
  const [openNonBillable, setOpenNonBillable] = useState(false);
  const p = economics.personnel;
  const km = economics.km;
  const r = economics.result;

  const funnel = stageHours
    ? ([
        { key: "planned", label: "Geplant", minutes: stageHours.plannedMinutes },
        { key: "documented", label: "Dokumentiert", minutes: stageHours.documentedMinutes },
        { key: "proven", label: "Nachgewiesen", minutes: stageHours.provenMinutes },
        { key: "invoiced", label: "Berechnet", minutes: stageHours.invoicedMinutes },
      ] as const)
    : null;

  const kmRows = [
    { key: "travel", label: "Anfahrt (Termine)", row: km.travel },
    { key: "customer", label: "Kunden-km (Termine)", row: km.customer },
    { key: "timeEntry", label: "Mitarbeiter-km (Zeiterfassung)", row: km.timeEntry },
  ] as const;

  return (
    <Card data-testid={`${testId}-economics`}>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Gauge className="w-4 h-4 text-indigo-600" />
          Wirtschaftlichkeit
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-8">
        {funnel && (
          <div>
            <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
              <Calendar className="w-4 h-4 text-sky-600" />
              Erlös-Trichter (Stunden)
            </h4>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm" data-testid="economics-funnel-hours">
              {funnel.map((f) => (
                <div key={f.key}>
                  <div className="text-muted-foreground">{f.label}</div>
                  <div className="font-semibold tabular-nums" data-testid={`economics-funnel-${f.key}`}>{hours(f.minutes)}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Personalkosten-Aufteilung */}
        <div>
          <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
            <Users className="w-4 h-4 text-teal-600" />
            Personalkosten
          </h4>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="economics-personnel">
              <thead>
                <tr className="text-muted-foreground border-b">
                  <th className="text-left font-medium py-1.5">Gruppe</th>
                  <th className="text-right font-medium py-1.5">Stunden</th>
                  <th className="text-right font-medium py-1.5">Kosten</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b" data-testid="economics-personnel-hauswirtschaft">
                  <td className="py-1.5">Hauswirtschaft</td>
                  <td className="text-right tabular-nums">{hours(p.hauswirtschaft.minutes)}</td>
                  <td className="text-right tabular-nums">{cents(p.hauswirtschaft.costCents)}</td>
                </tr>
                <tr className="border-b" data-testid="economics-personnel-alltagsbegleitung">
                  <td className="py-1.5">Alltagsbegleitung</td>
                  <td className="text-right tabular-nums">{hours(p.alltagsbegleitung.minutes)}</td>
                  <td className="text-right tabular-nums">{cents(p.alltagsbegleitung.costCents)}</td>
                </tr>
                <tr className="border-b font-medium" data-testid="economics-personnel-billable">
                  <td className="py-1.5">Abrechenbar gesamt</td>
                  <td className="text-right tabular-nums">{hours(p.billable.minutes)}</td>
                  <td className="text-right tabular-nums">{cents(p.billable.costCents)}</td>
                </tr>
                <tr className="border-b" data-testid="economics-personnel-erstberatung">
                  <td className="py-1.5">Erstberatung</td>
                  <td className="text-right tabular-nums">{hours(p.erstberatung.minutes)}</td>
                  <td className="text-right tabular-nums">{cents(p.erstberatung.costCents)}</td>
                </tr>
                <tr className="border-b" data-testid="economics-personnel-nonbillable">
                  <td className="py-1.5">
                    <button
                      type="button"
                      onClick={() => setOpenNonBillable(true)}
                      disabled={p.nonBillable.minutes === 0}
                      className="text-left underline-offset-2 hover:underline text-amber-700 disabled:no-underline disabled:text-foreground disabled:cursor-default"
                      data-testid="economics-nonbillable-drill"
                    >
                      {NON_BILLABLE_LABEL}
                    </button>
                  </td>
                  <td className="text-right tabular-nums">{hours(p.nonBillable.minutes)}</td>
                  <td className="text-right tabular-nums">{cents(p.nonBillable.costCents)}</td>
                </tr>
                <tr className="font-semibold" data-testid="economics-personnel-total">
                  <td className="py-1.5">Gesamt</td>
                  <td className="text-right tabular-nums">{hours(p.totalMinutes)}</td>
                  <td className="text-right tabular-nums">{cents(p.totalCostCents)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* Kilometer */}
        <div>
          <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
            <Route className="w-4 h-4 text-orange-600" />
            Kilometer
          </h4>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="economics-km">
              <thead>
                <tr className="text-muted-foreground border-b">
                  <th className="text-left font-medium py-1.5">Strecke</th>
                  <th className="text-right font-medium py-1.5">km</th>
                  <th className="text-right font-medium py-1.5">Erlös (berechnet)</th>
                  <th className="text-right font-medium py-1.5">Kosten (ausgezahlt)</th>
                </tr>
              </thead>
              <tbody>
                {kmRows.map((k) => (
                  <tr key={k.key} className="border-b" data-testid={`economics-km-${k.key}`}>
                    <td className="py-1.5">{k.label}</td>
                    <td className="text-right tabular-nums">{k.row.km.toLocaleString("de-DE", { maximumFractionDigits: 2 })}</td>
                    <td className="text-right tabular-nums">{cents(k.row.chargedCents)}</td>
                    <td className="text-right tabular-nums">{cents(k.row.paidCents)}</td>
                  </tr>
                ))}
                <tr className="font-semibold" data-testid="economics-km-total">
                  <td className="py-1.5">Gesamt</td>
                  <td className="text-right tabular-nums">
                    {(km.travel.km + km.customer.km + km.timeEntry.km).toLocaleString("de-DE", { maximumFractionDigits: 2 })}
                  </td>
                  <td className="text-right tabular-nums">{cents(km.totalChargedCents)}</td>
                  <td className="text-right tabular-nums">{cents(km.totalPaidCents)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* Ergebnis */}
        <div>
          <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-emerald-600" />
            Ergebnis
          </h4>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 text-sm" data-testid="economics-result">
            <div>
              <div className="text-muted-foreground">Erlös</div>
              <div className="font-semibold text-emerald-700 tabular-nums" data-testid="economics-revenue">{cents(r.revenueCents)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Kosten</div>
              <div className="font-semibold text-red-600 tabular-nums" data-testid="economics-cost">{cents(r.totalCostCents)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Deckungsbeitrag</div>
              <div className={`font-semibold tabular-nums ${r.marginCents >= 0 ? "text-emerald-700" : "text-red-600"}`} data-testid="economics-margin">
                {cents(r.marginCents)}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">DB-Marge</div>
              <div className={`font-semibold tabular-nums ${r.marginPercent >= 30 ? "text-emerald-700" : r.marginPercent >= 0 ? "text-amber-600" : "text-red-600"}`} data-testid="economics-margin-pct">
                {r.marginPercent}%
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Produktiv-Kosten</div>
              <div className="font-semibold tabular-nums" data-testid="economics-productive-cost">{cents(r.productiveCostCents)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Bezahlt, nicht-abrechenbar</div>
              <div className="font-semibold text-amber-700 tabular-nums" data-testid="economics-nonbillable-cost">{cents(r.nonBillableCostCents)}</div>
            </div>
          </div>
        </div>
      </CardContent>

      <NonBillableDialog open={openNonBillable} qs={qs} year={year} onClose={() => setOpenNonBillable(false)} />
    </Card>
  );
}

function NonBillableDialog({
  open, qs, year, onClose,
}: { open: boolean; qs: string; year: number; onClose: () => void }) {
  const query = useQuery<EconomicsNonBillableDrillRow[]>({
    queryKey: ["statistics-v2-revenue-nonbillable", qs],
    queryFn: async () =>
      unwrapResult(await api.get<EconomicsNonBillableDrillRow[]>(`/statistics/v2/revenue/economics/non-billable?${qs}`)),
    enabled: open,
    staleTime: 60_000,
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-3xl" data-testid="revenue-nonbillable-dialog">
        <DialogHeader>
          <DialogTitle>Nicht-abrechenbare Stunden</DialogTitle>
          <DialogDescription>
            Zeiterfassung nach Mitarbeiter und Kategorie (Büro, Vertrieb, Sonstiges, Krankheit, Urlaub), bewertet zum Hauswirtschafts-Stundensatz.
          </DialogDescription>
        </DialogHeader>
        {query.isLoading ? (
          <StatsLoading testId="revenue-nonbillable-loading" />
        ) : query.isError ? (
          <StatsError testId="revenue-nonbillable-error" />
        ) : (
          <DrillDownTable<EconomicsNonBillableDrillRow>
            rows={query.data ?? []}
            columns={[
              { key: "employee", label: "Mitarbeiter", render: (row) => row.employeeName },
              { key: "category", label: "Kategorie", render: (row) => row.categoryLabel },
              { key: "hours", label: "Stunden", render: (row) => hours(row.minutes), csvValue: (row) => row.minutes, align: "right", sortBy: (row) => row.minutes },
              { key: "cost", label: "Kosten", render: (row) => cents(row.costCents), csvValue: (row) => row.costCents, align: "right", sortBy: (row) => row.costCents },
            ]}
            getRowId={(row) => `${row.employeeId}-${row.category}`}
            testId="revenue-nonbillable-table"
            csvFilename={`nicht-abrechenbare-stunden-${year}`}
            emptyMessage="Keine nicht-abrechenbaren Stunden im gewählten Zeitraum."
          />
        )}
        <div className="flex justify-end pt-2">
          <Button variant="outline" size="sm" onClick={onClose} data-testid="revenue-nonbillable-close">
            Schließen
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
