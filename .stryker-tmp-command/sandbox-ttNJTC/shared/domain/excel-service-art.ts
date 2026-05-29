/**
 * Task #708 — Zentrales Mapping der Excel-Spalte "Art" auf die interne
 * Service-Kategorie.
 *
 * Vor dieser Vereinheitlichung verstreuten sich `serviceType.toLowerCase() === "hauswirtschaft"`
 * Vergleiche über `server/services/appointment-import.ts` und
 * `server/scripts/reconcile-import-from-excel.ts`. Jede Schreibvariante
 * ("Hauswirtschaft", "hauswirtschaft", " HW ") musste an mehreren Stellen
 * gepflegt werden — Drift zwischen Preview-, Update- und Reconcile-Pfad
 * war eine offene Flanke.
 *
 * Diese Datei ist die einzige autorisierte Stelle, an der Excel-„Art" in
 * eine `lohnart_kategorie` übersetzt wird. Erweiterungen (z.B. „AB",
 * „HW", Synonyme) gehören hier hin, nicht in Aufrufer.
 */
// @ts-nocheck


export type ServiceCategory = "hauswirtschaft" | "alltagsbegleitung";

const ART_TO_CATEGORY: Record<string, ServiceCategory> = {
  hauswirtschaft: "hauswirtschaft",
  hw: "hauswirtschaft",
  alltagsbegleitung: "alltagsbegleitung",
  ab: "alltagsbegleitung",
};

function normalize(art: string): string {
  return art.trim().toLowerCase();
}

export function excelServiceArtToCategory(art: string | null | undefined): ServiceCategory | null {
  if (!art) return null;
  return ART_TO_CATEGORY[normalize(art)] ?? null;
}

export function isHauswirtschaftArt(art: string | null | undefined): boolean {
  return excelServiceArtToCategory(art) === "hauswirtschaft";
}

export function isAlltagsbegleitungArt(art: string | null | undefined): boolean {
  return excelServiceArtToCategory(art) === "alltagsbegleitung";
}
