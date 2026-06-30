import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { iconSize } from "@/design-system";
import { Loader2, Pencil, Check, X, Calendar, ChevronDown, ChevronUp, AlertTriangle } from "lucide-react";
import { api, unwrapResult, ApiError } from "@/lib/api";
import { invalidateRelated } from "@/lib/query-invalidation";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { formatCurrency } from "@shared/utils/format";
import { formatEuroDE, parseEuroDE } from "@shared/utils/money";
import { parseLocalDate } from "@shared/utils/datetime";
import { WAGE_ROLES, type WageRole } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { ServiceWithPots } from "../types";

/**
 * Task #1510 — Wirtschaftlichkeit je Leistung (Verkaufspreis + Lohnsätze).
 *
 * EINE kombinierte Tabelle für die Ökonomie jeder Dienstleistung. Sie ERSETZT
 * die frühere separate `StandardPricingSection` UND die `EmployeeServiceRates`-
 * Lohnmatrix (vorher im Mitarbeiter-Dialog). Beide Seiten der Wirtschaftlichkeit
 * (firmenweiter Verkaufspreis + firmenweiter Rollen-Lohn) werden hier zentral
 * gepflegt — keine doppelte Pflegeoberfläche mehr.
 *
 * Sichtbarkeit:
 *   - Normale Admins: nur die Verkaufspreis-Spalte (Lohn-/Margen-Daten werden
 *     weder angezeigt noch geladen).
 *   - Superadmins: zusätzlich die drei Lohn-Spalten (Verwaltung / Teamleitung /
 *     Mitarbeiter). Die Lohn-Endpunkte sind serverseitig superadmin-gegated;
 *     die UI-Gate ist nur die zweite Verteidigungslinie.
 *
 * Es entstehen KEINE neuen Berechnungs-/Speicherpfade: Preise laufen weiter über
 * `/services/standard-prices`, Löhne über `/services/role-wage-rates`. GoBD-
 * Append-only-Phasen, Stichtag, Konflikt-/Ersetzen-Dialoge und Historie bleiben
 * unverändert.
 */

interface StandardPrice {
  id: number;
  serviceId: number;
  priceCents: number;
  validFrom: string;
  validTo: string | null;
  serviceName: string;
  serviceCode: string | null;
  defaultPriceCents: number;
  unitType: string;
}

interface WageRateRow {
  id: number;
  role: WageRole;
  serviceId: number;
  cents: number;
  validFrom: string;
  validTo: string | null;
  serviceName: string;
  serviceCode: string | null;
  defaultRateCents: number;
  unitType: string;
}

interface AffectedInvoice {
  id: number;
  invoiceNumber: string;
  billingMonth: number;
  billingYear: number;
  status: string;
}

interface AffectedMonth {
  year: number;
  month: number;
  employeeCount: number;
}

type PriceSaveVars = {
  serviceId: number;
  priceCents: number;
  validFrom?: string;
  confirmInvoiceOverride?: boolean;
  confirmReplace?: boolean;
};

type WageSaveVars = {
  role: WageRole;
  serviceId: number;
  cents: number;
  validFrom?: string;
  confirmReplace?: boolean;
  confirmClosedOverride?: boolean;
};

type WageDeleteVars = {
  rateId: number;
  confirmClosedOverride?: boolean;
};

type PendingPriceChange =
  | { kind: "save"; serviceId: number; priceCents: number; validFrom?: string; invoices: AffectedInvoice[] }
  | { kind: "delete"; priceId: number; invoices: AffectedInvoice[] };

interface PendingPriceReplace {
  serviceId: number;
  priceCents: number;
  validFrom?: string;
  existing: { id: number; priceCents: number; validFrom: string; serviceName: string };
}

interface PendingWageReplace {
  role: WageRole;
  serviceId: number;
  cents: number;
  validFrom?: string;
  existing: { id: number; cents: number; validFrom: string; serviceName: string; role: WageRole };
}

type PendingWageClosed =
  | { kind: "save"; vars: WageSaveVars; months: AffectedMonth[] }
  | { kind: "delete"; vars: WageDeleteVars; months: AffectedMonth[] };

const ROLE_LABELS: Record<WageRole, string> = {
  admin: "Verwaltung",
  teamLead: "Teamleitung",
  employee: "Mitarbeiter",
};

const UNIT_LABELS: Record<string, string> = {
  hours: "/Std.",
  kilometers: "/km",
  flat: " pauschal",
};

const MONTH_LABELS = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

function getTodayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDateDisplay(dateStr: string | null | undefined): string {
  if (!dateStr || typeof dateStr !== "string") return "—";
  try {
    const d = parseLocalDate(dateStr.slice(0, 10));
    if (!d || Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
  } catch {
    return "—";
  }
}

function wageCellKey(role: WageRole, serviceId: number): string {
  return `wage-${role}-${serviceId}`;
}

function priceCellKey(serviceId: number): string {
  return `price-${serviceId}`;
}

interface ServiceEconomicsSectionProps {
  services: ServiceWithPots[] | undefined;
  isLoading: boolean;
}

export function ServiceEconomicsSection({ services, isLoading }: ServiceEconomicsSectionProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const isSuperAdmin = user?.isSuperAdmin ?? false;

  const [editingCell, setEditingCell] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editValidFrom, setEditValidFrom] = useState("");
  const [expandedServiceId, setExpandedServiceId] = useState<number | null>(null);

  const [pendingPriceReplace, setPendingPriceReplace] = useState<PendingPriceReplace | null>(null);
  const [pendingPriceChange, setPendingPriceChange] = useState<PendingPriceChange | null>(null);
  const [pendingWageReplace, setPendingWageReplace] = useState<PendingWageReplace | null>(null);
  const [pendingWageClosed, setPendingWageClosed] = useState<PendingWageClosed | null>(null);

  // --- Preis-Queries (alle Admins) ---
  const { data: standardPrices, isLoading: loadingPrices } = useQuery<StandardPrice[]>({
    queryKey: ["standard-prices"],
    queryFn: async () => unwrapResult(await api.get<StandardPrice[]>("/services/standard-prices")),
    staleTime: 30000,
  });

  const { data: futurePrices } = useQuery<StandardPrice[]>({
    queryKey: ["standard-prices-future"],
    queryFn: async () => unwrapResult(await api.get<StandardPrice[]>("/services/standard-prices/future")),
    staleTime: 30000,
  });

  const { data: allPrices } = useQuery<StandardPrice[]>({
    queryKey: ["standard-prices-all"],
    queryFn: async () => unwrapResult(await api.get<StandardPrice[]>("/services/standard-prices/all")),
    staleTime: 30000,
    enabled: expandedServiceId !== null,
  });

  // --- Lohn-Queries (nur Superadmin; Daten werden sonst nie geladen) ---
  const { data: activeRates, isLoading: loadingRates } = useQuery<WageRateRow[]>({
    queryKey: ["role-wage-rates"],
    queryFn: async () => unwrapResult(await api.get<WageRateRow[]>("/services/role-wage-rates")),
    staleTime: 30000,
    enabled: isSuperAdmin,
  });

  const { data: futureRates } = useQuery<WageRateRow[]>({
    queryKey: ["role-wage-rates-future"],
    queryFn: async () => unwrapResult(await api.get<WageRateRow[]>("/services/role-wage-rates/future")),
    staleTime: 30000,
    enabled: isSuperAdmin,
  });

  const { data: allRates } = useQuery<WageRateRow[]>({
    queryKey: ["role-wage-rates-all"],
    queryFn: async () => unwrapResult(await api.get<WageRateRow[]>("/services/role-wage-rates/all")),
    staleTime: 30000,
    enabled: isSuperAdmin && expandedServiceId !== null,
  });

  // --- Preis-Mutationen ---
  const priceSaveMutation = useMutation({
    mutationFn: async (vars: PriceSaveVars) => {
      const body: Record<string, unknown> = { serviceId: vars.serviceId, priceCents: vars.priceCents };
      if (vars.validFrom) body.validFrom = vars.validFrom;
      if (vars.confirmInvoiceOverride) body.confirmInvoiceOverride = true;
      if (vars.confirmReplace) body.confirmReplace = true;
      return unwrapResult(await api.post("/services/standard-prices", body));
    },
    onSuccess: (_data, vars) => {
      invalidateRelated(queryClient, "standard-prices");
      resetEdit();
      setPendingPriceChange(null);
      setPendingPriceReplace(null);
      toast({ title: vars.confirmReplace ? "Bestehender Standardpreis ersetzt" : "Standardpreis gespeichert" });
    },
    onError: (error: Error, vars) => {
      if (error instanceof ApiError && error.code === "INVOICED_PERIOD_AFFECTED" && !vars.confirmInvoiceOverride) {
        const invoices = (error.details?.invoices as AffectedInvoice[] | undefined) || [];
        setPendingPriceChange({ kind: "save", serviceId: vars.serviceId, priceCents: vars.priceCents, validFrom: vars.validFrom, invoices });
        return;
      }
      if (error instanceof ApiError && error.code === "PRICE_CONFLICT") {
        const existing = error.details?.existing as PendingPriceReplace["existing"] | undefined;
        if (existing) {
          setPendingPriceReplace({ serviceId: vars.serviceId, priceCents: vars.priceCents, validFrom: vars.validFrom, existing });
          return;
        }
      }
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const priceDeleteMutation = useMutation({
    mutationFn: async ({ priceId, confirmInvoiceOverride }: { priceId: number; confirmInvoiceOverride?: boolean }) => {
      const url = confirmInvoiceOverride
        ? `/services/standard-prices/${priceId}?confirmInvoiceOverride=true`
        : `/services/standard-prices/${priceId}`;
      return unwrapResult(await api.delete(url));
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "standard-prices");
      setPendingPriceChange(null);
      toast({ title: "Standardpreis zurückgesetzt auf Katalogpreis" });
    },
    onError: (error: Error, vars) => {
      if (error instanceof ApiError && error.code === "INVOICED_PERIOD_AFFECTED" && !vars.confirmInvoiceOverride) {
        const invoices = (error.details?.invoices as AffectedInvoice[] | undefined) || [];
        setPendingPriceChange({ kind: "delete", priceId: vars.priceId, invoices });
        return;
      }
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  // --- Lohn-Mutationen ---
  const wageSaveMutation = useMutation({
    mutationFn: async (vars: WageSaveVars) => {
      const body: Record<string, unknown> = { role: vars.role, serviceId: vars.serviceId, cents: vars.cents };
      if (vars.validFrom) body.validFrom = vars.validFrom;
      if (vars.confirmReplace) body.confirmReplace = true;
      if (vars.confirmClosedOverride) body.confirmClosedOverride = true;
      return unwrapResult(await api.post("/services/role-wage-rates", body));
    },
    onSuccess: (_data, vars) => {
      invalidateRelated(queryClient, "role-wage-rates");
      resetEdit();
      setPendingWageReplace(null);
      setPendingWageClosed(null);
      toast({ title: vars.confirmReplace ? "Bestehender Lohnsatz ersetzt" : "Lohnsatz gespeichert" });
    },
    onError: (error: Error, vars) => {
      if (error instanceof ApiError && error.code === "WAGE_CONFLICT" && !vars.confirmReplace) {
        const existing = error.details?.existing as PendingWageReplace["existing"] | undefined;
        if (existing) {
          setPendingWageReplace({ role: vars.role, serviceId: vars.serviceId, cents: vars.cents, validFrom: vars.validFrom, existing });
          return;
        }
      }
      if (error instanceof ApiError && error.code === "CLOSED_WAGE_PERIOD_AFFECTED" && !vars.confirmClosedOverride) {
        const months = (error.details?.months as AffectedMonth[] | undefined) || [];
        setPendingWageClosed({ kind: "save", vars, months });
        return;
      }
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const wageDeleteMutation = useMutation({
    mutationFn: async (vars: WageDeleteVars) => {
      const url = vars.confirmClosedOverride
        ? `/services/role-wage-rates/${vars.rateId}?confirmClosedOverride=true`
        : `/services/role-wage-rates/${vars.rateId}`;
      return unwrapResult(await api.delete(url));
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "role-wage-rates");
      setPendingWageClosed(null);
      toast({ title: "Lohnsatz-Phase entfernt" });
    },
    onError: (error: Error, vars) => {
      if (error instanceof ApiError && error.code === "CLOSED_WAGE_PERIOD_AFFECTED" && !vars.confirmClosedOverride) {
        const months = (error.details?.months as AffectedMonth[] | undefined) || [];
        setPendingWageClosed({ kind: "delete", vars, months });
        return;
      }
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  function resetEdit() {
    setEditingCell(null);
    setEditValue("");
    setEditValidFrom("");
  }

  function startEditPrice(serviceId: number, currentCents: number) {
    setEditingCell(priceCellKey(serviceId));
    setEditValue(formatEuroDE(currentCents, { withCurrency: false }));
    setEditValidFrom("");
  }

  function startEditWage(role: WageRole, serviceId: number, currentCents: number) {
    setEditingCell(wageCellKey(role, serviceId));
    setEditValue(formatEuroDE(currentCents, { withCurrency: false }));
    setEditValidFrom("");
  }

  function handleSavePrice(serviceId: number) {
    const cents = parseEuroDE(editValue);
    if (cents === null || cents < 0) {
      toast({ title: "Ungültiger Preis", variant: "destructive" });
      return;
    }
    priceSaveMutation.mutate({ serviceId, priceCents: cents, validFrom: editValidFrom || undefined });
  }

  function handleSaveWage(role: WageRole, serviceId: number) {
    const cents = parseEuroDE(editValue);
    if (cents === null || cents < 0) {
      toast({ title: "Ungültiger Betrag", variant: "destructive" });
      return;
    }
    wageSaveMutation.mutate({ role, serviceId, cents, validFrom: editValidFrom || undefined });
  }

  function confirmPriceChange() {
    if (!pendingPriceChange) return;
    if (pendingPriceChange.kind === "save") {
      priceSaveMutation.mutate({
        serviceId: pendingPriceChange.serviceId,
        priceCents: pendingPriceChange.priceCents,
        validFrom: pendingPriceChange.validFrom,
        confirmInvoiceOverride: true,
      });
    } else {
      priceDeleteMutation.mutate({ priceId: pendingPriceChange.priceId, confirmInvoiceOverride: true });
    }
  }

  function confirmWageClosed() {
    if (!pendingWageClosed) return;
    if (pendingWageClosed.kind === "save") {
      wageSaveMutation.mutate({ ...pendingWageClosed.vars, confirmClosedOverride: true });
    } else {
      wageDeleteMutation.mutate({ ...pendingWageClosed.vars, confirmClosedOverride: true });
    }
  }

  const loading = isLoading || loadingPrices || (isSuperAdmin && loadingRates);
  const activeServices = (services || []).filter(s => s.isActive);

  const priceByService = new Map<number, StandardPrice>();
  standardPrices?.forEach(sp => priceByService.set(sp.serviceId, sp));

  const futurePriceByService = new Map<number, StandardPrice[]>();
  futurePrices?.forEach(fp => {
    const list = futurePriceByService.get(fp.serviceId) || [];
    list.push(fp);
    futurePriceByService.set(fp.serviceId, list);
  });

  const wageByCell = new Map<string, WageRateRow>();
  activeRates?.forEach(r => wageByCell.set(wageCellKey(r.role, r.serviceId), r));

  const futureWageByCell = new Map<string, WageRateRow[]>();
  futureRates?.forEach(r => {
    const k = wageCellKey(r.role, r.serviceId);
    const list = futureWageByCell.get(k) || [];
    list.push(r);
    futureWageByCell.set(k, list);
  });

  const hasFuturePrices = (futurePrices?.length || 0) > 0;
  const hasFutureWages = isSuperAdmin && (futureRates?.length || 0) > 0;

  const colCount = 2 + (isSuperAdmin ? WAGE_ROLES.length : 0) + 1;

  if (loading) {
    return (
      <div className="flex justify-center py-4">
        <Loader2 className={`${iconSize.md} animate-spin text-teal-600`} />
      </div>
    );
  }

  if (activeServices.length === 0) {
    return (
      <p className="text-sm text-gray-500 py-4 text-center" data-testid="text-no-economics-services">
        Keine aktiven Dienstleistungen im Katalog
      </p>
    );
  }

  return (
    <div className="space-y-2" data-testid="service-economics-section">
      {(hasFuturePrices || hasFutureWages) && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
          <p className="text-xs text-blue-700">
            <Calendar className="inline h-3 w-3 mr-1" />
            {hasFuturePrices && "Geplante Preisänderungen vorhanden."}
            {hasFuturePrices && hasFutureWages && " "}
            {hasFutureWages && "Geplante Lohnänderungen vorhanden."}
          </p>
        </div>
      )}

      <div className="border rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-2 py-1.5 font-medium text-gray-500">Dienstleistung</th>
              <th className="text-right px-2 py-1.5 font-medium text-gray-500 w-32">Verkaufspreis</th>
              {isSuperAdmin && WAGE_ROLES.map(role => (
                <th key={role} className="text-right px-2 py-1.5 font-medium text-gray-500 w-32">
                  Lohn {ROLE_LABELS[role]}
                </th>
              ))}
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {activeServices.map(service => {
              const unitLabel = UNIT_LABELS[service.unitType] || "";
              const isExpanded = expandedServiceId === service.id;
              const standardPrice = priceByService.get(service.id);
              const isPriceOverridden = !!standardPrice;
              const effectivePrice = standardPrice ? standardPrice.priceCents : service.defaultPriceCents;
              const serviceFuturePrices = futurePriceByService.get(service.id) || [];
              const isEditingPrice = editingCell === priceCellKey(service.id);
              return (
                <tr key={service.id} className="border-t align-top" data-testid={`row-economics-${service.id}`}>
                  <td className="px-2 py-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{service.name}</span>
                      {service.code && <span className="text-xs text-gray-400">({service.code})</span>}
                    </div>
                    <button
                      type="button"
                      className="text-[11px] text-gray-500 hover:text-gray-700 flex items-center gap-1 mt-0.5"
                      onClick={() => setExpandedServiceId(isExpanded ? null : service.id)}
                      data-testid={`button-toggle-history-${service.id}`}
                    >
                      {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                      Historie {isExpanded ? "ausblenden" : "anzeigen"}
                    </button>
                  </td>

                  {/* Verkaufspreis-Zelle */}
                  <td className="px-2 py-2 text-right w-32">
                    {!service.isBillable ? (
                      <span className="text-gray-400 text-xs" data-testid={`text-price-${service.id}`}>—</span>
                    ) : isEditingPrice ? (
                      <div className="flex flex-col items-end gap-1">
                        <div className="flex items-center gap-1">
                          <Input
                            type="text"
                            value={editValue}
                            onChange={e => setEditValue(e.target.value)}
                            className="h-7 text-sm text-right w-20"
                            autoFocus
                            placeholder="0,00"
                            onKeyDown={e => {
                              if (e.key === "Enter") handleSavePrice(service.id);
                              if (e.key === "Escape") resetEdit();
                            }}
                            data-testid={`input-price-${service.id}`}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            onClick={() => handleSavePrice(service.id)}
                            disabled={priceSaveMutation.isPending}
                            data-testid={`button-save-price-${service.id}`}
                          >
                            <Check className="h-3.5 w-3.5 text-green-600" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            onClick={resetEdit}
                            data-testid={`button-cancel-price-${service.id}`}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                        <Input
                          type="date"
                          value={editValidFrom}
                          onChange={e => setEditValidFrom(e.target.value)}
                          min={getTodayISO()}
                          className="h-7 text-xs w-32"
                          data-testid={`input-price-valid-from-${service.id}`}
                        />
                      </div>
                    ) : (
                      <div className="flex items-center justify-end gap-1">
                        <div className="flex flex-col items-end">
                          <span className={`font-semibold ${isPriceOverridden ? "text-teal-700" : ""}`} data-testid={`text-price-${service.id}`}>
                            {formatCurrency(effectivePrice)}{unitLabel}
                          </span>
                          {isPriceOverridden ? (
                            <span className="text-[10px] text-gray-400">
                              ab {formatDateDisplay(standardPrice!.validFrom)} · Standard {formatCurrency(service.defaultPriceCents)}
                            </span>
                          ) : (
                            <span className="text-[10px] text-gray-400">Katalog-Standard</span>
                          )}
                          {serviceFuturePrices.map(fp => (
                            <span
                              key={fp.id}
                              className="text-[10px] text-blue-600 flex items-center gap-0.5"
                              data-testid={`text-future-price-${fp.id}`}
                            >
                              <Calendar className="h-2.5 w-2.5" />
                              ab {formatDateDisplay(fp.validFrom)}: {formatCurrency(fp.priceCents)}
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-4 w-4 p-0 ml-0.5"
                                onClick={() => priceDeleteMutation.mutate({ priceId: fp.id })}
                                disabled={priceDeleteMutation.isPending}
                                data-testid={`button-delete-future-price-${fp.id}`}
                              >
                                <X className="h-2.5 w-2.5 text-blue-400 hover:text-red-500" />
                              </Button>
                            </span>
                          ))}
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          onClick={() => startEditPrice(service.id, effectivePrice)}
                          data-testid={`button-edit-price-${service.id}`}
                        >
                          <Pencil className="h-3.5 w-3.5 text-gray-500" />
                        </Button>
                      </div>
                    )}
                  </td>

                  {/* Lohn-Zellen (nur Superadmin) */}
                  {isSuperAdmin && WAGE_ROLES.map(role => {
                    const key = wageCellKey(role, service.id);
                    const activeRate = wageByCell.get(key);
                    const isEditingWage = editingCell === key;
                    const cellFuture = futureWageByCell.get(key) || [];
                    return (
                      <td key={role} className="px-2 py-2 text-right w-32">
                        {isEditingWage ? (
                          <div className="flex flex-col items-end gap-1">
                            <div className="flex items-center gap-1">
                              <Input
                                type="text"
                                value={editValue}
                                onChange={e => setEditValue(e.target.value)}
                                className="h-7 text-sm text-right w-20"
                                autoFocus
                                placeholder="0,00"
                                onKeyDown={e => {
                                  if (e.key === "Enter") handleSaveWage(role, service.id);
                                  if (e.key === "Escape") resetEdit();
                                }}
                                data-testid={`input-wage-${role}-${service.id}`}
                              />
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0"
                                onClick={() => handleSaveWage(role, service.id)}
                                disabled={wageSaveMutation.isPending}
                                data-testid={`button-save-wage-${role}-${service.id}`}
                              >
                                <Check className="h-3.5 w-3.5 text-green-600" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0"
                                onClick={resetEdit}
                                data-testid={`button-cancel-wage-${role}-${service.id}`}
                              >
                                <X className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                            <Input
                              type="date"
                              value={editValidFrom}
                              onChange={e => setEditValidFrom(e.target.value)}
                              className="h-7 text-xs w-32"
                              data-testid={`input-wage-valid-from-${role}-${service.id}`}
                            />
                          </div>
                        ) : (
                          <div className="flex items-center justify-end gap-1">
                            <div className="flex flex-col items-end">
                              {activeRate ? (
                                <>
                                  <span className="font-semibold text-teal-700" data-testid={`text-wage-${role}-${service.id}`}>
                                    {formatCurrency(activeRate.cents)}{unitLabel}
                                  </span>
                                  <span className="text-[10px] text-gray-400">ab {formatDateDisplay(activeRate.validFrom)}</span>
                                </>
                              ) : (
                                <span className="text-gray-400 text-xs" data-testid={`text-wage-${role}-${service.id}`}>
                                  Standard: {formatCurrency(service.employeeRateCents)}{unitLabel}
                                </span>
                              )}
                              {cellFuture.map(fr => (
                                <span
                                  key={fr.id}
                                  className="text-[10px] text-blue-600 flex items-center gap-0.5"
                                  data-testid={`text-future-wage-${fr.id}`}
                                >
                                  <Calendar className="h-2.5 w-2.5" />
                                  ab {formatDateDisplay(fr.validFrom)}: {formatCurrency(fr.cents)}
                                </span>
                              ))}
                            </div>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0"
                              onClick={() => startEditWage(role, service.id, activeRate ? activeRate.cents : service.employeeRateCents)}
                              data-testid={`button-edit-wage-${role}-${service.id}`}
                            >
                              <Pencil className="h-3.5 w-3.5 text-gray-500" />
                            </Button>
                          </div>
                        )}
                      </td>
                    );
                  })}
                  <td />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {expandedServiceId !== null && (() => {
        const svc = activeServices.find(s => s.id === expandedServiceId);
        const todayISO = getTodayISO();
        const pricePhases = (allPrices || [])
          .filter(p => p.serviceId === expandedServiceId)
          .concat((futurePrices || []).filter(p => p.serviceId === expandedServiceId && !(allPrices || []).some(a => a.id === p.id)));
        const wagePhases = isSuperAdmin
          ? (allRates || [])
              .filter(r => r.serviceId === expandedServiceId)
              .concat((futureRates || []).filter(r => r.serviceId === expandedServiceId && !(allRates || []).some(a => a.id === r.id)))
          : [];
        return (
          <div className="border rounded-lg overflow-hidden space-y-0" data-testid={`history-${expandedServiceId}`}>
            <div className="bg-gray-50 px-2 py-1.5 text-xs font-medium text-gray-600">
              Historie &amp; geplante Phasen: {svc?.name}
            </div>

            <div className="px-2 py-1 text-[11px] font-semibold text-gray-500 bg-gray-50/50">Verkaufspreis</div>
            {pricePhases.length === 0 ? (
              <p className="text-xs text-gray-500 text-center py-2">Keine Preis-Phasen (es gilt der Katalog-Standard).</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-right px-2 py-1.5 font-medium text-gray-500">Preis</th>
                    <th className="text-left px-2 py-1.5 font-medium text-gray-500">Gültig ab</th>
                    <th className="text-left px-2 py-1.5 font-medium text-gray-500">Gültig bis</th>
                  </tr>
                </thead>
                <tbody>
                  {pricePhases.map(p => (
                    <tr key={p.id} className={`border-t ${!p.validTo ? "bg-teal-50/50" : ""}`} data-testid={`price-history-row-${p.id}`}>
                      <td className="px-2 py-1.5 text-right font-medium" data-testid={`text-history-price-${p.id}`}>
                        {formatCurrency(p.priceCents)}{UNIT_LABELS[p.unitType] || ""}
                      </td>
                      <td className="px-2 py-1.5" data-testid={`text-history-price-valid-from-${p.id}`}>{formatDateDisplay(p.validFrom)}</td>
                      <td className="px-2 py-1.5" data-testid={`text-history-price-valid-to-${p.id}`}>{p.validTo ? formatDateDisplay(p.validTo) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {isSuperAdmin && (
              <>
                <div className="px-2 py-1 text-[11px] font-semibold text-gray-500 bg-gray-50/50 border-t">Lohnsätze</div>
                {wagePhases.length === 0 ? (
                  <p className="text-xs text-gray-500 text-center py-2">Keine Lohn-Phasen (es gilt der Katalog-Standard).</p>
                ) : (
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="text-left px-2 py-1.5 font-medium text-gray-500">Rolle</th>
                        <th className="text-right px-2 py-1.5 font-medium text-gray-500">Satz</th>
                        <th className="text-left px-2 py-1.5 font-medium text-gray-500">Gültig ab</th>
                        <th className="text-left px-2 py-1.5 font-medium text-gray-500">Gültig bis</th>
                        <th className="w-8" />
                      </tr>
                    </thead>
                    <tbody>
                      {wagePhases.map(p => {
                        const isEnded = p.validTo != null && p.validTo.slice(0, 10) < todayISO;
                        const deletable = !isEnded;
                        return (
                          <tr key={p.id} className={`border-t ${!p.validTo ? "bg-teal-50/50" : ""}`} data-testid={`wage-history-row-${p.id}`}>
                            <td className="px-2 py-1.5">{ROLE_LABELS[p.role]}</td>
                            <td className="px-2 py-1.5 text-right font-medium" data-testid={`text-history-wage-${p.id}`}>
                              {formatCurrency(p.cents)}{UNIT_LABELS[p.unitType] || ""}
                            </td>
                            <td className="px-2 py-1.5" data-testid={`text-history-wage-valid-from-${p.id}`}>{formatDateDisplay(p.validFrom)}</td>
                            <td className="px-2 py-1.5" data-testid={`text-history-wage-valid-to-${p.id}`}>{p.validTo ? formatDateDisplay(p.validTo) : "—"}</td>
                            <td className="px-1 py-1.5">
                              {deletable && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 w-6 p-0"
                                  onClick={() => wageDeleteMutation.mutate({ rateId: p.id })}
                                  disabled={wageDeleteMutation.isPending}
                                  data-testid={`button-delete-wage-${p.id}`}
                                >
                                  <X className="h-3 w-3 text-gray-400 hover:text-red-500" />
                                </Button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </>
            )}
          </div>
        );
      })()}

      <p className="text-[11px] text-gray-500">
        Verkaufspreise (zzgl. MwSt.) und {isSuperAdmin ? "Lohnsätze gelten" : "gelten"} firmenweit. Klicken Sie auf den Stift,
        um einen Wert zu setzen; über das Datumsfeld legen Sie einen „gültig ab"-Stichtag fest (frühestens heute).
        Kundenindividuelle Preise haben weiterhin Vorrang vor dem Standardpreis, der Standardpreis vor dem Katalog-Default;
        {isSuperAdmin ? " fehlt ein Rollen-Lohnsatz, gilt der Katalog-Standard." : ""} Änderungen werden als neue Korrekturphase
        ab Datum angelegt — bestehende Historieneinträge bleiben revisionssicher (GoBD).
      </p>

      {/* Preis: Ersetzen-Dialog */}
      <AlertDialog open={!!pendingPriceReplace} onOpenChange={open => { if (!open) setPendingPriceReplace(null); }}>
        <AlertDialogContent data-testid="dialog-replace-price">
          <AlertDialogHeader>
            <AlertDialogTitle>Bestehenden Standardpreis ersetzen?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                {pendingPriceReplace ? (
                  <>
                    <p>
                      Für <span className="font-medium">{pendingPriceReplace.existing.serviceName}</span> existiert bereits ein
                      aktiver Standardpreis ab dem <span className="font-medium">{formatDateDisplay(pendingPriceReplace.existing.validFrom)}</span>:
                    </p>
                    <div className="rounded-md border bg-gray-50 px-3 py-2">
                      <div className="flex items-center justify-between">
                        <span className="text-gray-600">Bisheriger Preis</span>
                        <span className="font-semibold" data-testid="text-existing-price">{formatCurrency(pendingPriceReplace.existing.priceCents)}</span>
                      </div>
                      <div className="flex items-center justify-between mt-1">
                        <span className="text-gray-600">Neuer Preis</span>
                        <span className="font-semibold text-amber-700" data-testid="text-new-price">{formatCurrency(pendingPriceReplace.priceCents)}</span>
                      </div>
                    </div>
                    <p className="text-xs text-gray-500">Der bestehende Eintrag wird als ersetzt markiert. Die Aktion erscheint im Audit-Log.</p>
                  </>
                ) : null}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="btn-cancel-replace-price">Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              data-testid="btn-confirm-replace-price"
              onClick={() => {
                if (!pendingPriceReplace) return;
                priceSaveMutation.mutate({
                  serviceId: pendingPriceReplace.serviceId,
                  priceCents: pendingPriceReplace.priceCents,
                  validFrom: pendingPriceReplace.validFrom,
                  confirmReplace: true,
                });
              }}
            >
              Ja, ersetzen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Preis: Abgerechnete-Monate-Dialog */}
      <AlertDialog open={pendingPriceChange !== null} onOpenChange={open => { if (!open) setPendingPriceChange(null); }}>
        <AlertDialogContent data-testid="dialog-confirm-invoiced-period">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-600" />
              Bereits abgerechnete Monate betroffen
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  Sie ändern einen firmenweiten Standardpreis mit einem Stichtag, der bereits in abgerechneten Zeiträumen liegt.
                  Diese Änderung könnte erneute Rechnungserstellungen mit anderen Preisen abrechnen, als ursprünglich auf der Rechnung standen.
                </p>
                {pendingPriceChange && pendingPriceChange.kind === "save" && pendingPriceChange.invoices.length > 0 && (
                  <div className="bg-amber-50 border border-amber-200 rounded p-2">
                    <p className="font-medium mb-1">Betroffene Rechnungen:</p>
                    <ul className="space-y-0.5">
                      {pendingPriceChange.invoices.slice(0, 10).map(inv => (
                        <li key={inv.id} className="text-xs" data-testid={`affected-invoice-${inv.id}`}>
                          {inv.invoiceNumber} ({String(inv.billingMonth).padStart(2, "0")}/{inv.billingYear}, {inv.status})
                        </li>
                      ))}
                      {pendingPriceChange.invoices.length > 10 && (
                        <li className="text-xs text-gray-500">… und {pendingPriceChange.invoices.length - 10} weitere</li>
                      )}
                    </ul>
                  </div>
                )}
                <p className="text-xs text-gray-600">
                  Bestehende, gesiegelte Rechnungen bleiben unverändert. Bitte bestätigen Sie nur, wenn Sie sicher sind. Die Aktion wird im Audit-Log dokumentiert.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="btn-cancel-invoiced-override">Abbrechen</AlertDialogCancel>
            <AlertDialogAction onClick={confirmPriceChange} className="bg-amber-600 hover:bg-amber-700" data-testid="btn-confirm-invoiced-override">
              Trotzdem speichern
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Lohn: Ersetzen-Dialog */}
      <AlertDialog open={!!pendingWageReplace} onOpenChange={open => { if (!open) setPendingWageReplace(null); }}>
        <AlertDialogContent data-testid="dialog-replace-wage">
          <AlertDialogHeader>
            <AlertDialogTitle>Bestehenden Lohnsatz ersetzen?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                {pendingWageReplace ? (
                  <>
                    <p>
                      Für <span className="font-medium">{ROLE_LABELS[pendingWageReplace.existing.role]} · {pendingWageReplace.existing.serviceName}</span>{" "}
                      existiert bereits ein aktiver Lohnsatz ab dem{" "}
                      <span className="font-medium">{formatDateDisplay(pendingWageReplace.existing.validFrom)}</span>:
                    </p>
                    <div className="rounded-md border bg-gray-50 px-3 py-2">
                      <div className="flex items-center justify-between">
                        <span className="text-gray-600">Bisheriger Satz</span>
                        <span className="font-semibold" data-testid="text-existing-wage">{formatCurrency(pendingWageReplace.existing.cents)}</span>
                      </div>
                      <div className="flex items-center justify-between mt-1">
                        <span className="text-gray-600">Neuer Satz</span>
                        <span className="font-semibold text-amber-700" data-testid="text-new-wage">{formatCurrency(pendingWageReplace.cents)}</span>
                      </div>
                    </div>
                    <p className="text-xs text-gray-500">Der bestehende Eintrag wird als ersetzt markiert. Die Aktion erscheint im Audit-Log.</p>
                  </>
                ) : null}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-replace-wage">Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-replace-wage"
              onClick={() => {
                if (!pendingWageReplace) return;
                wageSaveMutation.mutate({
                  role: pendingWageReplace.role,
                  serviceId: pendingWageReplace.serviceId,
                  cents: pendingWageReplace.cents,
                  validFrom: pendingWageReplace.validFrom,
                  confirmReplace: true,
                });
              }}
            >
              Ja, ersetzen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Lohn: Abgeschlossene-Monate-Dialog */}
      <AlertDialog open={pendingWageClosed !== null} onOpenChange={open => { if (!open) setPendingWageClosed(null); }}>
        <AlertDialogContent data-testid="dialog-confirm-closed-period">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-600" />
              Bereits abgeschlossene Lohn-Monate betroffen
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  Diese Lohnänderung betrifft bereits abgeschlossene Lohn-Monate. Eine Änderung kann sich auf bereits abgerechnete
                  Mitarbeiter-Vergütungen auswirken.
                </p>
                {pendingWageClosed && pendingWageClosed.months.length > 0 && (
                  <div className="bg-amber-50 border border-amber-200 rounded p-2">
                    <p className="font-medium mb-1">Betroffene Monate:</p>
                    <ul className="space-y-0.5">
                      {pendingWageClosed.months.slice(0, 12).map(m => (
                        <li key={`${m.year}-${m.month}`} className="text-xs" data-testid={`affected-month-${m.year}-${m.month}`}>
                          {MONTH_LABELS[m.month - 1]} {m.year} ({m.employeeCount} Mitarbeiter)
                        </li>
                      ))}
                      {pendingWageClosed.months.length > 12 && (
                        <li className="text-xs text-gray-500">… und {pendingWageClosed.months.length - 12} weitere</li>
                      )}
                    </ul>
                  </div>
                )}
                <p className="text-xs text-gray-600">Bitte bestätigen Sie nur, wenn Sie sicher sind. Die Aktion wird im Audit-Log dokumentiert.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-closed-override">Abbrechen</AlertDialogCancel>
            <AlertDialogAction onClick={confirmWageClosed} className="bg-amber-600 hover:bg-amber-700" data-testid="button-confirm-closed-override">
              Trotzdem fortfahren
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
