/**
 * Pflegegrad-Historie — welcher Eintrag lebt wieder auf, wenn ein Folge-Eintrag
 * als Fehleintrag entfernt wird? (Ticket 6hcgffPJWm57p72p, RK-10; Entscheidung
 * Alrik 25.09.2026: ja, aber erst nach Bestätigung im Dialog.)
 *
 * EINE Funktion für Client (Dialogtext „PG 2 gilt dann wieder ab …") und
 * Server (Ausführung) — sonst könnte der Dialog etwas anderes ankündigen, als
 * der Server tut.
 *
 * Kandidat ist der nicht entfernte Eintrag, der GENAU am Vortag des entfernten
 * endet — so hinterlässt ihn `addCareLevelHistory`, wenn ein neuer Grad
 * angelegt wird. Nur dann ist klar, dass der entfernte Eintrag ihn abgelöst
 * hat. Er übernimmt das Ende des entfernten (offen, wenn dieser offen war).
 */
import { addDays } from "../utils/datetime";

export interface HistorienEintrag {
  id: number;
  pflegegrad: number;
  validFrom: string;
  validTo: string | null;
  entferntAm?: unknown;
}

export function vorgaengerZumWiederaufleben<T extends HistorienEintrag>(
  historie: readonly T[],
  entfernteId: number,
): { eintrag: T; giltWiederAb: string; neuesEnde: string | null } | null {
  const entfernt = historie.find((e) => e.id === entfernteId);
  if (!entfernt) return null;
  const vortag = addDays(entfernt.validFrom, -1);
  const kandidaten = historie.filter((e) => e.id !== entfernteId && !e.entferntAm && e.validTo === vortag);
  if (kandidaten.length !== 1) return null;
  return { eintrag: kandidaten[0], giltWiederAb: entfernt.validFrom, neuesEnde: entfernt.validTo };
}
