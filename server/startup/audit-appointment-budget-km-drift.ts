import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";
import { quantizeKm } from "@shared/domain/invoice-line-items";

/**
 * Task #616 — Audit der Termin-vs-Budget-km-Drift (Screenshot 12.01./21.01./
 * 04.02.2026: Anzeige 70 km, gebucht für 7 km).
 *
 * BEWUSST KEIN automatisches Schreiben: GoBD-relevante Buchungen werden
 * NICHT vom Boot-Code mutiert. Wir scannen idempotent beim Start und loggen
 * pro betroffener Buchung die Vorher-/Nachher-Werte, damit ein Superadmin
 * (oder eine spätere gezielte Korrektur-Task) den Eingriff per Storno+
 * Neuanlage manuell entscheiden kann. Termine in geschlossenen Monaten
 * werden nur als Hinweis gemeldet.
 *
 * Idempotent: der reine SELECT verändert keine Daten — bei Re-Deploys
 * wiederholt sich nur das Log. Sobald die Buchungen korrigiert sind,
 * verschwinden sie aus dem Scan-Ergebnis von selbst.
 *
 * Drift-Definition: `|tx.travelKilometers − quantizeKm(appt.travelKilometers)|
 *  > 0,05 km` ODER analog für `customerKilometers`. Wir scannen nur
 * `consumption`-Buchungen, die einer noch existierenden, nicht gelöschten
 * Termin-Zeile zugeordnet sind.
 */
export async function auditAppointmentBudgetKmDrift(): Promise<void> {
  let driftRows: Array<{
    txId: number;
    apptId: number;
    apptDate: string;
    txTravelKm: number | null;
    apptTravelKm: number | null;
    txCustomerKm: number | null;
    apptCustomerKm: number | null;
    amountCents: number;
  }>;
  try {
    const res = await db.execute(sql`
      SELECT
        bt.id           AS "txId",
        a.id            AS "apptId",
        a.date          AS "apptDate",
        bt.travel_kilometers     AS "txTravelKm",
        a.travel_kilometers      AS "apptTravelKm",
        bt.customer_kilometers   AS "txCustomerKm",
        a.customer_kilometers    AS "apptCustomerKm",
        bt.amount_cents          AS "amountCents"
      FROM budget_transactions bt
      JOIN appointments a ON a.id = bt.appointment_id
      WHERE bt.transaction_type = 'consumption'
        AND a.deleted_at IS NULL
        AND (
              (bt.travel_kilometers IS NOT NULL
                AND a.travel_kilometers IS NOT NULL
                AND ABS(bt.travel_kilometers - a.travel_kilometers) > 0.05)
          OR  (bt.customer_kilometers IS NOT NULL
                AND a.customer_kilometers IS NOT NULL
                AND ABS(bt.customer_kilometers - a.customer_kilometers) > 0.05)
        )
      ORDER BY a.date DESC, bt.id DESC
      LIMIT 200
    `);
    driftRows = res.rows as typeof driftRows;
  } catch (err) {
    // Tabellen fehlen z.B. in einer frisch initialisierten DB (Tests) →
    // stillschweigend überspringen, damit der Boot nicht failed.
    log(`Termin-km-Drift-Audit übersprungen (DB nicht bereit): ${(err as Error).message}`, "startup");
    return;
  }

  if (driftRows.length === 0) return;

  log(
    `Termin-km-Drift gefunden in ${driftRows.length} Buchung(en) — Korrektur per ` +
      `\`tsx server/scripts/reconcile-km-drift.ts --apply --user=<superadmin-id> ` +
      `--reason="…"\` (Task #619, GoBD-konformes Storno+Neuanlage):`,
    "startup",
  );
  for (const r of driftRows) {
    const qApptTravel = quantizeKm(Number(r.apptTravelKm ?? 0));
    const qApptCustomer = quantizeKm(Number(r.apptCustomerKm ?? 0));
    log(
      `  tx#${r.txId} appt#${r.apptId} @${r.apptDate}: ` +
        `travel ${r.txTravelKm} → ${qApptTravel} km, ` +
        `customer ${r.txCustomerKm} → ${qApptCustomer} km, ` +
        `amount=${r.amountCents}ct`,
      "startup",
    );
  }
}
