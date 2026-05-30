import {
  customerBudgetPreferences,
  customerBudgetTypeSettings,
  type CustomerBudgetPreferences,
  type InsertBudgetPreferences,
  type CustomerBudgetTypeSetting,
} from "@shared/schema";
import { and, asc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { addDays, formatDateISO, todayISO } from "@shared/utils/datetime";
import { db } from "../../lib/db";
import type { DbClient } from "./types";
import { auditService } from "../../services/audit";

/**
 * Task #608 / #716: Backfill-Sentinel für `customer_budget_type_settings.validFrom`.
 * SSoT lebt in `shared/domain/budget-settings-sentinel.ts`; hier nur re-exportiert
 * für Rückwärts-Kompatibilität (interne Storage-Aufrufer).
 */
export { SETTINGS_VALID_FROM_EPOCH } from "@shared/domain/budget-settings-sentinel";

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
        budgetStartDateOrigin: preferences.budgetStartDateOrigin,
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
/** @deprecated Task #716 — bitte `readBudgetTypeSettings(c, { kind: "forDate", asOfDate })`. */
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
 * @deprecated Task #716 — bitte `readBudgetTypeSettings(c, { kind: "forDate", asOfDate: todayISO() })`
 * oder, wenn der Aufrufer einen historischen Stichtag hat, direkt mit dem konkreten
 * `asOfDate` aufrufen. Bleibt als Wrapper bestehen, damit Tests/Altcode kompilieren —
 * neue Aufrufer werden vom Architektur-Test geblockt.
 */
export async function getBudgetTypeSettings(customerId: number, _tx?: DbClient): Promise<CustomerBudgetTypeSetting[]> {
  return getActiveBudgetTypeSettings(customerId, todayISO(), _tx);
}

/**
 * Task #696 — Liefert pro `budgetType` die LATEST-INTENT-Zeile (die Zeile,
 * die nach Abschluss aller append-only Transitionen den künftigen Zustand
 * beschreibt). Für die UI-Bearbeitung der Topf-Einstellungen entscheidend,
 * weil eine echte Transition heute eine Konstellation hinterlässt, in der
 *
 *   - die alte Zeile `validTo = heute` trägt (also den heutigen Tag noch
 *     "abdeckt") und
 *   - die neue Zeile `validFrom = heute+1` trägt (also für `getActive*(today)`
 *     noch unsichtbar ist).
 *
 * `getBudgetTypeSettings(customerId)` (= active for today) würde in diesem
 * Fenster die ALTE Zeile inkl. transientem `validTo = heute` zurückgeben —
 * mit der Folge, dass der Admin "Gültig bis = heute" im Formular sieht,
 * leert, speichert, und der Save zum No-Op wird (die neue offene Zeile hat
 * `validTo = null` bereits, der Equality-Check erkennt nichts zu ändern).
 *
 * Diese Funktion ist read-only und ändert keine Historisierungs-Semantik:
 * Buchungspfade (`consumption-engine`, `import-availability`, Auto-Allocation)
 * nutzen weiterhin `getActiveBudgetTypeSettings(transactionDate)`. Hier
 * werden ausschließlich Display-/Edit-Pfade bedient.
 *
 * Auswahl-Logik pro `budgetType` (über alle Zeilen):
 *   1. Bevorzuge offene Zeilen (`validTo IS NULL`); unter mehreren offenen
 *      die jüngste nach `validFrom` (mit `NULL` als kleinstem Wert, damit
 *      eine später-erstellte explizit datierte Zeile gewinnt).
 *   2. Wenn keine offene Zeile existiert, nimm die Zeile mit dem spätesten
 *      `validFrom` (offene-Vorgänger-Reihen können geschlossen worden sein,
 *      Töpfe können explizit deaktiviert/abgeschlossen worden sein).
 *   3. Tie-Break: höchste `id` (jüngster Insert).
 */
/** @deprecated Task #716 — bitte `readBudgetTypeSettings(c, { kind: "forEdit" })`. */
export async function getLatestBudgetTypeSettings(
  customerId: number,
  _tx?: DbClient,
): Promise<CustomerBudgetTypeSetting[]> {
  const d = _tx ?? db;
  const all = await d.select()
    .from(customerBudgetTypeSettings)
    .where(eq(customerBudgetTypeSettings.customerId, customerId));

  const byType = new Map<string, CustomerBudgetTypeSetting>();
  const isOpen = (r: CustomerBudgetTypeSetting) => r.validTo == null;
  const vfRank = (r: CustomerBudgetTypeSetting) => r.validFrom ?? "0000-00-00";

  for (const r of all) {
    const incumbent = byType.get(r.budgetType);
    if (!incumbent) {
      byType.set(r.budgetType, r);
      continue;
    }
    // Schritt 1: offene Zeile schlägt geschlossene.
    if (isOpen(r) && !isOpen(incumbent)) {
      byType.set(r.budgetType, r);
      continue;
    }
    if (!isOpen(r) && isOpen(incumbent)) continue;
    // Beide offen oder beide geschlossen → spätestes validFrom gewinnt.
    const rVf = vfRank(r);
    const iVf = vfRank(incumbent);
    if (rVf > iVf || (rVf === iVf && r.id > incumbent.id)) {
      byType.set(r.budgetType, r);
    }
  }
  return Array.from(byType.values()).sort((a, b) => a.priority - b.priority);
}

/**
 * Task #703 — Snapshot der heute wirksamen Topf-Zeile (für UI-Übergangs-Erkennung).
 * Nur die Felder, die der UI helfen, einen nahtlosen Übergang von einer
 * heute-noch-aktiven Vorgänger-Zeile zur ab-morgen-gültigen Nachfolger-Zeile
 * zu erkennen. Keine GoBD-Semantik.
 */
export type EffectiveTodaySnapshot = {
  validFrom: string | null;
  validTo: string | null;
  enabled: boolean;
  monthlyLimitCents: number | null;
  yearlyLimitCents: number | null;
};

export type BudgetTypeSettingWithTransition = CustomerBudgetTypeSetting & {
  /**
   * Wenn gesetzt: Diese Latest-Intent-Zeile ist NOCH NICHT in Kraft (validFrom
   * liegt in der Zukunft), aber eine andere Zeile gleichen Topfs deckt den
   * heutigen Tag noch ab. Die UI nutzt das, um statt eines irreführenden
   * „Noch nicht aktiv"-Banners einen neutralen Übergangs-Hinweis zu zeigen.
   * Wenn null: Latest-Intent-Zeile ist selbst heute aktiv oder es gibt keinen
   * Vorgänger (echter Future-Start oder abgelaufen).
   */
  effectiveToday: EffectiveTodaySnapshot | null;
};

/**
 * Task #703 — Liefert wie {@link getLatestBudgetTypeSettings} pro Topf die
 * Latest-Intent-Zeile, ergänzt aber pro Eintrag um eine
 * `effectiveToday`-Momentaufnahme: die Zeile, die HEUTE tatsächlich gilt,
 * falls sie von der Latest-Intent-Zeile abweicht (typischer Fall: Admin
 * hat soeben gespeichert → alte Zeile läuft bis heute, neue Zeile gilt ab
 * morgen).
 *
 * Die Funktion ist read-only und teilt sich den Auswahl-Algorithmus mit
 * `getLatestBudgetTypeSettings`. Sie holt zusätzlich die zum heutigen
 * Datum aktive Zeile pro Topf und legt sie unter `effectiveToday` bei,
 * wenn sie eine andere ID hat als die Latest-Intent-Zeile.
 */
/** @deprecated Task #716 — bitte `readBudgetTypeSettings(c, { kind: "withTransition" })`. */
export async function getLatestBudgetTypeSettingsWithTransition(
  customerId: number,
  _tx?: DbClient,
): Promise<BudgetTypeSettingWithTransition[]> {
  const today = todayISO();
  const d = _tx ?? db;
  const [latest, activeToday] = await Promise.all([
    getLatestBudgetTypeSettings(customerId, d),
    getActiveBudgetTypeSettings(customerId, today, d),
  ]);
  const activeByType = new Map(activeToday.map(r => [r.budgetType, r]));
  return latest.map(row => {
    const effective = activeByType.get(row.budgetType);
    if (!effective || effective.id === row.id) {
      return { ...row, effectiveToday: null };
    }
    return {
      ...row,
      effectiveToday: {
        validFrom: effective.validFrom,
        validTo: effective.validTo,
        enabled: effective.enabled,
        monthlyLimitCents: effective.monthlyLimitCents,
        yearlyLimitCents: effective.yearlyLimitCents,
      },
    };
  });
}

/**
 * Task #716 (Phase 1.1) — Konsolidierter Lese-Einstiegspunkt für
 * `customer_budget_type_settings`.
 *
 * Genau EINE Funktion mit drei expliziten Modi statt vier separater Reads:
 *
 * - `{ kind: "forDate", asOfDate }` → liefert die zum Stichtag gültige
 *   Konfiguration. ZWINGEND für Buchungs-Pfade (consumption-engine,
 *   import-availability, rebook), damit GoBD-relevante Lookups mit
 *   `transactionDate` in der Vergangenheit nicht die heutige Konfig
 *   verwenden. Entspricht `getActiveBudgetTypeSettings(c, asOfDate)`.
 *
 * - `{ kind: "forEdit" }` → liefert pro Pot die jüngste Intent-Zeile, auch
 *   wenn sie erst morgen wirksam wird (Edit-/Settings-Form/Wizard).
 *   Entspricht `getLatestBudgetTypeSettings(c)`.
 *
 * - `{ kind: "withTransition" }` → Edit-Snapshot plus `effectiveToday`-
 *   Vorgänger pro Pot (UI-Übergangs-Banner).
 *   Entspricht `getLatestBudgetTypeSettingsWithTransition(c)`.
 *
 * Die vier alten Funktionen bleiben als `@deprecated`-Wrapper bestehen, damit
 * Bestandstests stabil bleiben — der Architektur-Test verhindert neue
 * Direkt-Aufrufe.
 */
export type SettingsReadMode =
  | { kind: "forDate"; asOfDate: string }
  | { kind: "forEdit" }
  | { kind: "withTransition" };

// Overloads statt Conditional-Type, weil TS bei Generics auf
// Discriminated-Unions die return-Variante nicht zuverlässig narrow'd —
// die Aufrufer brauchen aber die exakten Element-Typen (Sort/Filter etc.).
export function readBudgetTypeSettings(
  customerId: number,
  mode: { kind: "forDate"; asOfDate: string },
  tx?: DbClient,
): Promise<CustomerBudgetTypeSetting[]>;
export function readBudgetTypeSettings(
  customerId: number,
  mode: { kind: "forEdit" },
  tx?: DbClient,
): Promise<CustomerBudgetTypeSetting[]>;
export function readBudgetTypeSettings(
  customerId: number,
  mode: { kind: "withTransition" },
  tx?: DbClient,
): Promise<BudgetTypeSettingWithTransition[]>;
export function readBudgetTypeSettings(
  customerId: number,
  mode: SettingsReadMode,
  tx?: DbClient,
): Promise<CustomerBudgetTypeSetting[] | BudgetTypeSettingWithTransition[]> {
  if (mode.kind === "forDate") {
    return getActiveBudgetTypeSettings(customerId, mode.asOfDate, tx);
  }
  if (mode.kind === "forEdit") {
    return getLatestBudgetTypeSettings(customerId, tx);
  }
  return getLatestBudgetTypeSettingsWithTransition(customerId, tx);
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
 * Historisierte Aktualisierung der Topf-Konfiguration (Task #440 / GoBD,
 * Phasen-Append-Only-Fix Task #721).
 *
 * Vertrag (Append-Only, keine UPDATEs auf bereits in Kraft gewesene Zeilen
 * außer der `validTo`-Schließung):
 *
 * - Ohne explizites `validFrom` im Payload: alte offene Zeile pro
 *   `(customer, budgetType)` per `validTo = heute` schließen und neue Zeile
 *   mit `validFrom = heute+1` anlegen (klassischer Same-Day-Edit-Pfad).
 *   Erstanlage ohne `validFrom` speichert `validFrom = NULL` (rückwirkend
 *   gültig). Wurde die alte Zeile noch nie aktiv (Same-Day-Korrektur),
 *   wird sie in-place überschrieben statt eine Pseudo-Transition zu
 *   erzeugen.
 *
 * - Mit explizitem `validFrom` im Payload (Phasen-Schreibung, Task #721):
 *   Jeder Aufruf legt eine eigene Phase pro `validFrom` an. Über alle
 *   bestehenden Zeilen desselben Topfs wird der unmittelbare Vorgänger
 *   gesucht (max `validFrom < neuesValidFrom`, der den neuen Stichtag noch
 *   überdeckt) und auf `validTo = neuesValidFrom - 1` geschlossen. Falls
 *   eine bestehende Phase chronologisch HINTER der neuen liegt, wird die
 *   neue Phase mit `validTo = (nächstesValidFrom - 1)` eingeklemmt — keine
 *   überlappenden Gültigkeiten. Wird derselbe `validFrom` zweimal
 *   geschrieben, gewinnt die spätere Schreibung per in-place Update auf
 *   genau dieser Zeile (Phase war zum Zeitpunkt der ersten Schreibung
 *   bereits explizit datiert — typischerweise zukunftsdatiert und noch
 *   nicht in Kraft).
 *
 * - Aus dem Payload entfernte Töpfe werden geschlossen (validTo = heute),
 *   nicht gelöscht.
 * - Unveränderte Zeilen bleiben unangetastet (keine Pseudo-Transitionen).
 * - Jede Transition / Schließung / Erstanlage erzeugt einen Audit-Log-Eintrag
 *   (`budget_type_settings_transition`), falls ein userId vorliegt.
 *
 * Der partielle UNIQUE-Index `customer_budget_type_settings_unique_idx`
 * (`WHERE valid_to IS NULL`) stellt sicher, dass immer höchstens eine offene
 * Zeile pro `(customer, budgetType)` existiert. Beim Phasen-Append darf die
 * neue Zeile daher `validTo = null` nur dann tragen, wenn keine spätere
 * Phase existiert; andernfalls wird sie sofort durch die nächste Phase
 * begrenzt.
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
    const allRowsForCustomer = await executor.select()
      .from(customerBudgetTypeSettings)
      .where(eq(customerBudgetTypeSettings.customerId, customerId));

    const rowsByType = new Map<string, CustomerBudgetTypeSetting[]>();
    for (const r of allRowsForCustomer) {
      const list = rowsByType.get(r.budgetType);
      if (list) list.push(r); else rowsByType.set(r.budgetType, [r]);
    }
    const openRows = allRowsForCustomer.filter(r => r.validTo == null);
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

    // 2. Payload abarbeiten — Erstanlage, Phasen-Append, Same-Day-Edit, Transition oder No-Op.
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

      // Task #721 — Phasen-Append-Pfad: explizites validFrom aus dem Payload
      // bedeutet "neue Phase ab diesem Stichtag", NICHT "vorhandene Zeile
      // umdatieren". Wir suchen Vorgänger/Nachfolger über ALLE Zeilen des
      // Topfs (offene UND geschlossene), klemmen die neue Phase ein und
      // schließen den Vorgänger per `validTo = neuesValidFrom - 1`.
      //
      // Bedingung für diesen Pfad: explizites validFrom > heute UND
      // (kein current vorhanden ODER current trägt ein anderes validFrom).
      // - validFrom <= heute fällt durch in den Erstanlage-/In-Place-Pfad,
      //   damit Setup-Flows mit rückwirkendem Datum stabil bleiben.
      // - validFrom === current.validFrom ist ein Same-Phase-Edit; die
      //   Standardpfade behandeln das korrekt (In-Place wenn noch nie in
      //   Kraft, sonst Transition).
      const explicitVf = s.validFrom ?? null;
      const isPhaseAppend = explicitVf != null
        && explicitVf > today
        && (!current || (current.validFrom ?? null) !== explicitVf);

      if (isPhaseAppend) {
        const allOfType = rowsByType.get(s.budgetType) ?? [];
        const dayBefore = addDays(explicitVf, -1);

        // 0) Exakter Treffer auf validFrom (über ALLE Zeilen, nicht nur die
        //    offene): "Wird derselbe validFrom zweimal mit unterschiedlichen
        //    Werten geschickt, gewinnt die spätere Schreibung." Auch dann,
        //    wenn die Zeile inzwischen durch einen Nachfolger geschlossen
        //    wurde — wir aktualisieren die Felder in-place, validTo bleibt
        //    durch den Nachfolger weiterhin geklemmt.
        const exactMatch = allOfType.find(r => r.validFrom === explicitVf) ?? null;
        if (exactMatch) {
          if (!settingsEqual(exactMatch, s)) {
            await executor.update(customerBudgetTypeSettings)
              .set({
                enabled: s.enabled,
                priority: s.priority,
                monthlyLimitCents: s.monthlyLimitCents ?? null,
                yearlyLimitCents: s.yearlyLimitCents ?? null,
                // validTo NICHT überschreiben — bleibt entweder NULL (offene
                // letzte Phase) oder vom Nachfolger geklemmt.
                updatedAt: sql`now()`,
              })
              .where(eq(customerBudgetTypeSettings.id, exactMatch.id));
            auditEntries.push({ kind: "in_place_update", budgetType: s.budgetType, before: exactMatch, after: s, nextValidFrom: explicitVf });
          }
          continue;
        }

        // 1) Vorgänger = Zeile mit größtem validFrom < explicitVf, deren
        //    Gültigkeit den neuen Stichtag noch überdeckt. NULL-validFrom
        //    zählt als "rückwirkend ab Beginn" (= -∞) und ist ein gültiger
        //    Kandidat, wenn die Zeile noch offen ist oder bis >= explicitVf
        //    reicht. Ohne diese Behandlung würde eine offene NULL-Baseline
        //    nicht geschlossen → zwei offene Zeilen → Unique-Index-Verletzung.
        let predecessor: CustomerBudgetTypeSetting | null = null;
        for (const r of allOfType) {
          const rvf = r.validFrom;
          // Kandidaten-Filter: validFrom < explicitVf (NULL = -∞).
          if (rvf != null && rvf >= explicitVf) continue;
          // Coverage: validTo NULL ODER >= explicitVf.
          if (r.validTo != null && r.validTo < explicitVf) continue;
          if (!predecessor) {
            predecessor = r;
            continue;
          }
          // Größtes validFrom gewinnt. NULL ist immer kleiner als ein Datum.
          const pvf = predecessor.validFrom;
          if (pvf == null && rvf != null) predecessor = r;
          else if (pvf != null && rvf != null && pvf < rvf) predecessor = r;
        }

        // 2) Nachfolger = Zeile mit kleinstem validFrom > explicitVf.
        let successor: CustomerBudgetTypeSetting | null = null;
        for (const r of allOfType) {
          const rvf = r.validFrom;
          if (rvf == null || rvf <= explicitVf) continue;
          if (!successor || rvf < successor.validFrom!) successor = r;
        }

        // 3) Vorgänger schließen (idempotent: nur wenn die alte Schließung
        //    den neuen Stichtag noch überdeckt).
        if (predecessor && (predecessor.validTo == null || predecessor.validTo > dayBefore)) {
          await executor.update(customerBudgetTypeSettings)
            .set({ validTo: dayBefore, updatedAt: sql`now()` })
            .where(eq(customerBudgetTypeSettings.id, predecessor.id));
        }

        // 4) Neue Phase einklemmen: validTo aus Payload (falls gesetzt) ODER
        //    bis (Nachfolger.validFrom - 1) ODER offen.
        let newValidTo: string | null = s.validTo ?? null;
        if (successor) {
          const cap = addDays(successor.validFrom!, -1);
          if (newValidTo == null || newValidTo > cap) newValidTo = cap;
        }

        await executor.insert(customerBudgetTypeSettings).values({
          ...baseValues,
          validFrom: explicitVf,
          validTo: newValidTo,
        });
        auditEntries.push({ kind: "create", budgetType: s.budgetType, before: null, after: s, nextValidFrom: explicitVf });
        continue;
      }

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
        // Wichtig: lokale (Berlin-)Datums-Formatierung verwenden, NICHT
        // `toISOString().slice(0,10)` — letzteres liefert UTC und führt
        // nachts zwischen 00:00 und 02:00 Berlin-Zeit zu einem Off-by-One
        // (createdAt-UTC-Datum = gestern, today-Berlin = heute), wodurch
        // Same-day-Updates fälschlich als Transition erkannt würden.
        const createdToday = current.createdAt ? formatDateISO(current.createdAt) === today : false;
        // Task #608 (Revision nach Code-Review): Den Backfill-Sentinel
        // '1970-01-01' beim Edit NICHT in-place ersetzen — das hätte für
        // historische asOfDate-Lookups (`getActiveBudgetTypeSettings(date)`,
        // benötigt validFrom <= date) die einzige offene Zeile entfernt
        // und damit Buchungen aus der Vergangenheit ihrer Topf-Konfig
        // beraubt. Stattdessen läuft der Sentinel-Fall über den normalen
        // append-only Transitions-Pfad weiter unten (alte Zeile schließen
        // mit validTo=today, neue Zeile mit validFrom=tomorrow). Die
        // UI maskiert den Sentinel kosmetisch, der Edit wird ab morgen
        // wirksam — historische Lookups bleiben stabil.
        const isStillFresh = (oldValidFrom != null && oldValidFrom >= today)
          || (oldValidFrom == null && createdToday);
        if (isStillFresh) {
          // Task #754 (BUG-13) — PUT ohne explizites `validFrom` auf eine
          // offene Zeile, deren `validFrom` in der Zukunft liegt, bedeutet
          // semantisch „jetzt aktivieren". Vor dem Fix hat
          // `s.validFrom ?? oldValidFrom` das zukünftige Datum stur behalten,
          // sodass die gerade gespeicherten Werte (Monatslimit, enabled, …)
          // bis zum Stichtag UNSICHTBAR blieben und z.B. `monthly_auto` im
          // laufenden Monat keine Allocation mehr erzeugte. Wir ziehen die
          // Zeile in diesem Fall idempotent auf `today` vor — die Historie
          // bleibt korrekt, weil die alte Zukunfts-Konfiguration noch nie
          // „in Kraft" war (Konsumtions-Lookups arbeiten mit `validFrom <=
          // transactionDate`). Explizites `s.validFrom` aus dem Payload
          // hat weiterhin Vorrang.
          const pullForward = s.validFrom == null && oldValidFrom != null && oldValidFrom > today;
          const effectiveValidFrom = s.validFrom ?? (pullForward ? today : oldValidFrom);
          await executor.update(customerBudgetTypeSettings)
            .set({
              enabled: s.enabled,
              priority: s.priority,
              monthlyLimitCents: s.monthlyLimitCents ?? null,
              yearlyLimitCents: s.yearlyLimitCents ?? null,
              validFrom: effectiveValidFrom,
              validTo: s.validTo ?? null,
              updatedAt: sql`now()`,
            })
            .where(eq(customerBudgetTypeSettings.id, current.id));
          auditEntries.push({ kind: "in_place_update", budgetType: s.budgetType, before: current, after: s, nextValidFrom: effectiveValidFrom });
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
    // Same-day-in-place-Korrekturen werden NICHT als Transition geloggt
    // (Task #652): die alte Version war nie "in Kraft", es gibt also keine
    // historische Zustandsänderung — der Eintrag würde nur Audit-Rauschen
    // erzeugen.
    if (userId != null) {
      for (const entry of auditEntries) {
        if (entry.kind === "in_place_update") continue;
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

/**
 * Task #608: Setzt die Legacy-Felder `initial_balance_cents` / `initial_balance_month`
 * auf der aktuell offenen (validTo IS NULL) Settings-Zeile auf NULL.
 *
 * Wird vom DELETE-Pfad einer §45b-Startwert-/Carryover-Allokation aufgerufen,
 * damit eine spätere Re-Materialisierung nicht erneut einen Geister-Übertrag
 * aus diesen Spalten erzeugt. GoBD-konform: KEIN Schließen+Insert einer neuen
 * Zeile (die fachlichen Felder enabled/priority/monthlyLimit ändern sich
 * nicht), nur ein in-place UPDATE der reinen Legacy-Spalten + Audit-Eintrag,
 * wenn überhaupt etwas zu clearen ist (Idempotenz).
 *
 * Liefert `true` zurück, wenn tatsächlich ein Wert genullt wurde.
 */
export async function clearLegacyInitialBalanceFromSettings(
  customerId: number,
  budgetType: string,
  tx: DbClient,
  userId?: number,
): Promise<boolean> {
  const openRows = await tx.select()
    .from(customerBudgetTypeSettings)
    .where(and(
      eq(customerBudgetTypeSettings.customerId, customerId),
      eq(customerBudgetTypeSettings.budgetType, budgetType),
      isNull(customerBudgetTypeSettings.validTo),
    ));
  const current = openRows[0];
  if (!current) return false;
  if (current.initialBalanceCents == null && current.initialBalanceMonth == null) return false;

  await tx.update(customerBudgetTypeSettings)
    .set({ initialBalanceCents: null, initialBalanceMonth: null, updatedAt: sql`now()` })
    .where(eq(customerBudgetTypeSettings.id, current.id));

  if (userId != null) {
    await auditService.log(userId, "budget_type_settings_initial_balance_cleared", "budget", customerId, {
      customerId,
      budgetType,
      settingsId: current.id,
      previous: {
        initialBalanceCents: current.initialBalanceCents,
        initialBalanceMonth: current.initialBalanceMonth,
      },
      reason: "Task #608: Carryover-/Startwert-Allokation gelöscht — Legacy-Felder neutralisiert, damit der nächste Recompute keinen Geister-Übertrag wiederbelebt.",
    });
  }
  return true;
}
