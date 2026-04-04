import {
  budgetTransactions,
  appointments,
  appointmentServices,
  services,
  type BudgetTransaction,
} from "@shared/schema";
import { eq, and, sql, or, inArray } from "drizzle-orm";
import { db } from "../../lib/db";
import type { DbClient } from "./types";
import { getBudgetTypeSettings } from "./preferences-storage";
import { calculateAppointmentCost } from "./appointment-cost-calculator";
import { consumeFifo, createCascadeConsumption } from "./consumption-engine";

export async function rebookSingleTransaction(
  customerId: number,
  transactionId: number,
  targetBudgetType: string,
  userId: number
): Promise<{ reversalTransaction: BudgetTransaction; newTransaction: BudgetTransaction | null; amountCents: number }> {
  return await db.transaction(async (tx) => {
    const [original] = await tx.select()
      .from(budgetTransactions)
      .where(and(
        eq(budgetTransactions.id, transactionId),
        eq(budgetTransactions.customerId, customerId),
        eq(budgetTransactions.transactionType, "consumption"),
      ))
      .limit(1);

    if (!original) {
      throw new Error("Transaktion nicht gefunden oder keine Verbrauchsbuchung");
    }

    if (original.budgetType === targetBudgetType) {
      throw new Error("Ziel-Topf ist gleich dem aktuellen Topf");
    }

    const typeSettings = await getBudgetTypeSettings(customerId, tx);
    const targetSetting = typeSettings.find(s => s.budgetType === targetBudgetType);
    if (!targetSetting || !targetSetting.enabled) {
      throw new Error("Ziel-Topf ist nicht aktiviert");
    }
    const txDate = original.transactionDate;
    if (targetSetting.validFrom && txDate < targetSetting.validFrom) {
      throw new Error("Ziel-Topf ist für das Buchungsdatum noch nicht gültig");
    }
    if (targetSetting.validTo && txDate > targetSetting.validTo) {
      throw new Error("Ziel-Topf ist für das Buchungsdatum abgelaufen");
    }

    const existingReversal = await tx.select({ id: budgetTransactions.id })
      .from(budgetTransactions)
      .where(and(
        eq(budgetTransactions.customerId, customerId),
        eq(budgetTransactions.transactionType, "reversal"),
        or(
          eq(budgetTransactions.reversedTransactionId, transactionId),
          sql`${budgetTransactions.notes} LIKE ${'%Transaktion #' + transactionId + ')%'}`,
          sql`${budgetTransactions.notes} LIKE ${'%Transaktion #' + transactionId}`,
        ),
      ))
      .limit(1);

    if (existingReversal.length > 0) {
      throw new Error("Diese Buchung wurde bereits storniert oder umgebucht");
    }

    const absAmount = Math.abs(original.amountCents);

    const [reversalTransaction] = await tx.insert(budgetTransactions)
      .values({
        customerId,
        budgetType: original.budgetType,
        transactionDate: original.transactionDate,
        transactionType: "reversal",
        amountCents: absAmount,
        appointmentId: original.appointmentId,
        allocationId: original.allocationId,
        reversedTransactionId: transactionId,
        notes: `Storno für Umbuchung nach ${targetBudgetType} (Transaktion #${transactionId})`,
        createdByUserId: userId,
      })
      .returning();

    const fifoResult = await consumeFifo(
      customerId,
      targetBudgetType,
      absAmount,
      original.transactionDate,
      {
        appointmentId: original.appointmentId ?? undefined,
        userId,
        hauswirtschaftMinutes: original.hauswirtschaftMinutes ?? undefined,
        hauswirtschaftCents: original.hauswirtschaftCents ?? undefined,
        alltagsbegleitungMinutes: original.alltagsbegleitungMinutes ?? undefined,
        alltagsbegleitungCents: original.alltagsbegleitungCents ?? undefined,
        travelKilometers: original.travelKilometers ?? undefined,
        travelCents: original.travelCents ?? undefined,
        customerKilometers: original.customerKilometers ?? undefined,
        customerKilometersCents: original.customerKilometersCents ?? undefined,
        notes: `Umbuchung von ${original.budgetType} (Transaktion #${transactionId})`,
      },
      tx
    );

    if (fifoResult.consumedCents < absAmount) {
      throw new Error(`Ziel-Topf hat nicht genug Budget. Verfügbar: ${(fifoResult.consumedCents / 100).toFixed(2)} €, benötigt: ${(absAmount / 100).toFixed(2)} €`);
    }

    return {
      reversalTransaction,
      newTransaction: fifoResult.transactions[0] ?? null,
      amountCents: absAmount,
    };
  });
}

export async function getRebookPreview(customerId: number): Promise<{
  disabledTypes: string[];
  affectedAppointments: number;
  totalAmountCents: number;
  transactions: Array<{ id: number; budgetType: string; amountCents: number; appointmentId: number | null; transactionDate: string }>;
}> {
  const typeSettings = await getBudgetTypeSettings(customerId);
  const disabledTypes = typeSettings.filter(s => !s.enabled).map(s => s.budgetType);

  if (disabledTypes.length === 0) {
    return { disabledTypes: [], affectedAppointments: 0, totalAmountCents: 0, transactions: [] };
  }

  const consumptions = await db.select()
    .from(budgetTransactions)
    .where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.transactionType, "consumption"),
      inArray(budgetTransactions.budgetType, disabledTypes),
    ));

  const reversals = await db.select()
    .from(budgetTransactions)
    .where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.transactionType, "reversal"),
      inArray(budgetTransactions.budgetType, disabledTypes),
    ));

  const reversedIds = new Set(
    reversals
      .map(r => r.notes?.match(/Storno von Transaktion #(\d+)/)?.[1])
      .filter(Boolean)
      .map(Number)
  );

  const unreversed = consumptions.filter(c => !reversedIds.has(c.id));

  const appointmentIds = new Set(unreversed.filter(c => c.appointmentId).map(c => c.appointmentId!));
  const totalAmountCents = unreversed.reduce((sum, c) => sum + Math.abs(c.amountCents), 0);

  return {
    disabledTypes,
    affectedAppointments: appointmentIds.size,
    totalAmountCents,
    transactions: unreversed.map(c => ({
      id: c.id,
      budgetType: c.budgetType,
      amountCents: c.amountCents,
      appointmentId: c.appointmentId,
      transactionDate: c.transactionDate,
    })),
  };
}

export async function rebookDisabledBudgetTransactions(customerId: number, userId: number): Promise<{
  reversedCount: number;
  rebookedCount: number;
  totalOldAmountCents: number;
  totalNewAmountCents: number;
  errors: Array<{ appointmentId: number; error: string }>;
}> {
  const preview = await getRebookPreview(customerId);
  if (preview.transactions.length === 0) {
    return { reversedCount: 0, rebookedCount: 0, totalOldAmountCents: 0, totalNewAmountCents: 0, errors: [] };
  }

  const byAppointment = new Map<number, typeof preview.transactions>();
  for (const tx of preview.transactions) {
    if (!tx.appointmentId) continue;
    const existing = byAppointment.get(tx.appointmentId) || [];
    existing.push(tx);
    byAppointment.set(tx.appointmentId, existing);
  }

  let reversedCount = 0;
  let rebookedCount = 0;
  let totalOldAmountCents = 0;
  let totalNewAmountCents = 0;
  const errors: Array<{ appointmentId: number; error: string }> = [];

  for (const [appointmentId] of byAppointment) {
    try {
      const txResult = await db.transaction(async (tx) => {
        await (tx as unknown as typeof db).execute(sql`SELECT pg_advisory_xact_lock(${sql.raw(String(customerId))})`);

        const allConsumptions = await tx.select()
          .from(budgetTransactions)
          .where(and(
            eq(budgetTransactions.customerId, customerId),
            eq(budgetTransactions.appointmentId, appointmentId),
            eq(budgetTransactions.transactionType, "consumption"),
          ));

        const allReversals = await tx.select()
          .from(budgetTransactions)
          .where(and(
            eq(budgetTransactions.customerId, customerId),
            eq(budgetTransactions.appointmentId, appointmentId),
            eq(budgetTransactions.transactionType, "reversal"),
          ));

        const alreadyReversedIds = new Set(
          allReversals
            .map(r => r.notes?.match(/Storno von Transaktion #(\d+)/)?.[1])
            .filter(Boolean)
            .map(Number)
        );

        const unreversedConsumptions = allConsumptions.filter(c => !alreadyReversedIds.has(c.id));

        let localReversedCount = 0;
        let localOldAmountCents = 0;

        for (const oldTx of unreversedConsumptions) {
          await tx.insert(budgetTransactions).values({
            customerId,
            budgetType: oldTx.budgetType,
            transactionDate: oldTx.transactionDate,
            transactionType: "reversal",
            amountCents: -oldTx.amountCents,
            appointmentId: oldTx.appointmentId,
            allocationId: oldTx.allocationId,
            reversedTransactionId: oldTx.id,
            notes: `Storno von Transaktion #${oldTx.id} (Umbuchung)`,
            createdByUserId: userId,
          });
          localReversedCount++;
          localOldAmountCents += Math.abs(oldTx.amountCents);
        }

        const [appt] = await tx.select({
          customerId: appointments.customerId,
          date: appointments.date,
          travelKilometers: appointments.travelKilometers,
          customerKilometers: appointments.customerKilometers,
        }).from(appointments).where(eq(appointments.id, appointmentId)).limit(1);

        if (!appt) throw new Error(`Termin #${appointmentId} nicht gefunden`);

        const apptServices = await tx.select({
          serviceId: appointmentServices.serviceId,
          actualDurationMinutes: appointmentServices.actualDurationMinutes,
        }).from(appointmentServices).where(eq(appointmentServices.appointmentId, appointmentId));

        const allServices = await tx.select({
          id: services.id,
          code: services.code,
        }).from(services);

        const serviceCodeMap = new Map(allServices.map(s => [s.id, s.code]));

        let hwMinutes = 0;
        let abMinutes = 0;
        for (const as of apptServices) {
          const code = serviceCodeMap.get(as.serviceId);
          const mins = as.actualDurationMinutes ?? 0;
          if (code === "hauswirtschaft") hwMinutes += mins;
          else if (code === "alltagsbegleitung") abMinutes += mins;
        }

        const travelKm = appt.travelKilometers ?? 0;
        const customerKm = appt.customerKilometers ?? 0;
        const txDate = typeof appt.date === "string" ? appt.date : String(appt.date);

        const costs = await calculateAppointmentCost({
          customerId,
          hauswirtschaftMinutes: hwMinutes,
          alltagsbegleitungMinutes: abMinutes,
          travelKilometers: travelKm,
          customerKilometers: customerKm,
          date: txDate,
        });

        let localNewAmountCents = 0;
        if (costs.totalCents > 0) {
          const cascadeResult = await createCascadeConsumption({
            customerId,
            appointmentId,
            transactionDate: txDate,
            totalAmountCents: costs.totalCents,
            hauswirtschaftMinutes: hwMinutes,
            hauswirtschaftCents: costs.hauswirtschaftCents,
            alltagsbegleitungMinutes: abMinutes,
            alltagsbegleitungCents: costs.alltagsbegleitungCents,
            travelKilometers: travelKm,
            travelCents: costs.travelCents,
            customerKilometers: customerKm,
            customerKilometersCents: costs.customerKilometersCents,
            userId,
            skipExistingCheck: true,
          }, tx);

          if (cascadeResult.outstandingCents > 0) {
            throw new Error(
              `Ziel-Budget reicht nicht aus. ${(cascadeResult.outstandingCents / 100).toFixed(2)} € konnten nicht gebucht werden.`
            );
          }

          localNewAmountCents = cascadeResult.totalConsumedCents;
        }

        return { localReversedCount, localOldAmountCents, localNewAmountCents };
      });

      reversedCount += txResult.localReversedCount;
      totalOldAmountCents += txResult.localOldAmountCents;
      totalNewAmountCents += txResult.localNewAmountCents;
      rebookedCount++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ appointmentId, error: msg });
    }
  }

  return { reversedCount, rebookedCount, totalOldAmountCents, totalNewAmountCents, errors };
}
