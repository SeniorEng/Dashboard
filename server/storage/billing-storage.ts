import {
  type Invoice,
  type InvoiceLineItem,
  type InvoiceRenderSnapshot,
} from "@shared/schema";
import { db, type DbOrTx, type Tx } from "../lib/db";
import type { InvoiceWithCustomer } from "../storage";
import { formatInvoiceNumber } from "@shared/domain/invoice-number";
import { insuranceValidAtBillingMonthSqlRaw } from "../lib/insurance-period";

export async function getInvoices(filters: { year?: number; month?: number; customerId?: number; status?: string; statuses?: string[]; insuranceProviderId?: number; dateFrom?: string; dateTo?: string }): Promise<InvoiceWithCustomer[]> {
  const { invoices, customers } = await import("@shared/schema");
  const { eq, and, asc, desc, sql, inArray } = await import("drizzle-orm");
  const conditions: Array<ReturnType<typeof eq> | ReturnType<typeof sql>> = [];
  if (filters.year) conditions.push(eq(invoices.billingYear, filters.year));
  if (filters.month) conditions.push(eq(invoices.billingMonth, filters.month));
  if (filters.customerId) conditions.push(eq(invoices.customerId, filters.customerId));
  if (filters.status) conditions.push(eq(invoices.status, filters.status as string));
  // Task #1859 — Mehr-Status-Filter (z.B. versendet + avis_erhalten für den
  // Zahlungs-Zuordnungs-Picker). Wirkt zusätzlich zum Einzel-`status`.
  if (filters.statuses && filters.statuses.length > 0) {
    conditions.push(inArray(invoices.status, filters.statuses));
  }
  // Task #1317: Optionaler Datumsbereich (von–bis) — engt die Liste auf
  // Rechnungen ein, die mindestens eine Leistungszeile mit einem
  // Termindatum im gewählten Bereich tragen. Wirkt ZUSÄTZLICH zu
  // Monat/Jahr/Status/Kasse (Verfeinerung innerhalb des Monats). Beide
  // Grenzen sind unabhängig optional (nur „von", nur „bis" oder beide).
  if (filters.dateFrom || filters.dateTo) {
    const parts = [sql`ili.invoice_id = ${invoices.id}`];
    if (filters.dateFrom) parts.push(sql`ili.appointment_date >= ${filters.dateFrom}`);
    if (filters.dateTo) parts.push(sql`ili.appointment_date <= ${filters.dateTo}`);
    conditions.push(sql`EXISTS (
      SELECT 1 FROM invoice_line_items ili
      WHERE ${sql.join(parts, sql` AND `)}
    )`);
  }
  // Krankenkassen-Filter: matched gegen die im ABRECHNUNGSMONAT der jeweiligen
  // Rechnung gültige Zuordnung (Task #1893) — der Stichtag ist hier korreliert,
  // weil die Liste Rechnungen mehrerer Monate zugleich filtert. Selbstzahler-
  // Rechnungen haben keinen Eintrag und fallen automatisch raus, was dem
  // Filter-Intent entspricht.
  if (filters.insuranceProviderId) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM customer_insurance_history cih
      WHERE cih.customer_id = ${invoices.customerId}
        AND ${insuranceValidAtBillingMonthSqlRaw("cih", sql`${invoices.billingYear}`, sql`${invoices.billingMonth}`)}
        AND cih.insurance_provider_id = ${filters.insuranceProviderId}
    )`);
  }

  const results = await db.select({
    invoice: invoices,
    customerName: customers.name,
    customerVorname: customers.vorname,
    customerNachname: customers.nachname,
  })
  .from(invoices)
  .innerJoin(customers, eq(invoices.customerId, customers.id))
  .where(conditions.length > 0 ? and(...conditions) : undefined)
  .orderBy(desc(invoices.createdAt));

  return results.map(r => {
    // Task #1074 (GoBD) — Geladene Rechnungen liefern den EINGEFRORENEN
    // Kundennamen aus dem Render-Snapshot, nicht den per JOIN aktuellen
    // Stammdaten-Namen. Der Snapshot-Name == `customers.name` zum
    // Versiegelungszeitpunkt, daher byte-stabil für Re-Render/Verifier; eine
    // spätere Namensänderung erzeugt keine falsch-positive Drift mehr. Nur
    // Entwürfe (noch kein Snapshot) fallen auf den Live-Namen zurück.
    const snapshot = (r.invoice.renderSnapshot ?? null) as InvoiceRenderSnapshot | null;
    return {
      ...r.invoice,
      customerName: snapshot?.customer?.name ?? r.customerName,
      customerVorname: r.customerVorname,
      customerNachname: r.customerNachname,
    };
  });
}

export async function getInvoice(id: number): Promise<InvoiceWithCustomer | undefined> {
  const { invoices, customers } = await import("@shared/schema");
  const { eq } = await import("drizzle-orm");
  const results = await db.select({
    invoice: invoices,
    customerName: customers.name,
    customerVorname: customers.vorname,
    customerNachname: customers.nachname,
  })
  .from(invoices)
  .innerJoin(customers, eq(invoices.customerId, customers.id))
  .where(eq(invoices.id, id));
  if (results.length === 0) return undefined;
  // Task #1074 (GoBD) — siehe getInvoices: eingefrorener Snapshot-Kundenname
  // statt JOIN-Live-Name (byte-stabil für Re-Render/Verifier).
  const snapshot = (results[0].invoice.renderSnapshot ?? null) as InvoiceRenderSnapshot | null;
  return {
    ...results[0].invoice,
    customerName: snapshot?.customer?.name ?? results[0].customerName,
    customerVorname: results[0].customerVorname,
    customerNachname: results[0].customerNachname,
  };
}

export async function createInvoiceTx(
  exec: DbOrTx,
  data: Record<string, unknown>,
  lineItems: Record<string, unknown>[],
  userId: number,
): Promise<Invoice> {
  const { invoices, invoiceLineItems } = await import("@shared/schema");
  const invoiceValues = { ...data, createdByUserId: userId } as typeof invoices.$inferInsert;
  const [invoice] = await exec.insert(invoices).values(invoiceValues).returning();

  if (lineItems.length > 0) {
    await exec.insert(invoiceLineItems).values(
      lineItems.map((item, idx) => ({
        ...item,
        invoiceId: invoice.id,
        sortOrder: idx,
      } as typeof invoiceLineItems.$inferInsert))
    );
  }

  return invoice;
}

export async function createInvoice(data: Record<string, unknown>, lineItems: Record<string, unknown>[], userId: number): Promise<Invoice> {
  return await db.transaction(async (tx) => createInvoiceTx(tx, data, lineItems, userId));
}

/**
 * DER Engpass für jeden Rechnungs-Statuswechsel — mit Übergangs-Prüfung.
 *
 * ── Was das ERSETZT ─────────────────────────────────────────────────────
 * Das ZWEITE Schreib-Regime des Zahlungsabgleichs. Bis zum Status-Umbau ging
 * der manuelle Weg (`PATCH /billing/:id/status`, `POST /bulk-status`) über
 * `isAllowedInvoiceStatusTransition`, der Qonto-Abgleich dagegen über eigene
 * Direkt-Updates mit handgeschriebenem `WHERE`-Guard. Die Übergangs-SSoT
 * beschrieb damit nur die halbe Wirklichkeit — wer sie las und für vollständig
 * hielt, irrte (Bestandsaufnahme, W3).
 *
 * Jetzt prüft dieser Engpass, und alle Pfade gehen hindurch.
 *
 * `erlaubeGleichstand`: ein Schreibvorgang, der den Status NICHT ändert
 * (z.B. Zahlung nachtragen bei bereits `bezahlt`), ist kein Übergang und
 * wird durchgelassen. Ohne diese Ausnahme müsste jeder Aufrufer vorher selbst
 * vergleichen — und genau dort entstünde das nächste Zweitregime.
 */
export async function updateInvoiceStatusTx(
  exec: DbOrTx,
  id: number,
  status: string,
  _userId: number,
): Promise<Invoice> {
  const { invoices } = await import("@shared/schema");
  const { eq, sql } = await import("drizzle-orm");
  const { isAllowedInvoiceStatusTransition } = await import("@shared/domain/invoice-status");

  // Ist-Status unter FOR UPDATE lesen: serialisiert konkurrierende Wechsel und
  // liest den tatsaechlichen Stand, nicht den, den der Aufrufer zu kennen glaubt.
  const [ist] = await exec
    .select({ status: invoices.status })
    .from(invoices)
    .where(eq(invoices.id, id))
    .for("update");
  if (!ist) {
    throw new Error(`Rechnung ${id} nicht gefunden.`);
  }
  if (ist.status !== status && !isAllowedInvoiceStatusTransition(ist.status, status)) {
    throw new Error(
      `Unzulaessiger Statuswechsel fuer Rechnung ${id}: "${ist.status}" -> "${status}". ` +
      `Erlaubte Uebergaenge: shared/domain/invoice-status.ts`,
    );
  }
  const updateData: Partial<Invoice> = { status: status as Invoice["status"] };
  if (status === "versendet") {
    updateData.sentAt = new Date();
    // #66 — Die Ausgabe-Marke gehoert an DIESEN Engpass, nicht an die einzelnen
    // Aufrufer: jeder Weg nach `versendet` ist eine Ausgabe, ob ueber
    // `mark-sent`, den Sammelversand oder den generischen Statuswechsel.
    // `COALESCE` haelt den URSPRUNGSZEITPUNKT fest — eine erneute Markierung
    // ueberschreibt ihn nicht.
    updateData.issuedAt = sql`COALESCE(${invoices.issuedAt}, now())` as unknown as Date;
  }
  // Task #1434: Zurücksetzen auf "entwurf" leert das Versanddatum wieder, damit
  // Liste/PDF/Status konsistent bleiben (kein "Versendet am …" auf einem Entwurf).
  // #66 — `issuedAt` wird hier BEWUSST NICHT geleert. Genau das war die Luecke:
  // nach dem Leeren galt die Rechnung wieder als nie ausgegeben und der
  // Entwurfs-Loeschpfad gab ihre Belegnummer frei. Die Marke nimmt allein das
  // ausdrueckliche Fehlmarkierungs-Ventil zurueck.
  if (status === "entwurf") updateData.sentAt = null;
  if (status === "bezahlt") updateData.paidAt = new Date();
  if (status === "storniert") updateData.storniertAt = new Date();
  const [updated] = await exec.update(invoices).set(updateData).where(eq(invoices.id, id)).returning();
  return updated;
}

export async function updateInvoiceStatus(id: number, status: string, userId: number): Promise<Invoice> {
  return updateInvoiceStatusTx(db, id, status, userId);
}

// Tx-only: pg_advisory_xact_lock wird beim Commit/Rollback freigegeben.
// Erzwingt den Tx-Typ damit niemand versehentlich `db` übergibt — sonst wäre
// der Lock am Statement-Ende weg und MAX/Insert wieder race-anfällig.
export async function getNextInvoiceNumberTx(tx: Tx, year: number): Promise<string> {
  const { invoices } = await import("@shared/schema");
  const { eq, sql } = await import("drizzle-orm");

  const lockKey = `invoice_number_${year}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::int8)`);

  // #66 — Die Nummer kommt aus der HOCHWASSERMARKE, nicht mehr aus
  // `MAX(...) + 1` ueber die verbliebenen Zeilen. Jene Ableitung vergab eine
  // Nummer erneut, sobald ihre Zeile geloescht wurde: dieselbe Belegnummer
  // bezeichnete dann zwei verschiedene Dokumente (GoBD).
  //
  // Schritt 1 — Marke aus dem Bestand nachziehen. `GREATEST` sorgt dafuer,
  // dass sie nie unterlaufen kann: weder beim ersten Zug in einem Jahr (leere
  // Tabelle) noch bei importierten oder von Hand gesetzten Nummern oberhalb
  // des bisherigen Standes. Die Marke sinkt dabei NIE.
  const maxExisting = await tx.select({
    maxNum: sql<number>`COALESCE(MAX(CAST(SUBSTRING(${invoices.invoiceNumber} FROM 'RE-\\d{4}-(\\d+)') AS INTEGER)), 0)`,
  })
  .from(invoices)
  .where(eq(invoices.billingYear, year));
  const seed = maxExisting[0]?.maxNum || 0;

  await tx.execute(sql`
    INSERT INTO invoice_number_sequence (billing_year, last_number, updated_at)
    VALUES (${year}, ${seed}, now())
    ON CONFLICT (billing_year) DO UPDATE
      SET last_number = GREATEST(invoice_number_sequence.last_number, EXCLUDED.last_number),
          updated_at  = now()
  `);

  // Schritt 2 — Marke um eins erhoehen und den neuen Wert zurueckgeben. Der
  // Advisory-Lock oben serialisiert das gegen parallele Zuege im selben Jahr.
  const bumped = await tx.execute(sql`
    UPDATE invoice_number_sequence
       SET last_number = last_number + 1, updated_at = now()
     WHERE billing_year = ${year}
    RETURNING last_number
  `);
  const next = Number((bumped.rows[0] as { last_number: number | string }).last_number);
  return formatInvoiceNumber(year, next);
}

export async function getInvoiceLineItemsTx(exec: DbOrTx, invoiceId: number): Promise<InvoiceLineItem[]> {
  const { invoiceLineItems } = await import("@shared/schema");
  const { eq, asc } = await import("drizzle-orm");
  return await exec.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoiceId)).orderBy(asc(invoiceLineItems.sortOrder));
}

// Sperrt die Originalrechnung bis Commit/Rollback. Schützt vor Doppel-Storno
// derselben Rechnung in parallelen Tx (zwei PATCHs würden sonst beide den
// alten Status sehen und je eine Stornorechnung erzeugen).
export async function getInvoiceForUpdateTx(exec: DbOrTx, id: number): Promise<Invoice | undefined> {
  const { invoices } = await import("@shared/schema");
  const { eq } = await import("drizzle-orm");
  const rows = await exec.select().from(invoices).where(eq(invoices.id, id)).for("update");
  return rows[0];
}

export async function getInvoiceLineItems(invoiceId: number): Promise<InvoiceLineItem[]> {
  return getInvoiceLineItemsTx(db, invoiceId);
}

export async function getInvoicesForCustomerMonth(customerId: number, year: number, month: number): Promise<Invoice[]> {
  const { invoices } = await import("@shared/schema");
  const { eq, and } = await import("drizzle-orm");
  return await db.select().from(invoices).where(
    and(
      eq(invoices.customerId, customerId),
      eq(invoices.billingYear, year),
      eq(invoices.billingMonth, month)
    )
  );
}
