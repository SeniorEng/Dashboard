import { badRequest } from "../lib/errors";
import { computeNoShowCharge, type CancellationPolicyType } from "@shared/domain/cancellation-policy";
import { quantizeKm, computeKmLineTotalCents } from "@shared/domain/invoice-line-items";
import { buildBudgetSplitFromLedger, POT_ORDER, type InvoicePotKey, type BudgetSplitForAppointment } from "@shared/domain/budget-invoice-split";
import { DEFAULT_BUDGET_POT_ORDER } from "@shared/domain/budgets";
import { planCascade, type CascadePot } from "@shared/domain/budget/plan-cascade";
import { parseStornoReference } from "@shared/domain/budget/phantom-storno";
import { appointments, appointmentServices as appointmentServicesTable, services as servicesTable, users, customers as customersTable, customerInsuranceHistory, insuranceProviders, invoices as invoicesTable, invoiceLineItems, monthlyServiceRecords, serviceRecordAppointments, customerServicePrices, budgetTransactions } from "@shared/schema";
import { eq, and, isNull, inArray, ne, desc, or } from "drizzle-orm";
import { formatDateForDisplay } from "@shared/utils/datetime";
import { db } from "../lib/db";
import { readUnifiedBudgetAvailability, type CappedBudgetPot } from "../storage/budget/unified-reader";
import { monthlyServiceRecordsRepo, appointmentsRepo, customerServicePricesRepo } from "../repos";

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

export async function getAlreadyInvoicedAppointmentIds(customerId: number, billingYear: number, billingMonth: number): Promise<number[]> {
  const rows = await db.select({ appointmentId: invoiceLineItems.appointmentId })
    .from(invoiceLineItems)
    .innerJoin(invoicesTable, eq(invoiceLineItems.invoiceId, invoicesTable.id))
    .where(and(
      eq(invoicesTable.customerId, customerId),
      eq(invoicesTable.billingYear, billingYear),
      eq(invoicesTable.billingMonth, billingMonth),
      ne(invoicesTable.status, "storniert"),
      ne(invoicesTable.invoiceType, "stornorechnung")
    ));
  return rows.map(r => r.appointmentId).filter((id): id is number => id !== null);
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

export async function buildLineItemsFromAppointments(apptIds: number[], customerId?: number, billingType?: string) {
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
  let allCustomerPrices: { id: number; serviceId: number; priceCents: number; validFrom: Date | null; validTo: Date | null }[] = [];
  if (resolvedCustomerId) {
    allCustomerPrices = await customerServicePricesRepo.selectColumnsFrom({
      id: customerServicePrices.id,
      serviceId: customerServicePrices.serviceId,
      priceCents: customerServicePrices.priceCents,
      validFrom: customerServicePrices.validFrom,
      validTo: customerServicePrices.validTo,
    })
    .where(and(
      eq(customerServicePrices.customerId, resolvedCustomerId),
      customerServicePricesRepo.activeOnly(),
    ));
  }

  function toDateStr(d: Date | string | null): string {
    if (!d) return "";
    if (d instanceof Date) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
    return String(d).substring(0, 10);
  }

  function getCustomerPrice(serviceId: number, appointmentDate: string): number | undefined {
    const matching = allCustomerPrices.filter(p => {
      if (p.serviceId !== serviceId) return false;
      const fromDate = p.validFrom ? toDateStr(p.validFrom) : "0000-01-01";
      const toDate = p.validTo ? toDateStr(p.validTo) : "9999-12-31";
      return appointmentDate >= fromDate && appointmentDate <= toDate;
    });
    if (matching.length === 0) return undefined;
    matching.sort((a, b) => {
      const aFrom = a.validFrom ? new Date(a.validFrom).getTime() : 0;
      const bFrom = b.validFrom ? new Date(b.validFrom).getTime() : 0;
      if (bFrom !== aFrom) return bFrom - aFrom;
      // Tiebreaker für identisches validFrom (Race-Condition / Parallel-Insert):
      // Höchste id (= zuletzt eingefügt) gewinnt deterministisch.
      return b.id - a.id;
    });
    return matching[0].priceCents;
  }

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
            travelKilometers: appt.noShowKilometers ?? appt.travelKilometers ?? 0,
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
      const customerPrice = getCustomerPrice(svc.serviceId, apptDate);
      const pricePer60Min = customerPrice ?? svc.defaultPriceCents;
      if (pricePer60Min == null) {
        throw badRequest(`Kein Preis hinterlegt für Dienstleistung "${svc.serviceName || svc.serviceCode}". Bitte prüfen Sie den Dienstleistungskatalog.`);
      }
      const totalCents = Math.round((durationMinutes / 60) * pricePer60Min);
      const vatBasisPoints = isVatExempt ? 0 : (svc.vatRate || 0);
      const vatCents = Math.round(totalCents * vatBasisPoints / 10000);

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
      const kmCustomerPrice = getCustomerPrice(kmSvc.id, apptDate);
      const pricePerKm = kmCustomerPrice ?? kmSvc.defaultPriceCents ?? 35;
      // Task #561: GoBD-konforme km-Quantisierung — Anzeige UND Berechnung
      // verwenden denselben auf 2 Nachkommastellen gerundeten Wert.
      // Vorher: `Math.round(km * pricePerKm)` mit ungerundetem Float +
      // `Math.round(km)` als Anzeige → Drift (s. RE-2026-0003).
      const quantityKm = quantizeKm(kmEntry.km);
      const kmTotalCents = computeKmLineTotalCents(kmEntry.km, pricePerKm);
      const kmVatBasisPoints = isVatExempt ? 0 : (kmSvc.vatRate || 0);
      const kmVatCents = Math.round(kmTotalCents * kmVatBasisPoints / 10000);

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

  // ID mitlesen, damit wir gegen die Reversal-Verweise abgleichen können.
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

  if (txns.length === 0) return new Map();

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

  // Standard-Cascade-Priorität (§45b → §45a → §39/§42a).
  const orderedPots = [...DEFAULT_BUDGET_POT_ORDER]
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

export async function getInsuranceData(customerId: number) {
  const insuranceData = await db.select({
    providerName: insuranceProviders.name,
    ikNummer: insuranceProviders.ikNummer,
    versichertennummer: customerInsuranceHistory.versichertennummer,
    empfaenger: insuranceProviders.empfaenger,
    empfaengerZeile2: insuranceProviders.empfaengerZeile2,
    anschrift: insuranceProviders.anschrift,
    plzOrt: insuranceProviders.plzOrt,
    strasse: insuranceProviders.strasse,
    hausnummer: insuranceProviders.hausnummer,
    plz: insuranceProviders.plz,
    stadt: insuranceProviders.stadt,
  })
  .from(customerInsuranceHistory)
  .innerJoin(insuranceProviders, eq(customerInsuranceHistory.insuranceProviderId, insuranceProviders.id))
  .where(and(
    eq(customerInsuranceHistory.customerId, customerId),
    isNull(customerInsuranceHistory.validTo)
  ))
  .limit(1);

  return insuranceData.length > 0 ? insuranceData[0] : null;
}
