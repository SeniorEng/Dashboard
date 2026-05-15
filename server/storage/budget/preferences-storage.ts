import {
  customerBudgetPreferences,
  customerBudgetTypeSettings,
  type CustomerBudgetPreferences,
  type InsertBudgetPreferences,
  type CustomerBudgetTypeSetting,
} from "@shared/schema";
import { and, asc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { addDays, todayISO } from "@shared/utils/datetime";
import { db } from "../../lib/db";
import type { DbClient } from "./types";
import { auditService } from "../../services/audit";

export async function getBudgetPreferences(customerId: number, _tx?: DbClient): Promise<CustomerBudgetPreferences | undefined> {
  const d = _tx ?? db;
  const result = await d.select()
    .from(customerBudgetPreferences)
    .where(eq(customerBudgetPreferences.customerId, customerId))
    .limit(1);
  return result[0];
}

export async function upsertBudgetPreferences(preferences: InsertBudgetPreferences, _userId?: number): Promise<CustomerBudgetPreferences> {
  const existing = await getBudgetPreferences(preferences.customerId);

  if (existing) {
    const result = await db.update(customerBudgetPreferences)
      .set({
        monthlyLimitCents: preferences.monthlyLimitCents,
        budgetStartDate: preferences.budgetStartDate,
        notes: preferences.notes,
        updatedAt: sql`now()`,
      })
      .where(eq(customerBudgetPreferences.customerId, preferences.customerId))
      .returning();
    return result[0];
  }

  const result = await db.insert(customerBudgetPreferences)
    .values(preferences)
    .returning();
  return result[0];
}

/**
 * Liefert die zum `asOfDate` gültige (historisierte) §45b/§45a/§39-Konfiguration.
 *
 * Eine Zeile ist gültig wenn:
 *   - `validFrom <= asOfDate` (oder NULL als Backfill-Marker, siehe Startup-Migration), UND
 *   - `validTo IS NULL` (offen) ODER `validTo >= asOfDate`.
 *
 * Wichtig für GoBD: Buchungen mit `transactionDate` in der Vergangenheit MÜSSEN
 * die damals gültige Konfiguration nutzen, nicht die aktuelle. Aufrufer mit
 * transactionDate-Kontext (z.B. consumption-engine, import-availability) müssen
 * diese Funktion mit dem transactionDate aufrufen.
 */
export async function getActiveBudgetTypeSettings(
  customerId: number,
  asOfDate: string,
  _tx?: DbClient,
): Promise<CustomerBudgetTypeSetting[]> {
  const d = _tx ?? db;
  return d.select()
    .from(customerBudgetTypeSettings)
    .where(and(
      eq(customerBudgetTypeSettings.customerId, customerId),
      or(
        isNull(customerBudgetTypeSettings.validFrom),
        lte(customerBudgetTypeSettings.validFrom, asOfDate),
      ),
      or(
        isNull(customerBudgetTypeSettings.validTo),
        gte(customerBudgetTypeSettings.validTo, asOfDate),
      ),
    ))
    .orderBy(asc(customerBudgetTypeSettings.priority));
}

/**
 * Backwards-kompatibler Getter: liefert die HEUTE gültige Konfiguration.
 * Für historische Lookups (z. B. Buchung mit `transactionDate`) bitte
 * `getActiveBudgetTypeSettings(customerId, transactionDate, tx)` verwenden.
 */
export async function getBudgetTypeSettings(customerId: number, _tx?: DbClient): Promise<CustomerBudgetTypeSetting[]> {
  return getActiveBudgetTypeSettings(customerId, todayISO(), _tx);
}

type SettingPayload = {
  budgetType: string;
  enabled: boolean;
  priority: number;
  monthlyLimitCents?: number | null;
  yearlyLimitCents?: number | null;
  validFrom?: string | null;
  validTo?: string | null;
};

function settingsEqual(a: CustomerBudgetTypeSetting, b: SettingPayload): boolean {
  // validFrom wird in der Historisierung pro Zeile vergeben (nicht aus dem
  // Payload), daher hier bewusst nicht verglichen — sonst gäbe es bei jedem
  // Save Pseudo-Transitionen.
  return (
    a.enabled === b.enabled &&
    a.priority === b.priority &&
    (a.monthlyLimitCents ?? null) === (b.monthlyLimitCents ?? null) &&
    (a.yearlyLimitCents ?? null) === (b.yearlyLimitCents ?? null) &&
    (a.validTo ?? null) === (b.validTo ?? null)
  );
}

/**
 * Historisierte Aktualisierung der Topf-Konfiguration (Task #440 / GoBD).
 *
 * - Statt `DELETE + INSERT` wird die alte offene Zeile pro `(customer, budgetType)`
 *   per `validTo = heute` geschlossen und eine neue Zeile mit `validFrom = heute+1`
 *   angelegt. Erstanlagen (keine offene Vorgängerzeile) starten direkt heute.
 * - Aus dem Payload entfernte Töpfe werden geschlossen (validTo = heute),
 *   nicht gelöscht.
 * - Unveränderte Zeilen bleiben unangetastet (keine Pseudo-Transitionen).
 * - Jede Transition / Schließung / Erstanlage erzeugt einen Audit-Log-Eintrag
 *   (`budget_type_settings_transition`), falls ein userId vorliegt.
 *
 * Der partielle UNIQUE-Index `customer_budget_type_settings_unique_idx`
 * (`WHERE valid_to IS NULL`) stellt sicher, dass immer höchstens eine offene
 * Zeile pro `(customer, budgetType)` existiert.
 */
export async function upsertBudgetTypeSettings(
  customerId: number,
  settings: SettingPayload[],
  tx?: DbClient,
  userId?: number,
): Promise<CustomerBudgetTypeSetting[]> {
  const today = todayISO();
  const tomorrow = addDays(today, 1);

  const run = async (executor: DbClient): Promise<CustomerBudgetTypeSetting[]> => {
    const openRows = await executor.select()
      .from(customerBudgetTypeSettings)
      .where(and(
        eq(customerBudgetTypeSettings.customerId, customerId),
        isNull(customerBudgetTypeSettings.validTo),
      ));

    const openByType = new Map(openRows.map(r => [r.budgetType, r]));
    const payloadByType = new Map(settings.map(s => [s.budgetType, s]));

    type AuditEntry =
      | { kind: "close"; budgetType: string; before: CustomerBudgetTypeSetting; after: null; nextValidFrom: null }
      | { kind: "create"; budgetType: string; before: null; after: SettingPayload; nextValidFrom: string | null }
      | { kind: "in_place_update"; budgetType: string; before: CustomerBudgetTypeSetting; after: SettingPayload; nextValidFrom: string | null }
      | { kind: "transition"; budgetType: string; before: CustomerBudgetTypeSetting; after: SettingPayload; nextValidFrom: string };
    const auditEntries: AuditEntry[] = [];

    // 1. Aus dem Payload entfernte Töpfe schließen.
    for (const row of openRows) {
      if (!payloadByType.has(row.budgetType)) {
        await executor.update(customerBudgetTypeSettings)
          .set({ validTo: today, updatedAt: sql`now()` })
          .where(eq(customerBudgetTypeSettings.id, row.id));
        auditEntries.push({ kind: "close", budgetType: row.budgetType, before: row, after: null, nextValidFrom: null });
      }
    }

    // 2. Payload abarbeiten — Erstanlage, Transition oder No-Op.
    for (const s of settings) {
      const current = openByType.get(s.budgetType);
      const baseValues = {
        customerId,
        budgetType: s.budgetType,
        enabled: s.enabled,
        priority: s.priority,
        monthlyLimitCents: s.monthlyLimitCents ?? null,
        yearlyLimitCents: s.yearlyLimitCents ?? null,
        validTo: s.validTo ?? null,
      };

      if (!current) {
        // Erstanlage: wenn der Aufrufer kein validFrom mitgibt, speichern wir
        // NULL ("gilt rückwirkend ab Beginn"). Das ist notwendig, damit
        // budgetStartDate-basierte Auto-Allokationen (§45b) und historische
        // Buchungen die heute angelegte Topf-Konfiguration auch für Monate
        // VOR dem Anlagedatum sehen. Eine Pseudo-Begrenzung `validFrom = heute`
        // würde Setup-Flows mit rückwirkendem Budget-Start brechen.
        const newValidFrom = s.validFrom ?? null;
        await executor.insert(customerBudgetTypeSettings).values({
          ...baseValues,
          validFrom: newValidFrom,
        });
        auditEntries.push({ kind: "create", budgetType: s.budgetType, before: null, after: s, nextValidFrom: newValidFrom });
      } else if (!settingsEqual(current, s)) {
        // GoBD-Pragmatik: Wurde die aktuelle offene Zeile heute (oder in der
        // Zukunft) angelegt, hatte sie noch keinen Tag, an dem sie als
        // "gültig" hätte greifen können — Buchungen referenzieren ausschließlich
        // `transactionDate <= heute - 1` oder den heutigen Tag selbst, je nach
        // Aufruf-Pfad. Eine Pseudo-Historisierung (validTo = heute / validFrom
        // = morgen) würde hier nur unnötig dichten Audit-Müll erzeugen und in
        // Setup-Flows (z.B. Kundenanlage + Sofort-Anpassung) dazu führen, dass
        // die gerade gespeicherten Einstellungen *heute* noch nicht aktiv sind.
        // Daher: ist die alte Zeile noch nicht "in Kraft gewesen", aktualisieren
        // wir sie in-place — die Historie bleibt korrekt, weil keine Buchung
        // jemals die alte Version gesehen haben kann.
        //
        // "Noch nicht in Kraft" heißt entweder:
        //   (a) validFrom >= heute (Zukunfts-validFrom, klassische Pseudo-Hist), oder
        //   (b) validFrom IS NULL (rückwirkende Erstanlage) UND createdAt IS heute
        //       — d.h. die Zeile existiert noch keinen Werktag, kann also keine
        //       reale Buchung referenziert haben.
        const oldValidFrom = current.validFrom;
        const createdToday = current.createdAt ? current.createdAt.toISOString().slice(0, 10) === today : false;
        const isStillFresh = (oldValidFrom != null && oldValidFrom >= today) || (oldValidFrom == null && createdToday);
        if (isStillFresh) {
          await executor.update(customerBudgetTypeSettings)
            .set({
              enabled: s.enabled,
              priority: s.priority,
              monthlyLimitCents: s.monthlyLimitCents ?? null,
              yearlyLimitCents: s.yearlyLimitCents ?? null,
              validFrom: s.validFrom ?? oldValidFrom,
              validTo: s.validTo ?? null,
              updatedAt: sql`now()`,
            })
            .where(eq(customerBudgetTypeSettings.id, current.id));
          auditEntries.push({ kind: "in_place_update", budgetType: s.budgetType, before: current, after: s, nextValidFrom: s.validFrom ?? oldValidFrom });
        } else {
          await executor.update(customerBudgetTypeSettings)
            .set({ validTo: today, updatedAt: sql`now()` })
            .where(eq(customerBudgetTypeSettings.id, current.id));
          await executor.insert(customerBudgetTypeSettings).values({
            ...baseValues,
            validFrom: tomorrow,
          });
          auditEntries.push({ kind: "transition", budgetType: s.budgetType, before: current, after: s, nextValidFrom: tomorrow });
        }
      }
      // else: unverändert — kein Log, kein Insert.
    }

    // 3. Audit-Log pro Transition. FK auf users.id → bei fehlendem userId
    // schreiben wir nichts (synthetische IDs sind nicht möglich).
    if (userId != null) {
      for (const entry of auditEntries) {
        await auditService.log(userId, "budget_type_settings_transition", "budget", customerId, {
          customerId,
          budgetType: entry.budgetType,
          kind: entry.kind,
          previous: entry.before ? {
            enabled: entry.before.enabled,
            priority: entry.before.priority,
            monthlyLimitCents: entry.before.monthlyLimitCents,
            yearlyLimitCents: entry.before.yearlyLimitCents,
            validFrom: entry.before.validFrom,
            validTo: entry.before.validTo,
          } : null,
          next: entry.after ? {
            enabled: entry.after.enabled,
            priority: entry.after.priority,
            monthlyLimitCents: entry.after.monthlyLimitCents ?? null,
            yearlyLimitCents: entry.after.yearlyLimitCents ?? null,
            validFrom: entry.nextValidFrom,
            validTo: entry.after.validTo ?? null,
          } : null,
          closedAt: today,
        });
      }
    }

    return getActiveBudgetTypeSettings(customerId, today, executor);
  };

  if (tx) return run(tx);
  return db.transaction(run);
}
