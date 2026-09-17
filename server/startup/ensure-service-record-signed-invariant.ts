import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Ticket 6hWgf8W5hRq8W99G — Invariante:
 * `status = 'completed'` ⇒ `customer_signed_at IS NOT NULL`.
 *
 * ── Warum als Invariante und nicht als Reparatur einer Aufrufstelle ───────
 * Der Zustand ist real: am 17.09.2026 standen in Prod **42 Leistungsnachweise
 * bei 39 Kunden** auf `completed` ohne Kundenunterschrift. Erzeugt hat sie der
 * Altdaten-Import (`createServiceRecordsForImported`), der den Status hart
 * setzt, ohne Zeitstempel und ohne Signaturdaten.
 *
 * Diese eine Aufrufstelle zu reparieren würde die KLASSE nicht schließen.
 * `updateServiceRecord(id, data)` (`server/storage/service-records-storage.ts`)
 * ist ein vollkommen generischer Setter auf `IStorage` — er *kann* jederzeit
 * `status: 'completed'` ohne Zeitstempel schreiben. Dass das heute nur aus
 * einem Pfad kommt, ist eine Eigenschaft der heutigen Aufrufer, keine
 * Garantie. Die Datenbank soll die Garantie geben, nicht die Sorgfalt.
 *
 * Warum der Zustand teuer ist: `isServiceRecordSignedForBilling`
 * (`shared/domain/billing-eligibility.ts`) liest **nur den Status**, nie den
 * Zeitstempel. Für Pflegekasse ist `completed` das strenge Gate — gerade weil
 * die Kundenunterschrift der Kassen-Nachweis ist. Ein solcher Nachweis
 * passiert es, während der LN-Renderer ihn mangels Signaturdaten als „noch
 * nicht unterschrieben" ausweist. Beleg bei der Kasse ohne Unterschrift in der
 * Anlage.
 *
 * ── Warum NOT VALID ──────────────────────────────────────────────────────
 * Die 42 Bestandszeilen VERLETZEN die Invariante. Drei Wege standen zur Wahl:
 *
 *   • `NOT VALID`          — gilt für neue und geänderte Zeilen, Bestand
 *                            bleibt unberührt.
 *   • nur Wächter-Test     — kein Riegel in der DB.
 *   • Constraint mit einer Ausnahme für die bekannten 42 — macht den Bestand
 *                            permanent und schreibt ihn ins Schema.
 *
 * Gewählt ist `NOT VALID` (Weiche Alrik, 17.09.2026). Der Bestand bleibt
 * dokumentierte Altlast — das Protokoll dazu ist
 * `docs/corrections/2026-09-17_42er-unsignierte-nachweise-kassenbelege.md`.
 * Neue Fälle sind strukturell ausgeschlossen.
 *
 * WICHTIG und oft missverstanden: `NOT VALID` heißt NICHT „inaktiv". Postgres
 * prüft die Bedingung ab sofort bei jedem INSERT und bei jedem UPDATE einer
 * Zeile — es unterlässt nur den einmaligen Vollscan über den Bestand. Eine der
 * 42 Zeilen anzufassen löst die Prüfung also aus, und das ist gewollt: wer sie
 * anfasst, soll sie in Ordnung bringen.
 *
 * Wird der Bestand später bereinigt, macht ein
 * `ALTER TABLE … VALIDATE CONSTRAINT …` die Invariante rückwirkend scharf —
 * ohne die Constraint neu anzulegen.
 *
 * ── Warum die Bestandszeilen NICHT gezählt und übersprungen werden ────────
 * Das Muster von `ensure-budget-tx-appointment-constraint.ts` (verletzende
 * Zeilen zählen, bei Treffern SKIP) wäre hier falsch: es würde die Constraint
 * genau so lange NICHT anlegen, wie sie gebraucht wird. `NOT VALID` löst das
 * Problem, das dort zum SKIP führte.
 */

export const SERVICE_RECORD_SIGNED_CHECK_NAME =
  "monthly_service_records_completed_requires_signature_check";

export const SERVICE_RECORD_SIGNED_CHECK_SQL = `
    ALTER TABLE monthly_service_records
    ADD CONSTRAINT ${SERVICE_RECORD_SIGNED_CHECK_NAME}
    CHECK (status <> 'completed' OR customer_signed_at IS NOT NULL)
    NOT VALID
  `;

/** Idempotent: existiert die Constraint, passiert nichts. */
export async function ensureServiceRecordSignedInvariant(): Promise<void> {
  const existing = await db.execute(sql`
    SELECT 1 FROM pg_constraint
    WHERE conname = ${SERVICE_RECORD_SIGNED_CHECK_NAME}
      AND conrelid = 'monthly_service_records'::regclass
  `);
  if (existing.rows.length > 0) return;

  // Der Bestand wird gezählt und GEMELDET, aber er blockiert nichts — das ist
  // der Unterschied zum SKIP-Muster. Die Zahl gehört ins Log, damit sichtbar
  // bleibt, wie groß die Altlast ist, gegen die `NOT VALID` schützt.
  const violating = await db.execute(sql`
    SELECT count(*)::int AS n FROM monthly_service_records
    WHERE deleted_at IS NULL
      AND status = 'completed'
      AND customer_signed_at IS NULL
  `);
  const n = Number((violating.rows[0] as Record<string, unknown>).n ?? 0);

  await db.execute(sql.raw(SERVICE_RECORD_SIGNED_CHECK_SQL));

  log(
    n === 0
      ? `Invariante \`completed ⇒ customer_signed_at\` angelegt (NOT VALID, kein Altbestand).`
      : `Invariante \`completed ⇒ customer_signed_at\` angelegt (NOT VALID). `
        + `${n} Bestandszeilen verletzen sie und bleiben unberührt — `
        + `siehe docs/corrections/2026-09-17_42er-unsignierte-nachweise-kassenbelege.md`,
    "startup",
  );
}

/**
 * Self-Check gegen die LAUFENDE DB — dasselbe Muster wie
 * `assertAuditLogImmutable`: nach einem Restore oder einem fehlgeschlagenen
 * Migrationsschritt soll im Log stehen, ob der Riegel wirklich da ist.
 * Wirft nicht; ein fehlender Riegel darf keinen Boot verhindern.
 */
export async function assertServiceRecordSignedInvariant(): Promise<boolean> {
  const r = await db.execute(sql`
    SELECT convalidated FROM pg_constraint
    WHERE conname = ${SERVICE_RECORD_SIGNED_CHECK_NAME}
      AND conrelid = 'monthly_service_records'::regclass
  `);
  if (r.rows.length === 0) {
    log(
      `WARNUNG: Invariante \`${SERVICE_RECORD_SIGNED_CHECK_NAME}\` fehlt — `
      + "ein Leistungsnachweis kann auf `completed` gesetzt werden, ohne dass "
      + "der Kunde unterschrieben hat.",
      "startup",
    );
    return false;
  }
  const validated = (r.rows[0] as Record<string, unknown>).convalidated === true;
  log(
    `Invariante \`completed ⇒ customer_signed_at\` aktiv`
    + (validated ? " (validiert, auch der Bestand erfüllt sie)." : " (NOT VALID, Altbestand ausgenommen)."),
    "startup",
  );
  return true;
}
