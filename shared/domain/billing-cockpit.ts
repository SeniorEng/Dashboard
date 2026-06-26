/**
 * Task #1444 — Abrechnung-Cockpit (Phase 1): reine Domänen-Schicht.
 *
 * Das Cockpit ist eine READ-ONLY-Komposition über bestehende SSoTs. Diese
 * Datei enthält ausschließlich PURE, deterministische Funktionen ohne DB-/
 * Netzwerk-Zugriff:
 *  - Die FÜNF-stufige Trichter-Sicht (`Geplant → Dokumentiert →
 *    Leistungsnachweis → Abgerechnet → Bezahlt`) ist eine GRÖBERE Abbildung
 *    der bestehenden 7-stufigen Pipeline (`shared/domain/billing-pipeline.ts`)
 *    — KEINE zweite, parallele Stufen-Logik.
 *  - Gruppierung (Mitarbeiter/Rechnung/Kunde), Lohn-Readiness-Aggregation,
 *    Ampel und der „>48 h überfällig"-Filter sind reine Aggregationen über die
 *    von den Readern gelieferten Roh-Signale.
 *
 * Geldbeträge sind ausnahmslos Integer-Cents.
 */
import type { PipelineStage } from "./billing-pipeline";
import { daysOverdue } from "./appointments";

// ============================================
// TRICHTER-STUFEN (5) — gröbere Sicht auf die 7 Pipeline-Stufen
// ============================================

export const COCKPIT_FUNNEL_STAGES = [
  "geplant",
  "dokumentiert",
  "leistungsnachweis",
  "abgerechnet",
  "bezahlt",
] as const;
export type CockpitFunnelStage = (typeof COCKPIT_FUNNEL_STAGES)[number];

export const COCKPIT_FUNNEL_STAGE_LABELS: Record<CockpitFunnelStage, string> = {
  geplant: "Geplant",
  dokumentiert: "Dokumentiert",
  leistungsnachweis: "Leistungsnachweis",
  abgerechnet: "Abgerechnet",
  bezahlt: "Bezahlt",
};

/**
 * Bildet eine der 7 Pipeline-Stufen auf die 5 Cockpit-Trichter-Stufen ab.
 * Reine 1:N-Verdichtung der bestehenden SSoT-Stufen — der Trichter erfindet
 * KEINE eigene Klassifikation.
 *
 * | Pipeline-Stufe       | Trichter-Stufe      |
 * | -------------------- | ------------------- |
 * | offen                | geplant             |
 * | dokumentiert         | dokumentiert        |
 * | unterschrieben       | leistungsnachweis   |
 * | rechnung_erstellt    | abgerechnet         |
 * | versendet            | abgerechnet         |
 * | avis_erhalten        | abgerechnet         |
 * | bezahlt              | bezahlt             |
 */
export function mapPipelineStageToFunnel(stage: PipelineStage): CockpitFunnelStage {
  switch (stage) {
    case "offen":
      return "geplant";
    case "dokumentiert":
      return "dokumentiert";
    case "unterschrieben":
      return "leistungsnachweis";
    case "rechnung_erstellt":
    case "versendet":
    case "avis_erhalten":
      return "abgerechnet";
    case "bezahlt":
      return "bezahlt";
  }
}

// ============================================
// DRILL-DOWN-ZEILEN — eine Umsatz-tragende Einheit im Trichter
// ============================================

/**
 * Eine Drill-down-Zeile = ein Termin (frühe Stufen) bzw. eine Rechnung (späte
 * Stufen). Trägt alle drei Gruppierungs-Dimensionen, damit die Sicht
 * (Mitarbeiter/Rechnung/Kunde) rein clientseitig umgeschaltet werden kann.
 */
export interface CockpitDrillRow {
  /** Stabiler Render-Key (kollidiert nicht über Stufen/Quellen hinweg). */
  id: string;
  kind: "appointment" | "invoice";
  stage: CockpitFunnelStage;
  minutes: number;
  cents: number;
  employeeId: number | null;
  employeeName: string | null;
  customerId: number;
  customerName: string;
  invoiceId: number | null;
  invoiceNumber: string | null;
  invoiceStatus: string | null;
  billingType: string | null;
  /** Termin-Anker für den Zeilen-Klick → Termin-Detail (`/appointment/:id`). */
  appointmentId: number | null;
  date: string | null;
}

export interface CockpitStageSummary {
  stage: CockpitFunnelStage;
  label: string;
  /** Anzahl Umsatz-tragender Einheiten (Termine bzw. Rechnungen) in der Stufe. */
  itemCount: number;
  totalMinutes: number;
  totalCents: number;
}

/**
 * Ein bereits (z. B. serverseitig per SQL-`GROUP BY`) voraggregierter Beitrag
 * zu einer Trichter-Stufe. Erlaubt es, den Trichter zu summieren, OHNE jede
 * einzelne Drill-Zeile in den App-Prozess zu laden — das Stufen-Mapping bleibt
 * dieselbe SSoT (`mapPipelineStageToFunnel`), nur die Summierung arbeitet auf
 * gröberen Beiträgen statt auf Einzelzeilen.
 */
export interface CockpitStageContribution {
  stage: CockpitFunnelStage;
  itemCount: number;
  totalMinutes: number;
  totalCents: number;
}

/**
 * Verdichtet voraggregierte Stufen-Beiträge zu den 5 Trichter-Stufen (immer
 * alle 5, auch wenn leer — für eine stabile Trichter-Leiste). Reine,
 * assoziative Summierung: das Ergebnis ist identisch dazu, jede Einzelzeile
 * einzeln beizutragen (€-Konservierung).
 */
export function summarizeCockpitFunnelContributions(
  contributions: CockpitStageContribution[],
): CockpitStageSummary[] {
  const byStage = new Map<CockpitFunnelStage, { itemCount: number; totalMinutes: number; totalCents: number }>();
  for (const stage of COCKPIT_FUNNEL_STAGES) {
    byStage.set(stage, { itemCount: 0, totalMinutes: 0, totalCents: 0 });
  }
  for (const c of contributions) {
    const acc = byStage.get(c.stage)!;
    acc.itemCount += c.itemCount;
    acc.totalMinutes += c.totalMinutes;
    acc.totalCents += c.totalCents;
  }
  return COCKPIT_FUNNEL_STAGES.map((stage) => {
    const acc = byStage.get(stage)!;
    return {
      stage,
      label: COCKPIT_FUNNEL_STAGE_LABELS[stage],
      itemCount: acc.itemCount,
      totalMinutes: acc.totalMinutes,
      totalCents: acc.totalCents,
    };
  });
}

/**
 * Verdichtet die Drill-down-Zeilen zu den 5 Trichter-Stufen (immer alle 5,
 * auch wenn leer — für eine stabile Trichter-Leiste). Dünner Wrapper über
 * `summarizeCockpitFunnelContributions` (jede Zeile = ein Beitrag mit Count 1).
 */
export function summarizeCockpitFunnel(rows: CockpitDrillRow[]): CockpitStageSummary[] {
  return summarizeCockpitFunnelContributions(
    rows.map((row) => ({
      stage: row.stage,
      itemCount: 1,
      totalMinutes: row.minutes,
      totalCents: row.cents,
    })),
  );
}

// ============================================
// GRUPPIERUNG (Mitarbeiter / Rechnung / Kunde)
// ============================================

export type CockpitGroupDimension = "mitarbeiter" | "rechnung" | "kunde";

export const COCKPIT_GROUP_DIMENSION_LABELS: Record<CockpitGroupDimension, string> = {
  mitarbeiter: "Mitarbeiter",
  rechnung: "Rechnung",
  kunde: "Kunde",
};

export interface CockpitGroupRow {
  key: string;
  label: string;
  rowCount: number;
  totalMinutes: number;
  totalCents: number;
  rows: CockpitDrillRow[];
}

function groupKeyAndLabel(
  row: CockpitDrillRow,
  dimension: CockpitGroupDimension,
): { key: string; label: string } {
  switch (dimension) {
    case "mitarbeiter":
      return row.employeeId != null
        ? { key: `emp-${row.employeeId}`, label: row.employeeName ?? "Unbekannt" }
        : { key: "emp-none", label: "Ohne Mitarbeiter" };
    case "rechnung":
      return row.invoiceId != null
        ? { key: `inv-${row.invoiceId}`, label: row.invoiceNumber ?? `Rechnung ${row.invoiceId}` }
        : { key: "inv-none", label: "Ohne Rechnung" };
    case "kunde":
      return { key: `cust-${row.customerId}`, label: row.customerName || "Unbekannt" };
  }
}

/**
 * Gruppiert Drill-down-Zeilen nach der gewählten Dimension. Reine Sicht — die
 * gelieferten Zeilen bleiben unverändert, nur ihre Bündelung ändert sich.
 * Sortiert absteigend nach €-Summe (größte Posten zuerst).
 */
export function groupCockpitRows(
  rows: CockpitDrillRow[],
  dimension: CockpitGroupDimension,
): CockpitGroupRow[] {
  const groups = new Map<string, CockpitGroupRow>();
  for (const row of rows) {
    const { key, label } = groupKeyAndLabel(row, dimension);
    let group = groups.get(key);
    if (!group) {
      group = { key, label, rowCount: 0, totalMinutes: 0, totalCents: 0, rows: [] };
      groups.set(key, group);
    }
    group.rowCount += 1;
    group.totalMinutes += row.minutes;
    group.totalCents += row.cents;
    group.rows.push(row);
  }
  return Array.from(groups.values()).sort((a, b) => b.totalCents - a.totalCents);
}

// ============================================
// LOHN-READINESS (Monatsabschluss-Sicht)
// ============================================

export interface LohnReadinessInput {
  ready: boolean;
  isClosed: boolean;
  hasTimeEntries: boolean;
}

export interface LohnReadinessSummary {
  /** Mitarbeiter mit Aktivität, deren Monat lohnreif (oder bereits zu) ist. */
  lohnreif: number;
  /** Mitarbeiter mit Aktivität, deren Monat noch Blocker hat (in Prüfung). */
  inPruefung: number;
  /** Σ Mitarbeiter mit Aktivität im Monat. */
  withActivity: number;
}

/**
 * Verdichtet die Monatsabschluss-Readiness der Mitarbeiter zur Lohn-Zeile
 * („X lohnreif, Y in Prüfung"). KOMPONIERT die bestehende Readiness-SSoT
 * (`getAdminMonthClosingReadiness`) — leitet `ready`/`isClosed` NICHT neu ab.
 * Nur Mitarbeiter mit Aktivität (Termine/Zeiterfassung) zählen.
 */
export function summarizeLohnReadiness(employees: LohnReadinessInput[]): LohnReadinessSummary {
  let lohnreif = 0;
  let inPruefung = 0;
  let withActivity = 0;
  for (const emp of employees) {
    if (!emp.hasTimeEntries) continue;
    withActivity += 1;
    if (emp.ready || emp.isClosed) lohnreif += 1;
    else inPruefung += 1;
  }
  return { lohnreif, inPruefung, withActivity };
}

// ============================================
// AMPEL (grün / gelb / rot)
// ============================================

export type CockpitAmpel = "gruen" | "gelb" | "rot";

export interface CockpitAmpelInput {
  /** Termine >48 h überfällig dokumentiert. */
  ueberfaelligeDokuCount: number;
  /** Überfällige Rechnungen (Aging rot). */
  zahlungsverzugCount: number;
  /** Ausstehende Leistungsnachweis-Prüfungen. */
  lnPruefungCount: number;
  /** Berechtigte, noch nicht abgerechnete Kunden. */
  abrechnungsPruefungCount: number;
  /** Mitarbeiter mit Lohn-Blockern (in Prüfung). */
  lohnInPruefungCount: number;
}

/**
 * Leitet die Cockpit-Ampel rein aus den Ausnahme-Zählern ab:
 *  - ROT  bei harten Rückständen (Doku >48 h überfällig ODER Rechnung überfällig),
 *  - GELB bei offenen Prüfungen/Lohn-Blockern,
 *  - GRÜN sonst.
 */
export function resolveCockpitAmpel(input: CockpitAmpelInput): CockpitAmpel {
  if (input.ueberfaelligeDokuCount > 0 || input.zahlungsverzugCount > 0) return "rot";
  if (
    input.lnPruefungCount > 0 ||
    input.abrechnungsPruefungCount > 0 ||
    input.lohnInPruefungCount > 0
  ) {
    return "gelb";
  }
  return "gruen";
}

// ============================================
// „ÜBERFÄLLIGE DOKU" — >48 h alt ohne/unvollständige Doku
// ============================================

/**
 * True, wenn die Doku eines Termins „>48 h" überfällig ist. KOMPONIERT die
 * bestehende `daysOverdue`-SSoT (datums-basiert): ein Termin gilt als >48 h
 * überfällig, sobald sein Datum ≥ 2 Kalendertage vor dem Stichtag liegt.
 */
export function isDocumentationOverdue48h(
  appointment: { date: string },
  now: Date = new Date(),
): boolean {
  return daysOverdue(appointment, now) >= 2;
}
