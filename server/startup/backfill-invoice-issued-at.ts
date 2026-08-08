/**
 * #66 — Startup-Fix: Ausgabe-Marke und Nummernkreis für den BESTAND nachziehen.
 *
 * Ohne diesen Fix wären beide Neuerungen für Altdaten wirkungslos, und das auf
 * eine Weise, die niemandem auffällt:
 *
 *  1. `invoices.issued_at` kommt als NULL in die Welt. Für jede heute schon
 *     versendete oder bezahlte Rechnung hieße das „nie ausgegeben" — der neue
 *     Löschschutz wäre für den gesamten Bestand ein No-op, und gleichzeitig
 *     verlöre der Bestand den Korrekturweg ersatzlos: der generische Rückweg
 *     `versendet → entwurf` ist entfernt, und das Fehlmarkierungs-Ventil lehnt
 *     eine Rechnung ohne Marke ab. Es gäbe also weder Schutz noch Korrektur.
 *
 *  2. Die Hochwassermarke des Nummernkreises wird sonst erst beim ERSTEN Zug
 *     eines Jahres aus dem Bestand geseedet. Zwischen Deploy und erstem Zug
 *     könnte das Löschen der höchsten Rechnung sie noch senken. Hier wird sie
 *     deterministisch gesetzt, statt „so gut wie ihr erster Zug" zu sein.
 *
 * Idempotent: beide Schritte sind mit `WHERE`-Bedingungen bzw. `GREATEST`
 * gegen Mehrfachlauf abgesichert und laufen bei jedem Boot mit.
 */
import { sql } from "drizzle-orm";
import { db, type DbOrTx } from "../lib/db";

export interface InvoiceIssuedBackfillSummary {
  markedInvoices: number;
  seededYears: number;
}

export async function backfillInvoiceIssuedAt(exec: DbOrTx = db): Promise<InvoiceIssuedBackfillSummary> {
  // (1) Ausgabe-Marke für alles, was den Entwurfsstatus je verlassen hat.
  //
  // Der Anker ist bewusst `COALESCE(sent_at, storniert_at, paid_at, created_at)`
  // und nicht `now()`: der Zeitpunkt soll ungefähr stimmen, sonst behauptet das
  // Protokoll eine Ausgabe zum Deploy-Zeitpunkt. `created_at` ist die letzte
  // Rückfallebene — eine Rechnung im Status `versendet` ohne jedes Datum wäre
  // bereits ein Altdatenfehler, aber sie soll trotzdem geschützt sein.
  const marked = await exec.execute(sql`
    UPDATE invoices
       SET issued_at = COALESCE(sent_at, storniert_at, paid_at, created_at)
     WHERE issued_at IS NULL
       AND status <> 'entwurf'
  `);

  // (2) Hochwassermarke je Jahr deterministisch setzen. `GREATEST` sorgt dafür,
  // dass ein bereits höher stehender Zähler nie zurückfällt.
  const seeded = await exec.execute(sql`
    INSERT INTO invoice_number_sequence (billing_year, last_number, updated_at)
    SELECT billing_year,
           COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM 'RE-\\d{4}-(\\d+)') AS INTEGER)), 0),
           now()
      FROM invoices
     GROUP BY billing_year
    ON CONFLICT (billing_year) DO UPDATE
      SET last_number = GREATEST(invoice_number_sequence.last_number, EXCLUDED.last_number),
          updated_at  = now()
  `);

  const summary: InvoiceIssuedBackfillSummary = {
    markedInvoices: marked.rowCount ?? 0,
    seededYears: seeded.rowCount ?? 0,
  };
  if (summary.markedInvoices > 0 || summary.seededYears > 0) {
    console.log(
      `[startup] #66: ${summary.markedInvoices} Rechnung(en) als ausgegeben markiert, `
      + `Nummernkreis für ${summary.seededYears} Jahr(e) verankert.`,
    );
  }
  return summary;
}
