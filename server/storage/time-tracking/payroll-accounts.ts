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
 * Übertragskette wird innerhalb eines Jahres berechnet (Januar-Anker =
 * gespeicherter Wert oder 0). Cross-Year benötigt einen gespeicherten
 * Januar-Anfangsbestand (Go-Live/Übertrag) — bewusste Vereinfachung.
 *
 * Editier-Sperre: nach dem 8.-des-Monats-Auto-Abschluss (`isMonthClosed`).
 */
import { db } from "../../lib/db";
import { and, eq, gte, lte } from "drizzle-orm";
import {
  employeeHoursAccounts,
  HOURS_ACCOUNT_CATEGORIES,
  type HoursAccountCategory,
  type UpsertHoursAccount,
} from "@shared/schema/time-tracking";
import { withAudit } from "../../lib/with-audit";
import { isMonthClosed } from "./month-closing";
import { getMonthlyCategoryErfasst, type EmployeeMeta } from "./payroll-hours";

export interface AccountCell {
  category: HoursAccountCategory;
  anfangsbestand: number;
  anfangsbestandType: "go_live" | "carryover";
  erfasst: number;
  bezahlt: number;
  bezahltIsDefault: boolean;
  saldo: number;
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

/**
 * Berechnet für JEDEN Mitarbeiter die Kontozellen (alle Kategorien) des
 * gewählten Monats inkl. der Übertragskette ab Januar.
 */
export async function computeAccountsForMonth(
  year: number,
  month: number,
): Promise<{ byEmployee: Record<number, Record<string, AccountCell>>; employees: EmployeeMeta[] }> {
  const { byEmployeeMonth, employees } = await getMonthlyCategoryErfasst(year, month);
  const stored = await loadStoredRows(year, month);

  const byEmployee: Record<number, Record<string, AccountCell>> = {};

  for (const emp of employees) {
    const cells: Record<string, AccountCell> = {};
    for (const category of HOURS_ACCOUNT_CATEGORIES) {
      // Übertragskette Jan..month
      let saldoPrev = 0;
      let cell: AccountCell | null = null;
      for (let m = 1; m <= month; m++) {
        const erfasst = r2(byEmployeeMonth[emp.id]?.[m]?.[category] ?? 0);
        const row = stored[emp.id]?.[m]?.[category];

        let anfangsbestand: number;
        let anfangsbestandType: "go_live" | "carryover";
        if (row && row.anfangsbestand !== null && row.openingBalanceType === "go_live") {
          anfangsbestand = r2(row.anfangsbestand);
          anfangsbestandType = "go_live";
        } else {
          anfangsbestand = m === 1 ? 0 : r2(saldoPrev);
          anfangsbestandType = "carryover";
        }

        const bezahltIsDefault = !(row && row.bezahlt !== null);
        const bezahlt = bezahltIsDefault ? erfasst : r2(row!.bezahlt!);
        const saldo = r2(anfangsbestand + erfasst - bezahlt);

        saldoPrev = saldo;
        if (m === month) {
          cell = { category, anfangsbestand, anfangsbestandType, erfasst, bezahlt, bezahltIsDefault, saldo };
        }
      }
      cells[category] = cell!;
    }
    byEmployee[emp.id] = cells;
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
