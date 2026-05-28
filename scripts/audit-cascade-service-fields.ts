/**
 * Task #723 — Read-only Audit: appointments mit Σ-Drift bei
 * Service-Felder über alle Cascade-Konsum-Transaktionen.
 *
 * Iteriert über alle Termine, für die mindestens eine
 * `budget_transactions.transactionType='consumption'`-Tx existiert, und
 * summiert hauswirtschaftCents / alltagsbegleitungCents / travelCents /
 * customerKilometersCents pro Termin. Vor Task #723 hatten Cascade-
 * Folge-Töpfe (z.B. `umwandlung_45a` nach §45b-Erschöpfung) diese
 * Felder als NULL, sodass Σlegs ≠ appointment.<feld>Cents.
 *
 * Reine Diagnose. KEIN Schreibzugriff. Hostname-Guard analog
 * `audit-invoice-line-items.ts` — Produktion benötigt `--allow-prod`.
 *
 * Aufruf:
 *   npx tsx scripts/audit-cascade-service-fields.ts
 *   npx tsx scripts/audit-cascade-service-fields.ts --allow-prod
 */
import { db } from "../server/lib/db";
import { appointments, budgetTransactions } from "@shared/schema";
import { eq, sql, isNotNull } from "drizzle-orm";

function isProdHost(): boolean {
  const url = process.env.DATABASE_URL ?? "";
  return /neon\.tech|prod|production/i.test(url) && !/test|dev|staging/i.test(url);
}

async function main() {
  const allowProd = process.argv.includes("--allow-prod");
  if (isProdHost() && !allowProd) {
    console.error(
      "REFUSE: DATABASE_URL sieht nach Produktion aus. " +
        "Mit --allow-prod erneut aufrufen, wenn das beabsichtigt ist.",
    );
    process.exit(2);
  }

  // Pro Termin die Σ aller Konsum-Tx-Service-Felder + den Termin-Wert.
  const rows = await db
    .select({
      appointmentId: budgetTransactions.appointmentId,
      txCount: sql<number>`COUNT(*)::int`,
      sumHwCents: sql<number>`COALESCE(SUM(${budgetTransactions.hauswirtschaftCents}), 0)::bigint`,
      sumAbCents: sql<number>`COALESCE(SUM(${budgetTransactions.alltagsbegleitungCents}), 0)::bigint`,
      sumTvCents: sql<number>`COALESCE(SUM(${budgetTransactions.travelCents}), 0)::bigint`,
      sumCkCents: sql<number>`COALESCE(SUM(${budgetTransactions.customerKilometersCents}), 0)::bigint`,
    })
    .from(budgetTransactions)
    .where(
      sql`${budgetTransactions.transactionType} = 'consumption' AND ${budgetTransactions.appointmentId} IS NOT NULL`,
    )
    .groupBy(budgetTransactions.appointmentId);

  // Erwartete Termin-Werte aus dem Cost-Calculator hinzuziehen ist teuer
  // (jeder Aufruf liest Preise & Settings). Wir nutzen stattdessen das
  // einfache strukturelle Signal: Termine mit mehr als einer Konsum-Tx,
  // bei denen mindestens eine Tx NULL in einem Service-Feld hat,
  // während eine andere einen Wert hat → klassisches #723-Drift-Muster.
  const multiLeg = rows.filter((r) => Number(r.txCount) >= 2);

  const drifts: Array<{
    appointmentId: number;
    txCount: number;
    nullHw: number; nullAb: number; nullTv: number; nullCk: number;
    setHw: number; setAb: number; setTv: number; setCk: number;
  }> = [];

  for (const r of multiLeg) {
    if (r.appointmentId == null) continue;
    const legs = await db
      .select({
        hw: budgetTransactions.hauswirtschaftCents,
        ab: budgetTransactions.alltagsbegleitungCents,
        tv: budgetTransactions.travelCents,
        ck: budgetTransactions.customerKilometersCents,
      })
      .from(budgetTransactions)
      .where(
        sql`${budgetTransactions.transactionType} = 'consumption' AND ${budgetTransactions.appointmentId} = ${r.appointmentId}`,
      );

    let nullHw = 0, nullAb = 0, nullTv = 0, nullCk = 0;
    let setHw = 0, setAb = 0, setTv = 0, setCk = 0;
    for (const leg of legs) {
      if (leg.hw == null) nullHw++; else setHw++;
      if (leg.ab == null) nullAb++; else setAb++;
      if (leg.tv == null) nullTv++; else setTv++;
      if (leg.ck == null) nullCk++; else setCk++;
    }

    // Drift-Indikator: mindestens eine Tx hat einen Service-Feld-Wert,
    // eine andere hat NULL — das ist die #723-Signatur.
    const fieldMixed =
      (setHw > 0 && nullHw > 0) ||
      (setAb > 0 && nullAb > 0) ||
      (setTv > 0 && nullTv > 0) ||
      (setCk > 0 && nullCk > 0);

    if (fieldMixed) {
      drifts.push({
        appointmentId: r.appointmentId,
        txCount: Number(r.txCount),
        nullHw, nullAb, nullTv, nullCk,
        setHw, setAb, setTv, setCk,
      });
    }
  }

  console.log(`Geprüft: ${rows.length} Termine mit Konsum-Tx (davon ${multiLeg.length} mit ≥2 Legs).`);
  console.log(`Drift-Treffer (Task #723 Signatur "Service-Feld in Folge-Topf NULL"): ${drifts.length}`);
  if (drifts.length > 0) {
    console.table(drifts.slice(0, 50));
    if (drifts.length > 50) console.log(`… (${drifts.length - 50} weitere ausgelassen)`);
  }

  process.exit(drifts.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Audit fehlgeschlagen:", err);
  process.exit(2);
});
