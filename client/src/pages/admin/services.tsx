import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
import { Badge } from "@/components/ui/badge";
import { DatePicker } from "@/components/ui/date-picker";
import { api, unwrapResult } from "@/lib/api";
import { ArrowLeft, Plus, Pencil, Loader2, ClipboardList, Users, Check, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { iconSize, componentStyles } from "@/design-system";
import { formatCurrency } from "@shared/utils/format";
import { todayISO } from "@shared/utils/datetime";
import type { Service, InsertService } from "@shared/schema";
import { SERVICE_UNIT_TYPES, SERVICE_BILLING_CATEGORIES } from "@shared/schema";

const UNIT_TYPE_LABELS: Record<string, string> = {
  hours: "Stunden",
  kilometers: "Kilometer",
  flat: "Pauschale",
};

const BILLING_CATEGORY_LABELS: Record<string, string> = {
  hauswirtschaft: "Hauswirtschaft",
  alltagsbegleitung: "Alltagsbegleitung",
  none: "Nicht budgetrelevant",
};

function formatPrice(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

interface ServiceFormData {
  name: string;
  description: string;
  unitType: string;
  defaultPriceCents: string;
  vatRate: string;
  minDurationMinutes: string;
  billingCategory: string;
  isDefault: boolean;
  isActive: boolean;
}

const EMPTY_FORM: ServiceFormData = {
  name: "",
  description: "",
  unitType: "hours",
  defaultPriceCents: "",
  vatRate: "19",
  minDurationMinutes: "",
  billingCategory: "none",
  isDefault: false,
  isActive: true,
};

export default function AdminServices() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: services, isLoading } = useQuery<Service[]>({
    queryKey: ["/api/services/all"],
    queryFn: async () => {
      const result = await api.get<Service[]>("/services/all");
      return unwrapResult(result);
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: InsertService) => {
      const result = await api.post<Service, InsertService>("/services", data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/services/all"] });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<InsertService> }) => {
      const result = await api.put<Service, Partial<InsertService>>(`/services/${id}`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/services/all"] });
    },
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingService, setEditingService] = useState<Service | null>(null);
  const [form, setForm] = useState<ServiceFormData>(EMPTY_FORM);

  const openCreate = () => {
    setEditingService(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (service: Service) => {
    setEditingService(service);
    setForm({
      name: service.name,
      description: service.description || "",
      unitType: service.unitType,
      defaultPriceCents: formatPrice(service.defaultPriceCents),
      vatRate: String(service.vatRate),
      minDurationMinutes: service.minDurationMinutes ? String(service.minDurationMinutes) : "",
      billingCategory: service.billingCategory || "none",
      isDefault: service.isDefault ?? false,
      isActive: service.isActive,
    });
    setDialogOpen(true);
  };

  const handleChange = (field: keyof ServiceFormData, value: string | boolean) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSave = () => {
    if (!form.name.trim()) {
      toast({ title: "Name ist erforderlich", variant: "destructive" });
      return;
    }

    const priceValue = parseFloat(form.defaultPriceCents.replace(",", "."));
    if (isNaN(priceValue) || priceValue < 0) {
      toast({ title: "Ungültiger Preis", variant: "destructive" });
      return;
    }

    const vatValue = parseInt(form.vatRate, 10);
    if (isNaN(vatValue) || vatValue < 0 || vatValue > 100) {
      toast({ title: "Ungültiger MwSt-Satz", variant: "destructive" });
      return;
    }

    const priceCents = Math.round(priceValue * 100);
    const minDuration = form.minDurationMinutes ? parseInt(form.minDurationMinutes, 10) : null;

    const payload: InsertService = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      unitType: form.unitType as any,
      defaultPriceCents: priceCents,
      vatRate: vatValue,
      minDurationMinutes: form.unitType === "hours" && minDuration && minDuration > 0 ? minDuration : null,
      billingCategory: form.billingCategory as any,
      isDefault: form.isDefault,
      isActive: form.isActive,
      sortOrder: editingService?.sortOrder ?? 0,
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
    <Layout>
      <div className="space-y-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link href="/admin">
              <Button variant="ghost" size="icon" className="shrink-0" data-testid="button-back">
                <ArrowLeft className={iconSize.md} />
              </Button>
            </Link>
            <h1 className="text-xl font-bold text-gray-900">Dienstleistungskatalog</h1>
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
            {services.map((service) => (
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
                        {service.isDefault && (
                          <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full shrink-0" data-testid={`badge-default-${service.id}`}>Standard</span>
                        )}
                        {service.isActive ? (
                          <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full shrink-0" data-testid={`badge-active-${service.id}`}>Aktiv</span>
                        ) : (
                          <span className="text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full shrink-0" data-testid={`badge-inactive-${service.id}`}>Inaktiv</span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-500">
                        <span data-testid={`text-unit-type-${service.id}`}>{UNIT_TYPE_LABELS[service.unitType] || service.unitType}</span>
                        <span data-testid={`text-price-${service.id}`}>· {formatPrice(service.defaultPriceCents)} €</span>
                        <span data-testid={`text-vat-${service.id}`}>· {service.vatRate}% MwSt</span>
                        <span data-testid={`text-billing-category-${service.id}`}>· {BILLING_CATEGORY_LABELS[service.billingCategory] || service.billingCategory}</span>
                      </div>
                      {service.description && (
                        <p className="text-xs text-gray-400 mt-1 truncate" data-testid={`text-description-${service.id}`}>{service.description}</p>
                      )}
                    </div>
                    <Pencil className={`${iconSize.sm} text-gray-400 shrink-0`} />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <EmployeeRatesSection services={services || []} />

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingService ? "Dienstleistung bearbeiten" : "Neue Dienstleistung hinzufügen"}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 mt-2">
            <div className="space-y-2">
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                className="text-base"
                value={form.name}
                onChange={(e) => handleChange("name", e.target.value)}
                placeholder="z. B. Hauswirtschaftliche Versorgung"
                data-testid="input-service-name"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Beschreibung</Label>
              <Input
                id="description"
                className="text-base"
                value={form.description}
                onChange={(e) => handleChange("description", e.target.value)}
                placeholder="Optionale Beschreibung"
                data-testid="input-service-description"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="unitType">Einheit</Label>
              <Select
                value={form.unitType}
                onValueChange={(value) => handleChange("unitType", value)}
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

            <div className="space-y-2">
              <Label htmlFor="billingCategory">Abrechnungskategorie</Label>
              <Select
                value={form.billingCategory}
                onValueChange={(value) => handleChange("billingCategory", value)}
              >
                <SelectTrigger className="text-base" data-testid="select-billing-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SERVICE_BILLING_CATEGORIES.map((cat) => (
                    <SelectItem key={cat} value={cat} data-testid={`select-billing-category-option-${cat}`}>
                      {BILLING_CATEGORY_LABELS[cat]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-gray-500">Bestimmt, über welchen Budget-Topf die Leistung abgerechnet wird</p>
            </div>

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

interface EmployeeRate {
  id: number;
  serviceId: number;
  rateCents: number;
  validFrom: string;
  validTo: string | null;
  service: Service;
}

const UNIT_SUFFIX: Record<string, string> = {
  hours: "/Std.",
  kilometers: "/km",
  flat: " pauschal",
};

function EmployeeRatesSection({ services }: { services: Service[] }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editingServiceId, setEditingServiceId] = useState<number | null>(null);
  const [editRate, setEditRate] = useState("");
  const [editValidFrom, setEditValidFrom] = useState(todayISO());

  const { data: currentRates, isLoading } = useQuery<EmployeeRate[]>({
    queryKey: ["employee-service-rates"],
    queryFn: async () => {
      const result = await api.get<EmployeeRate[]>("/services/employee-rates");
      return unwrapResult(result);
    },
    staleTime: 60000,
  });

  const saveMutation = useMutation({
    mutationFn: async (data: { serviceId: number; rateCents: number; validFrom: string }) => {
      return unwrapResult(await api.post("/services/employee-rates", data));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["employee-service-rates"] });
      setEditingServiceId(null);
      setEditRate("");
      setEditValidFrom(todayISO());
      toast({ title: "Vergütungssatz gespeichert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleSave = (serviceId: number) => {
    const cents = Math.round(parseFloat(editRate.replace(",", ".")) * 100);
    if (isNaN(cents) || cents < 0) {
      toast({ title: "Bitte gültigen Betrag eingeben", variant: "destructive" });
      return;
    }
    saveMutation.mutate({ serviceId, rateCents: cents, validFrom: editValidFrom });
  };

  const startEdit = (serviceId: number, currentCents?: number) => {
    setEditingServiceId(serviceId);
    setEditRate(currentCents !== undefined ? (currentCents / 100).toFixed(2) : "");
    setEditValidFrom(todayISO());
  };

  const rateMap = new Map<number, EmployeeRate>();
  currentRates?.forEach(r => rateMap.set(r.serviceId, r));

  const activeServices = services.filter(s => s.isActive);

  return (
    <div className="mt-8" data-testid="employee-rates-section">
      <div className="flex items-center gap-2 mb-3">
        <Users className={iconSize.sm} />
        <h2 className="text-lg font-bold text-gray-900">Mitarbeiter-Vergütungssätze</h2>
      </div>
      <p className="text-sm text-gray-600 mb-4">
        Interne Vergütung pro Dienstleistung (was Mitarbeiter erhalten)
      </p>

      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-teal-600" />
        </div>
      ) : activeServices.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-4">Keine aktiven Dienstleistungen</p>
      ) : (
        <Card>
          <CardContent className="py-2 px-0">
            <div className="divide-y">
              {activeServices.map((service) => {
                const rate = rateMap.get(service.id);
                const isEditing = editingServiceId === service.id;
                const suffix = UNIT_SUFFIX[service.unitType] || "";

                return (
                  <div key={service.id} className="px-4" data-testid={`employee-rate-row-${service.id}`}>
                    <div className="flex items-center justify-between py-3">
                      <div className="min-w-0">
                        <span className="text-sm font-medium">{service.name}</span>
                        <div className="text-xs text-gray-500">
                          Kundenpreis: {formatCurrency(service.defaultPriceCents)}{suffix}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {rate ? (
                          <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200 font-semibold" data-testid={`text-employee-rate-${service.id}`}>
                            {formatCurrency(rate.rateCents)}{suffix}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="bg-gray-50 text-gray-400 border-gray-200" data-testid={`text-employee-rate-${service.id}`}>
                            Nicht festgelegt
                          </Badge>
                        )}
                        <button
                          type="button"
                          onClick={() => startEdit(service.id, rate?.rateCents)}
                          className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded text-gray-400 hover:text-gray-700"
                          data-testid={`btn-edit-employee-rate-${service.id}`}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>

                    {isEditing && (
                      <div className="pb-3">
                        <div className="p-3 bg-gray-50 rounded-lg space-y-3">
                          <div className="space-y-1">
                            <Label className="text-xs">Vergütung (€{suffix})</Label>
                            <Input
                              type="text"
                              inputMode="decimal"
                              value={editRate}
                              onChange={(e) => setEditRate(e.target.value)}
                              className="h-8 text-base"
                              autoFocus
                              data-testid={`input-employee-rate-${service.id}`}
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Gültig ab</Label>
                            <DatePicker
                              value={editValidFrom || null}
                              onChange={(val) => setEditValidFrom(val || "")}
                              data-testid={`input-employee-rate-valid-from-${service.id}`}
                            />
                          </div>
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              onClick={() => handleSave(service.id)}
                              disabled={saveMutation.isPending}
                              data-testid={`btn-save-employee-rate-${service.id}`}
                            >
                              {saveMutation.isPending ? (
                                <Loader2 className={`${iconSize.sm} animate-spin`} />
                              ) : (
                                <><Check className={`${iconSize.sm} mr-1`} />Speichern</>
                              )}
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => setEditingServiceId(null)}>
                              <X className={`${iconSize.sm} mr-1`} />Abbrechen
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
