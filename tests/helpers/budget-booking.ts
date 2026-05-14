/**
 * Helper für Equality-Tests: legt einen echten Termin + Service-Junctions an
 * und ruft die produktive `createConsumptionTransaction`-Engine auf. Liefert
 * die Summe der absolut gebuchten Cents über alle Cascade-Töpfe zurück.
 *
 * Wichtig: Dieser Helper darf NICHT `calculateAppointmentCost` direkt
 * aufrufen — er muss durch die echte Engine laufen, damit Drift zwischen
 * Cost-Estimate und tatsächlicher Buchung zuverlässig erkannt wird.
 */
import { eq } from "drizzle-orm";
import { appointments, appointmentServices, budgetTransactions } from "@shared/schema";
import { db } from "../../server/lib/db";
import { createConsumptionTransaction } from "../../server/storage/budget/consumption-engine";
import { apiGet } from "../test-utils";

let serviceIdCache: Map<string, number> | null = null;

async function getServiceIds(): Promise<Map<string, number>> {
  if (serviceIdCache) return serviceIdCache;
  const r = await apiGet<Array<{ id: number; code: string }>>("/api/services");
  serviceIdCache = new Map(r.data.map((s) => [s.code, s.id]));
  return serviceIdCache;
}

export interface BookingRequest {
  customerId: number;
  employeeId: number;
  date: string;
  hwMinutes: number;
  abMinutes: number;
  travelKm: number;
  customerKm: number;
  userId: number;
  scheduledStart?: string;
  scheduledEnd?: string;
  notes?: string;
}

export interface BookingResult {
  appointmentId: number;
  totalBookedAbsCents: number;
  /** Einzel-Transaktionen (kann mehrere bei Cascade über mehrere Töpfe). */
  transactionAmountsCents: number[];
}

export async function bookConsumption(req: BookingRequest): Promise<BookingResult> {
  const services = await getServiceIds();
  const totalMinutes = Math.max(req.hwMinutes + req.abMinutes, 60);

  const [appt] = await db
    .insert(appointments)
    .values({
      customerId: req.customerId,
      assignedEmployeeId: req.employeeId,
      appointmentType: "kundentermin",
      date: req.date,
      scheduledStart: req.scheduledStart ?? "10:00:00",
      scheduledEnd: req.scheduledEnd ?? "11:00:00",
      durationPromised: totalMinutes,
      status: "scheduled",
      notes: req.notes ?? "T427 Equality booking",
    })
    .returning();

  if (req.hwMinutes > 0) {
    const id = services.get("hauswirtschaft");
    if (!id) throw new Error("Service hauswirtschaft nicht gefunden");
    await db.insert(appointmentServices).values({
      appointmentId: appt.id,
      serviceId: id,
      plannedDurationMinutes: req.hwMinutes,
    });
  }
  if (req.abMinutes > 0) {
    const id = services.get("alltagsbegleitung");
    if (!id) throw new Error("Service alltagsbegleitung nicht gefunden");
    await db.insert(appointmentServices).values({
      appointmentId: appt.id,
      serviceId: id,
      plannedDurationMinutes: req.abMinutes,
    });
  }

  await createConsumptionTransaction({
    customerId: req.customerId,
    appointmentId: appt.id,
    transactionDate: req.date,
    hauswirtschaftMinutes: req.hwMinutes,
    alltagsbegleitungMinutes: req.abMinutes,
    travelKilometers: req.travelKm,
    customerKilometers: req.customerKm,
    userId: req.userId,
  });

  const txs = await db
    .select({ amountCents: budgetTransactions.amountCents, type: budgetTransactions.transactionType })
    .from(budgetTransactions)
    .where(eq(budgetTransactions.appointmentId, appt.id));

  // Nur Konsum-Transaktionen (nicht Carryover/Reversal/Adjustment) summieren.
  const consumptionTxs = txs.filter((t) => t.type === "consumption");
  const total = consumptionTxs.reduce((s, t) => s + Math.abs(t.amountCents), 0);
  return {
    appointmentId: appt.id,
    totalBookedAbsCents: total,
    transactionAmountsCents: consumptionTxs.map((t) => Math.abs(t.amountCents)),
  };
}
