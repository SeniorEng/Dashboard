import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { createTask } from "../storage/tasks";

const TASK_TITLE_PREFIX = "§39/42a Budget-Verlängerung:";

export async function checkBudgetRenewals(): Promise<number> {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  if (currentMonth < 11) return 0;

  const adminUsers = await db.execute(sql`
    SELECT id FROM users WHERE is_admin = true AND deleted_at IS NULL ORDER BY id ASC LIMIT 1
  `);
  const adminUserId = (adminUsers.rows[0] as any)?.id;
  if (!adminUserId) {
    console.warn("[Budget-Renewal] Kein Admin-Benutzer gefunden, Prüfung übersprungen");
    return 0;
  }

  const customersWithBudget = await db.execute(sql`
    SELECT DISTINCT c.id, c.vorname, c.nachname
    FROM customers c
    JOIN customer_budget_type_settings cbts ON cbts.customer_id = c.id
    WHERE cbts.budget_type = 'ersatzpflege_39_42a'
      AND cbts.enabled = true
      AND c.status = 'aktiv'
      AND c.deleted_at IS NULL
  `);

  if (customersWithBudget.rows.length === 0) return 0;

  const dueDate = `${currentYear}-12-01`;

  const existingTasks = await db.execute(sql`
    SELECT customer_id FROM tasks
    WHERE title LIKE ${TASK_TITLE_PREFIX + "%"}
      AND due_date = ${dueDate}
      AND deleted_at IS NULL
  `);
  const existingCustomerIds = new Set(
    existingTasks.rows.map((r: any) => r.customer_id)
  );

  let created = 0;

  for (const customer of customersWithBudget.rows as any[]) {
    if (existingCustomerIds.has(customer.id)) continue;

    const customerName = `${customer.vorname} ${customer.nachname}`.trim();

    await createTask({
      title: `${TASK_TITLE_PREFIX} ${customerName}`,
      description: `Das §39/42a Budget (Gemeinsamer Jahresbetrag) läuft am 31.12.${currentYear} aus. Bitte die Verlängerung für ${currentYear + 1} mit dem Kunden abstimmen.`,
      dueDate,
      priority: "high",
      assignedToUserId: adminUserId,
      customerId: customer.id,
    } as any, adminUserId);

    created++;
  }

  return created;
}
