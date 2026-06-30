/**
 * Task #1503 — `wageFor`-SSoT: die EINE Lohnsatz-Auflösung.
 *
 * Analog zu `priceFor` (Verkaufspreise) beantwortet diese reine Funktion die
 * Frage „Welcher Stundensatz gilt für einen Mitarbeiter mit Rolle X, Leistung Y
 * am Datum Z?". Heute beantworteten zwei parallele Quellen diese Frage ad-hoc
 * (flacher Katalogwert `services.employee_rate_cents` im Wirtschaftlichen
 * Überblick/Statistik vs. die schlafende `employee_compensation_history` im
 * Lexware-Export → 0 €). Diese Funktion ist die einzige Auflösungslogik; alle
 * Lese-/Schreibpfade importieren sie, statt eigene Lookups zu bauen.
 *
 * Auflösungsreihenfolge (zeitversioniert):
 *   1. Rollen-Satz   — eine VORHANDENE Zeile (Rolle × Leistung) gewinnt IMMER
 *                      über den Katalog-Default, auch bei `cents = 0`. Es zählt
 *                      die EXISTENZ der Zeile, nicht der Wert — KEIN 0/NULL-
 *                      Kurzschluss auf den Katalog.
 *   2. Katalog-Default — `services.employee_rate_cents` als unterster Fallback.
 *
 * Rein (keine I/O): Aufrufer laden die Zeilen und übergeben sie. Datums-Vergleich
 * erfolgt lexikografisch auf `YYYY-MM-DD`.
 *
 * [KRITISCH] Die Rolle ist die des LEISTENDEN Mitarbeiters, NICHT des
 * Anfragenden — abgeleitet über `wageRoleForUserFlags`. In den SQL-Aggregaten
 * (viele Mitarbeiter gleichzeitig) MUSS die Rolle pro Zeile aus den Flags des
 * dort leistenden Mitarbeiters kommen, nie aus einem Session-Wert.
 */

import type { WageRole } from "../../schema/contracts";

export type { WageRole };

export type WageSource = "role" | "default";

/** Eine zeitversionierte Lohnsatz-Zeile (Rollen-Satz). */
export interface VersionedWageRow {
  cents: number;
  /** `YYYY-MM-DD` oder null (= offener Anfang). */
  validFrom: string | null;
  /** `YYYY-MM-DD` oder null (= offenes Ende). */
  validTo: string | null;
  /** Deterministischer Tiebreaker bei identischem `validFrom` (höher = neuer). */
  id: number;
}

/** Katalog-Attribut eines Services für den Default-Fallback. */
export interface WageCatalogEntry {
  employeeRateCents: number;
}

export interface WageResolution {
  cents: number;
  source: WageSource;
}

const MIN_DATE = "0000-01-01";
const MAX_DATE = "9999-12-31";

/**
 * Wählt die am `date` aktive Zeile: alle Zeilen, deren `[validFrom, validTo]`
 * das Datum enthält; bei mehreren gewinnt das späteste `validFrom`, dann die
 * höchste `id`. Gibt `null`, wenn keine Zeile passt.
 *
 * Identisch zu `pickActive` in `price-for.ts` (bewusste Lockstep-Spiegelung).
 */
function pickActive(rows: readonly VersionedWageRow[], date: string): VersionedWageRow | null {
  let best: VersionedWageRow | null = null;
  for (const r of rows) {
    const from = r.validFrom ?? MIN_DATE;
    const to = r.validTo ?? MAX_DATE;
    if (date < from || date > to) continue;
    if (best === null) {
      best = r;
      continue;
    }
    const bestFrom = best.validFrom ?? MIN_DATE;
    if (from > bestFrom || (from === bestFrom && r.id > best.id)) {
      best = r;
    }
  }
  return best;
}

/**
 * Löst den geltenden Stundensatz (Integer-Cents) für eine Rolle × Leistung am
 * `date` auf.
 *
 * Gibt `null` NUR, wenn weder eine Rollen-Satz-Zeile noch ein Katalog-Eintrag
 * existiert (= unbekanntes Service); Aufrufer behandeln das als klaren
 * Konfigurationsfehler.
 */
export function resolveWageFor(args: {
  date: string;
  roleRows: readonly VersionedWageRow[];
  catalog?: WageCatalogEntry;
}): WageResolution | null {
  // 1. Rollen-Satz — EXISTENZ gewinnt (cents === 0 ist ein gültiger Satz).
  const role = pickActive(args.roleRows, args.date);
  if (role !== null) {
    return { cents: role.cents, source: "role" };
  }

  // 2. Katalog-Default (unterster Fallback).
  if (args.catalog) {
    return { cents: args.catalog.employeeRateCents, source: "default" };
  }

  return null;
}

/**
 * Reine Rollen-Ableitung aus den Flags eines Mitarbeiters.
 *
 * admin/superadmin → "admin"; sonst teamLead → "teamLead"; sonst "employee".
 * Mehrfachrollen sind damit eindeutig (admin > teamLead > employee).
 *
 * MUSS deckungsgleich mit `actorRole`/`isTeamLead` (`server/lib/team-lead.ts`)
 * sein — getestet für alle Flag-Kombinationen. Das `isTeamLead`-Flag, das hier
 * übergeben wird, ist bereits aktiv-/anonymisierungs-gegated (der Aufrufer —
 * TS wie SQL — wendet dieselbe Gating-Regel an, bevor er das Flag setzt).
 */
export function wageRoleForUserFlags(
  isSuperAdmin: boolean,
  isAdmin: boolean,
  isTeamLead: boolean,
): WageRole {
  if (isAdmin || isSuperAdmin) return "admin";
  if (isTeamLead) return "teamLead";
  return "employee";
}
