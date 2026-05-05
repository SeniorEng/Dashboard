import { sql } from "drizzle-orm";
import { db } from "../../lib/db";

const MONTH_NAMES_DE = [
  "", "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

export interface AlertItem {
  severity: "rot" | "gelb" | "gruen";
  title: string;
  description: string;
  count: number;
  link?: string;
}

export async function getOperationsAlerts(): Promise<AlertItem[]> {
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;
  const prevM = curMonth === 1 ? 12 : curMonth - 1;
  const prevMYear = curMonth === 1 ? curYear - 1 : curYear;
  const threeDaysAgoDate = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const threeDaysAgo = `${threeDaysAgoDate.getFullYear()}-${String(threeDaysAgoDate.getMonth() + 1).padStart(2, "0")}-${String(threeDaysAgoDate.getDate()).padStart(2, "0")}`;

  const [undocumented, budgetOverspend, noAppointments, missingRecords, newCustomers] = await Promise.all([
    db.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM appointments a
      WHERE a.deleted_at IS NULL
        AND a.status = 'completed'
        AND a.date::date < ${threeDaysAgo}::date
    `),
    db.execute(sql`
      SELECT COUNT(DISTINCT sub.customer_id)::int AS count
      FROM (
        SELECT ba.customer_id,
          COALESCE(SUM(ba.amount_cents), 0) AS allocated,
          COALESCE(ABS((
            SELECT SUM(bt.amount_cents)
            FROM budget_transactions bt
            WHERE bt.customer_id = ba.customer_id
              AND bt.budget_type = 'entlastungsbetrag_45b'
              AND bt.transaction_type = 'consumption'
              AND EXTRACT(YEAR FROM bt.transaction_date::date) = ${curYear}
          )), 0) AS used
        FROM budget_allocations ba
        WHERE ba.budget_type = 'entlastungsbetrag_45b'
          AND ba.year = ${curYear}
        GROUP BY ba.customer_id
        HAVING COALESCE(ABS((
          SELECT SUM(bt.amount_cents)
          FROM budget_transactions bt
          WHERE bt.customer_id = ba.customer_id
            AND bt.budget_type = 'entlastungsbetrag_45b'
            AND bt.transaction_type = 'consumption'
            AND EXTRACT(YEAR FROM bt.transaction_date::date) = ${curYear}
        )), 0) > COALESCE(SUM(ba.amount_cents), 0)
      ) sub
    `),
    db.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM customers c
      WHERE c.status = 'aktiv' AND c.deleted_at IS NULL
        AND c.id NOT IN (
          SELECT DISTINCT a.customer_id
          FROM appointments a
          WHERE a.deleted_at IS NULL
            AND a.status != 'cancelled'
            AND EXTRACT(YEAR FROM a.date::date) = ${curYear}
            AND EXTRACT(MONTH FROM a.date::date) = ${curMonth}
        )
    `),
    db.execute(sql`
      SELECT COUNT(DISTINCT sub.customer_id)::int AS count
      FROM (
        SELECT DISTINCT a.customer_id
        FROM appointments a
        WHERE a.deleted_at IS NULL
          AND a.status IN ('completed','documented')
          AND EXTRACT(YEAR FROM a.date::date) = ${prevMYear}
          AND EXTRACT(MONTH FROM a.date::date) = ${prevM}
      ) sub
      WHERE sub.customer_id NOT IN (
        SELECT msr.customer_id
        FROM monthly_service_records msr
        WHERE msr.year = ${prevMYear} AND msr.month = ${prevM}
      )
    `),
    db.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM customers c
      WHERE c.status = 'aktiv' AND c.deleted_at IS NULL
        AND EXTRACT(YEAR FROM c.created_at) = ${curYear}
        AND EXTRACT(MONTH FROM c.created_at) = ${curMonth}
    `),
  ]);

  const alerts: AlertItem[] = [];

  const undocCount = Number(undocumented.rows[0]?.count || 0);
  if (undocCount > 0) {
    alerts.push({
      severity: "rot",
      title: "Undokumentierte Termine",
      description: `${undocCount} abgeschlossene Termine warten seit mehr als 3 Tagen auf Dokumentation.`,
      count: undocCount,
      link: "/undocumented",
    });
  }

  const overCount = Number(budgetOverspend.rows[0]?.count || 0);
  if (overCount > 0) {
    alerts.push({
      severity: "rot",
      title: "Budget-Überschreitung",
      description: `${overCount} Kunden haben ihr §45b-Budget für ${curYear} überschritten.`,
      count: overCount,
      link: "/admin/statistics/budgets",
    });
  }

  const noApptCount = Number(noAppointments.rows[0]?.count || 0);
  if (noApptCount > 0) {
    alerts.push({
      severity: "gelb",
      title: "Kunden ohne Termine",
      description: `${noApptCount} aktive Kunden haben keine Termine im ${MONTH_NAMES_DE[curMonth]}.`,
      count: noApptCount,
      link: "/admin/statistics/process-health/customers-without-appointments",
    });
  }

  const missingCount = Number(missingRecords.rows[0]?.count || 0);
  if (missingCount > 0) {
    alerts.push({
      severity: "gelb",
      title: "Fehlende Leistungsnachweise",
      description: `${missingCount} Kunden haben noch keinen Leistungsnachweis für ${MONTH_NAMES_DE[prevM]}.`,
      count: missingCount,
      link: "/service-records",
    });
  }

  const newCustCount = Number(newCustomers.rows[0]?.count || 0);
  if (newCustCount > 0) {
    alerts.push({
      severity: "gruen",
      title: "Neue Kunden",
      description: `${newCustCount} neue Kunden im ${MONTH_NAMES_DE[curMonth]} gewonnen.`,
      count: newCustCount,
    });
  }

  return alerts;
}
