import { useCallback, useState } from "react";

/**
 * Task #1888 — Gemeinsame Mehrfachauswahl-Hülle (#1376) als wiederverwendbarer
 * Hook. Kapselt die reine Auswahl-State-Logik (Set von numerischen IDs +
 * toggle/toggleMany/setAll/clear/has), damit die Rechnungs-Liste UND die
 * Erstellungs-Liste dieselbe „Alle auswählen"/Cluster-/Zeilenauswahl teilen, ohne
 * die Logik zu duplizieren. Die WELCHE-IDs-Frage (was „Alle auswählen" umfasst)
 * bleibt bei der jeweiligen Liste — sie unterscheiden sich (Rechnungen ohne Storno
 * vs. nur erstellbare Kunden) und dürfen ihr Datenmodell nicht vereinheitlichen.
 */
export interface Selection {
  selectedIds: Set<number>;
  /** Eine einzelne ID an-/abwählen. */
  toggle: (id: number, checked: boolean) => void;
  /** Eine Menge von IDs gemeinsam an-/abwählen (Cluster/Gruppe). */
  toggleMany: (ids: number[], checked: boolean) => void;
  /** Die Auswahl exakt auf diese IDs setzen (z. B. „Alle auswählen"). */
  setAll: (ids: number[]) => void;
  /** Auswahl leeren. */
  clear: () => void;
  /** Ist die ID ausgewählt? */
  has: (id: number) => boolean;
}

export function useSelection(): Selection {
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const toggle = useCallback((id: number, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const toggleMany = useCallback((ids: number[], checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const setAll = useCallback((ids: number[]) => setSelectedIds(new Set(ids)), []);
  const clear = useCallback(() => setSelectedIds(new Set()), []);
  const has = useCallback((id: number) => selectedIds.has(id), [selectedIds]);

  return { selectedIds, toggle, toggleMany, setAll, clear, has };
}
