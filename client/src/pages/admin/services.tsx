import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusBadge } from "@/components/patterns/status-badge";
import { api, unwrapResult } from "@/lib/api";
import { ArrowLeft, Plus, Pencil, Loader2, ClipboardList, Calculator } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { iconSize, componentStyles } from "@/design-system";
import { formatCurrency } from "@shared/utils/format";
import type { InsertService } from "@shared/schema";
import { SERVICE_UNIT_TYPES } from "@shared/schema";
import { BUDGET_TYPES, BUDGET_TYPE_LABELS } from "@shared/domain/budgets";

interface ServiceWithPots {
  id: number;
  code: string | null;
  name: string;
  description: string | null;
  unitType: string;
  defaultPriceCents: number;
  vatRate: number;
  minDurationMinutes: number | null;
  isActive: boolean;
  isDefault: boolean;
  isSystem: boolean;
  isBillable: boolean;
  employeeRateCents: number;
  lohnartKategorie: string;
  sortOrder: number;
  budgetPots: string[];
  createdAt: string;
}

const UNIT_TYPE_LABELS: Record<string, string> = {
  hours: "Stunden",
  kilometers: "Kilometer",
  flat: "Pauschale",
};

const UNIT_SUFFIX: Record<string, string> = {
  hours: "/Std.",
  kilometers: "/km",
  flat: " pauschal",
};

function formatPrice(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

interface ServiceFormData {
  name: string;
  code: string;
  description: string;
  unitType: string;
  defaultPriceCents: string;
  vatRate: string;
  minDurationMinutes: string;
  isBillable: boolean;
  employeeRateCents: string;
  lohnartKategorie: string;
  budgetPots: string[];
  isDefault: boolean;
  isActive: boolean;
  sortOrder: string;
}

const EMPTY_FORM: ServiceFormData = {
  name: "",
  code: "",
  description: "",
  unitType: "hours",
  defaultPriceCents: "",
  vatRate: "19",
  minDurationMinutes: "",
  isBillable: true,
  employeeRateCents: "",
  lohnartKategorie: "hauswirtschaft",
  budgetPots: [],
  isDefault: false,
  isActive: true,
  sortOrder: "0",
};

const LOHNART_LABELS: Record<string, string> = {
  hauswirtschaft: "Hauswirtschaft",
  alltagsbegleitung: "Alltagsbegleitung",
};

export default function AdminServices() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: services, isLoading } = useQuery<ServiceWithPots[]>({
    queryKey: ["/api/services/all"],
    queryFn: async () => {
      const result = await api.get<ServiceWithPots[]>("/services/all");
      return unwrapResult(result);
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: InsertService) => {
      const result = await api.post<ServiceWithPots, InsertService>("/services", data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/services/all"] });
      toast({ title: "Erfolg", description: "Leistung wurde erstellt" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<InsertService> }) => {
      const result = await api.put<ServiceWithPots, Partial<InsertService>>(`/services/${id}`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/services/all"] });
      toast({ title: "Erfolg", description: "Leistung wurde aktualisiert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingService, setEditingService] = useState<ServiceWithPots | null>(null);
  const [form, setForm] = useState<ServiceFormData>(EMPTY_FORM);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkPrices, setBulkPrices] = useState<Record<number, string>>({});
  const [bulkPercent, setBulkPercent] = useState("");
  const [bulkSaving, setBulkSaving] = useState(false);

  const openBulkPrices = () => {
    if (!services) return;
    const initial: Record<number, string> = {};
    services
      .filter(s => s.isBillable && s.isActive)
      .forEach(s => { initial[s.id] = formatPrice(s.defaultPriceCents); });
    setBulkPrices(initial);
    setBulkPercent("");
    setBulkOpen(true);
  };

  const applyBulkPercent = () => {
    const pct = parseFloat(bulkPercent.replace(",", "."));
    if (isNaN(pct)) {
      toast({ title: "Ungültiger Prozentwert", variant: "destructive" });
      return;
    }
    if (!services) return;
    const factor = 1 + pct / 100;
    const next: Record<number, string> = {};
    services
      .filter(s => s.isBillable && s.isActive)
      .forEach(s => {
        const newCents = Math.max(0, Math.round(s.defaultPriceCents * factor));
        next[s.id] = formatPrice(newCents);
      });
    setBulkPrices(next);
  };

  const handleBulkSave = async () => {
    if (!services) return;
    const updates: { id: number; name: string; oldCents: number; newCents: number }[] = [];
    for (const s of services) {
      if (!s.isBillable || !s.isActive) continue;
      const raw = bulkPrices[s.id];
      if (raw === undefined || raw === "") continue;
      const euros = parseFloat(raw.replace(",", "."));
      if (isNaN(euros) || euros < 0) {
        toast({ title: `Ungültiger Preis für ${s.name}`, variant: "destructive" });
        return;
      }
      const newCents = Math.round(euros * 100);
      if (newCents !== s.defaultPriceCents) {
        updates.push({ id: s.id, name: s.name, oldCents: s.defaultPriceCents, newCents });
      }
    }

    if (updates.length === 0) {
      return;
    }

    setBulkSaving(true);
    try {
      let okCount = 0;
      const failed: string[] = [];
      for (const u of updates) {
        const result = await api.put<ServiceWithPots, Partial<InsertService>>(`/services/${u.id}`, { defaultPriceCents: u.newCents });
        if (result.success) {
          okCount++;
        } else {
          failed.push(u.name);
        }
      }
      await queryClient.invalidateQueries({ queryKey: ["/api/services/all"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/services"] });
      if (failed.length === 0) {
        toast({ title: "Standardpreise aktualisiert", description: `${okCount} Dienstleistung(en) angepasst.` });
        setBulkOpen(false);
      } else {
        toast({
          title: "Teilweise gespeichert",
          description: `${okCount} aktualisiert, fehlgeschlagen: ${failed.join(", ")}`,
          variant: "destructive",
        });
      }
    } finally {
      setBulkSaving(false);
    }
  };

  const openCreate = () => {
    setEditingService(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (service: ServiceWithPots) => {
    setEditingService(service);
    setForm({
      name: service.name,
      code: service.code || "",
      description: service.description || "",
      unitType: service.unitType,
      defaultPriceCents: formatPrice(service.defaultPriceCents),
      vatRate: String(service.vatRate),
      minDurationMinutes: service.minDurationMinutes ? String(service.minDurationMinutes) : "",
      isBillable: service.isBillable,
      employeeRateCents: service.employeeRateCents ? formatPrice(service.employeeRateCents) : "",
      lohnartKategorie: service.lohnartKategorie || "hauswirtschaft",
      budgetPots: service.budgetPots || [],
      isDefault: service.isDefault ?? false,
      isActive: service.isActive,
      sortOrder: String(service.sortOrder),
    });
    setDialogOpen(true);
  };

  const handleChange = (field: keyof ServiceFormData, value: string | boolean | string[]) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const toggleBudgetPot = (pot: string) => {
    setForm((prev) => ({
      ...prev,
      budgetPots: prev.budgetPots.includes(pot)
        ? prev.budgetPots.filter(p => p !== pot)
        : [...prev.budgetPots, pot],
    }));
  };

  const handleSave = () => {
    if (!form.name.trim()) {
      toast({ title: "Name ist erforderlich", variant: "destructive" });
      return;
    }

    const priceValue = form.isBillable ? parseFloat(form.defaultPriceCents.replace(",", ".")) : 0;
    if (form.isBillable && (isNaN(priceValue) || priceValue < 0)) {
      toast({ title: "Ungültiger Preis", variant: "destructive" });
      return;
    }

    const vatValue = form.isBillable ? parseInt(form.vatRate, 10) : 0;
    if (form.isBillable && (isNaN(vatValue) || vatValue < 0 || vatValue > 100)) {
      toast({ title: "Ungültiger MwSt-Satz", variant: "destructive" });
      return;
    }

    const employeeRateValue = form.employeeRateCents ? parseFloat(form.employeeRateCents.replace(",", ".")) : 0;
    if (isNaN(employeeRateValue) || employeeRateValue < 0) {
      toast({ title: "Ungültiger Vergütungssatz", variant: "destructive" });
      return;
    }

    const priceCents = Math.round(priceValue * 100);
    const employeeRateCents = Math.round(employeeRateValue * 100);
    const minDuration = form.minDurationMinutes ? parseInt(form.minDurationMinutes, 10) : null;

    const payload: InsertService = {
      name: form.name.trim(),
      code: form.code.trim() || undefined,
      description: form.description.trim() || null,
      unitType: form.unitType as "hours" | "kilometers" | "flat",
      defaultPriceCents: priceCents,
      vatRate: vatValue,
      minDurationMinutes: form.unitType === "hours" && minDuration && minDuration > 0 ? minDuration : null,
      isBillable: form.isBillable,
      employeeRateCents,
      lohnartKategorie: form.lohnartKategorie as "alltagsbegleitung" | "hauswirtschaft",
      budgetPots: form.isBillable ? form.budgetPots as ("entlastungsbetrag_45b" | "umwandlung_45a" | "ersatzpflege_39_42a")[] : [],
      isDefault: form.isDefault,
      isActive: form.isActive,
      sortOrder: parseInt(form.sortOrder, 10) || 0,
    };

    if (editingService) {
      updateMutation.mutate(
        { id: editingService.id, data: payload },
        {
          onSuccess: () => {
            toast({ title: "Dienstleistung aktualisiert" });
            setDialogOpen(false);
          },
          onError: (error: Error) => {
            toast({ title: "Fehler", description: error.message, variant: "destructive" });
          },
        }
      );
    } else {
      createMutation.mutate(payload, {
        onSuccess: () => {
          toast({ title: "Dienstleistung angelegt" });
          setDialogOpen(false);
        },
        onError: (error: Error) => {
          toast({ title: "Fehler", description: error.message, variant: "destructive" });
        },
      });
    }
  };

  const isSaving = createMutation.isPending || updateMutation.isPending;

  const hasServiceChanges = useMemo(() => {
    if (!editingService) return true;
    if (form.name !== editingService.name) return true;
    if (form.code !== (editingService.code || "")) return true;
    if (form.description !== (editingService.description || "")) return true;
    if (form.unitType !== editingService.unitType) return true;
    if (form.isBillable !== editingService.isBillable) return true;
    if (form.defaultPriceCents !== formatPrice(editingService.defaultPriceCents)) return true;
    if (form.vatRate !== String(editingService.vatRate)) return true;
    const initialMinDuration = editingService.minDurationMinutes ? String(editingService.minDurationMinutes) : "";
    if (form.minDurationMinutes !== initialMinDuration) return true;
    const initialEmployeeRate = editingService.employeeRateCents ? formatPrice(editingService.employeeRateCents) : "";
    if (form.employeeRateCents !== initialEmployeeRate) return true;
    if (form.lohnartKategorie !== (editingService.lohnartKategorie || "hauswirtschaft")) return true;
    if (form.isDefault !== (editingService.isDefault ?? false)) return true;
    if (form.isActive !== editingService.isActive) return true;
    if (form.sortOrder !== String(editingService.sortOrder)) return true;
    const initialPots = [...(editingService.budgetPots || [])].sort();
    const currentPots = [...form.budgetPots].sort();
    if (initialPots.length !== currentPots.length) return true;
    if (initialPots.some((p, i) => p !== currentPots[i])) return true;
    return false;
  }, [editingService, form]);

  const hasBulkChanges = useMemo(() => {
    if (!services) return false;
    return services
      .filter(s => s.isBillable && s.isActive)
      .some(s => {
        const raw = bulkPrices[s.id];
        if (raw === undefined || raw === "") return false;
        const euros = parseFloat(raw.replace(",", "."));
        if (isNaN(euros) || euros < 0) return false;
        return Math.round(euros * 100) !== s.defaultPriceCents;
      });
  }, [services, bulkPrices]);

  return (
    <Layout variant="admin">
      <div className="space-y-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link href="/admin">
              <Button variant="ghost" size="icon" className="shrink-0" aria-label="Zurück" data-testid="button-back">
                <ArrowLeft className={iconSize.md} />
              </Button>
            </Link>
            <h1 className={componentStyles.pageTitle}>Dienstleistungskatalog</h1>
          </div>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-sm text-gray-600">Leistungen und Standardpreise</p>
            <div className="flex items-center gap-2">
              <Button
                onClick={openBulkPrices}
                variant="outline"
                size="sm"
                disabled={!services || services.length === 0}
                data-testid="button-bulk-prices"
              >
                <Calculator className={`${iconSize.sm} mr-1`} />
                Preise anpassen
              </Button>
              <Button onClick={openCreate} className={componentStyles.btnPrimary} size="sm" data-testid="button-add-service">
                <Plus className={`${iconSize.sm} mr-1`} />
                Neue Dienstleistung
              </Button>
            </div>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
          </div>
        ) : !services?.length ? (
          <Card>
            <CardContent className="py-12 text-center">
              <ClipboardList className="h-12 w-12 mx-auto mb-4 text-gray-300" />
              <p className="text-gray-500 mb-4">Noch keine Dienstleistungen angelegt</p>
              <Button onClick={openCreate} className={componentStyles.btnPrimary} data-testid="button-add-first-service">
                <Plus className={`${iconSize.sm} mr-1`} />
                Dienstleistung hinzufügen
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="flex flex-col gap-3">
            {services.map((service) => {
              const suffix = UNIT_SUFFIX[service.unitType] || "";
              return (
                <Card
                  key={service.id}
                  className={`cursor-pointer border ${!service.isActive ? "opacity-60" : ""}`}
                  onClick={() => openEdit(service)}
                  data-testid={`card-service-${service.id}`}
                >
                  <CardContent className="py-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-medium text-gray-900 truncate" data-testid={`text-service-name-${service.id}`}>{service.name}</span>
                          {service.isSystem && (
                            <StatusBadge type="system" value="system" size="sm" data-testid={`badge-system-${service.id}`} />
                          )}
                          {service.isDefault && (
                            <StatusBadge type="system" value="default" size="sm" data-testid={`badge-default-${service.id}`} />
                          )}
                          <StatusBadge type="billable" value={service.isBillable ? "billable" : "not-billable"} size="sm" data-testid={`badge-billable-${service.id}`} />
                          {!service.isSystem && (
                            <StatusBadge type="activity" value={service.isActive ? "active" : "inactive"} size="sm" data-testid={`badge-active-${service.id}`} />
                          )}
                        </div>
                        <div className="text-sm text-gray-500 space-y-0.5">
                          <div className="flex items-center gap-2">
                            <span data-testid={`text-unit-type-${service.id}`}>{UNIT_TYPE_LABELS[service.unitType] || service.unitType}</span>
                            {service.isBillable && (
                              <>
                                <span className="text-gray-300">·</span>
                                <span data-testid={`text-price-${service.id}`}>{formatPrice(service.defaultPriceCents)} €{suffix}</span>
                                <span className="text-gray-300">·</span>
                                <span data-testid={`text-vat-${service.id}`}>{service.vatRate}% MwSt</span>
                              </>
                            )}
                          </div>
                          {service.employeeRateCents > 0 && (
                            <div data-testid={`text-employee-rate-${service.id}`}>
                              Vergütung: {formatCurrency(service.employeeRateCents)}{suffix}
                            </div>
                          )}
                        </div>
                        {service.description && (
                          <p className="text-xs text-gray-500 mt-1 truncate" data-testid={`text-description-${service.id}`}>{service.description}</p>
                        )}
                      </div>
                      <Pencil className={`${iconSize.sm} text-gray-500 shrink-0`} />
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingService ? "Dienstleistung bearbeiten" : "Neue Dienstleistung hinzufügen"}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 mt-2">
            {editingService?.isSystem && (
              <div className="bg-purple-50 border border-purple-200 rounded-lg px-3 py-2 text-sm text-purple-700" data-testid="info-system-service">
                System-Service: Name, Code, Einheit und Status können nicht geändert werden.
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                className="text-base"
                value={form.name}
                onChange={(e) => handleChange("name", e.target.value)}
                placeholder="z. B. Hauswirtschaftliche Versorgung"
                disabled={editingService?.isSystem}
                data-testid="input-service-name"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="unitType">Einheit</Label>
              <Select
                value={form.unitType}
                onValueChange={(value) => handleChange("unitType", value)}
                disabled={editingService?.isSystem}
              >
                <SelectTrigger className="text-base" data-testid="select-unit-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SERVICE_UNIT_TYPES.map((type) => (
                    <SelectItem key={type} value={type} data-testid={`select-unit-type-option-${type}`}>
                      {UNIT_TYPE_LABELS[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-3 py-2">
              <Switch
                id="isBillable"
                checked={form.isBillable}
                onCheckedChange={(checked) => handleChange("isBillable", checked)}
                data-testid="switch-is-billable"
              />
              <Label htmlFor="isBillable" className="cursor-pointer">
                Abrechenbar (wird dem Kunden berechnet)
              </Label>
            </div>

            {form.isBillable && (
              <div className="space-y-2">
                <Label htmlFor="defaultPriceCents">Standardpreis (€)</Label>
                <Input
                  id="defaultPriceCents"
                  className="text-base"
                  type="text"
                  inputMode="decimal"
                  value={form.defaultPriceCents}
                  onChange={(e) => handleChange("defaultPriceCents", e.target.value)}
                  placeholder="0,00"
                  data-testid="input-service-price"
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="employeeRateCents">Mitarbeiter-Vergütung (€)</Label>
                <Input
                  id="employeeRateCents"
                  className="text-base"
                  type="text"
                  inputMode="decimal"
                  value={form.employeeRateCents}
                  onChange={(e) => handleChange("employeeRateCents", e.target.value)}
                  placeholder="0,00"
                  data-testid="input-service-employee-rate"
                />
                <p className="text-xs text-gray-500">Vergütung pro Einheit</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="lohnartKategorie">Lohnart-Kategorie</Label>
                <Select value={form.lohnartKategorie} onValueChange={(v) => handleChange("lohnartKategorie", v)}>
                  <SelectTrigger id="lohnartKategorie" data-testid="select-lohnart-kategorie">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(LOHNART_LABELS).map(([key, label]) => (
                      <SelectItem key={key} value={key}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-gray-500">Für Lexware-Lohnexport</p>
              </div>
            </div>

            {form.isBillable && (
              <div className="space-y-2">
                <Label htmlFor="vatRate">MwSt-Satz (%)</Label>
                <Input
                  id="vatRate"
                  className="text-base"
                  type="number"
                  inputMode="numeric"
                  value={form.vatRate}
                  onChange={(e) => handleChange("vatRate", e.target.value)}
                  placeholder="19"
                  data-testid="input-service-vat"
                />
              </div>
            )}

            {form.isBillable && (
              <div className="space-y-2">
                <Label>Budget-Töpfe</Label>
                <div className="space-y-2">
                  {BUDGET_TYPES.map((pot) => (
                    <div key={pot} className="flex items-center gap-2">
                      <Checkbox
                        id={`pot-${pot}`}
                        checked={form.budgetPots.includes(pot)}
                        onCheckedChange={() => toggleBudgetPot(pot)}
                        data-testid={`checkbox-budget-pot-${pot}`}
                      />
                      <Label htmlFor={`pot-${pot}`} className="cursor-pointer text-sm font-normal">
                        {BUDGET_TYPE_LABELS[pot]}
                      </Label>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-gray-500">Über welche Budget-Töpfe kann diese Leistung abgerechnet werden?</p>
              </div>
            )}

            {form.unitType === "hours" && (
              <div className="space-y-2">
                <Label htmlFor="minDurationMinutes">Mindesteinsatz in Minuten</Label>
                <Input
                  id="minDurationMinutes"
                  className="text-base"
                  type="number"
                  inputMode="numeric"
                  value={form.minDurationMinutes}
                  onChange={(e) => handleChange("minDurationMinutes", e.target.value)}
                  placeholder="z. B. 60"
                  data-testid="input-service-min-duration"
                />
              </div>
            )}


            {!editingService?.isSystem && (
              <div className="flex items-center gap-3 py-2">
                <Switch
                  id="isDefault"
                  checked={form.isDefault}
                  onCheckedChange={(checked) => handleChange("isDefault", checked)}
                  data-testid="switch-is-default"
                />
                <Label htmlFor="isDefault" className="cursor-pointer">
                  Standard bei Terminanlage
                </Label>
              </div>
            )}

            {!editingService?.isSystem && (
              <div className="flex items-center gap-3 py-2">
                <Switch
                  id="isActive"
                  checked={form.isActive}
                  onCheckedChange={(checked) => handleChange("isActive", checked)}
                  data-testid="switch-is-active"
                />
                <Label htmlFor="isActive" className="cursor-pointer">
                  Dienstleistung aktiv
                </Label>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-4 border-t">
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialogOpen(false)}
                data-testid="button-cancel"
              >
                Abbrechen
              </Button>
              <Button
                type="button"
                className={componentStyles.btnPrimary}
                onClick={handleSave}
                disabled={isSaving || !hasServiceChanges}
                title={!isSaving && !hasServiceChanges ? "Keine Änderungen zu speichern" : undefined}
                data-testid="button-save-service"
              >
                {isSaving ? (
                  <>
                    <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                    Speichern...
                  </>
                ) : editingService ? (
                  "Änderungen speichern"
                ) : (
                  "Dienstleistung hinzufügen"
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkOpen} onOpenChange={(open) => { if (!bulkSaving) setBulkOpen(open); }}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto" data-testid="dialog-bulk-prices">
          <DialogHeader>
            <DialogTitle>Standardpreise anpassen</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 mt-2">
            <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-sm text-blue-700">
              Hier passen Sie die Standardpreise des Katalogs an. Sie gelten automatisch für alle Kunden ohne individuellen Preis. Kundenindividuelle Preise bleiben unverändert.
            </div>

            <div className="space-y-2 border rounded-lg p-3">
              <Label htmlFor="bulk-percent">Pauschale prozentuale Anpassung</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="bulk-percent"
                  type="text"
                  inputMode="decimal"
                  value={bulkPercent}
                  onChange={(e) => setBulkPercent(e.target.value)}
                  placeholder="z. B. 5 für +5 %"
                  className="text-base"
                  data-testid="input-bulk-percent"
                />
                <span className="text-sm text-gray-500">%</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={applyBulkPercent}
                  disabled={!bulkPercent}
                  data-testid="button-apply-bulk-percent"
                >
                  Anwenden
                </Button>
              </div>
              <p className="text-xs text-gray-500">
                Berechnet aus den aktuellen Werten und überschreibt die Eingabefelder unten. Negative Werte (z. B. -10) für Senkungen.
              </p>
            </div>

            <div className="border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-gray-500">Dienstleistung</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-500">Aktuell</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-500">Neu (€)</th>
                  </tr>
                </thead>
                <tbody>
                  {(services || [])
                    .filter(s => s.isBillable && s.isActive)
                    .map((s) => {
                      const suffix = UNIT_SUFFIX[s.unitType] || "";
                      return (
                        <tr key={s.id} className="border-t" data-testid={`bulk-row-${s.id}`}>
                          <td className="px-3 py-2">
                            <div className="font-medium">{s.name}</div>
                            <div className="text-xs text-gray-500">{UNIT_TYPE_LABELS[s.unitType] || s.unitType}{suffix}</div>
                          </td>
                          <td className="px-3 py-2 text-right text-gray-600 whitespace-nowrap">
                            {formatPrice(s.defaultPriceCents)} €
                          </td>
                          <td className="px-3 py-2 text-right">
                            <Input
                              type="text"
                              inputMode="decimal"
                              value={bulkPrices[s.id] ?? ""}
                              onChange={(e) => setBulkPrices(prev => ({ ...prev, [s.id]: e.target.value }))}
                              className="h-8 text-sm text-right w-24 ml-auto"
                              placeholder="0,00"
                              data-testid={`input-bulk-price-${s.id}`}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  {(services || []).filter(s => s.isBillable && s.isActive).length === 0 && (
                    <tr>
                      <td colSpan={3} className="px-3 py-4 text-center text-sm text-gray-500">
                        Keine abrechenbaren Dienstleistungen vorhanden.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <p className="text-xs text-gray-500">
              Es werden nur veränderte Preise gespeichert. Die Anpassung wirkt sich auf zukünftige Abrechnungen aus.
            </p>

            <div className="flex justify-end gap-2 pt-4 border-t">
              <Button
                type="button"
                variant="outline"
                onClick={() => setBulkOpen(false)}
                disabled={bulkSaving}
                data-testid="button-cancel-bulk"
              >
                Abbrechen
              </Button>
              <Button
                type="button"
                className={componentStyles.btnPrimary}
                onClick={handleBulkSave}
                disabled={bulkSaving || !hasBulkChanges}
                title={!bulkSaving && !hasBulkChanges ? "Keine Änderungen zu speichern" : undefined}
                data-testid="button-save-bulk"
              >
                {bulkSaving ? (
                  <>
                    <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                    Speichern...
                  </>
                ) : (
                  "Änderungen speichern"
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Layout>
  );
}
