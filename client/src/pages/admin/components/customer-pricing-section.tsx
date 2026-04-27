import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatCurrency } from "@shared/utils/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, unwrapResult, ApiError } from "@/lib/api";
import { invalidateRelated } from "@/lib/query-invalidation";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Pencil, Check, X, RotateCcw, Calendar, ChevronDown, ChevronUp, AlertTriangle } from "lucide-react";
import { parseLocalDate } from "@shared/utils/datetime";
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

interface AffectedInvoice {
  id: number;
  invoiceNumber: string;
  billingMonth: number;
  billingYear: number;
  status: string;
}

type PendingChange =
  | { kind: "save"; serviceId: number; priceCents: number; validFrom?: string; invoices: AffectedInvoice[] }
  | { kind: "edit"; priceId: number; priceCents: number; invoices: AffectedInvoice[] }
  | { kind: "delete"; priceId: number; invoices: AffectedInvoice[] }
  | { kind: "update"; priceId: number; validFrom: string; validTo: string | null; priceCents?: number; invoices: AffectedInvoice[] };

interface CatalogService {
  id: number;
  name: string;
  code: string | null;
  unitType: string;
  defaultPriceCents: number;
  vatRate: number;
  isBillable: boolean;
  isActive: boolean;
}

interface CustomerPrice {
  id: number;
  customerId: number;
  serviceId: number;
  priceCents: number;
  validFrom: string;
  validTo: string | null;
  serviceName: string;
  serviceCode: string;
  defaultPriceCents: number;
  unitType: string;
}

const UNIT_LABELS: Record<string, string> = {
  hours: "€/Std.",
  kilometers: "€/km",
  flat: "€ pauschal",
};

function formatDateDisplay(dateStr: string): string {
  try {
    const d = parseLocalDate(dateStr);
    return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
  } catch {
    return dateStr;
  }
}

function getTodayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface PricingSectionProps {
  customerId: number;
  customerName: string;
  onRefresh: () => void;
}

interface PendingReplaceState {
  serviceId: number;
  priceCents: number;
  validFrom?: string;
  existing: { id: number; priceCents: number; validFrom: string; serviceName: string };
}

export function PricingSection({ customerId, customerName, onRefresh }: PricingSectionProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editingServiceId, setEditingServiceId] = useState<number | null>(null);
  const [editPrice, setEditPrice] = useState("");
  const [editValidFrom, setEditValidFrom] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [pendingChange, setPendingChange] = useState<PendingChange | null>(null);
  const [pendingReplace, setPendingReplace] = useState<PendingReplaceState | null>(null);
  const [editingPriceId, setEditingPriceId] = useState<number | null>(null);
  const [editPriceValidFrom, setEditPriceValidFrom] = useState("");
  const [editPriceValidTo, setEditPriceValidTo] = useState("");
  const [editPriceAmount, setEditPriceAmount] = useState("");

  const { data: services, isLoading: loadingServices } = useQuery<CatalogService[]>({
    queryKey: ["/api/services"],
    staleTime: 60000,
  });

  const { data: customerPrices, isLoading: loadingPrices } = useQuery<CustomerPrice[]>({
    queryKey: ["customer-service-prices", customerId],
    queryFn: async () => {
      const result = await api.get<CustomerPrice[]>(`/customers/${customerId}/service-prices`);
      return unwrapResult(result);
    },
    staleTime: 30000,
  });

  const { data: futurePrices } = useQuery<CustomerPrice[]>({
    queryKey: ["customer-service-prices-future", customerId],
    queryFn: async () => {
      const result = await api.get<CustomerPrice[]>(`/customers/${customerId}/service-prices/future`);
      return unwrapResult(result);
    },
    staleTime: 30000,
  });

  const { data: allPrices } = useQuery<CustomerPrice[]>({
    queryKey: ["customer-service-prices-all", customerId],
    queryFn: async () => {
      const result = await api.get<CustomerPrice[]>(`/customers/${customerId}/service-prices/all`);
      return unwrapResult(result);
    },
    staleTime: 30000,
    enabled: showHistory,
  });

  const saveMutation = useMutation({
    mutationFn: async ({
      serviceId,
      priceCents,
      validFrom,
      confirmInvoiceOverride,
      confirmReplace,
    }: {
      serviceId: number;
      priceCents: number;
      validFrom?: string;
      confirmInvoiceOverride?: boolean;
      confirmReplace?: boolean;
    }) => {
      const body: Record<string, unknown> = { serviceId, priceCents };
      if (validFrom) body.validFrom = validFrom;
      if (confirmInvoiceOverride) body.confirmInvoiceOverride = true;
      if (confirmReplace) body.confirmReplace = true;
      const result = await api.post(`/customers/${customerId}/service-prices`, body);
      return unwrapResult(result);
    },
    onSuccess: (_data, variables) => {
      invalidateRelated(queryClient, "customer-service-prices");
      setEditingServiceId(null);
      setEditPrice("");
      setEditValidFrom("");
      setPendingChange(null);
      setPendingReplace(null);
      toast({ title: variables.confirmReplace ? "Bestehender Preis ersetzt" : "Kundenpreis gespeichert" });
    },
    onError: (error: Error, variables) => {
      if (
        error instanceof ApiError
        && error.code === "INVOICED_PERIOD_AFFECTED"
        && !variables.confirmInvoiceOverride
      ) {
        const invoices = (error.details?.invoices as AffectedInvoice[] | undefined) || [];
        setPendingChange({
          kind: "save",
          serviceId: variables.serviceId,
          priceCents: variables.priceCents,
          validFrom: variables.validFrom,
          invoices,
        });
        return;
      }
      if (error instanceof ApiError && error.code === "PRICE_CONFLICT") {
        const existing = (error.details?.existing as PendingReplaceState["existing"] | undefined);
        if (existing) {
          setPendingReplace({
            serviceId: variables.serviceId,
            priceCents: variables.priceCents,
            validFrom: variables.validFrom,
            existing,
          });
          return;
        }
      }
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const editMutation = useMutation({
    mutationFn: async ({
      priceId,
      priceCents,
      confirmInvoiceOverride,
    }: {
      priceId: number;
      priceCents: number;
      confirmInvoiceOverride?: boolean;
    }) => {
      const body: Record<string, unknown> = { priceCents };
      if (confirmInvoiceOverride) body.confirmInvoiceOverride = true;
      const result = await api.patch(`/customers/${customerId}/service-prices/${priceId}`, body);
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "customer-service-prices");
      setEditingServiceId(null);
      setEditPrice("");
      setEditValidFrom("");
      setPendingChange(null);
      toast({ title: "Kundenpreis aktualisiert" });
    },
    onError: (error: Error, variables) => {
      if (
        error instanceof ApiError
        && error.code === "INVOICED_PERIOD_AFFECTED"
        && !variables.confirmInvoiceOverride
      ) {
        const invoices = (error.details?.invoices as AffectedInvoice[] | undefined) || [];
        setPendingChange({
          kind: "edit",
          priceId: variables.priceId,
          priceCents: variables.priceCents,
          invoices,
        });
        return;
      }
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({
      priceId,
      validFrom,
      validTo,
      priceCents,
      confirmInvoiceOverride,
    }: {
      priceId: number;
      validFrom: string;
      validTo: string | null;
      priceCents?: number;
      confirmInvoiceOverride?: boolean;
    }) => {
      const body: Record<string, unknown> = { validFrom, validTo };
      if (priceCents !== undefined) body.priceCents = priceCents;
      if (confirmInvoiceOverride) body.confirmInvoiceOverride = true;
      const result = await api.patch(`/customers/${customerId}/service-prices/${priceId}`, body);
      return unwrapResult(result);
    },
    onSuccess: (_data, variables) => {
      invalidateRelated(queryClient, "customer-service-prices");
      setEditingPriceId(null);
      setEditPriceValidFrom("");
      setEditPriceValidTo("");
      setEditPriceAmount("");
      setPendingChange(null);
      toast({
        title: variables.priceCents !== undefined
          ? "Kundenpreis aktualisiert"
          : "Gültigkeitszeitraum aktualisiert",
      });
    },
    onError: (error: Error, variables) => {
      if (
        error instanceof ApiError
        && error.code === "INVOICED_PERIOD_AFFECTED"
        && !variables.confirmInvoiceOverride
      ) {
        const invoices = (error.details?.invoices as AffectedInvoice[] | undefined) || [];
        setPendingChange({
          kind: "update",
          priceId: variables.priceId,
          validFrom: variables.validFrom,
          validTo: variables.validTo,
          priceCents: variables.priceCents,
          invoices,
        });
        return;
      }
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async ({ priceId, confirmInvoiceOverride }: { priceId: number; confirmInvoiceOverride?: boolean }) => {
      const url = confirmInvoiceOverride
        ? `/customers/${customerId}/service-prices/${priceId}?confirmInvoiceOverride=true`
        : `/customers/${customerId}/service-prices/${priceId}`;
      const result = await api.delete(url);
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "customer-service-prices");
      setPendingChange(null);
      toast({ title: "Kundenpreis zurückgesetzt auf Katalogpreis" });
    },
    onError: (error: Error, variables) => {
      if (
        error instanceof ApiError
        && error.code === "INVOICED_PERIOD_AFFECTED"
        && !variables.confirmInvoiceOverride
      ) {
        const invoices = (error.details?.invoices as AffectedInvoice[] | undefined) || [];
        setPendingChange({
          kind: "delete",
          priceId: variables.priceId,
          invoices,
        });
        return;
      }
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  function confirmPendingChange() {
    if (!pendingChange) return;
    if (pendingChange.kind === "save") {
      saveMutation.mutate({
        serviceId: pendingChange.serviceId,
        priceCents: pendingChange.priceCents,
        validFrom: pendingChange.validFrom,
        confirmInvoiceOverride: true,
      });
    } else if (pendingChange.kind === "edit") {
      editMutation.mutate({
        priceId: pendingChange.priceId,
        priceCents: pendingChange.priceCents,
        confirmInvoiceOverride: true,
      });
    } else if (pendingChange.kind === "update") {
      updateMutation.mutate({
        priceId: pendingChange.priceId,
        validFrom: pendingChange.validFrom,
        validTo: pendingChange.validTo,
        priceCents: pendingChange.priceCents,
        confirmInvoiceOverride: true,
      });
    } else {
      deleteMutation.mutate({ priceId: pendingChange.priceId, confirmInvoiceOverride: true });
    }
  }

  if (loadingServices || loadingPrices) {
    return (
      <div className="flex justify-center py-4">
        <Loader2 className="h-5 w-5 animate-spin text-gray-500" />
      </div>
    );
  }

  const activeServices = services?.filter(s => s.isActive && s.isBillable) || [];
  const priceMap = new Map<number, CustomerPrice>();
  customerPrices?.forEach(cp => priceMap.set(cp.serviceId, cp));

  const futureByService = new Map<number, CustomerPrice[]>();
  futurePrices?.forEach(fp => {
    const list = futureByService.get(fp.serviceId) || [];
    list.push(fp);
    futureByService.set(fp.serviceId, list);
  });

  if (activeServices.length === 0) {
    return <p className="text-sm text-gray-500 py-4 text-center" data-testid="text-no-prices">Keine Dienstleistungen im Katalog</p>;
  }

  const hasCustomPrices = priceMap.size > 0;
  const hasFuturePrices = (futurePrices?.length || 0) > 0;

  function startEdit(serviceId: number, currentPriceCents: number) {
    setEditingServiceId(serviceId);
    setEditPrice((currentPriceCents / 100).toFixed(2).replace(".", ","));
    setEditValidFrom("");
  }

  function handleSave(serviceId: number) {
    const normalized = editPrice.replace(",", ".");
    const euros = parseFloat(normalized);
    if (isNaN(euros) || euros < 0) {
      toast({ title: "Ungültiger Preis", variant: "destructive" });
      return;
    }
    const newPriceCents = Math.round(euros * 100);
    const existingCustomPrice = priceMap.get(serviceId);
    if (!editValidFrom && existingCustomPrice && newPriceCents !== existingCustomPrice.priceCents) {
      editMutation.mutate({
        priceId: existingCustomPrice.id,
        priceCents: newPriceCents,
      });
      return;
    }
    if (!editValidFrom && existingCustomPrice && newPriceCents === existingCustomPrice.priceCents) {
      setEditingServiceId(null);
      setEditPrice("");
      setEditValidFrom("");
      return;
    }
    saveMutation.mutate({
      serviceId,
      priceCents: newPriceCents,
      validFrom: editValidFrom || undefined,
    });
  }

  return (
    <>
    <AlertDialog
      open={!!pendingReplace}
      onOpenChange={(open) => { if (!open) setPendingReplace(null); }}
    >
      <AlertDialogContent data-testid="dialog-replace-price">
        <AlertDialogHeader>
          <AlertDialogTitle>Bestehenden Kundenpreis ersetzen?</AlertDialogTitle>
          <AlertDialogDescription>
            {pendingReplace ? (
              <>
                Für <span className="font-medium">{pendingReplace.existing.serviceName}</span> existiert
                bereits ein aktiver Preis ab dem{" "}
                <span className="font-medium">{formatDateDisplay(pendingReplace.existing.validFrom)}</span>:
                <div className="mt-3 rounded-md border bg-gray-50 px-3 py-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-gray-600">Bisheriger Preis</span>
                    <span className="font-semibold" data-testid="text-existing-price">{formatCurrency(pendingReplace.existing.priceCents)}</span>
                  </div>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-gray-600">Neuer Preis</span>
                    <span className="font-semibold text-amber-700" data-testid="text-new-price">{formatCurrency(pendingReplace.priceCents)}</span>
                  </div>
                </div>
                <div className="mt-3 text-xs text-gray-500">
                  Der bestehende Eintrag wird als ersetzt markiert. Die Aktion erscheint im Audit-Log.
                </div>
              </>
            ) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="btn-cancel-replace">Abbrechen</AlertDialogCancel>
          <AlertDialogAction
            data-testid="btn-confirm-replace"
            onClick={() => {
              if (!pendingReplace) return;
              saveMutation.mutate({
                serviceId: pendingReplace.serviceId,
                priceCents: pendingReplace.priceCents,
                validFrom: pendingReplace.validFrom,
                confirmReplace: true,
              });
            }}
          >
            Ja, ersetzen
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <div className="space-y-1" data-testid="pricing-section">
      {hasCustomPrices && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-2">
          <p className="text-xs text-amber-700">Kundenindividuelle Preise aktiv – abweichende Preise sind markiert.</p>
        </div>
      )}
      {hasFuturePrices && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 mb-2">
          <p className="text-xs text-blue-700">
            <Calendar className="inline h-3 w-3 mr-1" />
            Geplante Preisänderungen vorhanden.
          </p>
        </div>
      )}
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 items-center px-2 py-1 text-xs text-gray-500 font-medium">
        <span>Dienstleistung</span>
        <span className="text-right w-24">Preis</span>
        <span className="w-16"></span>
      </div>
      {activeServices.map((service) => {
        const unitLabel = UNIT_LABELS[service.unitType] || "€";
        const customPrice = priceMap.get(service.id);
        const effectivePrice = customPrice ? customPrice.priceCents : service.defaultPriceCents;
        const isEditing = editingServiceId === service.id;
        const isCustom = !!customPrice;
        const serviceFuturePrices = futureByService.get(service.id) || [];

        return (
          <div key={service.id} data-testid={`pricing-row-${service.id}`}>
            <div className={`grid grid-cols-[1fr_auto_auto] gap-x-3 items-center px-2 py-2 rounded-lg hover:bg-gray-50 ${isCustom ? 'bg-amber-50/50' : ''}`}>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{service.name}</span>
                  {isCustom && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">Kundenpreis</span>
                  )}
                </div>
                {isCustom && (
                  <div className="text-[11px] text-gray-500 mt-0.5">
                    Katalog: {formatCurrency(service.defaultPriceCents)} {unitLabel}
                  </div>
                )}
                {serviceFuturePrices.map(fp => (
                  <div key={fp.id} className="text-[11px] text-blue-600 mt-0.5 flex items-center gap-1" data-testid={`future-price-${fp.id}`}>
                    <Calendar className="h-3 w-3" />
                    Ab {formatDateDisplay(fp.validFrom)}: {formatCurrency(fp.priceCents)} {unitLabel}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 w-5 p-0 ml-1"
                      onClick={() => deleteMutation.mutate({ priceId: fp.id })}
                      disabled={deleteMutation.isPending}
                      data-testid={`btn-delete-future-${fp.id}`}
                    >
                      <X className="h-3 w-3 text-blue-400 hover:text-red-500" />
                    </Button>
                  </div>
                ))}
              </div>
              <div className="text-right w-24">
                {isEditing ? (
                  <div className="space-y-1">
                    <Input
                      type="text"
                      value={editPrice}
                      onChange={e => setEditPrice(e.target.value)}
                      className="h-7 text-sm text-right w-20"
                      autoFocus
                      placeholder="0,00"
                      onKeyDown={e => {
                        if (e.key === "Enter") handleSave(service.id);
                        if (e.key === "Escape") { setEditingServiceId(null); setEditPrice(""); setEditValidFrom(""); }
                      }}
                      data-testid={`input-price-${service.id}`}
                    />
                    <Input
                      type="date"
                      value={editValidFrom}
                      onChange={e => setEditValidFrom(e.target.value)}
                      min={getTodayISO()}
                      className="h-7 text-xs w-20"
                      placeholder="Gültig ab"
                      data-testid={`input-valid-from-${service.id}`}
                    />
                  </div>
                ) : (
                  <>
                    <span className={`text-sm font-semibold ${isCustom ? 'text-amber-700' : ''}`}>{formatCurrency(effectivePrice)}</span>
                    <span className="text-xs text-gray-500 ml-0.5">{unitLabel}</span>
                  </>
                )}
              </div>
              <div className="w-16 flex justify-end gap-1">
                {isEditing ? (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      onClick={() => handleSave(service.id)}
                      disabled={saveMutation.isPending || editMutation.isPending}
                      data-testid={`btn-save-price-${service.id}`}
                    >
                      <Check className="h-3.5 w-3.5 text-green-600" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      onClick={() => { setEditingServiceId(null); setEditPrice(""); setEditValidFrom(""); }}
                      data-testid={`btn-cancel-price-${service.id}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      onClick={() => startEdit(service.id, effectivePrice)}
                      data-testid={`btn-edit-price-${service.id}`}
                    >
                      <Pencil className="h-3.5 w-3.5 text-gray-500" />
                    </Button>
                    {isCustom && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => deleteMutation.mutate({ priceId: customPrice.id })}
                        disabled={deleteMutation.isPending}
                        data-testid={`btn-reset-price-${service.id}`}
                      >
                        <RotateCcw className="h-3.5 w-3.5 text-gray-500" />
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        );
      })}

      <div className="px-2 pt-2 space-y-2">
        <p className="text-[11px] text-gray-500">
          Preise zzgl. MwSt. Klicken Sie auf den Stift, um einen kundenindividuellen Preis zu setzen.
          {" "}Über das Datumsfeld können Sie einen zukünftigen Gültigkeitszeitpunkt festlegen.
          {hasCustomPrices ? " Der Pfeil setzt den Preis auf den Katalogpreis zurück." : ""}
          {" "}In der Preishistorie können Sie Preis, Gültig-ab und Gültig-bis bestehender Einträge nachträglich anpassen.
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="text-xs text-gray-500 h-6 px-2"
          onClick={() => setShowHistory(!showHistory)}
          data-testid="btn-toggle-history"
        >
          {showHistory ? <ChevronUp className="h-3 w-3 mr-1" /> : <ChevronDown className="h-3 w-3 mr-1" />}
          Preishistorie {showHistory ? "ausblenden" : "anzeigen"}
        </Button>

        {showHistory && allPrices && allPrices.length > 0 && (
          <div className="border rounded-lg overflow-hidden" data-testid="pricing-history">
            <table className="w-full text-xs">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-2 py-1.5 font-medium text-gray-500">Dienstleistung</th>
                  <th className="text-right px-2 py-1.5 font-medium text-gray-500">Preis</th>
                  <th className="text-left px-2 py-1.5 font-medium text-gray-500">Gültig ab</th>
                  <th className="text-left px-2 py-1.5 font-medium text-gray-500">Gültig bis</th>
                  <th className="px-2 py-1.5 w-20"></th>
                </tr>
              </thead>
              <tbody>
                {allPrices.map(p => {
                  const isRowEditing = editingPriceId === p.id;
                  return (
                    <tr key={p.id} className={`border-t ${!p.validTo ? 'bg-amber-50/50' : ''}`} data-testid={`history-row-${p.id}`}>
                      <td className="px-2 py-1.5">{p.serviceName}</td>
                      <td className="px-2 py-1.5 text-right font-medium">
                        {isRowEditing ? (
                          <div className="flex items-center justify-end gap-1">
                            <Input
                              type="text"
                              value={editPriceAmount}
                              onChange={e => setEditPriceAmount(e.target.value)}
                              className="h-7 text-xs text-right w-20"
                              placeholder="0,00"
                              data-testid={`input-history-price-${p.id}`}
                            />
                            <span className="text-xs text-gray-500">{UNIT_LABELS[p.unitType] || "€"}</span>
                          </div>
                        ) : (
                          <>{formatCurrency(p.priceCents)} {UNIT_LABELS[p.unitType] || "€"}</>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        {isRowEditing ? (
                          <Input
                            type="date"
                            value={editPriceValidFrom}
                            onChange={e => setEditPriceValidFrom(e.target.value)}
                            className="h-7 text-xs w-32"
                            data-testid={`input-history-valid-from-${p.id}`}
                          />
                        ) : (
                          formatDateDisplay(p.validFrom)
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        {isRowEditing ? (
                          <Input
                            type="date"
                            value={editPriceValidTo}
                            onChange={e => setEditPriceValidTo(e.target.value)}
                            min={editPriceValidFrom || undefined}
                            className="h-7 text-xs w-32"
                            data-testid={`input-history-valid-to-${p.id}`}
                          />
                        ) : (
                          p.validTo ? formatDateDisplay(p.validTo) : "—"
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="flex justify-end gap-1">
                          {isRowEditing ? (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 w-6 p-0"
                                onClick={() => {
                                  if (!editPriceValidFrom) {
                                    toast({ title: "Gültig-ab-Datum erforderlich", variant: "destructive" });
                                    return;
                                  }
                                  if (editPriceValidTo && editPriceValidTo < editPriceValidFrom) {
                                    toast({ title: "Gültig-bis-Datum darf nicht vor Gültig-ab-Datum liegen", variant: "destructive" });
                                    return;
                                  }
                                  const normalized = editPriceAmount.replace(",", ".");
                                  const euros = parseFloat(normalized);
                                  if (isNaN(euros) || euros <= 0) {
                                    toast({ title: "Ungültiger Preis", variant: "destructive" });
                                    return;
                                  }
                                  const newPriceCents = Math.round(euros * 100);
                                  updateMutation.mutate({
                                    priceId: p.id,
                                    validFrom: editPriceValidFrom,
                                    validTo: editPriceValidTo || null,
                                    priceCents: newPriceCents !== p.priceCents ? newPriceCents : undefined,
                                  });
                                }}
                                disabled={updateMutation.isPending}
                                data-testid={`btn-save-history-${p.id}`}
                              >
                                <Check className="h-3.5 w-3.5 text-green-600" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 w-6 p-0"
                                onClick={() => {
                                  setEditingPriceId(null);
                                  setEditPriceValidFrom("");
                                  setEditPriceValidTo("");
                                  setEditPriceAmount("");
                                }}
                                data-testid={`btn-cancel-history-${p.id}`}
                              >
                                <X className="h-3.5 w-3.5" />
                              </Button>
                            </>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 p-0"
                              onClick={() => {
                                setEditingPriceId(p.id);
                                setEditPriceValidFrom(p.validFrom.substring(0, 10));
                                setEditPriceValidTo(p.validTo ? p.validTo.substring(0, 10) : "");
                                setEditPriceAmount((p.priceCents / 100).toFixed(2).replace(".", ","));
                              }}
                              data-testid={`btn-edit-history-${p.id}`}
                            >
                              <Pencil className="h-3.5 w-3.5 text-gray-500" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {showHistory && (!allPrices || allPrices.length === 0) && (
          <p className="text-xs text-gray-500 text-center py-2">Keine Preishistorie vorhanden.</p>
        )}
      </div>

      <AlertDialog
        open={pendingChange !== null}
        onOpenChange={(open) => {
          if (!open) setPendingChange(null);
        }}
      >
        <AlertDialogContent data-testid="dialog-confirm-invoiced-period">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-600" />
              Bereits abgerechnete Monate betroffen
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  Sie ändern eine Preis-Periode, die bereits in abgerechneten Zeiträumen liegt.
                  Diese Änderung könnte zukünftige Nachberechnungen oder erneute Rechnungserstellungen
                  mit anderen Preisen abrechnen, als ursprünglich auf der Rechnung standen.
                </p>
                {pendingChange && pendingChange.invoices.length > 0 && (
                  <div className="bg-amber-50 border border-amber-200 rounded p-2">
                    <p className="font-medium mb-1">Betroffene Rechnungen:</p>
                    <ul className="space-y-0.5">
                      {pendingChange.invoices.slice(0, 10).map((inv) => (
                        <li
                          key={inv.id}
                          className="text-xs"
                          data-testid={`affected-invoice-${inv.id}`}
                        >
                          {inv.invoiceNumber} ({String(inv.billingMonth).padStart(2, "0")}/{inv.billingYear}, {inv.status})
                        </li>
                      ))}
                      {pendingChange.invoices.length > 10 && (
                        <li className="text-xs text-gray-500">
                          … und {pendingChange.invoices.length - 10} weitere
                        </li>
                      )}
                    </ul>
                  </div>
                )}
                <p className="text-xs text-gray-600">
                  Bitte bestätigen Sie nur, wenn Sie sicher sind. Die Aktion wird im Audit-Log dokumentiert.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="btn-cancel-invoiced-override">Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmPendingChange}
              className="bg-amber-600 hover:bg-amber-700"
              data-testid="btn-confirm-invoiced-override"
            >
              Trotzdem speichern
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    </>
  );
}
