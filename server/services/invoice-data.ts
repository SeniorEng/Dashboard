import { badRequest } from "../lib/errors";
import { computeNoShowCharge, type CancellationPolicyType } from "@shared/domain/cancellation-policy";
import { quantizeKm, computeKmLineTotalCents } from "@shared/domain/invoice-line-items";
import { serviceVatRateBP } from "@shared/domain/invoice-vat";
import { buildBudgetSplitFromLedger, POT_ORDER, type InvoicePotKey, type BudgetSplitForAppointment, type SplitReversalRow } from "@shared/domain/budget-invoice-split";
import { effectiveDefaultPots } from "@shared/domain/budgets";
import { planCascade, type CascadePot } from "@shared/domain/budget/plan-cascade";
import { parseStornoReference } from "@shared/domain/budget/phantom-storno";
import { FINAL_APPOINTMENT_STATUSES } from "@shared/domain/appointments";
import { appointments, appointmentServices as appointmentServicesTable, services as servicesTable, users, customers as customersTable, customerInsuranceHistory, insuranceProviders, invoices as invoicesTable, invoiceLineItems, monthlyServiceRecords, serviceRecordAppointments, budgetTransactions } from "@shared/schema";
import { eq, and, isNull, inArray, notInArray, ne, desc, or, gte, lt, lte, sql } from "drizzle-orm";
import { formatDateForDisplay } from "@shared/utils/datetime";
import { db } from "../lib/db";
import { readUnifiedBudgetAvailability, type CappedBudgetPot } from "../storage/budget/unified-reader";
import { loadCustomerPriceContext } from "../storage/pricing/price-for";
import { monthlyServiceRecordsRepo, appointmentsRepo, customersRepo } from "../repos";
import { resolveCustomerInsuranceAt } from "../storage/customer-mgmt/insurance";
import { isServiceRecordSignedForBilling } from "@shared/domain/billing-eligibility";
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
export async function getAlreadyInvoicedAppointmentIds(appointmentIds: readonly number[]): Promise<number[]> {
  const rows = await findActiveInvoicesForAppointments(appointmentIds);
  return Array.from(
    new Set(rows.map(r => r.appointmentId).filter((id): id is number => id !== null)),
  );
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
 * Task #1743 — Anzahl der noch OFFENEN (geplanten) Termine pro Kunde im
 * abzurechnenden Fenster. „Offen" = jeder aktive Termin, dessen Status NICHT
 * terminal ist — exakt die Definition der `FINAL_APPOINTMENT_STATUSES`-SSoT,
 * die auch die Monatsabschluss-Readiness nutzt (offene vs. abgeschlossene
 * Termine). Damit kann die Abrechnungs-Übersicht („Noch zu erstellen") Kunden
 * mit noch offenen Terminen getrennt ausweisen, ohne eine zweite „offener
 * Termin"-Regel zu definieren.
 *
 * Task #1317 — Der Zähl-Scope spiegelt EXAKT den Eligibility-Scope von
 * `GET /billing/eligible-customers`: Ohne Datumsbereich der ganze Monat
 * (`gte periodStart` … `lt nextMonth`); mit optionalem `dateFrom`/`dateTo`
 * (ISO) NUR das gewählte Fenster (inklusiver `lte dateTo`, wie der
 * Eligibility-Filter). Sonst würde die Gruppierung „bereit vs. offen" bei
 * Teil-Abrechnung nicht zum gefilterten Fenster passen.
 */
export async function getOpenAppointmentCountByCustomer(
  customerIds: number[],
  billingYear: number,
  billingMonth: number,
  range?: { dateFrom?: string; dateTo?: string },
): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  if (customerIds.length === 0) return result;
  for (const id of customerIds) result.set(id, 0);

  // Fenster identisch zur Eligibility-Logik in `/eligible-customers`:
  // gesetzter Datumsbereich verengt (nur die vorhandenen Grenzen), sonst Monat.
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

  const openRows = await appointmentsRepo.selectColumnsFrom({
    customerId: appointments.customerId,
    count: sql<number>`COUNT(*)::int`,
  })
    .where(and(
      inArray(appointments.customerId, customerIds),
      notInArray(appointments.status, [...FINAL_APPOINTMENT_STATUSES]),
      appointmentsRepo.activeOnly(),
      ...dateConds,
    ))
    .groupBy(appointments.customerId);

  for (const r of openRows) {
    if (r.customerId == null) continue;
    result.set(r.customerId, Number(r.count));
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
  if (apptIds.length === 0) return { lineItems: [], totalNetCents: 0, totalVatCents: 0 };
  const isVatExempt = billingType && billingType !== "selbstzahler";

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

  const employeeIds = [...new Set(appts.map(a => a.assignedEmployeeId || a.performedByEmployeeId).filter((id): id is number => id != null))];
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

  const lineItems: BuildLineItem[] = [];
  let totalNetCents = 0;
  let totalVatCents = 0;

  for (const appt of appts) {
    const apptServices = serviceBreakdown.filter(s => s.appointmentId === appt.id);
    const apptDate = appt.date;

    const employeeId = appt.assignedEmployeeId || appt.performedByEmployeeId;
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
      // Task #1659 — USt über die zentrale SSoT (`serviceVatRateBP` liefert
      // Basispunkte, 19 % → 1900). Der frühere Code las `svc.vatRate` (Prozent)
      // roh und teilte durch 10000 → 0,19 % statt 19 % (Regression `9d6f9d4`,
      // RE-2026-0250). Steuerbefreite Töpfe (Pflegekasse) bleiben 0.
      const vatRateBp = isVatExempt ? 0 : serviceVatRateBP(svc);
      const vatCents = Math.round(totalCents * vatRateBp / 10000);

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
      });

      totalNetCents += totalCents;
      totalVatCents += vatCents;
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
      // Task #1659 — identische Korrektur für den Kilometer-Pfad: USt-Satz über
      // die SSoT (Basispunkte), damit Selbstzahler-km 19 % statt 0,19 % tragen.
      const kmVatRateBp = isVatExempt ? 0 : serviceVatRateBP(kmSvc);
      const kmVatCents = Math.round(kmTotalCents * kmVatRateBp / 10000);

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
      });

      totalNetCents += kmTotalCents;
      totalVatCents += kmVatCents;
    }
  }

  return { lineItems, totalNetCents, totalVatCents };
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
 * (Anzeige-Split) und `findNetZeroBilledAppointments` (Re-Buchungs-Trigger).
 */
async function loadAppointmentConsumptionTxns(
  customerId: number,
  apptIds: number[],
): Promise<{ txns: ApptConsumptionTxn[]; reversedIds: Set<number>; reversalRows: SplitReversalRow[] }> {
  const txns = await db.select({
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
  const reversalRows = await db.select({
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
 * Task #1014 — Trigger für die Re-Buchung netto-null-belegter Termine bei der
 * tatsächlichen Rechnungs-ERSTELLUNG (nicht Preview). Liefert die Termine, die
 * eine Konsumption hatten, deren Buchungen aber komplett storniert wurden —
 * exakt die Termine, deren Pot-Anteil `getBudgetSplitForAppointments`
 * read-only aus der aktuellen Allocation re-deriviert. Beim Generieren werden
 * für diese Termine frische `consumption`-Zeilen gebucht (siehe
 * `rebookNetZeroAppointmentConsumption`), damit Ledger und Rechnung nicht
 * auseinanderlaufen.
 */
export async function findNetZeroBilledAppointments(
  customerId: number,
  apptIds: number[],
): Promise<number[]> {
  if (apptIds.length === 0) return [];
  const { txns, reversedIds } = await loadAppointmentConsumptionTxns(customerId, apptIds);
  if (txns.length === 0) return [];
  return computeNetZeroApptIds(txns, reversedIds);
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
  // belegten Original-IDs — geteilt mit findNetZeroBilledAppointments.
  const { txns, reversedIds, reversalRows } = await loadAppointmentConsumptionTxns(customerId, apptIds);

  if (txns.length === 0) return new Map();

  // Live-Split (storno-bereinigt) über die pure SSoT im shared/domain. Töpfe,
  // deren Verbrauch ausschließlich aus stornierten Buchungen besteht (z.B. eine
  // Phantom-§45a-Aufteilung), fallen hier weg und erzeugen keine eigene
  // Folge-Rechnung mehr (Task #1012).
  const out = buildBudgetSplitFromLedger(txns, reversalRows);

  // Stolperfalle (Task #1011): Termine, die eine Konsumption HATTEN, deren
  // Buchungen aber ALLE storniert wurden (netto null, kein Live-Konsum mehr),
  // dürfen NICHT blind auf den private-Fallback fallen — das erzeugte eine
  // falsche Selbstzahler-Rechnung. Stattdessen den Pot-Anteil aus der AKTUELLEN
  // Allocation re-derivieren (read-only Cascade gegen die heute verfügbaren
  // Töpfe). Termine, die NIE eine Konsumption hatten (echte Selbstzahler /
  // Alt-Daten), behalten das bestehende Verhalten (kein Eintrag → private).
  const apptsWithAnyConsumption = new Set<number>();
  for (const txn of txns) {
    if (txn.appointmentId != null) apptsWithAnyConsumption.add(txn.appointmentId);
  }
  const netZeroApptIds = [...apptsWithAnyConsumption].filter((id) => !out.has(id));
  if (netZeroApptIds.length > 0) {
    await rederiveSplitFromCurrentAllocation(customerId, netZeroApptIds, txns, reversedIds, out);
  }

  return out;
}

/**
 * Task #1011 — Re-Derivation für netto-null-belegte Termine (alle Buchungen
 * storniert, keine aktive Konsumption mehr). Verteilt die Termin-Kost (= Σ der
 * stornierten Original-Buchungen dieses Termins) read-only über die aktuelle
 * Topf-Verfügbarkeit (`readUnifiedBudgetAvailability` → `planCascade`), in der
 * Standard-Cascade-Priorität §45b → §45a → §39/§42a, Rest → private. Es wird
 * NICHTS gebucht — Preview und Generate sehen denselben Split, und es entsteht
 * keine Phantom-Rechnung für einen netto-null belegten Topf.
 */
async function rederiveSplitFromCurrentAllocation(
  customerId: number,
  apptIds: number[],
  txns: ReadonlyArray<{ id: number; appointmentId: number | null; amountCents: number }>,
  reversedIds: ReadonlySet<number>,
  out: Map<number, BudgetSplitForAppointment>,
): Promise<void> {
  // Termin-Kost = Σ |Betrag| der stornierten Original-Buchungen des Termins.
  const costByAppt = new Map<number, number>();
  for (const txn of txns) {
    if (!txn.appointmentId || !reversedIds.has(txn.id)) continue;
    if (!apptIds.includes(txn.appointmentId)) continue;
    costByAppt.set(
      txn.appointmentId,
      (costByAppt.get(txn.appointmentId) ?? 0) + Math.abs(txn.amountCents),
    );
  }

  const apptRows = await appointmentsRepo.selectColumnsFrom({
    id: appointments.id,
    date: appointments.date,
  })
  .where(and(inArray(appointments.id, apptIds), appointmentsRepo.activeOnly()));
  const dateByAppt = new Map(apptRows.map((a) => [a.id, a.date]));

  // BUG-19 (Facette A) — Standard-Cascade-Priorität (§45b → §45a → §39/§42a)
  // über die SSoT `effectiveDefaultPots` (mit Kundenkontext), nicht über die
  // jetzt modul-private Konstante. Für die reine Reihenfolge ist der `enabled`-
  // Zustand zwar irrelevant, der Resolver bleibt aber die einzige Default-Quelle.
  const [splitCustomer] = await customersRepo
    .selectColumnsFrom({
      billingType: customersTable.billingType,
      pflegegrad: customersTable.pflegegrad,
    })
    .where(eq(customersTable.id, customerId));
  const orderedPots = effectiveDefaultPots({
    billingType: splitCustomer?.billingType,
    pflegegrad: splitCustomer?.pflegegrad,
  })
    .sort((a, b) => a.priority - b.priority)
    .map((p) => p.budgetType as CappedBudgetPot);

  for (const apptId of apptIds) {
    const cost = costByAppt.get(apptId) ?? 0;
    const date = dateByAppt.get(apptId);
    if (cost <= 0 || !date) continue; // nichts ableitbar → bleibt ohne Eintrag (private)

    const avail = await readUnifiedBudgetAvailability(customerId, date, db);
    const pots: CascadePot[] = orderedPots.map((bt) => ({
      budgetType: bt,
      capacityCents: avail.pots[bt].availableCents,
    }));
    // privater Topf absorbiert den Rest, der von keinem Kassen-Topf gedeckt ist.
    pots.push({ budgetType: "private", capacityCents: 0, uncapped: true });

    const { splits } = planCascade(cost, pots);
    const cents: BudgetSplitForAppointment["cents"] = {};
    for (const split of splits) {
      if (split.amountCents <= 0) continue;
      const potKey = (POT_ORDER as readonly string[]).includes(split.budgetType)
        ? (split.budgetType as InvoicePotKey)
        : "private";
      cents[potKey] = (cents[potKey] ?? 0) + split.amountCents;
    }
    if (Object.keys(cents).length > 0) {
      out.set(apptId, { cents });
    }
  }
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
