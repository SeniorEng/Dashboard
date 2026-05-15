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

async function createSyntheticProspectForOrphan(customerId: number): Promise<number | null> {
  const customerRows = await db.execute(sql`
    SELECT id, name, vorname, nachname, email, telefon, festnetz,
           strasse, nr, plz, stadt, pflegegrad, created_at
    FROM customers
    WHERE id = ${customerId}
    LIMIT 1
  `);
  const row = (customerRows.rows as Array<{
    id: number;
    name: string;
    vorname: string | null;
    nachname: string | null;
    email: string | null;
    telefon: string | null;
    festnetz: string | null;
    strasse: string | null;
    nr: string | null;
    plz: string | null;
    stadt: string | null;
    pflegegrad: number | null;
  }>)[0];
  if (!row) {
    return null;
  }

  let vorname = (row.vorname ?? "").trim();
  let nachname = (row.nachname ?? "").trim();
  if (!vorname || !nachname) {
    const parts = (row.name ?? "").trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      vorname = vorname || parts.slice(0, -1).join(" ");
      nachname = nachname || parts[parts.length - 1];
    } else if (parts.length === 1) {
      vorname = vorname || parts[0];
      nachname = nachname || "(unbekannt)";
    } else {
      vorname = vorname || "(unbekannt)";
      nachname = nachname || "(unbekannt)";
    }
  }

  const telefon = row.telefon ?? row.festnetz ?? null;
  const plz = row.plz && /^\d{5}$/.test(row.plz) ? row.plz : null;

  const inserted = await db.execute(sql`
    INSERT INTO prospects (
      vorname, nachname, telefon, email,
      strasse, nr, plz, stadt, pflegegrad,
      status, quelle, quelle_details
    ) VALUES (
      ${vorname}, ${nachname}, ${telefon}, ${row.email},
      ${row.strasse}, ${row.nr}, ${plz}, ${row.stadt}, ${row.pflegegrad},
      'erstberatung_durchgeführt',
      'migration_orphan_customer',
      ${`Synthetisch erzeugt aus Waisen-Kunde #${customerId} (Task #509)`}
    )
    RETURNING id
  `);
  const newId = (inserted.rows as Array<{ id: number }>)[0]?.id;
  return typeof newId === "number" ? newId : null;
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
      const synthetic = await createSyntheticProspectForOrphan(customer.id);
      if (!synthetic) {
        warnings.push(`Kunde ${customer.id} (${customer.name}) hat keinen verknüpften Prospect und konnte nicht synthetisch erzeugt werden — übersprungen`);
        continue;
      }
      prospectId = synthetic;
      log(
        `Erstberatung-Migration: Synthetischer Prospect ${prospectId} für Waisen-Kunde ${customer.id} (${customer.name}) angelegt`,
        "startup"
      );
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
