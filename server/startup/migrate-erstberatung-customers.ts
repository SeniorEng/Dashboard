import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

interface QueryResult {
  rowCount: number;
  rows: Record<string, unknown>[];
}

async function ensureCheckConstraint(): Promise<void> {
  const existing = await db.execute(sql`
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE c.conname = 'appointments_prospect_or_customer_check'
      AND t.relname = 'appointments'
  `);

  if ((existing.rows as unknown[]).length > 0) {
    return;
  }

  const violating = await db.execute(sql`
    SELECT COUNT(*) as cnt FROM appointments
    WHERE prospect_id IS NULL AND customer_id IS NULL
  `);
  const violatingCount = Number((violating.rows as Array<{ cnt: string }>)[0]?.cnt ?? 0);

  if (violatingCount > 0) {
    log(`CHECK-Constraint übersprungen: ${violatingCount} Termine ohne prospect_id und customer_id gefunden`, "startup");
    return;
  }

  await db.execute(sql`
    ALTER TABLE appointments
    ADD CONSTRAINT appointments_prospect_or_customer_check
    CHECK (prospect_id IS NOT NULL OR customer_id IS NOT NULL)
  `);
  log("CHECK-Constraint für appointments (prospect_id OR customer_id) hinzugefügt", "startup");
}

export async function migrateErstberatungCustomers(): Promise<void> {
  await ensureCheckConstraint();

  const erstberatungCustomers = await db.execute(sql`
    SELECT c.id, c.name, c.converted_from_prospect_id
    FROM customers c
    WHERE c.status = 'erstberatung'
      AND c.deleted_at IS NULL
  `);

  const rows = erstberatungCustomers.rows as Array<{
    id: number;
    name: string;
    converted_from_prospect_id: number | null;
  }>;

  if (rows.length === 0) {
    return;
  }

  log(`Erstberatung-Migration: ${rows.length} Kunden mit Status 'erstberatung' gefunden`, "startup");

  const warnings: string[] = [];
  const customerProspectPairs: Array<{ customerId: number; customerName: string; prospectId: number }> = [];

  for (const customer of rows) {
    let prospectId: number | null = customer.converted_from_prospect_id;

    if (!prospectId) {
      const prospectRows = await db.execute(sql`
        SELECT id FROM prospects
        WHERE converted_customer_id = ${customer.id}
          AND deleted_at IS NULL
        LIMIT 1
      `);
      if ((prospectRows.rows as Array<{ id: number }>).length > 0) {
        prospectId = (prospectRows.rows as Array<{ id: number }>)[0].id;
      }
    }

    if (!prospectId) {
      warnings.push(`Kunde ${customer.id} (${customer.name}) hat keinen verknüpften Prospect — übersprungen`);
      continue;
    }

    customerProspectPairs.push({
      customerId: customer.id,
      customerName: customer.name,
      prospectId,
    });
  }

  if (customerProspectPairs.length === 0) {
    for (const w of warnings) {
      log(`Erstberatung-Migration WARNUNG: ${w}`, "startup");
    }
    return;
  }

  await db.transaction(async (tx) => {
    for (const pair of customerProspectPairs) {
      const movedResult = await tx.execute(sql`
        UPDATE appointments
        SET prospect_id = ${pair.prospectId},
            customer_id = NULL
        WHERE customer_id = ${pair.customerId}
          AND deleted_at IS NULL
          AND appointment_type = 'Erstberatung'
      `) as unknown as QueryResult;
      const movedCount = movedResult.rowCount ?? 0;

      await tx.execute(sql`
        UPDATE prospects
        SET status = 'erstberatung_durchgeführt',
            converted_customer_id = NULL,
            updated_at = NOW()
        WHERE id = ${pair.prospectId}
      `);

      await tx.execute(sql`
        UPDATE customers
        SET deleted_at = NOW(),
            status = 'inaktiv'
        WHERE id = ${pair.customerId}
      `);

      log(
        `Erstberatung-Migration: Kunde ${pair.customerId} (${pair.customerName}) → Prospect ${pair.prospectId}, ${movedCount} Termine umgehängt`,
        "startup"
      );
    }
  });

  log(
    `Erstberatung-Migration abgeschlossen: ${customerProspectPairs.length} migriert, ${warnings.length} übersprungen`,
    "startup"
  );

  for (const w of warnings) {
    log(`Erstberatung-Migration WARNUNG: ${w}`, "startup");
  }
}
