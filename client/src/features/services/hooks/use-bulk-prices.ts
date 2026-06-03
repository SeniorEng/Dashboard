import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateRelated } from "@/lib/query-invalidation";
import { api } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { parseEuroDE } from "@shared/utils/money";
import type { InsertService } from "@shared/schema";
import type { ServiceWithPots } from "../types";
import { formatPrice } from "../utils";

export function useBulkPrices(services: ServiceWithPots[] | undefined) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

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
      const newCents = parseEuroDE(raw);
      if (newCents === null || newCents < 0) {
        toast({ title: `Ungültiger Preis für ${s.name}`, variant: "destructive" });
        return;
      }
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
      invalidateRelated(queryClient, "services");
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

  const hasBulkChanges = useMemo(() => {
    if (!services) return false;
    return services
      .filter(s => s.isBillable && s.isActive)
      .some(s => {
        const raw = bulkPrices[s.id];
        if (raw === undefined || raw === "") return false;
        const newCents = parseEuroDE(raw);
        if (newCents === null || newCents < 0) return false;
        return newCents !== s.defaultPriceCents;
      });
  }, [services, bulkPrices]);

  return {
    bulkOpen,
    setBulkOpen,
    bulkPrices,
    setBulkPrices,
    bulkPercent,
    setBulkPercent,
    bulkSaving,
    openBulkPrices,
    applyBulkPercent,
    handleBulkSave,
    hasBulkChanges,
  };
}
