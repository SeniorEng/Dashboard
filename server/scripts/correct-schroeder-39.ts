/**
 * Task #708 — Idempotenter One-Shot zur Korrektur des Kundenkontos
 * Rosemarie Schröder (Kunde #39).
 *
 * Bug-Bild aus dem Excel-Import: zwei Termine waren als `scheduled`
 * stehengeblieben (#177 und #710) und wurden vom Re-Import fälschlich
 * als "Duplikat → skip" behandelt, statt auf `completed` angehoben zu
 * werden. Zusätzlich hatten zwei weitere Termine (#303/#304 am 18.03.2026)
 * kein `signed_at`, obwohl der Leistungsnachweis unterschrieben war —
 * das hat sie aus dem §45b-Verbrauch ausgeklammert.
 *
 * Nach Anwendung sollte der §45b-Verbrauch 2026 für #39 = 475,55 €
 * betragen.
 *
 * Termin #1387 (27.05.2026) wird bewusst NICHT angefasst — der liegt
 * jenseits des Excel-Cutoffs und bleibt geplant.
 *
 * Ausführung:
 *   tsx server/scripts/correct-schroeder-39.ts            # Dry-Run
 *   tsx server/scripts/correct-schroeder-39.ts --apply    # Schreibend
 */

import { and, eq, sum, gte, lte, sql } from "drizzle-orm";
import { db } from "../lib/db";
import {
  appointments,
  appointmentServices,
  budgetTransactions,
  users,
} from "@shared/schema";
import { appointmentsRepo } from "../repos";
import { budgetLedgerStorage } from "../storage/budget-ledger";
import { auditService } from "../services/audit";
import { isHauswirtschaftArt } from "@shared/domain/excel-service-art";
import { REBOOK_TRIGGERS } from "@shared/domain/budget-rebook-triggers";

const CUSTOMER_ID = 39;
const TARGET_45B_CENTS_2026 = 47555;

interface UpgradePlan {
  appointmentId: number;
  date: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  kilometers: number;
  art: string; // "Hauswirtschaft" | "Alltagsbegleitung"
  employeeDisplayName: string;
  serviceCode: "hauswirtschaft" | "alltagsbegleitung";
}

interface SignFixPlan {
  appointmentId: number;
  date: string;
}

const UPGRADES: UpgradePlan[] = [
  {
    appointmentId: 177,
    date: "2026-02-09",
    startTime: "13:30",
    endTime: "15:00",
    durationMinutes: 90,
    kilometers: 15,
    art: "Alltagsbegleitung",
    employeeDisplayName: "Naji",
    serviceCode: "alltagsbegleitung",
  },
  {
    appointmentId: 710,
    date: "2026-04-15",
    startTime: "09:00",
    endTime: "11:00",
    durationMinutes: 120,
    kilometers: 1.8,
    art: "Hauswirtschaft",
    employeeDisplayName: "Janet",
    serviceCode: "hauswirtschaft",
  },
];

const SIGN_FIXES: SignFixPlan[] = [
  { appointmentId: 303, date: "2026-03-18" },
  { appointmentId: 304, date: "2026-03-18" },
];

async function findOperatorUserId(): Promise<number> {
  const [u] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isSuperAdmin, true))
    .limit(1);
  if (!u) throw new Error("Kein Superadmin gefunden — Operator für Audit-Log fehlt.");
  return u.id;
}

async function findEmployeeIdByDisplayName(name: string): Promise<number | null> {
  const all = await db
    .select({ id: users.id, displayName: users.displayName, vorname: users.vorname })
    .from(users);
  // Erster Treffer mit Vorname == name (Janet/Naji im Excel) ODER
  // displayName beginnt mit name.
  const exact = all.find((u) => u.vorname === name);
  if (exact) return exact.id;
  const prefix = all.find((u) => (u.displayName ?? "").startsWith(name));
  return prefix?.id ?? null;
}

async function findServiceId(code: "hauswirtschaft" | "alltagsbegleitung"): Promise<number | null> {
  const { services } = await import("@shared/schema");
  const rows = await db
    .select({ id: services.id, code: services.code })
    .from(services)
    .where(eq(services.code, code))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function get45bConsumption2026(): Promise<number> {
  // §45b-Verbrauch = Summe ALLER Bewegungen (consumption negativ + reversal
  // positiv kompensieren sich). Wir geben den absoluten Verbrauch in Cents
  // (positiv) zurück.
  const [agg] = await db
    .select({ total: sum(budgetTransactions.amountCents).mapWith(Number) })
    .from(budgetTransactions)
    .where(
      and(
        eq(budgetTransactions.customerId, CUSTOMER_ID),
        eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
        gte(budgetTransactions.transactionDate, "2026-01-01"),
        lte(budgetTransactions.transactionDate, "2026-12-31"),
        sql`${budgetTransactions.transactionType} IN ('consumption', 'reversal')`,
      ),
    );
  return Math.abs(Number(agg?.total ?? 0));
}

async function upgradeAppointment(plan: UpgradePlan, operatorUserId: number, apply: boolean): Promise<"upgraded" | "already_completed" | "skipped" | "missing"> {
  const [appt] = await appointmentsRepo
    .selectColumnsFrom({
      id: appointments.id,
      customerId: appointments.customerId,
      status: appointments.status,
      signedAt: appointments.signedAt,
      assignedEmployeeId: appointments.assignedEmployeeId,
      travelKilometers: appointments.travelKilometers,
      durationPromised: appointments.durationPromised,
    })
    .where(
      and(
        eq(appointments.id, plan.appointmentId),
        appointmentsRepo.activeOnly(),
      ),
    )
    .limit(1);

  if (!appt) {
    console.warn(`  [skip] Termin #${plan.appointmentId} nicht aktiv/nicht gefunden`);
    return "missing";
  }
  if (appt.customerId !== CUSTOMER_ID) {
    console.warn(`  [skip] Termin #${plan.appointmentId} gehört Kunde ${appt.customerId}, nicht #${CUSTOMER_ID}`);
    return "skipped";
  }
  if (appt.status === "completed" && appt.signedAt) {
    console.log(`  [ok ] Termin #${plan.appointmentId} bereits completed+signed — nichts zu tun`);
    return "already_completed";
  }
  if (appt.status !== "scheduled") {
    console.warn(`  [skip] Termin #${plan.appointmentId} hat Status '${appt.status}' (nicht 'scheduled') — nicht upgegradet`);
    return "skipped";
  }

  const employeeId = await findEmployeeIdByDisplayName(plan.employeeDisplayName);
  if (!employeeId) {
    console.warn(`  [skip] Mitarbeiter '${plan.employeeDisplayName}' nicht gefunden`);
    return "skipped";
  }
  const serviceId = await findServiceId(plan.serviceCode);
  if (!serviceId) {
    console.warn(`  [skip] Service '${plan.serviceCode}' nicht gefunden`);
    return "skipped";
  }

  if (!apply) {
    console.log(`  [dry] WÜRDE Termin #${plan.appointmentId} (${plan.date} ${plan.startTime}-${plan.endTime}, ${plan.art}, ${plan.kilometers}km, ${plan.employeeDisplayName}) auf 'completed' anheben und §45b-Consumption buchen.`);
    return "upgraded";
  }

  const isHauswirtschaft = isHauswirtschaftArt(plan.art);
  const hwMinutes = isHauswirtschaft ? plan.durationMinutes : 0;
  const abMinutes = isHauswirtschaft ? 0 : plan.durationMinutes;
  const signedAt = new Date();

  await db.transaction(async (tx) => {
    await tx
      .update(appointments)
      .set({
        status: "completed",
        actualStart: plan.startTime,
        actualEnd: plan.endTime,
        scheduledEnd: plan.endTime,
        durationPromised: plan.durationMinutes,
        assignedEmployeeId: employeeId,
        performedByEmployeeId: employeeId,
        travelKilometers: plan.kilometers,
        signedAt,
        signedByUserId: operatorUserId,
        notes: "Schröder-Korrektur (Task #708): Import-Upgrade aus Altdaten",
      })
      .where(eq(appointments.id, plan.appointmentId));

    await tx
      .delete(appointmentServices)
      .where(eq(appointmentServices.appointmentId, plan.appointmentId));
    await tx.insert(appointmentServices).values({
      appointmentId: plan.appointmentId,
      serviceId,
      plannedDurationMinutes: plan.durationMinutes,
      actualDurationMinutes: plan.durationMinutes,
      details: `Schröder-Korrektur: ${plan.art}`,
    });

    await budgetLedgerStorage.createConsumptionTransaction(
      {
        customerId: CUSTOMER_ID,
        appointmentId: plan.appointmentId,
        transactionDate: plan.date,
        hauswirtschaftMinutes: hwMinutes,
        alltagsbegleitungMinutes: abMinutes,
        travelKilometers: plan.kilometers,
        customerKilometers: 0,
        userId: operatorUserId,
      },
      tx,
    );
  });

  await auditService.log(
    operatorUserId,
    "appointment_km_rebooked",
    "appointment",
    plan.appointmentId,
    {
      customerId: CUSTOMER_ID,
      trigger: REBOOK_TRIGGERS.import.upgrade,
      task: "task-708",
      script: "correct-schroeder-39",
      previousStatus: appt.status,
      newStatus: "completed",
      actualStart: plan.startTime,
      actualEnd: plan.endTime,
      signedAt: signedAt.toISOString(),
      hauswirtschaftMinutes: hwMinutes,
      alltagsbegleitungMinutes: abMinutes,
      travelKilometers: plan.kilometers,
      previousTravelKm: appt.travelKilometers ?? 0,
      previousAssignedEmployeeId: appt.assignedEmployeeId ?? null,
      newAssignedEmployeeId: employeeId,
    },
  );

  console.log(`  [ok ] Termin #${plan.appointmentId} upgegradet (${plan.date} ${plan.art} ${plan.kilometers}km).`);
  return "upgraded";
}

async function fixSignedAt(plan: SignFixPlan, operatorUserId: number, apply: boolean): Promise<"fixed" | "already_signed" | "skipped" | "missing"> {
  const [appt] = await appointmentsRepo
    .selectColumnsFrom({
      id: appointments.id,
      customerId: appointments.customerId,
      status: appointments.status,
      signedAt: appointments.signedAt,
    })
    .where(
      and(
        eq(appointments.id, plan.appointmentId),
        appointmentsRepo.activeOnly(),
      ),
    )
    .limit(1);

  if (!appt) {
    console.warn(`  [skip] Termin #${plan.appointmentId} nicht gefunden`);
    return "missing";
  }
  if (appt.customerId !== CUSTOMER_ID) {
    console.warn(`  [skip] Termin #${plan.appointmentId} gehört Kunde ${appt.customerId}, nicht #${CUSTOMER_ID}`);
    return "skipped";
  }
  if (appt.signedAt) {
    console.log(`  [ok ] Termin #${plan.appointmentId} hat bereits signed_at — nichts zu tun`);
    return "already_signed";
  }
  if (appt.status !== "completed") {
    console.warn(`  [skip] Termin #${plan.appointmentId} ist Status '${appt.status}' (erwartet 'completed') — signed_at NICHT nachgesetzt`);
    return "skipped";
  }

  if (!apply) {
    console.log(`  [dry] WÜRDE signed_at auf Termin #${plan.appointmentId} (${plan.date}) nachsetzen.`);
    return "fixed";
  }

  const signedAt = new Date();
  await db
    .update(appointments)
    .set({ signedAt, signedByUserId: operatorUserId })
    .where(eq(appointments.id, plan.appointmentId));

  await auditService.log(
    operatorUserId,
    "appointment_updated",
    "appointment",
    plan.appointmentId,
    {
      customerId: CUSTOMER_ID,
      task: "task-708",
      script: "correct-schroeder-39",
      reason: "signed_at_backfilled",
      date: plan.date,
      signedAt: signedAt.toISOString(),
    },
  );
  console.log(`  [ok ] Termin #${plan.appointmentId} signed_at nachgesetzt.`);
  return "fixed";
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`\n=== Schröder-Korrektur Kunde #${CUSTOMER_ID} (Task #708) ===`);
  console.log(`Modus: ${apply ? "APPLY (schreibend)" : "DRY-RUN"}\n`);

  const before = await get45bConsumption2026();
  console.log(`§45b-Verbrauch 2026 VOR Korrektur: ${(before / 100).toFixed(2)} €`);

  const operatorUserId = await findOperatorUserId();

  console.log(`\n[1/2] Upgrade-Termine:`);
  for (const plan of UPGRADES) {
    await upgradeAppointment(plan, operatorUserId, apply);
  }

  console.log(`\n[2/2] signed_at nachsetzen:`);
  for (const plan of SIGN_FIXES) {
    await fixSignedAt(plan, operatorUserId, apply);
  }

  const after = await get45bConsumption2026();
  console.log(`\n§45b-Verbrauch 2026 NACH Korrektur: ${(after / 100).toFixed(2)} €`);
  console.log(`Zielwert: ${(TARGET_45B_CENTS_2026 / 100).toFixed(2)} €`);

  if (apply) {
    if (after === TARGET_45B_CENTS_2026) {
      console.log(`✓ Zielwert exakt erreicht.`);
    } else {
      console.warn(`⚠ Abweichung zum Zielwert: ${((after - TARGET_45B_CENTS_2026) / 100).toFixed(2)} €. Bitte prüfen.`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
