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
import { api, unwrapResult } from "@/lib/api";
import { ArrowLeft, Plus, Pencil, Loader2, ClipboardList } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { iconSize, componentStyles } from "@/design-system";
import type { Service, InsertService } from "@shared/schema";
import { SERVICE_UNIT_TYPES } from "@shared/schema";

const UNIT_TYPE_LABELS: Record<string, string> = {
  hours: "Stunden",
  kilometers: "Kilometer",
  flat: "Pauschale",
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
  isActive: boolean;
}

const EMPTY_FORM: ServiceFormData = {
  name: "",
  description: "",
  unitType: "hours",
  defaultPriceCents: "",
  vatRate: "19",
  minDurationMinutes: "",
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
      <div className="min-h-screen bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]">
        <div className="container mx-auto px-4 py-6 max-w-4xl">
          <div className="flex items-center gap-4 mb-6">
            <Link href="/admin">
              <Button variant="ghost" size="icon" data-testid="button-back">
                <ArrowLeft className={iconSize.md} />
              </Button>
            </Link>
            <div className="flex-1">
              <h1 className="text-2xl font-bold text-gray-900">Dienstleistungskatalog</h1>
              <p className="text-gray-600">Leistungen und Standardpreise verwalten</p>
            </div>
            <Button onClick={openCreate} className={componentStyles.btnPrimary} data-testid="button-add-service">
              <Plus className={`${iconSize.sm} mr-1`} />
              Neue Dienstleistung
            </Button>
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
                          {!service.isActive && (
                            <span className="text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full" data-testid={`badge-inactive-${service.id}`}>Inaktiv</span>
                          )}
                          {service.isActive && (
                            <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full" data-testid={`badge-active-${service.id}`}>Aktiv</span>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-500">
                          <span data-testid={`text-unit-type-${service.id}`}>{UNIT_TYPE_LABELS[service.unitType] || service.unitType}</span>
                          <span data-testid={`text-price-${service.id}`}>· {formatPrice(service.defaultPriceCents)} €</span>
                          <span data-testid={`text-vat-${service.id}`}>· {service.vatRate}% MwSt</span>
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
      </div>

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
