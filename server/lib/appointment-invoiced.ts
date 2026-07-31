/**
 * Task #1892 — SSoT für die fachliche Frage:
 * „Liegt dieser Termin auf einer AKTIVEN Rechnung?"
 *
 * Aktiv heißt: die Rechnung ist weder selbst storniert (`status = 'storniert'`)
 * noch eine Stornorechnung (`invoice_type = 'stornorechnung'`). Nur solche
 * Rechnungen binden einen Termin fachlich — nach einem Storno ist der Termin
 * wieder frei (genau der Realfall aus #1892: RE-2026-0417 storniert über
 * RE-2026-0500).
 *
 * ERSETZT die zwei wortgleichen Inline-Kopien dieser Query in
 * `server/routes/service-records.ts` (`GET /:id/check-invoiced` und der
 * LN-Lösch-Route). Beide importieren ab jetzt diese Funktion; ein dritter
 * Aufrufer (der Storno-first-Guard der Termin-Lösch-Route) kommt hinzu, ohne
 * das Prädikat erneut zu formulieren.
 *
 * Nimmt einen `DbOrTx`-Client entgegen, damit der Guard INNERHALB der
 * Lösch-Transaktion (unter dem FOR-UPDATE-Lock) laufen kann und nicht als
 * check-then-write daneben.
 */
import { and, eq, inArray, ne } from "drizzle-orm";
import { invoiceLineItems, invoices as invoicesTable } from "@shared/schema";
import { db, type DbOrTx } from "./db";

/** Eine aktive Rechnung, die einen der abgefragten Termine berechnet. */
export interface ActiveInvoiceRef {
  appointmentId: number | null;
  invoiceId: number;
  invoiceNumber: string;
  status: string;
}

/**
 * Liefert die aktiven Rechnungen, die einen der übergebenen Termine berechnen.
 * Leeres Array ⇒ kein Termin ist aktiv abgerechnet.
 */
export async function findActiveInvoicesForAppointments(
  appointmentIds: readonly number[],
  client: DbOrTx = db,
): Promise<ActiveInvoiceRef[]> {
  if (appointmentIds.length === 0) return [];

  return await client
    .select({
      appointmentId: invoiceLineItems.appointmentId,
      invoiceId: invoicesTable.id,
      invoiceNumber: invoicesTable.invoiceNumber,
      status: invoicesTable.status,
    })
    .from(invoiceLineItems)
    .innerJoin(invoicesTable, eq(invoiceLineItems.invoiceId, invoicesTable.id))
    .where(
      and(
        inArray(invoiceLineItems.appointmentId, [...appointmentIds]),
        ne(invoicesTable.status, "storniert"),
        ne(invoicesTable.invoiceType, "stornorechnung"),
      ),
    );
}

/** Bequemer Boolean-Wrapper für Aufrufer, die nur „ja/nein" brauchen. */
export async function hasActiveInvoiceForAppointments(
  appointmentIds: readonly number[],
  client: DbOrTx = db,
): Promise<boolean> {
  const rows = await findActiveInvoicesForAppointments(appointmentIds, client);
  return rows.length > 0;
}
