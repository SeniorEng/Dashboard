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
 *
 * ---------------------------------------------------------------------------
 * Konsolidierung (SSoT-Registry `appointment-active-invoice`)
 * ---------------------------------------------------------------------------
 * Dieselbe Frage war zusätzlich als handgeschriebenes Prädikat über den ganzen
 * Server verstreut — teils wortgleich, teils als Kern mit zusätzlichem Scope.
 * `activeInvoiceCondition()` (Drizzle) und die beiden `…SqlRaw`-Bausteine
 * (Roh-SQL) ERSETZEN diese Kopien: wortgleiche Stellen rufen sie direkt auf,
 * enger gescopte Stellen komponieren sie mit ihren Zusatzbedingungen. Damit
 * gibt es genau EINE Definition von „aktiv" — die Zusatz-Scopes bleiben
 * sichtbar an ihrer Aufrufstelle stehen.
 *
 * Muster analog `server/lib/appointment-signed.ts`: Drizzle-Bedingung und
 * Roh-SQL-Fragmente sind Zwillinge derselben Regel und MÜSSEN im Gleichschritt
 * geändert werden. Der Architektur-Wächter A6 in
 * `tests/architecture/ssot-imports.test.ts` bricht, sobald irgendwo sonst das
 * Storno-Paar erneut an `invoice_line_items.appointment_id` gebunden wird.
 */
import { and, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { invoiceLineItems, invoices as invoicesTable } from "@shared/schema";
import { db, type DbOrTx } from "./db";

/**
 * DIE Definition von „aktive Rechnung" als Drizzle-Bedingung: weder selbst
 * storniert noch eine Stornorechnung.
 *
 * Entwurfs-Rechnungen (`status = 'entwurf'`) sind bewusst EINGESCHLOSSEN — ein
 * Termin auf einem noch nicht versendeten Entwurf gilt als abgerechnet.
 *
 * Zum Komponieren gedacht: `and(inArray(...), activeInvoiceCondition())`. Die
 * Bedingung setzt voraus, dass `invoices` in der Query verfügbar ist (Join oder
 * `from`).
 */
export function activeInvoiceCondition(): SQL {
  const condition = and(
    ne(invoicesTable.status, "storniert"),
    ne(invoicesTable.invoiceType, "stornorechnung"),
  );
  // `and(...)` ist typseitig `SQL | undefined` (leer bei null-Argumenten). Hier
  // kann das nie eintreten, aber der Rückgabetyp MUSS `SQL` sein: ein
  // durchgereichtes `undefined` in `.where(activeInvoiceCondition())` würde die
  // WHERE-Klausel leeren — dann gälte JEDE Rechnung als aktiv, also exakt die
  // Umkehrung des Prädikats. Fail-fast statt still falsch.
  if (!condition) throw new Error("activeInvoiceCondition: leere Bedingung");
  return condition;
}

/**
 * Roh-SQL-ZWILLING von `activeInvoiceCondition()` — dasselbe Prädikat für
 * Leser, die ihre Query als Roh-SQL bauen (die Statistik-Reader unter
 * `server/storage/statistics/**` tun das durchgehend).
 *
 * Bis zu diesem Baustein gab es das Fragment nur handgeschrieben: 17 Kopien
 * über den Server verstreut, davon acht allein im Umsatz-Reader — und drei
 * innerhalb DIESER Datei, also in der SSoT selbst. Genau daran hängt der Punkt:
 * eine einzelne vergessene Kopie verändert einen ausgewiesenen Umsatz, ohne
 * dass ein Test anschlägt.
 *
 * MUSS mit `activeInvoiceCondition()` im Gleichschritt geändert werden — beide
 * sind Formulierungen DERSELBEN Regel (Muster `server/lib/appointment-signed.ts`).
 *
 * @param alias Tabellen-Alias der `invoices`-Tabelle in der aufrufenden Query
 *   (z. B. `"i"`). Bewusst Pflichtparameter: die Reader nutzen verschiedene
 *   Aliase, und ein stiller Default würde in der falschen Query lautlos auf die
 *   falsche Tabelle zeigen.
 */
export function activeInvoiceSqlRaw(alias: string): SQL {
  // `sql.raw` umgeht die Parametrisierung — ein durchgereichter Alias könnte
  // hier sonst beliebiges SQL einschleusen. Heute übergeben alle Aufrufer
  // String-Literale; die Prüfung kostet nichts und hält das so.
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error(`activeInvoiceSqlRaw: unzulässiger Tabellen-Alias "${alias}"`);
  }
  const a = sql.raw(alias);
  return sql`${a}.status != 'storniert' AND ${a}.invoice_type != 'stornorechnung'`;
}

/**
 * Roh-SQL-Zwilling in Mengen-Form: die IDs aller Termine, die auf einer aktiven
 * Rechnung liegen — als Sub-SELECT für `<termin>.id IN (…)` /
 * `NOT IN (…)`-Formulierungen.
 *
 * `AND li.appointment_id IS NOT NULL` gehört bewusst zum Baustein: ohne diesen
 * Filter liefert ein `NOT IN` über eine Menge mit NULL nach SQL-3VL gar keine
 * Zeilen mehr (still leere Liste statt „keine Rechnung").
 *
 * @param extraInvoiceFilter Optionaler, mit `AND` beginnender Zusatz-Scope auf
 *   `invoices` (z. B. Abrechnungs-Zeitraum). Wird ans Ende der WHERE-Klausel
 *   gehängt; die Aufrufstelle behält damit ihren Scope sichtbar.
 */
export function activeInvoicedAppointmentIdsSqlRaw(extraInvoiceFilter: SQL = sql``): SQL {
  return sql`SELECT DISTINCT li.appointment_id
      FROM invoice_line_items li
      JOIN invoices i ON i.id = li.invoice_id
      WHERE ${activeInvoiceSqlRaw("i")}
        AND li.appointment_id IS NOT NULL ${extraInvoiceFilter}`;
}

/**
 * Roh-SQL-Zwilling für „liegt DIESER Termin auf einer aktiven Rechnung?".
 *
 * @param appointmentIdRef SQL-Ausdruck, der die Termin-ID liefert — z. B.
 *   `"a.id"` (Alias der `appointments`-Tabelle) oder `"sra.appointment_id"`
 *   (Junction-Spalte). Bewusst ein Ausdruck statt eines Tabellen-Alias: die
 *   Aufrufer binden mal die Termin-Tabelle, mal eine Fremdschlüssel-Spalte.
 */
export function activeInvoiceForAppointmentExistsSqlRaw(appointmentIdRef: string): SQL {
  const apptId = sql.raw(appointmentIdRef);
  return sql`EXISTS (
      SELECT 1 FROM invoice_line_items li
      JOIN invoices i ON i.id = li.invoice_id
      WHERE li.appointment_id = ${apptId}
        AND ${activeInvoiceSqlRaw("i")}
    )`;
}

/**
 * Roh-SQL-Zwilling für „die ZULETZT angelegte aktive Rechnung dieses Termins".
 * Liefert ein komplettes `LEFT JOIN LATERAL … ON true` mit den Spalten
 * `invoice_id`, `invoice_status`, `invoice_type` unter `resultAlias`; ohne
 * aktive Rechnung sind sie NULL.
 *
 * @param appointmentIdRef siehe `activeInvoiceForAppointmentExistsSqlRaw`.
 * @param resultAlias Alias, unter dem die Spalten verfügbar werden.
 */
export function latestActiveInvoiceForAppointmentLateralRaw(
  appointmentIdRef: string,
  resultAlias: string,
): SQL {
  const apptId = sql.raw(appointmentIdRef);
  const r = sql.raw(resultAlias);
  return sql`LEFT JOIN LATERAL (
      SELECT i.id AS invoice_id, i.status AS invoice_status, i.invoice_type AS invoice_type
      FROM invoice_line_items li
      JOIN invoices i ON i.id = li.invoice_id
      WHERE li.appointment_id = ${apptId}
        AND ${activeInvoiceSqlRaw("i")}
      ORDER BY i.id DESC
      LIMIT 1
    ) ${r} ON true`;
}

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
        activeInvoiceCondition(),
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

/**
 * Roh-SQL: „haengt an DIESEM Leistungsnachweis mindestens ein Termin, der
 * nicht abgerechnet ist?"
 *
 * Hierher gezogen aus `server/storage/statistics/process-health.ts`, wo sie
 * datei-privat lag. Der Deaktivierungs-Guard (Ticket 6hWcjpm3Q4V95Xwp)
 * stellt dieselbe Frage; die Komposition ein zweites Mal hinzuschreiben
 * hiesse, dass eine Aenderung an #1536 nur eine Haelfte trifft. Der innere
 * Teil („aktive Rechnung") kam schon vorher aus der SSoT — die Klammer
 * darum nicht.
 *
 * Task #1536 — Ausnahme „nichts abzurechnen": Ein No-Show-Termin mit
 * unterdrueckter Privatrechnung (`no_show_charge_suppressed = true`)
 * erzeugt ABSICHTLICH kein Line-Item. Er ist damit nicht „unberechnet",
 * sondern „nichts abzurechnen", und darf den Nachweis nicht dauerhaft
 * als offenen Posten festhalten (falsch-positiver Alarm).
 *
 * @param msrIdRef SQL-Ausdruck, der die `monthly_service_records`-ID
 *   liefert — z. B. eine gebundene Drizzle-Spalte oder `sql.raw("msr.id")`.
 */
export function recordHasUnbilledAppointmentSqlRaw(msrIdRef: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM service_record_appointments sra
    JOIN appointments a ON a.id = sra.appointment_id AND a.deleted_at IS NULL
    WHERE sra.service_record_id = ${msrIdRef}
      AND NOT (a.status = 'customer_no_show' AND a.no_show_charge_suppressed = true)
      AND NOT ${activeInvoiceForAppointmentExistsSqlRaw("sra.appointment_id")}
  )`;
}
