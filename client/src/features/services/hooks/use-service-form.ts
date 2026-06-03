import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { invalidateRelated } from "@/lib/query-invalidation";
import { api, unwrapResult } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import type { InsertService } from "@shared/schema";
import type { ServiceFormData, ServiceWithPots } from "../types";
import { EMPTY_FORM } from "../constants";
import { formatPrice } from "../utils";

export function useServiceForm() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: async (data: InsertService) => {
      const result = await api.post<ServiceWithPots, InsertService>("/services", data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "services");
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
      invalidateRelated(queryClient, "services");
      toast({ title: "Erfolg", description: "Leistung wurde aktualisiert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
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

  return {
    dialogOpen,
    setDialogOpen,
    editingService,
    form,
    openCreate,
    openEdit,
    handleChange,
    toggleBudgetPot,
    handleSave,
    isSaving,
    hasServiceChanges,
  };
}
