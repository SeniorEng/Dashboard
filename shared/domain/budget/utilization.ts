/**
 * Task #928 — Pure Budget-Ausnutzungs-Mathematik (SSoT).
 *
 * Die Anzeige der prozentualen Budget-Ausnutzung („genutzt / bewilligt")
 * wurde an mehreren UI-Stellen inline nachgebaut
 * (`Math.round((used / allocated) * 100)`, teils mit `Math.min(100, …)`-Deckel).
 * Diese Datei zieht GENAU diese Berechnung als reine, seiteneffektfreie SSoT
 * heraus, damit Fortschrittsbalken (gedeckelt) und KPI-Kacheln (ungedeckelt)
 * dieselbe Formel teilen und nicht auseinanderdriften.
 *
 * Keine DB-Zugriffe, keine State-Werte — alle Inputs werden explizit übergeben.
 */

/**
 * Prozentuale Budget-Ausnutzung (gerundet, ungedeckelt).
 * Gibt 0 zurück, wenn kein Budget bewilligt ist (`allocatedCents <= 0`),
 * sodass keine Division durch 0 entsteht.
 */
export function utilizationPercent(usedCents: number, allocatedCents: number): number {
  if (allocatedCents <= 0) return 0;
  return Math.round((usedCents / allocatedCents) * 100);
}

/**
 * Prozentuale Budget-Ausnutzung, auf 100 % gedeckelt — für Fortschrittsbalken,
 * deren Breite nie über 100 % laufen darf.
 */
export function clampedUtilizationPercent(usedCents: number, allocatedCents: number): number {
  return Math.min(100, utilizationPercent(usedCents, allocatedCents));
}
