import { useEffect, useMemo, useState } from "react";

// Standard-Zeilen-Cap für lange Detail-Listen auf der Abrechnungsseite. Begrenzt
// NUR die Darstellung — alle Summen/Aggregate werden weiterhin über die
// vollständige Datenmenge gebildet (der Aufrufer berechnet Totals separat).
export const DEFAULT_ROW_CAP = 12;

// Clientseitiger „erst N Zeilen, dann alle anzeigen"-Helfer. Keine
// Server-Pagination — arbeitet auf bereits geladenen Daten. Schaltet beim
// Schrumpfen der Liste unter den Cap automatisch in die kompakte Sicht zurück.
export function useRowCap<T>(rows: T[], cap: number = DEFAULT_ROW_CAP) {
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (rows.length <= cap) setShowAll(false);
  }, [rows.length, cap]);

  const visible = useMemo(
    () => (showAll ? rows : rows.slice(0, cap)),
    [rows, showAll, cap],
  );

  const hiddenCount = rows.length - visible.length;
  const capped = rows.length > cap;

  return { visible, showAll, setShowAll, hiddenCount, capped, total: rows.length };
}
