/**
 * Task #1555 — Stundenkonto (Auszahl-Rückstand) pro Mitarbeiter × Monat ×
 * Kategorie. Saldo = Anfangsbestand + Erfasst − Bezahlt.
 *
 *  - Erfasst: abgeleitet aus den Termin-/Zeitdaten (SSoT `payroll-hours`), nie
 *    persistiert.
 *  - Bezahlt: manuell pflegbar; NULL ⇒ default = Erfasst (Saldo bleibt 0).
 *  - Anfangsbestand: einmaliger Go-Live-Eröffnungssaldo ('go_live', editierbar
 *    solange der Monat offen ist) ODER zur Laufzeit aus dem Vormonats-Saldo
 *    abgeleiteter Übertrag ('carryover', abgeleitet/gesperrt).
 *
 * Übertragskette läuft KONTINUIERLICH über Jahresgrenzen hinweg (Task #1564,
 * ersetzt die frühere Vereinfachung „Januar-Anker = 0"): der Dezember-Saldo
 * eines Jahres wird automatisch zum abgeleiteten 'carryover'-Anfangsbestand des
 * darauffolgenden Januars — durch denselben Reader, damit Übersicht UND
 * Drill-down identisch fortführen. Ein gespeicherter Go-Live-Anfangsbestand
 * setzt die Kette in seinem Monat neu; der Ketten-Start (frühestes Jahr mit
 * Aktivität/gespeichertem Wert, gedeckelt via MAX_CARRYOVER_LOOKBACK_YEARS)
 * startet bei 0.
 *
 * Editier-Sperre: nach dem 8.-des-Monats-Auto-Abschluss (`isMonthClosed`).
 */
import { db } from "../../lib/db";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import {
  employeeHoursAccounts,
  HOURS_ACCOUNT_CATEGORIES,
  type HoursAccountCategory,
  type UpsertHoursAccount,
} from "@shared/schema/time-tracking";
import { withAudit } from "../../lib/with-audit";
import { isMonthClosed } from "./month-closing";
import { getMonthlyCategoryErfasst, loadContext, type EmployeeMeta } from "./payroll-hours";

export interface AccountCell {
  category: HoursAccountCategory;
  anfangsbestand: number;
  anfangsbestandType: "go_live" | "carryover";
  erfasst: number;
  bezahlt: number;
  bezahltIsDefault: boolean;
  saldo: number;
}

/**
 * SSoT für den Gesamt-Stundenkonto-Saldo (Reststunden) eines Mitarbeiters aus
 * seinen Kategorie-Zellen: Summe der Salden von HW + AB + Feiertage, auf 2 NK
 * gerundet. Kilometer ist KEINE Stunde und bleibt bewusst ausgeschlossen.
 * Diese eine Funktion liefert die Zahl sowohl für die Admin-Spalte
 * „Stundenkonto" als auch für die Mitarbeiter-Selbstansicht — nie parallel
 * nachrechnen (Anzeige-≠-Buchung-Drift vermeiden).
 */
export function sumStundenkontoSaldo(cells: Record<string, AccountCell> | undefined): number {
  const hw = cells?.hw?.saldo ?? 0;
  const ab = cells?.ab?.saldo ?? 0;
  const feiertage = cells?.feiertage?.saldo ?? 0;
  return Math.round((hw + ab + feiertage) * 100) / 100;
}

type StoredRow = {
  category: string;
  anfangsbestand: number | null;
  bezahlt: number | null;
  openingBalanceType: string;
};

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function loadStoredRows(
  year: number,
  uptoMonth: number,
): Promise<Record<number, Record<number, Record<string, StoredRow>>>> {
  const rows = await db
    .select({
      userId: employeeHoursAccounts.userId,
      month: employeeHoursAccounts.month,
      category: employeeHoursAccounts.category,
      anfangsbestand: employeeHoursAccounts.anfangsbestand,
      bezahlt: employeeHoursAccounts.bezahlt,
      openingBalanceType: employeeHoursAccounts.openingBalanceType,
    })
    .from(employeeHoursAccounts)
    .where(
      and(
        eq(employeeHoursAccounts.year, year),
        gte(employeeHoursAccounts.month, 1),
        lte(employeeHoursAccounts.month, uptoMonth),
      ),
    );

  const out: Record<number, Record<number, Record<string, StoredRow>>> = {};
  for (const r of rows) {
    (out[r.userId] ??= {})[r.month] ??= {};
    out[r.userId][r.month][r.category] = {
      category: r.category,
      anfangsbestand: r.anfangsbestand,
      bezahlt: r.bezahlt,
      openingBalanceType: r.openingBalanceType,
    };
  }
  return out;
}

// Sicherheits-Deckel für den Cross-Year-Rückblick: die Übertragskette startet
// höchstens so viele Jahre vor dem angefragten Jahr. Verhindert unbeschränkte
// Query-Fan-outs bei alten/verwaisten Aktivitätsdaten; der so gedeckelte
// Ketten-Start beginnt (wie ein Ketten-Anfang) bei 0.
const MAX_CARRYOVER_LOOKBACK_YEARS = 15;

/**
 * Bestimmt das früheste Jahr, ab dem die Übertragskette gerechnet werden muss:
 * das kleinste Jahr mit gespeichertem Stundenkonto-Wert ODER dokumentierter
 * Termin-/Zeiteintrags-Aktivität. Frühere Jahre tragen (Anker 0, keine
 * Aktivität) ohnehin einen Dezember-Saldo von 0 bei und dürfen entfallen.
 */
async function findChainStartYear(year: number): Promise<number> {
  // MIN über ein UNION ALL: der Aggregat-MIN ignoriert NULL-Teilergebnisse
  // (leere Quelltabellen) und liefert nur dann NULL, wenn ALLE Quellen leer
  // sind. So kollabiert eine einzelne leere Tabelle das Ergebnis NICHT auf NULL
  // (was den Ketten-Start fälschlich aufs angefragte Jahr zurücksetzen würde).
  const res = await db.execute(sql`
    SELECT MIN(y)::int AS start_year FROM (
      SELECT MIN(year) AS y FROM employee_hours_accounts
      UNION ALL
      SELECT MIN(EXTRACT(YEAR FROM date::date))::int FROM appointments
        WHERE performed_by_employee_id IS NOT NULL AND deleted_at IS NULL
      UNION ALL
      SELECT MIN(EXTRACT(YEAR FROM entry_date::date))::int FROM employee_time_entries
        WHERE deleted_at IS NULL
    ) t
  `);
  const raw = (res.rows?.[0] as { start_year: number | string | null } | undefined)?.start_year;
  let startYear = raw == null ? year : Number(raw);
  if (!Number.isFinite(startYear) || startYear > year) startYear = year;
  const floor = year - MAX_CARRYOVER_LOOKBACK_YEARS;
  if (startYear < floor) startYear = floor;
  return startYear;
}

/**
 * Berechnet für JEDEN Mitarbeiter die Kontozellen (alle Kategorien) des
 * gewählten Monats inkl. der Übertragskette. Die Kette läuft KONTINUIERLICH ab
 * dem frühesten relevanten Jahr bis zum angefragten Monat und überschreitet
 * dabei Jahresgrenzen: der Dezember-Saldo wird zum Januar-Anfangsbestand des
 * Folgejahres (Task #1564). Ein gespeicherter Go-Live-Anfangsbestand setzt die
 * Kette in seinem Monat neu.
 */
export async function computeAccountsForMonth(
  year: number,
  month: number,
): Promise<{ byEmployee: Record<number, Record<string, AccountCell>>; employees: EmployeeMeta[] }> {
  const startYear = await findChainStartYear(year);

  // Der Kontext (aktive Mitarbeiter, Verdienstgrenze, Lohnsätze) ist
  // jahresunabhängig — einmal laden und über ALLE Jahre der Übertragskette
  // wiederverwenden, statt ihn (samt Employee-/Wage-Queries) pro Jahr neu zu
  // laden (Task #1568).
  const ctx = await loadContext();
  const employees: EmployeeMeta[] = ctx.employees;

  const byEmployee: Record<number, Record<string, AccountCell>> = {};
  // Fortlaufender Saldo pro Mitarbeiter × Kategorie, über Jahresgrenzen getragen.
  const saldoCarry: Record<number, Record<string, number>> = {};

  for (let y = startYear; y <= year; y++) {
    const uptoMonth = y === year ? month : 12;
    const { byEmployeeMonth, employees: yearEmployees } = await getMonthlyCategoryErfasst(y, uptoMonth, ctx);
    const stored = await loadStoredRows(y, uptoMonth);

    for (const emp of yearEmployees) {
      const cells: Record<string, AccountCell> = {};
      for (const category of HOURS_ACCOUNT_CATEGORIES) {
        // Eingehender Anker: Dezember-Saldo des Vorjahres (0 am Ketten-Start).
        let saldoPrev = saldoCarry[emp.id]?.[category] ?? 0;
        let cell: AccountCell | null = null;
        for (let m = 1; m <= uptoMonth; m++) {
          const erfasst = r2(byEmployeeMonth[emp.id]?.[m]?.[category] ?? 0);
          const row = stored[emp.id]?.[m]?.[category];

          let anfangsbestand: number;
          let anfangsbestandType: "go_live" | "carryover";
          if (row && row.anfangsbestand !== null && row.openingBalanceType === "go_live") {
            anfangsbestand = r2(row.anfangsbestand);
            anfangsbestandType = "go_live";
          } else {
            // Nur der allererste Monat der GESAMTEN Kette startet bei 0; jeder
            // Folgemonat (auch der Januar eines Folgejahres) erbt den Vormonats-
            // bzw. Vorjahres-Dezember-Saldo.
            anfangsbestand = y === startYear && m === 1 ? 0 : r2(saldoPrev);
            anfangsbestandType = "carryover";
          }

          const bezahltIsDefault = !(row && row.bezahlt !== null);
          const bezahlt = bezahltIsDefault ? erfasst : r2(row!.bezahlt!);
          const saldo = r2(anfangsbestand + erfasst - bezahlt);

          saldoPrev = saldo;
          if (y === year && m === uptoMonth) {
            cell = { category, anfangsbestand, anfangsbestandType, erfasst, bezahlt, bezahltIsDefault, saldo };
          }
        }
        // Dezember-Saldo (bzw. Saldo des letzten gerechneten Monats) ins
        // nächste Jahr übertragen.
        (saldoCarry[emp.id] ??= {})[category] = saldoPrev;
        if (y === year) cells[category] = cell!;
      }
      if (y === year) byEmployee[emp.id] = cells;
    }
  }

  return { byEmployee, employees };
}

/**
 * Speichert einen manuellen Kontowert (Anfangsbestand und/oder Bezahlt) für
 * genau eine Zelle. Audit-protokolliert und für abgeschlossene Monate gesperrt.
 *
 * Rückgabe `null` ⇒ Monat ist abgeschlossen (Aufrufer antwortet 403).
 */
export class OpeningBalanceLockedError extends Error {
  constructor() {
    super("Nur ein Go-Live-Anfangsbestand ist editierbar; ein übertragener Anfangsbestand ist gesperrt.");
    this.name = "OpeningBalanceLockedError";
  }
}

export async function upsertHoursAccount(
  input: UpsertHoursAccount,
  actorUserId: number,
  ipAddress?: string,
): Promise<{ locked: boolean }> {
  // Sperre für übertragenen (abgeleiteten) Anfangsbestand: ein Anfangsbestand
  // darf ausschließlich als Go-Live-Eröffnungssaldo geschrieben werden. Ein
  // 'carryover'-Wert wird zur Laufzeit aus der Vormonatskette abgeleitet und
  // darf nie manuell gesetzt werden — sonst bricht die Übertragskette.
  if (input.anfangsbestand !== undefined && input.openingBalanceType !== "go_live") {
    throw new OpeningBalanceLockedError();
  }

  const dateStr = `${input.year}-${String(input.month).padStart(2, "0")}-15`;
  if (await isMonthClosed(input.userId, dateStr)) {
    return { locked: true };
  }

  await withAudit(async (tx, audit) => {
    const [existing] = await tx
      .select()
      .from(employeeHoursAccounts)
      .where(
        and(
          eq(employeeHoursAccounts.userId, input.userId),
          eq(employeeHoursAccounts.year, input.year),
          eq(employeeHoursAccounts.month, input.month),
          eq(employeeHoursAccounts.category, input.category),
        ),
      )
      .limit(1);

    const previous = {
      anfangsbestand: existing?.anfangsbestand ?? null,
      bezahlt: existing?.bezahlt ?? null,
      openingBalanceType: existing?.openingBalanceType ?? null,
    };

    const anfangsbestand = input.anfangsbestand === undefined
      ? (existing?.anfangsbestand ?? null)
      : input.anfangsbestand;
    const bezahlt = input.bezahlt === undefined
      ? (existing?.bezahlt ?? null)
      : input.bezahlt;
    const openingBalanceType = input.openingBalanceType
      ?? (existing?.openingBalanceType ?? "carryover");

    let entityId: number;
    if (existing) {
      await tx
        .update(employeeHoursAccounts)
        .set({ anfangsbestand, bezahlt, openingBalanceType, updatedAt: new Date() })
        .where(eq(employeeHoursAccounts.id, existing.id));
      entityId = existing.id;
    } else {
      const [created] = await tx
        .insert(employeeHoursAccounts)
        .values({
          userId: input.userId,
          year: input.year,
          month: input.month,
          category: input.category,
          anfangsbestand,
          bezahlt,
          openingBalanceType,
        })
        .returning({ id: employeeHoursAccounts.id });
      entityId = created.id;
    }

    audit.record({
      userId: actorUserId,
      action: "hours_account_updated",
      entityType: "hours_account",
      entityId,
      metadata: {
        employeeUserId: input.userId,
        year: input.year,
        month: input.month,
        category: input.category,
        previous,
        next: { anfangsbestand, bezahlt, openingBalanceType },
        // Flache Felder bleiben für Rückwärtskompatibilität erhalten.
        anfangsbestand,
        bezahlt,
        openingBalanceType,
      },
      ipAddress,
    });
  });

  return { locked: false };
}
