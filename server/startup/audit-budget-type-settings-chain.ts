import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Task #721 — Idempotenter Startup-Audit für die Phasen-Historisierung von
 * `customer_budget_type_settings`.
 *
 * Hintergrund: vor dem Phasen-Append-Fix konnte ein `PUT /type-settings` mit
 * neuem `validFrom` eine bestehende offene Zeile in-place überschreiben.
 * Folge: einzelne Kunden können in der Datenbank Phasen-Drift haben
 * (überlappende Gültigkeit, mehrere offene Zeilen pro Topf, oder Lücken
 * zwischen Phasen).
 *
 * Dieser Hook MUTIERT NICHTS — er protokolliert nur. Wiederherstellen
 * verlorener Phasen ist nicht möglich (die ursprünglichen Werte wurden vom
 * UPDATE überschrieben) und wäre GoBD-relevant; daher bleibt die Korrektur
 * eine bewusste Operator-Entscheidung. Der Audit dient als Frühwarnsystem,
 * dass solcher Drift in Zukunft auftritt.
 *
 * Drei Drift-Klassen werden geprüft:
 *   1. Mehr als eine offene (`valid_to IS NULL`) Zeile pro (customer, type).
 *      Sollte durch den partiellen UNIQUE-Index ausgeschlossen sein — wenn
 *      doch, ist es ein harter Datenfehler.
 *   2. Überlappende Phasen pro (customer, type): zwei Zeilen mit
 *      `validFrom_a <= validFrom_b` und (`validTo_a IS NULL OR validTo_a >= validFrom_b`).
 *   3. Lücken zwischen aufeinanderfolgenden Phasen: eine geschlossene Zeile
 *      mit `validTo + 1 day < nextValidFrom`.
 */
export async function auditBudgetTypeSettingsChain(): Promise<void> {
  // Mehrere offene Zeilen pro Topf (sollte unmöglich sein dank partiellem UNIQUE).
  const multiOpen = await db.execute(sql`
    SELECT customer_id, budget_type, COUNT(*)::int AS open_count
    FROM customer_budget_type_settings
    WHERE valid_to IS NULL
    GROUP BY customer_id, budget_type
    HAVING COUNT(*) > 1
    ORDER BY customer_id, budget_type
    LIMIT 50
  `);
  const multiOpenRows = (multiOpen as unknown as { rows: Array<{ customer_id: number; budget_type: string; open_count: number }> }).rows;
  if (multiOpenRows.length > 0) {
    log(
      `Budget-Settings-Chain-Audit (Task #721): ${multiOpenRows.length} (customer, budget_type)-Paare mit MEHR als einer offenen Zeile gefunden (partieller UNIQUE-Index sollte das verhindern) — erste Treffer: ${multiOpenRows
        .slice(0, 5)
        .map(r => `${r.customer_id}/${r.budget_type}=${r.open_count}`)
        .join(", ")}`,
      "startup",
    );
  }

  // Überlappende Phasen.
  const overlaps = await db.execute(sql`
    SELECT a.customer_id, a.budget_type, a.id AS a_id, b.id AS b_id,
           a.valid_from AS a_from, a.valid_to AS a_to,
           b.valid_from AS b_from, b.valid_to AS b_to
    FROM customer_budget_type_settings a
    JOIN customer_budget_type_settings b
      ON b.customer_id = a.customer_id
     AND b.budget_type = a.budget_type
     AND b.id <> a.id
     AND b.valid_from IS NOT NULL
     AND a.valid_from IS NOT NULL
     AND a.valid_from <= b.valid_from
     AND (a.valid_to IS NULL OR a.valid_to >= b.valid_from)
    ORDER BY a.customer_id, a.budget_type, a.valid_from
    LIMIT 50
  `);
  const overlapRows = (overlaps as { rows: Array<Record<string, unknown>> }).rows;
  if (overlapRows.length > 0) {
    log(
      `Budget-Settings-Chain-Audit (Task #721): ${overlapRows.length} überlappende Phasen-Paare in customer_budget_type_settings gefunden — manuelle Prüfung erforderlich, keine Auto-Korrektur (GoBD).`,
      "startup",
    );
  }

  // Lücken zwischen aufeinanderfolgenden Phasen.
  const gaps = await db.execute(sql`
    WITH ordered AS (
      SELECT id, customer_id, budget_type, valid_from, valid_to,
             LEAD(valid_from) OVER (
               PARTITION BY customer_id, budget_type
               ORDER BY valid_from NULLS FIRST, id
             ) AS next_from
      FROM customer_budget_type_settings
      WHERE valid_from IS NOT NULL
    )
    SELECT customer_id, budget_type, id, valid_to, next_from
    FROM ordered
    WHERE valid_to IS NOT NULL
      AND next_from IS NOT NULL
      AND (valid_to + INTERVAL '1 day')::date < next_from
    ORDER BY customer_id, budget_type, valid_to
    LIMIT 50
  `);
  const gapRows = (gaps as { rows: Array<Record<string, unknown>> }).rows;
  if (gapRows.length > 0) {
    log(
      `Budget-Settings-Chain-Audit (Task #721): ${gapRows.length} Phasen-Lücken (validTo+1 < nextValidFrom) gefunden — kann legitim sein (Topf war zwischendurch deaktiviert), aber Stichprobe empfohlen.`,
      "startup",
    );
  }
}
