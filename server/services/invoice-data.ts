import { badRequest } from "../lib/errors";
import { computeNoShowCharge, type CancellationPolicyType } from "@shared/domain/cancellation-policy";
import { quantizeKm, computeKmLineTotalCents } from "@shared/domain/invoice-line-items";
import { istKilometerPosition } from "@shared/domain/invoice-vat";
import { getCareLevelAt } from "../storage/customer-mgmt/care-level";
import { buildBudgetSplitFromLedger, type BudgetSplitForAppointment, type SplitReversalRow } from "@shared/domain/budget-invoice-split";
import { parseStornoReference } from "@shared/domain/budget/phantom-storno";
import { FINAL_APPOINTMENT_STATUSES } from "@shared/domain/appointments";
import { serviceRecordEmployeeId } from "@shared/domain/service-record-scope";
import { appointments, appointmentServices as appointmentServicesTable, services as servicesTable, users, customers as customersTable, customerInsuranceHistory, insuranceProviders, invoices as invoicesTable, invoiceLineItems, monthlyServiceRecords, serviceRecordAppointments, budgetTransactions } from "@shared/schema";
import { eq, and, isNull, inArray, notInArray, ne, desc, or, gte, lt, lte, sql } from "drizzle-orm";
import { formatDateForDisplay } from "@shared/utils/datetime";
import { db, type DbOrTx, type Tx } from "../lib/db";
import { chronologischeReihenfolge } from "../storage/budget/abrechnungs-lauf";
import { rebookNetZeroAppointmentCore } from "../storage/budget/rebook-storage";
import { reverseBudgetTransaction } from "../storage/budget/transaction-storage";
import { readUnifiedBudgetAvailability } from "../storage/budget/unified-reader";
import { loadCustomerPriceContext } from "../storage/pricing/price-for";
import { monthlyServiceRecordsRepo, appointmentsRepo } from "../repos";
import { resolveCustomerInsuranceAt } from "../storage/customer-mgmt/insurance";
import { isServiceRecordSignedForBilling, BILLING_BLOCK_MESSAGES } from "@shared/domain/billing-eligibility";
import { findActiveInvoicesForAppointments } from "../lib/appointment-invoiced";

export interface BuildLineItem extends Record<string, unknown> {
  appointmentId: number;
  appointmentDate: string;
  serviceDescription: string;
  serviceCode: string | null;
  startTime: string | null;
  endTime: string | null;
  durationMinutes: number;
  // Task #561: explizite Menge + Einheit. Für km-Lines trägt
  // `quantityRaw` die auf 2 Nachkommastellen quantisierten Kilometer
  // (gleicher Wert für Anzeige UND Berechnung). Für Stunden-Lines
  // trägt `quantityRaw` die Dezimalstunden (`durationMinutes / 60`).
  quantityRaw: number;
  quantityUnit: "hours" | "km";
  unitPriceCents: number;
  totalCents: number;
  employeeName: string;
  appointmentNotes: string | null;
  serviceDetails: string | null;
  /**
   * Pflegegrad, der am Leistungstag in der Historie nachgewiesen ist
   * (`getCareLevelAt`), sonst `null`. Grundlage der USt (Tabelle D) und des
   * „Leistungsempfänger … (Pflegegrad N)" auf der Rechnung. NIE aus
   * `customers.pflegegrad` (Stand heute).
   */
  pflegegradAmLeistungstag: number | null;
  /** Codes der Hauptleistungen desselben Termins — Kilometer folgen ihnen (D6). */
  hauptleistungenDesTermins: string[];
}

/**
 * Idempotenz-Sperre der Abrechnungs-Engine: welche der übergebenen Termine
 * liegen bereits auf einer aktiven Rechnung — ZEITRAUM-BLIND?
 *
 * Task #1892 (PR-2). ERSETZT die frühere Signatur
 * `(customerId, billingYear, billingMonth)`, die über
 * `invoices.billing_year`/`billing_month` filterte. Dieser Zeitraum-Scope war
 * eine stille Lücke: ein Termin, der auf einer Rechnung eines ANDEREN
 * Abrechnungszeitraums liegt, las sich hier als „noch nicht abgerechnet" und
 * wurde ein zweites Mal berechnet. Die Frage der Engine ist nicht „im Monat X
 * abgerechnet?", sondern „überhaupt abgerechnet?" — ein Termin wird genau
 * einmal berechnet.
 *
 * Die neue Form fragt nicht mehr selbst, sondern KONSUMIERT die #1892-SSoT
 * `findActiveInvoicesForAppointments` (`server/lib/appointment-invoiced.ts`).
 * Damit gibt es für „liegt dieser Termin auf einer aktiven Rechnung?" genau
 * eine Ableitung — Anzeige, Schutz-Guard und Engine können nicht mehr
 * auseinanderlaufen. Der Kunden-Scope entfällt ersatzlos: ein Termin gehört zu
 * genau einem Kunden, die Termin-Menge trägt die Eingrenzung bereits.
 *
 * Enger als vorher, nie weiter: die Sperre kann ab jetzt nur MEHR blockieren.
 */
export async function getAlreadyInvoicedAppointmentIds(
  appointmentIds: readonly number[],
  client: DbOrTx = db,
): Promise<number[]> {
  const rows = await findActiveInvoicesForAppointments(appointmentIds, client);
  return Array.from(
    new Set(rows.map(r => r.appointmentId).filter((id): id is number => id !== null)),
  );
}

/**
 * Namensraum der Abrechnungs-Sperre. Ein fester erster Schlüssel trennt sie von
 * jedem anderen Advisory-Lock der Anwendung; der zweite ist die Kunden-ID.
 */
const BILLING_LOCK_NAMESPACE = 1892;

/**
 * Serialisiert die Rechnungserstellung PRO KUNDE innerhalb der laufenden
 * Transaktion.
 *
 * `pg_advisory_xact_lock` blockiert, bis ein konkurrierender Lauf für denselben
 * Kunden committet oder zurückgerollt hat, und wird beim Transaktionsende
 * automatisch freigegeben — es gibt keinen Pfad, auf dem die Sperre liegen
 * bleibt (anders als bei einem Session-Lock, der bei Pool-Wiederverwendung
 * hängen bliebe).
 *
 * Der Schlüssel ist der KUNDE, nicht der Zeitraum: seit #1892 PR-2 ist die
 * Idempotenz-Frage zeitraum-blind, also müssen sich auch zwei Läufe für
 * verschiedene Monate desselben Kunden serialisieren — sie können dieselben
 * Termine betreffen.
 */
export async function lockCustomerForBilling(tx: Tx, customerId: number): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${BILLING_LOCK_NAMESPACE}::int, ${customerId}::int)`,
  );
}

/**
 * Autoritative Idempotenz-Prüfung INNERHALB der Schreib-Transaktion.
 *
 * ERSETZT die Vor-Transaktions-Prüfung in `generateInvoiceCore` als
 * verbindliche Entscheidung. Jene bleibt bestehen, aber nur noch für das, was
 * sie leisten kann: den Entwurf bauen und die Vorschau-Zahlen füllen. Als
 * Sperre taugte sie nicht — zwischen ihrem `SELECT` und dem `INSERT` lag ein
 * offenes Fenster, in dem ein paralleler Lauf dieselben Termine abrechnen
 * konnte (check-then-write). Zwei gleichzeitige `POST /api/billing/generate`
 * für denselben Kunden erzeugten so zwei Rechnungen über dieselben Termine.
 *
 * Zusammen mit `lockCustomerForBilling` ist das Fenster zu: der zweite Lauf
 * wartet auf den Lock, sieht danach die committeten Zeilen des ersten und
 * bricht mit derselben Meldung ab, die auch der Vorab-Pfad verwendet
 * (`BILLING_BLOCK_MESSAGES.already_billed`) — eine Formulierung, kein
 * zweiter Begriff.
 */
export async function assertAppointmentsNotYetInvoiced(
  tx: Tx,
  appointmentIds: readonly number[],
): Promise<void> {
  if (appointmentIds.length === 0) return;
  const already = await getAlreadyInvoicedAppointmentIds(appointmentIds, tx);
  if (already.length > 0) {
    throw badRequest(BILLING_BLOCK_MESSAGES.already_billed);
  }
}

// Task #817: Verwaiste/blockierende Entwurfs-Rechnungen eines Zeitraums.
// Sie tauchen in `getAlreadyInvoicedAppointmentIds` als „bereits abgerechnet"
// auf (status != 'storniert'), obwohl sie nie finalisiert wurden — und
// blockieren so jede neue Rechnung. Storno-Rechnungen sind ausgeschlossen:
// Ein Storno-Entwurf gehört zum GoBD-Storno-Trail und darf NICHT als
// „verwaist" verworfen werden.
export async function getBlockingDraftInvoices(customerId: number, billingYear: number, billingMonth: number) {
  return db.select({
    id: invoicesTable.id,
    invoiceNumber: invoicesTable.invoiceNumber,
    grossAmountCents: invoicesTable.grossAmountCents,
    billingRunId: invoicesTable.billingRunId,
    createdAt: invoicesTable.createdAt,
  })
    .from(invoicesTable)
    .where(and(
      eq(invoicesTable.customerId, customerId),
      eq(invoicesTable.billingYear, billingYear),
      eq(invoicesTable.billingMonth, billingMonth),
      eq(invoicesTable.status, "entwurf"),
      ne(invoicesTable.invoiceType, "stornorechnung"),
    ))
    .orderBy(desc(invoicesTable.createdAt));
}

/**
 * Task #1790 — EINE SSoT: welche Kunden haben im Monat ≥1 dokumentierten
 * (`completed`), strikt signierten, noch NICHT abgerechneten Termin?
 *
 * Spiegelt die Termin-genaue Idempotenz von `getAlreadyInvoicedAppointmentIds`
 * und der process-health-„noch abzurechnen"-Sicht: pro Kunde die Termine unter
 * strikt-signierten Leistungsnachweisen (`isServiceRecordSignedForBilling`,
 * kassen-/zahlerabhängig) minus die bereits abgerechneten Termine.
 *
 * Sowohl `GET /billing/eligible-customers` (Anzeige + Zähler, no-date-range) als
 * auch `POST /billing/generate-all` (Skip-Vorprüfung, no-date-range) nutzen
 * DIESE Funktion — kein zweiter Ableitungspfad, damit „taucht in der Liste auf"
 * und „wird tatsächlich abgerechnet" nie auseinanderlaufen. Ersetzt den bis
 * dahin kunde-groben „hat irgendeine Rechnung im Monat → ausschließen/skip"-
 * Filter, der spät signierte Nachzügler-Termine unsichtbar machte.
 */
export interface UnbilledSignedFacts {
  /** Termine unter strikt-signierten LNs (vor „bereits abgerechnet"-Filter). */
  signedAppointmentCount: number;
  /** Anzahl davon, die NOCH NICHT abgerechnet sind. */
  unbilledAppointmentCount: number;
}

export async function getUnbilledSignedAppointmentFactsByCustomer(
  customerIds: number[],
  billingYear: number,
  billingMonth: number,
): Promise<Map<number, UnbilledSignedFacts>> {
  const result = new Map<number, UnbilledSignedFacts>();
  if (customerIds.length === 0) return result;

  // LN-Status je Kunde (loser Filter completed/employee_signed — der strikte
  // Signatur-Filter unten ist eine Teilmenge davon).
  const signedRecords = await monthlyServiceRecordsRepo.selectColumnsFrom({
    id: monthlyServiceRecords.id,
    customerId: monthlyServiceRecords.customerId,
    status: monthlyServiceRecords.status,
  })
    .where(and(
      inArray(monthlyServiceRecords.customerId, customerIds),
      eq(monthlyServiceRecords.year, billingYear),
      eq(monthlyServiceRecords.month, billingMonth),
      or(
        eq(monthlyServiceRecords.status, "completed"),
        eq(monthlyServiceRecords.status, "employee_signed"),
      ),
      monthlyServiceRecordsRepo.activeOnly(),
    ));
  if (signedRecords.length === 0) return result;

  // Kassen-/zahlerabhängiges Signatur-Gate braucht den billingType je Kunde.
  const billingTypeRows = await db.select({
    id: customersTable.id,
    billingType: customersTable.billingType,
  })
    .from(customersTable)
    .where(inArray(customersTable.id, customerIds));
  const billingTypeById = new Map(billingTypeRows.map(c => [c.id, c.billingType]));

  // Strikt-signierte LN-IDs je Kunde (identische Akzeptanz wie `buildInvoiceDraft`).
  const strictSrToCustomer = new Map<number, number>();
  for (const r of signedRecords) {
    if (isServiceRecordSignedForBilling(billingTypeById.get(r.customerId), r.status)) {
      strictSrToCustomer.set(r.id, r.customerId);
    }
  }
  const strictSrIds = Array.from(strictSrToCustomer.keys());
  if (strictSrIds.length === 0) return result;

  // Termine unter strikt-signierten LNs (spiegelt `getAppointmentIdsFromServiceRecords`).
  // Task #1868 — soft-gelöschte Termine ausschließen (identisch zum echten
  // Generate-Pfad, der die Termine über `buildLineItemsFromAppointments` /
  // `getBudgetSplitForAppointments` mit `appointmentsRepo.activeOnly()` liest
  // und gelöschte Termine gar nicht abrechnet). Ohne diesen Filter zählte ein
  // noch mit dem LN verknüpfter, aber gelöschter und nie abgerechneter Termin
  // als „signiert & offen" → Kunde erschien fälschlich abrechenbar, während die
  // Erstellung 0,00 € erzeugt (Review↔Generate-Drift).
  const signedApptByCustomer = new Map<number, Set<number>>();
  const srApptRows = await db.select({
    serviceRecordId: serviceRecordAppointments.serviceRecordId,
    appointmentId: serviceRecordAppointments.appointmentId,
  })
    .from(serviceRecordAppointments)
    .innerJoin(appointments, eq(serviceRecordAppointments.appointmentId, appointments.id))
    .where(and(
      inArray(serviceRecordAppointments.serviceRecordId, strictSrIds),
      appointmentsRepo.activeOnly(),
    ));
  for (const row of srApptRows) {
    const cid = strictSrToCustomer.get(row.serviceRecordId);
    if (cid == null) continue;
    const set = signedApptByCustomer.get(cid) ?? new Set<number>();
    set.add(row.appointmentId);
    signedApptByCustomer.set(cid, set);
  }

  // Bereits abgerechnete Termine (spiegelt `getAlreadyInvoicedAppointmentIds`,
  // batch — und ist deshalb wie diese ZEITRAUM-BLIND, Task #1892 PR-2). Liefe
  // der Spiegel weiter zeitraum-gescopt, erschiene ein Kunde in der Liste als
  // abrechenbar, dessen Termine die Engine bereits sperrt — genau die
  // Review-↔-Generate-Drift, gegen die #1790 gebaut wurde.
  const allSignedApptIds = Array.from(
    new Set(Array.from(signedApptByCustomer.values()).flatMap(s => Array.from(s))),
  );
  const invoicedApptIds = new Set(await getAlreadyInvoicedAppointmentIds(allSignedApptIds));

  for (const [cid, signedAppts] of signedApptByCustomer) {
    let unbilled = 0;
    for (const id of signedAppts) if (!invoicedApptIds.has(id)) unbilled++;
    result.set(cid, {
      signedAppointmentCount: signedAppts.size,
      unbilledAppointmentCount: unbilled,
    });
  }
  return result;
}

export async function getServiceRecordsForPeriod(customerId: number, year: number, month: number) {
  return monthlyServiceRecordsRepo.selectFrom()
    .where(and(
      eq(monthlyServiceRecords.customerId, customerId),
      eq(monthlyServiceRecords.year, year),
      eq(monthlyServiceRecords.month, month),
      monthlyServiceRecordsRepo.activeOnly()
    ));
}

export async function getAppointmentIdsFromServiceRecords(serviceRecordIds: number[]): Promise<number[]> {
  if (serviceRecordIds.length === 0) return [];
  const rows = await db.select({ appointmentId: serviceRecordAppointments.appointmentId })
    .from(serviceRecordAppointments)
    .where(inArray(serviceRecordAppointments.serviceRecordId, serviceRecordIds));
  return rows.map(r => r.appointmentId);
}

/**
 * Task #1625 — Dokumentations-Abdeckung pro Kunde für einen Abrechnungsmonat.
 * Liefert je Kunde die Zahl der dokumentierten (`completed`) Termine im Monat
 * und die davon durch aktive Leistungsnachweise abgedeckten Termine. Das ist
 * die EINE Berechnung, die sowohl `/billing/eligible-customers` (Anzeige-Hinweis
 * + Zähler) als auch `POST /billing/generate-all` (optionaler Skip
 * unvollständiger Kunden) nutzen — kein zweiter Ableitungspfad. Die „partiell
 * dokumentiert"-Klassifikation selbst lebt in der pure SSoT
 * `isPartiallyDocumented` (`@shared/domain/billing-eligibility`).
 */
export async function getDocumentationCoverageByCustomer(
  customerIds: number[],
  billingYear: number,
  billingMonth: number,
): Promise<Map<number, { completedAppointments: number; coveredAppointments: number }>> {
  const result = new Map<number, { completedAppointments: number; coveredAppointments: number }>();
  if (customerIds.length === 0) return result;

  const mm = String(billingMonth).padStart(2, "0");
  const periodStartStr = `${billingYear}-${mm}-01`;
  const nextMonth = billingMonth === 12 ? 1 : billingMonth + 1;
  const nextYear = billingMonth === 12 ? billingYear + 1 : billingYear;
  const periodEndStr = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;

  const completedRows = await appointmentsRepo.selectColumnsFrom({
    customerId: appointments.customerId,
    count: sql<number>`COUNT(*)::int`,
  })
    .where(and(
      inArray(appointments.customerId, customerIds),
      eq(appointments.status, "completed"),
      appointmentsRepo.activeOnly(),
      gte(appointments.date, periodStartStr),
      lt(appointments.date, periodEndStr),
    ))
    .groupBy(appointments.customerId);
  const completedByCustomer = new Map(completedRows.map(r => [r.customerId, Number(r.count)]));

  const signedRecords = await monthlyServiceRecordsRepo.selectColumnsFrom({
    id: monthlyServiceRecords.id,
  })
    .where(and(
      eq(monthlyServiceRecords.year, billingYear),
      eq(monthlyServiceRecords.month, billingMonth),
      or(
        eq(monthlyServiceRecords.status, "completed"),
        eq(monthlyServiceRecords.status, "employee_signed"),
      ),
      monthlyServiceRecordsRepo.activeOnly(),
    ));
  const allActiveSrIds = signedRecords.map(r => r.id);
  const coveredRows = allActiveSrIds.length > 0
    ? await db.select({
        customerId: appointments.customerId,
        count: sql<number>`COUNT(DISTINCT ${serviceRecordAppointments.appointmentId})::int`,
      })
        .from(serviceRecordAppointments)
        .innerJoin(appointments, eq(serviceRecordAppointments.appointmentId, appointments.id))
        .where(and(
          inArray(serviceRecordAppointments.serviceRecordId, allActiveSrIds),
          inArray(appointments.customerId, customerIds),
          // Task #1868 — soft-gelöschte Termine dürfen die „abgedeckt"-Zahl nicht
          // aufblähen; sonst kann `coveredAppointments` die dokumentierten
          // (`completed`, bereits active-gefiltert) übersteigen.
          appointmentsRepo.activeOnly(),
        ))
        .groupBy(appointments.customerId)
    : [];
  const coveredByCustomer = new Map(coveredRows.map(r => [r.customerId, Number(r.count)]));

  for (const id of customerIds) {
    result.set(id, {
      completedAppointments: completedByCustomer.get(id) ?? 0,
      coveredAppointments: coveredByCustomer.get(id) ?? 0,
    });
  }
  return result;
}

/**
 * Task #1905 — DIE EINE Termin-Mengen-SSoT des Abrechnungs-Fensters pro Kunde.
 *
 * ERSETZT `getOpenAppointmentCountByCustomer` (Task #1743): dessen einzige
 * Antwort — die Zahl der offenen Termine — ist hier `openIds.length`. Zwei
 * Funktionen mit demselben Fenster, derselben `FINAL_APPOINTMENT_STATUSES`-SSoT
 * und einem wortgleich kopierten `dateConds`-Block nebeneinander hätten
 * garantiert auseinanderdriften können; die Erstberatungs-Abweichung (unten) war
 * bereits der Anfang davon.
 *
 * Liefert pro Kunde die zwei disjunkten Mengen, aus denen Gruppierung, IST und
 * PLAN gebildet werden:
 *
 *  • `documentedUnbilledIds` — dokumentierte (`completed`) Termine im Zeitraum,
 *    die noch auf KEINER aktiven Rechnung liegen. Basis des IST-Betrags
 *    (geleistete, noch nicht abgerechnete Arbeit) — unabhängig davon, ob sie
 *    bereits abrechenbar signiert sind. Genau das füllt in der Gruppe
 *    „Leistungsnachweis fehlt" die heutigen „—".
 *  • `openIds` — offene (noch nicht finale) Termine im Zeitraum. Basis des
 *    PLAN-Betrags (geplante, noch nicht geleistete Arbeit).
 *
 * Beide Mengen sind per Status-Definition disjunkt (`completed` ist ein finaler
 * Status, `openIds` ist dessen Komplement über `FINAL_APPOINTMENT_STATUSES`) —
 * kein Termin trägt zu IST und PLAN gleichzeitig bei.
 *
 * „Offen" = jeder aktive Termin, dessen Status NICHT terminal ist — exakt die
 * `FINAL_APPOINTMENT_STATUSES`-SSoT, die auch die Monatsabschluss-Readiness
 * nutzt. Das Fenster spiegelt den Eligibility-Scope von
 * `GET /billing/eligible-customers`: ohne Datumsbereich der ganze Monat, mit
 * `dateFrom`/`dateTo` nur das gewählte Fenster (inklusiver `lte dateTo`).
 *
 * Der `Erstberatung`-Ausschluss gilt für BEIDE Mengen und ist damit die
 * Korrektur einer echten Abweichung: `getOpenAppointmentCountByCustomer` hatte
 * ihn nicht. Ein Erstberatungs-Termin mit gesetzter `customer_id` zählte dort
 * als offener Termin (Kunde in „Dokumentation ausstehend"), steuerte aber nichts
 * zum PLAN-Betrag bei — Gruppierung und Betrag sagten Verschiedenes über
 * denselben Termin. Erstberatungen sind kundenseitig nie abrechenbar
 * (CLAUDE.md); mitarbeiterseitig (Lohn/Stunden/km) bleiben sie unberührt, dieser
 * Reader liegt ausschließlich auf dem Kundenpfad.
 */
export async function getClusterAmountAppointmentsByCustomer(
  customerIds: number[],
  billingYear: number,
  billingMonth: number,
  range?: { dateFrom?: string; dateTo?: string },
): Promise<Map<number, { documentedUnbilledIds: number[]; openIds: number[] }>> {
  const result = new Map<number, { documentedUnbilledIds: number[]; openIds: number[] }>();
  if (customerIds.length === 0) return result;
  for (const id of customerIds) result.set(id, { documentedUnbilledIds: [], openIds: [] });

  const dateConds = range?.dateFrom || range?.dateTo
    ? [
        ...(range.dateFrom ? [gte(appointments.date, range.dateFrom)] : []),
        ...(range.dateTo ? [lte(appointments.date, range.dateTo)] : []),
      ]
    : (() => {
        const mm = String(billingMonth).padStart(2, "0");
        const periodStartStr = `${billingYear}-${mm}-01`;
        const nextMonth = billingMonth === 12 ? 1 : billingMonth + 1;
        const nextYear = billingMonth === 12 ? billingYear + 1 : billingYear;
        const periodEndStr = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
        return [gte(appointments.date, periodStartStr), lt(appointments.date, periodEndStr)];
      })();

  const rows = await appointmentsRepo.selectColumnsFrom({
    id: appointments.id,
    customerId: appointments.customerId,
    status: appointments.status,
  })
    .where(and(
      inArray(appointments.customerId, customerIds),
      ne(appointments.appointmentType, "Erstberatung"),
      appointmentsRepo.activeOnly(),
      ...dateConds,
    ));

  const completedIds: number[] = [];
  for (const r of rows) {
    if (r.customerId == null) continue;
    if (r.status === "completed") completedIds.push(r.id);
  }
  // Zeitraum-blind, identisch zur Engine-Sperre in `buildInvoiceDraft`: ein
  // Termin auf einer Rechnung eines ANDEREN Abrechnungszeitraums ist abgerechnet
  // und darf nicht noch einmal als offener IST-Betrag erscheinen.
  const invoicedIds = new Set(await getAlreadyInvoicedAppointmentIds(completedIds));

  const finalStatuses = new Set<string>(FINAL_APPOINTMENT_STATUSES);
  for (const r of rows) {
    if (r.customerId == null) continue;
    const entry = result.get(r.customerId);
    if (!entry) continue;
    if (r.status === "completed") {
      if (!invoicedIds.has(r.id)) entry.documentedUnbilledIds.push(r.id);
    } else if (!finalStatuses.has(r.status)) {
      entry.openIds.push(r.id);
    }
  }
  return result;
}

export async function buildLineItemsFromAppointments(apptIds: number[], customerId?: number, billingType?: string) {
  // #1886: Erstberatungen erreichen die Kunden-Abrechnung nicht — die `apptIds`
  // stammen ausschließlich aus kunden-signierten Leistungsnachweisen
  // (`getAppointmentIdsFromServiceRecords`), und Erstberatungen sind kundenlos
  // (customer_id = NULL) und tragen nie einen LN. Der Ausschluss ist damit an
  // diesen Invariant gekoppelt (kein redundanter appointment_type-Filter). Auf der
  // Mitarbeiterseite (Lohn/Stunden/km) zählt die Erstberatung dagegen voll — siehe
  // CLAUDE.md → Arbeitsregeln.
  if (apptIds.length === 0) return { lineItems: [], totalNetCents: 0 };
  // Keine USt mehr hier: die Entscheidung fällt je Topf in `ustFuerTopf`
  // (Tabelle D, § 4 Nr. 16 g UStG). Der Zeilen-Bauer liefert dafür je Zeile
  // den Pflegegrad am Leistungstag und die Hauptleistungen des Termins.

  const appts = await appointmentsRepo.selectFrom()
    .where(and(inArray(appointments.id, apptIds), appointmentsRepo.activeOnly()));

  // Task #485: Cancellation-Policy nur für Selbstzahler.
  let cancellationPolicy: {
    type: string;
    flatCents: number | null;
    hourlyRateCents: number | null;
    kmRateCents: number | null;
  } | null = null;
  if (customerId && billingType === "selbstzahler") {
    const polRow = await db
      .select({
        type: customersTable.cancellationPolicyType,
        flatCents: customersTable.cancellationFlatCents,
        hourlyRateCents: customersTable.cancellationHourlyRateCents,
        kmRateCents: customersTable.cancellationKmRateCents,
      })
      .from(customersTable)
      .where(eq(customersTable.id, customerId))
      .limit(1);
    if (polRow.length > 0) {
      cancellationPolicy = polRow[0];
    }
  }

  const serviceBreakdown = await db.select({
    appointmentId: appointmentServicesTable.appointmentId,
    serviceId: appointmentServicesTable.serviceId,
    serviceCode: servicesTable.code,
    serviceName: servicesTable.name,
    plannedDurationMinutes: appointmentServicesTable.plannedDurationMinutes,
    actualDurationMinutes: appointmentServicesTable.actualDurationMinutes,
    defaultPriceCents: servicesTable.defaultPriceCents,
    vatRate: servicesTable.vatRate,
    details: appointmentServicesTable.details,
  })
  .from(appointmentServicesTable)
  .innerJoin(servicesTable, eq(appointmentServicesTable.serviceId, servicesTable.id))
  .where(inArray(appointmentServicesTable.appointmentId, apptIds));

  const resolvedCustomerId = customerId ?? appts[0]?.customerId;
  // Task #1291 — Preis-Auflösung ausschließlich über die `priceFor`-SSoT
  // (Kunden-Override → Standard → Katalog-Default, zeitversioniert, Existenz
  // der Kundenzeile gewinnt auch bei cents = 0).
  const priceCtx = await loadCustomerPriceContext(resolvedCustomerId ?? null);

  // Task #1896 — WEM gehört der Termin? Über die Umfangs-SSoT, nicht über eine
  // eigene Reihenfolge. Die frühere Formel (`assigned || performed`) stellte
  // den Zugewiesenen VOR den Erbringer und nannte damit im
  // Leistungsnachweis-PDF („Mitarbeiter/in (Leistungserbringer/in)") einen
  // anderen Mitarbeiter, als darunter unterschrieben hat.
  const employeeIds = [...new Set(appts.map(a => serviceRecordEmployeeId(a)).filter((id): id is number => id != null))];
  const employeeMap = new Map<number, { displayName: string }>();
  if (employeeIds.length > 0) {
    const emps = await db.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, employeeIds));
    for (const emp of emps) {
      employeeMap.set(emp.id, { displayName: emp.displayName });
    }
  }

  const kmServiceRows = await db.select({
    id: servicesTable.id,
    code: servicesTable.code,
    name: servicesTable.name,
    defaultPriceCents: servicesTable.defaultPriceCents,
    vatRate: servicesTable.vatRate,
  })
  .from(servicesTable)
  .where(inArray(servicesTable.code, ["travel_km", "customer_km", "hauswirtschaft"]));
  const kmServiceMap = new Map(kmServiceRows.map(s => [s.code, s]));

  // Pflegegrad je Leistungstag — aus der Historie (`getCareLevelAt`), einmal
  // je Datum gelesen.
  const pflegegradAm = new Map<string, number | null>();
  if (resolvedCustomerId != null) {
    for (const datum of new Set(appts.map(a => a.date))) {
      pflegegradAm.set(datum, await getCareLevelAt(resolvedCustomerId, datum));
    }
  }

  const lineItems: BuildLineItem[] = [];
  let totalNetCents = 0;

  for (const appt of appts) {
    const apptServices = serviceBreakdown.filter(s => s.appointmentId === appt.id);
    const apptDate = appt.date;
    const ustKontext = {
      pflegegradAmLeistungstag: pflegegradAm.get(apptDate) ?? null,
      hauptleistungenDesTermins: apptServices
        .map(s => s.serviceCode)
        .filter((c): c is string => c != null && !istKilometerPosition(c)),
    };

    const employeeId = serviceRecordEmployeeId(appt);
    const emp = employeeId ? employeeMap.get(employeeId) : undefined;
    const employeeName = emp?.displayName || "";

    // Task #485 — Customer No-Show: keine Service-Posten; ggf. "Vergebliche Anfahrt"-Posten für Selbstzahler.
    if (appt.status === "customer_no_show") {
      // Wenn der Sachbearbeiter die Privatrechnung explizit unterdrückt hat
      // (Kulanz mit Begründung), wird kein Line-Item erzeugt.
      if (appt.noShowChargeSuppressed) {
        continue;
      }
      if (cancellationPolicy && cancellationPolicy.type !== "none") {
        // Fallback-Sätze aus globalem Service-Katalog (gleiche Quelle wie
        // die Doc-Endpoint-Vorschau — verhindert Preview-vs-Booking-Drift).
        const travelKmSvc = kmServiceMap.get("travel_km");
        const hwSvc = kmServiceMap.get("hauswirtschaft");
        const charge = computeNoShowCharge(
          {
            type: cancellationPolicy.type as CancellationPolicyType,
            flatCents: cancellationPolicy.flatCents,
            hourlyRateCents: cancellationPolicy.hourlyRateCents,
            kmRateCents: cancellationPolicy.kmRateCents,
          },
          {
            // Task #1565: No-Show-Km-SSoT ist ausschließlich `noShowKilometers`
            // (identisch mit der Zeitübersicht-Leerfahrten-Kachel). Der frühere
            // `?? travelKilometers`-Fallback war die zweite Quelle und ist
            // entfernt; Alt-Datensätze werden per Startup-Backfill migriert.
            travelKilometers: appt.noShowKilometers ?? 0,
            waitMinutes: appt.noShowWaitMinutes ?? 0,
          },
          {
            kmRateCents: travelKmSvc?.defaultPriceCents ?? null,
            hourlyRateCents: hwSvc?.defaultPriceCents ?? null,
          },
        );
        if (charge.totalCents > 0) {
          // VAT 0: Schadensersatz-/Ausfallleistung, kein Leistungsaustausch.
          const dateLabel = formatDateForDisplay(appt.date);
          const waitMin = appt.noShowWaitMinutes ?? 0;
          lineItems.push({
            appointmentId: appt.id,
            appointmentDate: appt.date,
            serviceDescription: `Vergebliche Anfahrt am ${dateLabel}`,
            serviceCode: "no_show_charge",
            startTime: appt.actualStart || appt.scheduledStart,
            endTime: null,
            durationMinutes: waitMin,
            // No-Show-Pauschale wird als 1 "Vorgang" abgebildet (Stunden-Einheit
            // mit Menge 1, damit Menge × Satz = Summe aufgeht).
            quantityRaw: 1,
            quantityUnit: "hours",
            unitPriceCents: charge.totalCents,
            totalCents: charge.totalCents,
            employeeName,
            appointmentNotes: appt.noShowNotes || null,
            serviceDetails: null,
            ...ustKontext,
          });
          totalNetCents += charge.totalCents;
        }
      }
      continue;
    }

    for (const svc of apptServices) {
      const durationMinutes = Math.round(svc.actualDurationMinutes ?? svc.plannedDurationMinutes ?? 0);
      const pricePer60Min = priceCtx.resolveById(svc.serviceId, apptDate)?.cents ?? null;
      if (pricePer60Min == null) {
        throw badRequest(`Kein Preis hinterlegt für Dienstleistung "${svc.serviceName || svc.serviceCode}". Bitte prüfen Sie den Dienstleistungskatalog.`);
      }
      const totalCents = Math.round((durationMinutes / 60) * pricePer60Min);

      lineItems.push({
        appointmentId: appt.id,
        appointmentDate: appt.date,
        serviceDescription: svc.serviceName || svc.serviceCode || "Dienstleistung",
        serviceCode: svc.serviceCode,
        startTime: appt.actualStart || appt.scheduledStart,
        endTime: appt.actualEnd || appt.scheduledEnd,
        durationMinutes,
        // Task #561: Stunden-Line — Menge in Dezimalstunden. Berechnung
        // (Math.round((durationMinutes/60) * pricePer60Min)) bleibt unverändert,
        // damit Bestandsverhalten und Tests stabil sind.
        quantityRaw: durationMinutes / 60,
        quantityUnit: "hours",
        unitPriceCents: pricePer60Min,
        totalCents,
        employeeName,
        appointmentNotes: appt.notes || null,
        serviceDetails: svc.details || null,
        ...ustKontext,
      });

      totalNetCents += totalCents;
    }

    const kmEntries: { code: string; km: number }[] = [];
    if (appt.travelKilometers && appt.travelKilometers > 0) {
      kmEntries.push({ code: "travel_km", km: appt.travelKilometers });
    }
    if (appt.customerKilometers && appt.customerKilometers > 0) {
      kmEntries.push({ code: "customer_km", km: appt.customerKilometers });
    }
    for (const kmEntry of kmEntries) {
      const kmSvc = kmServiceMap.get(kmEntry.code);
      if (!kmSvc) continue;
      const kmCustomerPrice = priceCtx.resolveById(kmSvc.id, apptDate)?.cents ?? null;
      // Task #1033 — Kein stiller, festkodierter Kilometer-Fallback-Preis:
      // analog zum Stunden-Preis (oben) wird ein fehlender km-Satz als klarer
      // Konfigurationsfehler gemeldet statt mit einem irreführenden Default
      // (vorher `?? 35`) abgerechnet, der nicht zur Preisliste passt.
      const pricePerKm = kmCustomerPrice;
      if (pricePerKm == null) {
        throw badRequest(`Kein Kilometer-Preis hinterlegt für "${kmSvc.name || kmEntry.code}". Bitte prüfen Sie den Dienstleistungskatalog.`);
      }
      // Task #561: GoBD-konforme km-Quantisierung — Anzeige UND Berechnung
      // verwenden denselben auf 2 Nachkommastellen gerundeten Wert.
      // Vorher: `Math.round(km * pricePerKm)` mit ungerundetem Float +
      // `Math.round(km)` als Anzeige → Drift (s. RE-2026-0003).
      const quantityKm = quantizeKm(kmEntry.km);
      const kmTotalCents = computeKmLineTotalCents(kmEntry.km, pricePerKm);

      lineItems.push({
        appointmentId: appt.id,
        appointmentDate: appt.date,
        serviceDescription: kmSvc.name || (kmEntry.code === "travel_km" ? "Anfahrt" : "Fahrten für/mit Kunde"),
        serviceCode: kmEntry.code,
        startTime: appt.actualStart || appt.scheduledStart,
        endTime: appt.actualEnd || appt.scheduledEnd,
        // Backward-Compat: `durationMinutes` ist ein required-NOT-NULL-int
        // im DB-Schema. Wir tragen den ganzzahligen km-Wert ein (historisches
        // Verhalten), das PDF-Template liest aber jetzt `quantityRaw`.
        durationMinutes: Math.round(quantityKm),
        quantityRaw: quantityKm,
        quantityUnit: "km",
        unitPriceCents: pricePerKm,
        totalCents: kmTotalCents,
        employeeName,
        appointmentNotes: null,
        serviceDetails: null,
        ...ustKontext,
      });

      totalNetCents += kmTotalCents;
    }
  }

  return { lineItems, totalNetCents };
}

type ApptConsumptionTxn = {
  id: number;
  appointmentId: number | null;
  budgetType: string;
  amountCents: number;
};

/**
 * Lädt die `consumption`-Zeilen der angegebenen Termine plus die Menge der
 * IDs, auf die ein `reversal` zeigt (stornierte Original-Buchungen). Eine
 * `consumption`-Zeile, deren ID in `reversedIds` liegt, ist netto null belegt.
 * SSoT für die Netto-Null-Erkennung — geteilt von `getBudgetSplitForAppointments`
 * (Anzeige-Split) und `neuzubuchendeTermine` (Re-Buchungs-Auslöser).
 */
async function loadAppointmentConsumptionTxns(
  customerId: number,
  apptIds: number[],
  d: Pick<typeof db, "select"> = db,
): Promise<{ txns: ApptConsumptionTxn[]; reversedIds: Set<number>; reversalRows: SplitReversalRow[] }> {
  const txns = await d.select({
    id: budgetTransactions.id,
    appointmentId: budgetTransactions.appointmentId,
    budgetType: budgetTransactions.budgetType,
    amountCents: budgetTransactions.amountCents,
  })
  .from(budgetTransactions)
  .where(and(
    eq(budgetTransactions.customerId, customerId),
    inArray(budgetTransactions.appointmentId, apptIds),
    eq(budgetTransactions.transactionType, "consumption"),
  ));

  if (txns.length === 0) return { txns, reversedIds: new Set<number>(), reversalRows: [] };

  // Stornierte Original-Buchungen ermitteln — sowohl über die VERKNÜPFUNG
  // (`reversed_transaction_id`) als auch über NOTE-basierte Waisen-Stornos
  // („Storno … von Transaktion #<id>"), gemäß der Phantom-Storno-Konvention
  // (vgl. shared/domain/budget/phantom-storno.ts). Eine so referenzierte
  // consumption-Zeile ist netto null belegt und zählt nicht. (Task #1012)
  const consumptionIds = txns.map((t) => t.id);
  const reversalRows = await d.select({
    reversedTransactionId: budgetTransactions.reversedTransactionId,
    notes: budgetTransactions.notes,
  })
  .from(budgetTransactions)
  .where(and(
    eq(budgetTransactions.customerId, customerId),
    eq(budgetTransactions.transactionType, "reversal"),
    or(
      inArray(budgetTransactions.reversedTransactionId, consumptionIds),
      inArray(budgetTransactions.appointmentId, apptIds),
    ),
  ));
  const reversedIds = new Set<number>();
  for (const r of reversalRows) {
    if (r.reversedTransactionId != null) reversedIds.add(r.reversedTransactionId);
    const noteRef = parseStornoReference(r.notes);
    if (noteRef != null) reversedIds.add(noteRef);
  }
  return { txns, reversedIds, reversalRows };
}

/**
 * Netto-Null-Termine = Termine, die EINE Konsumption hatten, deren Buchungen
 * aber ALLE storniert wurden (kein Live-Konsum mehr). Termine, die NIE eine
 * Konsumption hatten (echte Selbstzahler / Alt-Daten), sind NICHT netto-null.
 */
function computeNetZeroApptIds(
  txns: ReadonlyArray<{ id: number; appointmentId: number | null }>,
  reversedIds: ReadonlySet<number>,
): number[] {
  const hadConsumption = new Set<number>();
  const hasLiveConsumption = new Set<number>();
  for (const txn of txns) {
    if (!txn.appointmentId) continue;
    hadConsumption.add(txn.appointmentId);
    if (!reversedIds.has(txn.id)) hasLiveConsumption.add(txn.appointmentId);
  }
  return [...hadConsumption].filter((id) => !hasLiveConsumption.has(id));
}

/**
 * Welche Termine eines Laufs werden NEU gebucht — beim Erstellen echt, in der
 * Vorschau im Probelauf? EINE Antwort für beide Wege.
 *
 *   · `nettoNull`   — alle Buchungen storniert (Task #1014, unverändert).
 *   · `ueberzogen`  — NEU (Funke, Kunde 89, 26.09.2026; Regel Alrik:
 *     „Überlauf über dem verfügbaren Budget → privat, auch bei bereits
 *     gebuchten Terminen"). Termine mit LEBENDER Buchung in einem Topf, der an
 *     einem ihrer Buchungstage überzogen ist (zugewiesen − Verbrauch < 0 im Reader,
 *     Stichtag = Buchungstag = Leistungstag). Dann werden ALLE lebend
 *     gebuchten Termine dieses Topfs im Lauf neu gebucht — chronologisch,
 *     frühere zuerst, der Überlauf geht in die Kaskade (privat).
 *
 * ERSETZT `findNetZeroBilledAppointments` (entfernt) als Auslöser beim Erstellen. Vorher
 * übernahm die Rechnung gespeicherte Buchungen ungeprüft: bei Funke hingen
 * 194,20 € an einem inzwischen gelöschten Übertrag, der Reader zeigte Juni
 * überzogen, und RE-0696 ging trotzdem komplett an die Kasse.
 *
 * `apptIds` sind die Termine des Laufs, also NICHT abgerechnete. Bereits
 * abgerechnete (auch bezahlte) Termine werden nie angefasst (GoBD); sie
 * zählen nur als Verbrauch, der den Topf belegt.
 */
export async function neuzubuchendeTermine(
  customerId: number,
  apptIds: number[],
  d: Tx | typeof db = db,
): Promise<{ nettoNull: number[]; ueberzogen: number[] }> {
  if (apptIds.length === 0) return { nettoNull: [], ueberzogen: [] };
  const { txns, reversedIds } = await loadAppointmentConsumptionTxns(customerId, apptIds, d);
  if (txns.length === 0) return { nettoNull: [], ueberzogen: [] };
  const nettoNull = computeNetZeroApptIds(txns, reversedIds);

  const lebend = txns.filter((t) => t.appointmentId != null && !reversedIds.has(t.id));
  if (lebend.length === 0) return { nettoNull, ueberzogen: [] };
  const datumsZeilen = await d.select({ id: budgetTransactions.id, datum: budgetTransactions.transactionDate })
    .from(budgetTransactions)
    .where(inArray(budgetTransactions.id, lebend.map((t) => t.id)));
  const datumJeBuchung = new Map(datumsZeilen.map((z) => [z.id, String(z.datum)]));

  const ueberzogeneToepfe = new Set<string>();
  const cache = new Map<string, Awaited<ReturnType<typeof readUnifiedBudgetAvailability>>>();
  for (const t of lebend) {
    if (ueberzogeneToepfe.has(t.budgetType)) continue;
    const datum = datumJeBuchung.get(t.id);
    if (!datum) continue;
    let r = cache.get(datum);
    if (!r) { r = await readUnifiedBudgetAvailability(customerId, datum, d); cache.set(datum, r); }
    // Zugewiesen minus Verbrauch, NICHT `availableCents`: das ist bei 0
    // gekappt (Funke: Reader zeigt „0,00 € frei" bei 85,18 € Überzug).
    const topf = (r.pots as Record<string, { allocatedCents: number; consumedNetCents: number } | undefined>)[t.budgetType];
    if (topf && topf.allocatedCents - topf.consumedNetCents < 0) ueberzogeneToepfe.add(t.budgetType);
  }
  const ueberzogen = [...new Set(lebend
    .filter((t) => ueberzogeneToepfe.has(t.budgetType))
    .map((t) => t.appointmentId as number))];
  return { nettoNull, ueberzogen };
}

/**
 * Storniert die lebenden Buchungen der Termine (append-only, `reversal`), damit
 * sie netto null stehen und über `rebookNetZeroAppointmentCore` neu gebucht
 * werden. ALLE zuerst, dann neu buchen — sonst hielte ein späterer Termin
 * seinen alten Anteil fest, während ein früherer neu bucht.
 */
async function lebendeBuchungenStornieren(
  tx: Tx,
  customerId: number,
  apptIds: number[],
  userId: number | undefined,
): Promise<void> {
  if (apptIds.length === 0) return;
  const { txns, reversedIds } = await loadAppointmentConsumptionTxns(customerId, apptIds, tx);
  for (const t of txns) {
    if (reversedIds.has(t.id)) continue;
    await reverseBudgetTransaction(t.id, userId, tx);
  }
}

/**
 * Neubuchung beim ERSTELLEN — alles in EINER Transaktion unter der
 * Abrechnungs-Sperre des Kunden (Gate 2 zu #197, B-2/B-3):
 *   1. Sperre wie die Rechnungs-Transaktion (`lockCustomerForBilling`), dann
 *      prüfen, dass kein Termin inzwischen abgerechnet ist — ein paralleler
 *      Lauf darf nie Buchungen abgerechneter Termine stornieren.
 *   2. Auswahl (`neuzubuchendeTermine`) UNTER der Sperre neu treffen.
 *   3. Lebende Buchungen der überzogenen Termine stornieren, dann alle
 *      chronologisch neu buchen (`rebookNetZeroAppointmentCore`).
 * Scheitert ein Termin (z. B. kein Privatanteil erlaubt), rollt ALLES zurück:
 * das Ledger bleibt wie vorher, der Lauf bricht mit der Meldung der Engine ab.
 *
 * ERSETZT beim Erstellen `rebookNetZeroAppointmentConsumption` (entfernt; eine
 * Transaktion je Termin — ein Fehler mittendrin ließ die früheren Termine
 * gebucht und die späteren netto null zurück).
 */
export async function neubuchenFuerLauf(
  customerId: number,
  apptIds: number[],
  userId: number,
): Promise<number[]> {
  if (apptIds.length === 0) return [];
  return db.transaction(async (tx) => {
    await lockCustomerForBilling(tx, customerId);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('budget_consumption_' || ${customerId}::text))`);
    await assertAppointmentsNotYetInvoiced(tx, apptIds);
    const { nettoNull, ueberzogen } = await neuzubuchendeTermine(customerId, apptIds, tx);
    await lebendeBuchungenStornieren(tx, customerId, ueberzogen, userId);
    const neu: number[] = [];
    for (const appointmentId of await chronologischeReihenfolge([...new Set([...nettoNull, ...ueberzogen])], tx)) {
      const { rebooked } = await rebookNetZeroAppointmentCore(tx, { customerId, appointmentId, handelnder: { userId } });
      if (rebooked) neu.push(appointmentId);
    }
    return neu;
  });
}

/**
 * Task #759 — Variant C: liefert pro Termin die tatsächlich gebuchten
 * Pot-Anteile aus `budget_transactions` (`consumption`). Pot-Keys sind
 * die echten BudgetType-Werte (`entlastungsbetrag_45b` /
 * `umwandlung_45a` / `ersatzpflege_39_42a`) sowie `"private"` für den
 * Selbstzahler-Overflow — exakt das, was `consumption-engine.ts` schreibt.
 *
 * Task #1011 — nur die AKTIVE (nicht stornierte) Konsumption zählt. Eine
 * `consumption`-Zeile, auf die ein `reversal` zeigt (`reversedTransactionId`),
 * ist netto null belegt und darf KEINEN Pot-Anteil mehr erzeugen — sonst
 * entstünde eine Phantom-Folgerechnung für einen Topf, der real gar nicht
 * (mehr) belegt ist (z.B. eine §45a-Buchung, die am selben Tag wieder
 * storniert wurde). „Live"-Konsum = `consumption` minus die Zeilen, auf die
 * ein `reversal` verweist — dieselbe Projekt-SSoT wie im Storage-Layer.
 */
export async function getBudgetSplitForAppointments(
  customerId: number,
  apptIds: number[],
): Promise<Map<number, BudgetSplitForAppointment>> {
  if (apptIds.length === 0) return new Map();

  // SSoT-Loader liefert die Konsumptionen, die storno-bereinigten Reversal-Zeilen
  // (link- UND note-basiert, Task #1012) und die abgeleitete Menge der netto-null
  // belegten Original-IDs — geteilt mit neuzubuchendeTermine.
  const { txns, reversalRows } = await loadAppointmentConsumptionTxns(customerId, apptIds);

  if (txns.length === 0) return new Map();

  // Live-Split (storno-bereinigt) über die pure SSoT im shared/domain. Töpfe,
  // deren Verbrauch ausschließlich aus stornierten Buchungen besteht (z.B. eine
  // Phantom-§45a-Aufteilung), fallen hier weg und erzeugen keine eigene
  // Folge-Rechnung mehr (Task #1012).
  const out = buildBudgetSplitFromLedger(txns, reversalRows);

  // Überzogene Töpfe (siehe `neuzubuchendeTermine`): die gespeicherte
  // Aufteilung gilt nicht, der Probelauf bucht diese Termine neu.
  const { ueberzogen } = await neuzubuchendeTermine(customerId, apptIds);
  for (const id of ueberzogen) out.delete(id);

  // Stolperfalle (Task #1011): Termine, die eine Konsumption HATTEN, deren
  // Buchungen aber ALLE storniert wurden (netto null, kein Live-Konsum mehr),
  // dürfen NICHT blind auf den private-Fallback fallen — das erzeugte eine
  // falsche Selbstzahler-Rechnung. Stattdessen den Pot-Anteil über einen
  // Probelauf DERSELBEN Neubuchung wie beim Erstellen ermitteln
  // (`probelaufNeubuchung`, zurückgerollt). Termine, die NIE eine Konsumption hatten (echte Selbstzahler /
  // Alt-Daten), behalten das bestehende Verhalten (kein Eintrag → private).
  const apptsWithAnyConsumption = new Set<number>();
  for (const txn of txns) {
    if (txn.appointmentId != null) apptsWithAnyConsumption.add(txn.appointmentId);
  }
  const netZeroApptIds = [...apptsWithAnyConsumption].filter((id) => !out.has(id));
  if (netZeroApptIds.length > 0) {
    const probe = await probelaufNeubuchung(customerId, netZeroApptIds, ueberzogen);
    for (const [apptId, split] of probe) out.set(apptId, split);
  }

  return out;
}

/** Signal zum Zurueckrollen des Probelaufs — kein Fehler. */
class ProbelaufZurueckrollen extends Error {}

/**
 * Die Aufteilung netto-null belegter Termine — ermittelt mit DERSELBEN
 * Neubuchung wie beim Erstellen, in einer Transaktion, die zurueckgerollt wird.
 *
 * ── ERSETZT die Nachbildung (Entscheidung Alrik, 25.09.2026) ────────────
 * Bis #193 leitete die Vorschau die Aufteilung read-only ab
 * (`rederiveSplitFromCurrentAllocation`): Kosten aus der Summe der stornierten
 * Buchungen, Kapazitaet aus `readUnifiedBudgetAvailability`, die Aufrechnung
 * im Lauf ueber eigene Topf-Fenster. Das Erstellen bucht dagegen ueber
 * `rebookNetZeroAppointmentCore` — Kosten zum Termindatum neu gerechnet,
 * Kapazitaet aus der Buchungs-Engine. Zwei Rechnungen derselben Frage; sie
 * liefen auseinander (gemessen: Vorschau 194,20 EUR, Erstellen 196,02 EUR).
 *
 * „Vorschau und Erstellen zeigen denselben Bruttobetrag — die Vorschau ist
 * also falsch, nicht das Erstellen." Deshalb gibt es die Nachbildung nicht
 * mehr: der Probelauf IST das Erstellen, nur ohne Commit. Damit entfallen
 * auch die Grenzen, die Gate 2 an der Nachbildung fand (Fristgrenzen
 * 30.06./01.01., abweichende Kosten bei geaenderten Preisen, die Formel-
 * Differenz Holds/Cap).
 *
 * Reihenfolge wie beim Erstellen: `chronologischeReihenfolge`, dieselbe Funktion.
 *
 * Nebenwirkungen: alles, was der Probelauf schreibt (Buchungen, Advisory-
 * Lock), faellt mit dem Zurueckrollen weg. Der Lock gilt nur fuer die Dauer der
 * Vorschau und haelt eine gleichzeitige Buchung desselben Kunden so lange an.
 * Was bleibt: Sequenzwerte von `budget_transactions`/`budget_allocations`
 * (Luecken in den IDs, keine Rechnungsnummern). Die einzige Stelle der Engine,
 * die AUSSERHALB der Transaktion schreibt (Audit `budget_reconcile_skipped`),
 * schreibt im Probelauf nur in die Konsole (`handelnder: "probelauf"`).
 * Gesichert: NB-1 prueft nach Vorschau und Liste, dass der Ledger unveraendert
 * ist (mutations-gegengeprueft: ohne das Zurueckrollen rot).
 */
async function probelaufNeubuchung(
  customerId: number,
  apptIds: number[],
  ueberzogen: number[] = [],
): Promise<Map<number, BudgetSplitForAppointment>> {
  let ergebnis = new Map<number, BudgetSplitForAppointment>();
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('budget_consumption_' || ${customerId}::text))`);
      await lebendeBuchungenStornieren(tx, customerId, ueberzogen, undefined);
      for (const appointmentId of await chronologischeReihenfolge(apptIds, tx)) {
        await rebookNetZeroAppointmentCore(tx, { customerId, appointmentId, handelnder: "probelauf" });
      }
      const { txns, reversalRows } = await loadAppointmentConsumptionTxns(customerId, apptIds, tx);
      const live = buildBudgetSplitFromLedger(txns, reversalRows);
      ergebnis = new Map([...live].filter(([id]) => apptIds.includes(id)));
      throw new ProbelaufZurueckrollen();
    });
  } catch (err) {
    if (!(err instanceof ProbelaufZurueckrollen)) throw err;
  }
  return ergebnis;
}


/**
 * Kostenträger-Stammdaten für die Rechnungserstellung — am STICHTAG des
 * Abrechnungszeitraums, nicht „heute" (Task #1893).
 *
 * Dünne Projektion über `resolveCustomerInsuranceAt`; das frühere eigene
 * `valid_to IS NULL`-Select ist damit ersetzt (eine Fenster-Logik, nicht zwei).
 */
export async function getInsuranceData(customerId: number, asOfISO: string) {
  const ins = await resolveCustomerInsuranceAt(customerId, asOfISO);
  if (!ins) return null;

  return {
    providerName: ins.provider.name,
    ikNummer: ins.provider.ikNummer,
    versichertennummer: ins.versichertennummer,
    empfaenger: ins.provider.empfaenger,
    empfaengerZeile2: ins.provider.empfaengerZeile2,
    anschrift: ins.provider.anschrift,
    plzOrt: ins.provider.plzOrt,
    strasse: ins.provider.strasse,
    hausnummer: ins.provider.hausnummer,
    plz: ins.provider.plz,
    stadt: ins.provider.stadt,
  };
}
