import {
  budgetTransactions,
  appointments,
  appointmentServices,
  services,
  customers,
  type BudgetTransaction,
} from "@shared/schema";
import { eq, and, sql, or, inArray, isNotNull } from "drizzle-orm";
import { db } from "../../lib/db";
import type { DbClient } from "./types";
import { readBudgetTypeSettings } from "./preferences-storage";
import { todayISO } from "@shared/utils/datetime";
import { calculateAppointmentCost } from "./appointment-cost-calculator";
import { consumeFifo, createCascadeConsumption } from "./consumption-engine";
import { formatEuroDE } from "@shared/utils/money";
import { appointmentsRepo, customersRepo } from "../../repos";
import {
  isPrivatePaymentAllowed,
  isSelbstzahlerBillingType,
} from "@shared/domain/budget-selbstzahler-validator";

export async function rebookSingleTransaction(
  customerId: number,
  transactionId: number,
  targetBudgetType: string,
  userId: number
): Promise<{ reversalTransaction: BudgetTransaction; newTransaction: BudgetTransaction | null; amountCents: number }> {
  return await db.transaction(async (tx) => {
    // Gleicher Advisory-Lock-Namespace wie in createConsumptionTransaction:
    // Rebook und parallele Konsumbuchungen pro Kunde serialisieren, damit
    // der Ziel-Topf nicht überbucht werden kann.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('budget_consumption_' || ${customerId}::text))`
    );

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

    // Historisierungs-aware (Task #440): die zum ursprünglichen Buchungsdatum
    // gültige Topf-Konfiguration entscheidet, ob die Umbuchung erlaubt ist.
    const typeSettings = await readBudgetTypeSettings(customerId, { kind: "forDate", asOfDate: original.transactionDate }, tx);
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

    // Task #754 (BUG-14 / BUG-10b) — Service-Cent-/Minuten-/km-Spalten der
    // Original-Consumption spiegeln (vorzeichen-invertiert), damit Σ je
    // Service-Spalte über {original consumption + reversal} = 0. Andernfalls
    // bleibt der Termin in Lexware/Statistik als „voll gebucht" sichtbar,
    // obwohl der Umbuchungs-Storno die Zahlung zurückgenommen hat.
    const negate = (v: number | null | undefined) => (v == null ? null : -v);
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
        hauswirtschaftMinutes: negate(original.hauswirtschaftMinutes),
        hauswirtschaftCents: negate(original.hauswirtschaftCents),
        alltagsbegleitungMinutes: negate(original.alltagsbegleitungMinutes),
        alltagsbegleitungCents: negate(original.alltagsbegleitungCents),
        travelKilometers: negate(original.travelKilometers),
        travelCents: negate(original.travelCents),
        customerKilometers: negate(original.customerKilometers),
        customerKilometersCents: negate(original.customerKilometersCents),
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
      throw new Error(`Ziel-Topf hat nicht genug Budget. Verfügbar: ${formatEuroDE(fifoResult.consumedCents)}, benötigt: ${formatEuroDE(absAmount)}`);
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
  // Task #716: Rebook-Preview ist eine Edit-/Operator-Ansicht (welche Töpfe
  // sind aktuell deaktiviert?), nicht ein Buchungs-Lookup für einen
  // historischen Stichtag — wir lesen pro Topf die jüngste Intent-Zeile.
  const typeSettings = await readBudgetTypeSettings(customerId, { kind: "forEdit" });
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
        // Gleicher Advisory-Lock-Namespace wie in createConsumptionTransaction,
        // damit Rebook und Konsumbuchungen für denselben Kunden gegenseitig
        // serialisieren.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext('budget_consumption_' || ${customerId}::text))`
        );

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

        // Task #754 (BUG-10b) — Cascade-Storno spiegelt pro Reversal-TX die
        // anteiligen Service-Cents/-Minuten/-km der korrespondierenden
        // Consumption-TX (vorzeichen-invertiert), sodass Σ pro Service-Spalte
        // über alle Cascade-Töpfe + ihre Storno-Zeilen netto 0 ergibt — auch
        // dann, wenn ein Termin §45b + §45a + §39 gleichzeitig getroffen hat.
        const negate = (v: number | null | undefined) => (v == null ? null : -v);
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
            hauswirtschaftMinutes: negate(oldTx.hauswirtschaftMinutes),
            hauswirtschaftCents: negate(oldTx.hauswirtschaftCents),
            alltagsbegleitungMinutes: negate(oldTx.alltagsbegleitungMinutes),
            alltagsbegleitungCents: negate(oldTx.alltagsbegleitungCents),
            travelKilometers: negate(oldTx.travelKilometers),
            travelCents: negate(oldTx.travelCents),
            customerKilometers: negate(oldTx.customerKilometers),
            customerKilometersCents: negate(oldTx.customerKilometersCents),
            notes: `Storno von Transaktion #${oldTx.id} (Umbuchung)`,
            createdByUserId: userId,
          });
          localReversedCount++;
          localOldAmountCents += Math.abs(oldTx.amountCents);
        }

        const [appt] = await appointmentsRepo.selectColumnsFrom({
          customerId: appointments.customerId,
          date: appointments.date,
          travelKilometers: appointments.travelKilometers,
          customerKilometers: appointments.customerKilometers,
        }, tx).where(eq(appointments.id, appointmentId)).limit(1);

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
              `Ziel-Budget reicht nicht aus. ${formatEuroDE(cascadeResult.outstandingCents)} konnten nicht gebucht werden.`
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

/**
 * Task #1014 — Re-Buchung netto-null-belegter Termine bei der Rechnungs-
 * ERSTELLUNG (nicht Preview).
 *
 * Hintergrund: Wird eine Rechnung storniert, läuft pro Termin ein Budget-
 * Reversal — der Termin wird wieder abrechenbar und seine Konsumption ist
 * netto null (alle `consumption`-Zeilen storniert). Beim Re-Abrechnen
 * deriviert `getBudgetSplitForAppointments` den Pot-Anteil read-only aus der
 * AKTUELLEN Allocation (Task #1011), bucht aber NICHTS. Ohne Re-Buchung weist
 * die neue Rechnung also einen Pott aus (z.B. §45b), während der Ledger den
 * Topf weiterhin als „verfügbar" führt → ein späterer Termin verbraucht
 * denselben Topf erneut → derselbe Topf ist über ZWEI aktive Rechnungen
 * doppelt belegt (GoBD-/Finanz-Drift).
 *
 * Lösung: Vor dem Bauen des finalen Rechnungs-Drafts werden für die netto-
 * null-Termine frische Cascade-`consumption`-Zeilen GoBD-append-only gebucht
 * (gegen die jetzt verfügbaren Töpfe, identische Standard-Priorität §45b →
 * §45a → §39/§42a, Rest → privater uncapped-Topf). Danach liest der Draft den
 * Split aus diesen Live-Zeilen — Ledger und Rechnung sind per Konstruktion
 * deckungsgleich (eine Quelle: die gebuchten Zeilen).
 *
 * Kein Doppel-Verbrauch: Es wird ausschließlich für Termine OHNE Live-Konsum
 * gebucht. Nach erfolgreicher Buchung ist der Termin nicht mehr netto-null →
 * ein erneuter Generate-Lauf erkennt ihn nicht mehr als netto-null und bucht
 * nicht erneut (idempotent). Die Netto-Null-Prüfung läuft UNTER dem
 * Pro-Kunde-Advisory-Lock erneut, damit parallele Läufe nicht doppelt buchen.
 */
export async function rebookNetZeroAppointmentConsumption(params: {
  customerId: number;
  appointmentIds: number[];
  userId: number;
}): Promise<{ rebookedAppointmentIds: number[] }> {
  const { customerId, appointmentIds, userId } = params;
  const rebookedAppointmentIds: number[] = [];
  if (appointmentIds.length === 0) return { rebookedAppointmentIds };

  for (const appointmentId of appointmentIds) {
    const didRebook = await db.transaction(async (tx) => {
      // Gleicher Advisory-Lock-Namespace wie createConsumptionTransaction /
      // rebookDisabledBudgetTransactions: serialisiert Re-Buchung und
      // parallele Konsumbuchungen pro Kunde.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('budget_consumption_' || ${customerId}::text))`
      );

      // Netto-Null UNTER dem Lock erneut prüfen (Concurrency-Schutz).
      const consumptions = await tx.select({ id: budgetTransactions.id })
        .from(budgetTransactions)
        .where(and(
          eq(budgetTransactions.customerId, customerId),
          eq(budgetTransactions.appointmentId, appointmentId),
          eq(budgetTransactions.transactionType, "consumption"),
        ));
      // Nie konsumiert (echter Selbstzahler / Alt-Daten) → nicht netto-null,
      // nichts zu tun.
      if (consumptions.length === 0) return false;

      const consumptionIds = consumptions.map((c) => c.id);
      const reversals = await tx.select({
        reversedTransactionId: budgetTransactions.reversedTransactionId,
      })
        .from(budgetTransactions)
        .where(and(
          eq(budgetTransactions.customerId, customerId),
          eq(budgetTransactions.transactionType, "reversal"),
          isNotNull(budgetTransactions.reversedTransactionId),
          inArray(budgetTransactions.reversedTransactionId, consumptionIds),
        ));
      const reversedIds = new Set(
        reversals
          .map((r) => r.reversedTransactionId)
          .filter((id): id is number => id !== null),
      );
      const hasLiveConsumption = consumptions.some((c) => !reversedIds.has(c.id));
      // Bereits (wieder) live belegt → nicht netto-null (z.B. paralleler Lauf
      // war schneller). Idempotent: nichts buchen.
      if (hasLiveConsumption) return false;

      // Termin-Kost frisch zum Termin-Datum berechnen (temporale Preise) —
      // identische Quelle wie der normale Konsum-Buchungspfad.
      const [appt] = await appointmentsRepo.selectColumnsFrom({
        date: appointments.date,
        travelKilometers: appointments.travelKilometers,
        customerKilometers: appointments.customerKilometers,
      }, tx).where(eq(appointments.id, appointmentId)).limit(1);
      if (!appt) return false;

      const apptServices = await tx.select({
        serviceId: appointmentServices.serviceId,
        actualDurationMinutes: appointmentServices.actualDurationMinutes,
      }).from(appointmentServices).where(eq(appointmentServices.appointmentId, appointmentId));

      const allServices = await tx.select({
        id: services.id,
        code: services.code,
      }).from(services);
      const serviceCodeMap = new Map(allServices.map((s) => [s.id, s.code]));

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
      if (costs.totalCents <= 0) return false;

      // Task #1353 — Privat-Topf-Gate identisch zum normalen Buchungspfad
      // (`createConsumptionTransaction`): Der frühere bedingungslose
      // `privatePot: { statutoryExcluded: false, noteKind: "privatzahlung" }`
      // hat JEDEN Kunden einen uncapped Privattopf gegeben, sodass ein Rest
      // (der bei der Re-Ableitung gegen den aktuellen Ledger entstehen kann)
      // still als 19%-Privatrechnung abgerechnet wurde — auch bei reinen
      // Pflegekassen-Kunden ohne `acceptsPrivatePayment` (Jungnickel-/AOK-Fall).
      // Jetzt entscheidet derselbe zentrale Gate (`isPrivatePaymentAllowed`),
      // ob ein privater Terminal-Topf zulässig ist:
      //   - Selbstzahler        → nur privat (statutorisch ausgelassen),
      //   - Pflegekasse + privat → statutorische Töpfe + uncapped Privattopf,
      //   - Pflegekasse o. privat → KEIN Privattopf; bleibt ein Rest, blockiert
      //                            der Lauf laut (klare Sperre) statt eine
      //                            verbotene Privatrechnung zu erzeugen.
      const [customer] = await customersRepo
        .selectColumnsFrom(
          {
            billingType: customers.billingType,
            acceptsPrivatePayment: customers.acceptsPrivatePayment,
          },
          tx,
        )
        .where(eq(customers.id, customerId))
        .limit(1);
      const isSelbstzahler = isSelbstzahlerBillingType(customer?.billingType);
      const isPrivateAllowed = isPrivatePaymentAllowed({
        billingType: customer?.billingType,
        acceptsPrivatePayment: customer?.acceptsPrivatePayment,
      });
      const privatePot = isSelbstzahler
        ? { statutoryExcluded: true, noteKind: "selbstzahler" as const }
        : isPrivateAllowed
          ? { statutoryExcluded: false, noteKind: "privatzahlung" as const }
          : undefined;

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
        privatePot,
      }, tx);

      // Reiner Pflegekassen-Kunde (kein Privattopf) und die gesetzlichen Töpfe
      // reichen nicht → outstandingCents > 0. Statt still privat abzurechnen,
      // bricht die Re-Abrechnung laut ab (Transaktion rollt zurück). Die
      // Rechnungserstellung scheitert mit klarer Meldung, der/die Bearbeiter:in
      // muss die Budget-Konfiguration/Buchungen für diesen Termin prüfen.
      if (cascadeResult.outstandingCents > 0) {
        throw new Error(
          `Re-Abrechnung nicht möglich: Termin #${appointmentId} kann nicht ` +
          `vollständig aus den gesetzlichen Pflegekassen-Töpfen abgerechnet ` +
          `werden (${formatEuroDE(cascadeResult.outstandingCents)} ohne ` +
          `Deckung). Eine Privatabrechnung ist für diesen Kunden nicht ` +
          `zulässig. Bitte prüfen Sie die Budget-Konfiguration und Buchungen.`,
        );
      }

      return true;
    });

    if (didRebook) rebookedAppointmentIds.push(appointmentId);
  }

  return { rebookedAppointmentIds };
}
