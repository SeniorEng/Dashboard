import { useState } from "react";
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
import { ArrowLeft, Plus, Pencil, Loader2, ClipboardList } from "lucide-react";
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
  budgetPots: [],
  isDefault: false,
  isActive: true,
  sortOrder: "0",
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
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<InsertService> }) => {
      const result = await api.put<ServiceWithPots, Partial<InsertService>>(`/services/${id}`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/services/all"] });
    },
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingService, setEditingService] = useState<ServiceWithPots | null>(null);
  const [form, setForm] = useState<ServiceFormData>(EMPTY_FORM);

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
      unitType: form.unitType as any,
      defaultPriceCents: priceCents,
      vatRate: vatValue,
      minDurationMinutes: form.unitType === "hours" && minDuration && minDuration > 0 ? minDuration : null,
      isBillable: form.isBillable,
      employeeRateCents,
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
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Dienstleistungskatalog</h1>
          </div>
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-600">Leistungen und Standardpreise</p>
            <Button onClick={openCreate} className={componentStyles.btnPrimary} size="sm" data-testid="button-add-service">
              <Plus className={`${iconSize.sm} mr-1`} />
              Neue Dienstleistung
            </Button>
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
                          <p className="text-xs text-gray-400 mt-1 truncate" data-testid={`text-description-${service.id}`}>{service.description}</p>
                        )}
                      </div>
                      <Pencil className={`${iconSize.sm} text-gray-400 shrink-0`} />
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
              <p className="text-xs text-gray-500">Interne Vergütung pro Einheit (was Mitarbeiter erhalten)</p>
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
                disabled={isSaving}
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
    </Layout>
  );
}
