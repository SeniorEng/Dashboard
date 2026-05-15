import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Task #510 — Karteileichen-Prävention: ein Kunde darf nur dann den Status
 * `erstberatung` tragen, wenn er nachweislich aus einem Prospect entstanden
 * ist (`converted_from_prospect_id IS NOT NULL`). Andernfalls sammeln sich
 * Waisen ohne Lead-Bezug an, die in Übersichten als "in Erstberatung"
 * erscheinen, obwohl sie nie aus einem Lead konvertiert wurden.
 *
 * Soft-gelöschte Zeilen sind vom CHECK ausgenommen, damit historische
 * Karteileichen (die per Bereinigungs-Task auf `deleted_at = NOW()` gesetzt
 * werden) das Constraint nicht blocken.
 *
 * Idempotent: prüft erst, ob das Constraint existiert; wenn nicht, prüft es,
 * ob es lebende Verletzer gibt. Solange noch Waisen existieren, überspringt
 * es den ALTER TABLE und meldet die Anzahl im Log — die separate Bereinigung
 * räumt erst auf.
 */
export async function ensureErstberatungProspectLinkConstraint(): Promise<void> {
  const existing = await db.execute(sql`
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE c.conname = 'customers_erstberatung_requires_prospect_check'
      AND t.relname = 'customers'
  `);

  if ((existing.rows as unknown[]).length > 0) {
    return;
  }

  const violating = await db.execute(sql`
    SELECT COUNT(*) as cnt FROM customers
    WHERE status = 'erstberatung'
      AND converted_from_prospect_id IS NULL
      AND deleted_at IS NULL
  `);
  const violatingCount = Number((violating.rows as Array<{ cnt: string }>)[0]?.cnt ?? 0);

  if (violatingCount > 0) {
    log(
      `CHECK-Constraint customers_erstberatung_requires_prospect_check übersprungen: ${violatingCount} lebende Kunden mit Status 'erstberatung' ohne Prospect-Bezug gefunden`,
      "startup",
    );
    return;
  }

  await db.execute(sql`
    ALTER TABLE customers
    ADD CONSTRAINT customers_erstberatung_requires_prospect_check
    CHECK (
      status <> 'erstberatung'
      OR converted_from_prospect_id IS NOT NULL
      OR deleted_at IS NOT NULL
    )
  `);
  log(
    "CHECK-Constraint customers_erstberatung_requires_prospect_check hinzugefügt",
    "startup",
  );
}
