import { db, type DbOrTx } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

interface QueryResult {
  rowCount: number;
  rows: Record<string, unknown>[];
}

/**
 * Task #514 — Bereinigt die 15 verbleibenden Karteileichen (lebende Kunden mit
 * Status `erstberatung` ohne Prospect-Bezug), die nach der ersten Migration
 * (#509) und vor dem Schließen des Anlage-Pfads (#510) entstanden sind.
 *
 * Erst nach dieser Bereinigung kann `ensureErstberatungProspectLinkConstraint`
 * das DB-CHECK-Constraint aktivieren.
 *
 * Im Gegensatz zur generellen `migrateErstberatungCustomers`-Migration (die
 * ALLE Erstberatungs-Kunden anfasst) zielt diese Migration ausschließlich auf
 * Waisen ohne `converted_from_prospect_id`. Legitim verknüpfte
 * Erstberatungs-Kunden bleiben unberührt.
 *
 * Vorgehen pro Waisen-Kunde:
 *  1. Falls es bereits einen Prospect mit `converted_customer_id` auf diesen
 *     Kunden gibt, wird dieser verwendet.
 *  2. Andernfalls wird aus den Kundendaten ein synthetischer Prospect mit
 *     Status `erstberatung_durchgeführt` angelegt.
 *  3. Alle nicht-gelöschten `Erstberatung`-Termine des Kunden werden auf den
 *     Prospect umgehängt (`customer_id = NULL`, `prospect_id = ...`).
 *  4. Der Kunde wird soft-gelöscht (`deleted_at = NOW()`, `status = 'inaktiv'`).
 *  5. Der Prospect wird auf `erstberatung_durchgeführt` zurückgesetzt und
 *     `converted_customer_id` geleert.
 *
 * Idempotent: läuft mehrfach ohne Schaden, da nach erfolgreichem Lauf keine
 * Waisen mehr existieren.
 */
async function createSyntheticProspectForOrphan(
  exec: DbOrTx,
  customerId: number,
): Promise<number | null> {
  const customerRows = await exec.execute(sql`
    SELECT id, name, vorname, nachname, email, telefon, festnetz,
           strasse, nr, plz, stadt, pflegegrad
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

  const inserted = await exec.execute(sql`
    INSERT INTO prospects (
      vorname, nachname, telefon, email,
      strasse, nr, plz, stadt, pflegegrad,
      status, quelle, quelle_details
    ) VALUES (
      ${vorname}, ${nachname}, ${telefon}, ${row.email},
      ${row.strasse}, ${row.nr}, ${plz}, ${row.stadt}, ${row.pflegegrad},
      'erstberatung_durchgeführt',
      'migration_orphan_customer',
      ${`Synthetisch erzeugt aus Waisen-Kunde #${customerId} (Task #514)`}
    )
    RETURNING id
  `);
  const newId = (inserted.rows as Array<{ id: number }>)[0]?.id;
  return typeof newId === "number" ? newId : null;
}

export async function cleanupOrphanErstberatungCustomers(exec: DbOrTx = db): Promise<void> {
  const orphans = await exec.execute(sql`
    SELECT c.id, c.name
    FROM customers c
    WHERE c.status = 'erstberatung'
      AND c.converted_from_prospect_id IS NULL
      AND c.deleted_at IS NULL
  `);

  const rows = orphans.rows as Array<{ id: number; name: string }>;

  if (rows.length === 0) {
    return;
  }

  log(
    `Erstberatung-Waisen-Bereinigung: ${rows.length} Kunden mit Status 'erstberatung' ohne Prospect-Bezug gefunden`,
    "startup",
  );

  const warnings: string[] = [];
  let cleanedUp = 0;

  for (const customer of rows) {
    // Pro Kunde ein eigener SAVEPOINT INNERHALB der vom
    // `runGuardedBudgetMigration`-Runner gehaltenen Migrations-Transaktion:
    // Prospect-Lookup, ggf. synthetische Anlage, Termin-Umhängung,
    // Kunden-Soft-Delete und Prospect-Reset laufen atomar. Bricht ein Schritt,
    // wird NUR dieser SAVEPOINT zurückgerollt (kein halb-erstellter
    // synthetischer Prospect ohne Customer-Cleanup); die übrigen Kunden und der
    // Ledger-Eintrag bleiben erhalten. Der nächste Startup-Lauf findet den
    // Waisen-Kunden erneut und versucht es sauber wieder.
    const savepoint = `orphan_erstb_${customer.id}`;
    try {
      await exec.execute(sql.raw(`SAVEPOINT ${savepoint}`));

      const prospectRows = await exec.execute(sql`
        SELECT id FROM prospects
        WHERE converted_customer_id = ${customer.id}
          AND deleted_at IS NULL
        LIMIT 1
      `);
      let prospectId: number | null = null;
      let synthetic = false;
      if ((prospectRows.rows as Array<{ id: number }>).length > 0) {
        prospectId = (prospectRows.rows as Array<{ id: number }>)[0].id;
      }

      if (!prospectId) {
        const created = await createSyntheticProspectForOrphan(exec, customer.id);
        if (!created) {
          throw new Error(
            `Kunde ${customer.id} (${customer.name}) hat keinen verknüpften Prospect und konnte nicht synthetisch erzeugt werden`,
          );
        }
        prospectId = created;
        synthetic = true;
      }

      const movedResult = (await exec.execute(sql`
        UPDATE appointments
        SET prospect_id = ${prospectId},
            customer_id = NULL
        WHERE customer_id = ${customer.id}
          AND deleted_at IS NULL
          AND appointment_type = 'Erstberatung'
      `)) as unknown as QueryResult;
      const movedCount = movedResult.rowCount ?? 0;

      await exec.execute(sql`
        UPDATE prospects
        SET status = 'erstberatung_durchgeführt',
            converted_customer_id = NULL,
            updated_at = NOW()
        WHERE id = ${prospectId}
      `);

      await exec.execute(sql`
        UPDATE customers
        SET deleted_at = NOW(),
            status = 'inaktiv'
        WHERE id = ${customer.id}
      `);

      await exec.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));

      log(
        `Erstberatung-Waisen-Bereinigung: Kunde ${customer.id} (${customer.name}) → Prospect ${prospectId}${synthetic ? " (synthetisch)" : ""}, ${movedCount} Termine umgehängt`,
        "startup",
      );
      cleanedUp++;
    } catch (err) {
      await exec.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${savepoint}`)).catch(() => {});
      warnings.push(
        `Kunde ${customer.id} (${customer.name}) konnte nicht bereinigt werden: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  log(
    `Erstberatung-Waisen-Bereinigung abgeschlossen: ${cleanedUp} bereinigt, ${warnings.length} übersprungen`,
    "startup",
  );

  for (const w of warnings) {
    log(`Erstberatung-Waisen-Bereinigung WARNUNG: ${w}`, "startup");
  }
}
