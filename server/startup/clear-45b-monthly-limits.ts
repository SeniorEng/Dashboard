import { db } from "../lib/db";
import { sql, eq, and, isNotNull, asc } from "drizzle-orm";
import { log } from "../lib/log";
import { auditService } from "../services/audit";
import { customerBudgetTypeSettings, users } from "@shared/schema";

/**
 * Task #425 — §45b Entlastungsbetrag wird vom Monats-Cap auf einen Jahrestopf
 * mit monatlicher Aufstockung umgestellt.
 *
 * Diese einmalige Migration setzt den veralteten `monthly_limit_cents`-Wert
 * für alle §45b-Topfkonfigurationen auf NULL. Der Wert wird seit der
 * Umstellung in Backend (cap-calculator, summary-queries) und Frontend
 * (BudgetTypeSettings) ohnehin nicht mehr ausgewertet — wir leeren ihn
 * trotzdem, damit Datenbestand und UI-Anzeige konsistent bleiben.
 *
 * Pro betroffenem Kunden wird ein Audit-Log-Eintrag
 * (`budget_type_settings_updated`) mit dem alten und neuen Wert geschrieben,
 * damit die Bereinigung GoBD-konform nachvollziehbar bleibt.
 *
 * Idempotent: Greift nur, solange noch §45b-Zeilen mit gesetztem
 * monthly_limit_cents existieren.
 */
export async function clear45bMonthlyLimits(): Promise<void> {
  const affected = await db
    .select({
      id: customerBudgetTypeSettings.id,
      customerId: customerBudgetTypeSettings.customerId,
      monthlyLimitCents: customerBudgetTypeSettings.monthlyLimitCents,
    })
    .from(customerBudgetTypeSettings)
    .where(and(
      eq(customerBudgetTypeSettings.budgetType, "entlastungsbetrag_45b"),
      isNotNull(customerBudgetTypeSettings.monthlyLimitCents),
    ));

  if (affected.length === 0) return;

  // Realer Audit-Akteur: bevorzugt SuperAdmin, sonst Admin. Ohne Akteur wird
  // die Migration zwar ausgeführt, aber das Audit-Log nur ins Server-Log
  // geschrieben (Foreign Key auf users.id verbietet synthetische IDs).
  const [superActor] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isSuperAdmin, true))
    .orderBy(asc(users.id))
    .limit(1);
  let actorId: number | null = superActor?.id ?? null;
  if (actorId == null) {
    const [adminActor] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isAdmin, true))
      .orderBy(asc(users.id))
      .limit(1);
    actorId = adminActor?.id ?? null;
  }

  const result = await db.execute(sql`
    UPDATE customer_budget_type_settings
    SET monthly_limit_cents = NULL,
        updated_at = NOW()
    WHERE budget_type = 'entlastungsbetrag_45b'
      AND monthly_limit_cents IS NOT NULL
  `);

  const rowCount = (result as { rowCount?: number }).rowCount ?? affected.length;

  let auditedCount = 0;
  if (actorId != null) {
    for (const row of affected) {
      try {
        await auditService.log(
          actorId,
          "budget_type_settings_updated",
          "budget",
          row.customerId,
          {
            customerId: row.customerId,
            budgetType: "entlastungsbetrag_45b",
            field: "monthlyLimitCents",
            previousMonthlyLimitCents: row.monthlyLimitCents,
            newMonthlyLimitCents: null,
            reason: "Task #425 — §45b Jahrestopf-Umstellung (Monats-Cap entfernt)",
            migration: "clear-45b-monthly-limits",
          },
        );
        auditedCount++;
      } catch (err) {
        log(
          `[clear-45b-monthly-limits] Audit-Log für Kunde ${row.customerId} fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
          "startup",
        );
      }
    }
  } else {
    log(
      "[clear-45b-monthly-limits] Kein Audit-Akteur (Super-/Admin) gefunden — Audit-Log wird übersprungen.",
      "startup",
    );
  }

  log(
    `§45b auf Jahrestopf-Modell umgestellt: monthly_limit_cents in ${rowCount} customer_budget_type_settings-Zeile(n) auf NULL gesetzt; ${auditedCount}/${affected.length} Audit-Log-Einträge geschrieben (Task #425).`,
    "startup",
  );
}
