/**
 * Task #1014 — Re-Buchung netto-null-belegter Termine bei der Rechnungs-
 * ERSTELLUNG.
 *
 * Hintergrund (Folge von Task #1011): Wird eine Rechnung storniert, läuft pro
 * Termin ein Budget-Reversal → der Termin ist netto null (alle `consumption`-
 * Zeilen storniert). Beim Re-Abrechnen deriviert der Split den Pot-Anteil
 * READ-ONLY aus der aktuellen Allocation, bucht aber nichts. Ohne Re-Buchung
 * weist die neue Rechnung einen Topf aus, den der Ledger weiter als verfügbar
 * führt → ein späterer Termin verbraucht denselben Topf erneut (Doppel-Spend).
 *
 * `rebookNetZeroAppointmentConsumption` schließt die Lücke: es bucht für netto-
 * null-Termine frische GoBD-append-only `consumption`-Zeilen über die Standard-
 * Cascade. Dieser Test prüft:
 *  1) Ein netto-null-Termin bekommt nach dem Re-Book eine LIVE §45b-Konsumption
 *     (nicht mehr netto null).
 *  2) Idempotenz: ein zweiter Aufruf bucht NICHTS erneut (kein Doppel-Spend).
 *  3) Ein Termin OHNE jede Konsumption (echter Selbstzahler) wird ignoriert.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../server/lib/db";
import { budgetTransactions, appointmentServices } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import { rebookNetZeroAppointmentConsumption } from "../../server/storage/budget/rebook-storage";
import {
  apiGet,
  apiPost,
  apiPut,
  apiPatch,
  apiDelete,
  createTestEmployee,
  deactivateTestEmployee,
  cleanupCustomer,
  getAuthCookie,
  runCleanup,
  uniqueId,
} from "../test-utils";

const YEAR = 2026;
const MONTH = 4;
const APPT_DATE = `${YEAR}-0${MONTH}-15`;

let customerId: number;
let employeeId: number;
let userId: number;
let abServiceId: number;
let netZeroAppt: number;
let selbstzahlerAppt: number;
const cleanupApptIds: number[] = [];

async function createAppt(scheduledStart: string, scheduledEnd: string): Promise<number> {
  const res = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
    customerId,
    date: APPT_DATE,
    scheduledStart,
    scheduledEnd,
    notes: `Rebook-NetZero-${uniqueId()}`,
    assignedEmployeeId: employeeId,
    services: [{ serviceId: abServiceId, durationMinutes: 30 }],
  });
  expect(res.status, `create appt: ${JSON.stringify(res.data)}`).toBe(201);
  cleanupApptIds.push(res.data.id);
  // actualDurationMinutes setzen, damit calculateAppointmentCost > 0 liefert
  // (appointment_services ist nicht GoBD-immutability-geschützt).
  await db.update(appointmentServices)
    .set({ actualDurationMinutes: 30 })
    .where(eq(appointmentServices.appointmentId, res.data.id));
  return res.data.id;
}

async function liveConsumptions(apptId: number) {
  const all = await db.select({
    id: budgetTransactions.id,
    budgetType: budgetTransactions.budgetType,
    amountCents: budgetTransactions.amountCents,
  }).from(budgetTransactions).where(and(
    eq(budgetTransactions.appointmentId, apptId),
    eq(budgetTransactions.transactionType, "consumption"),
  ));
  // reversierte ausfiltern
  const reversed = await db.select({ ref: budgetTransactions.reversedTransactionId })
    .from(budgetTransactions).where(and(
      eq(budgetTransactions.appointmentId, apptId),
      eq(budgetTransactions.transactionType, "reversal"),
    ));
  const reversedIds = new Set(reversed.map((r) => r.ref).filter((x): x is number => x !== null));
  return all.filter((c) => !reversedIds.has(c.id));
}

beforeAll(async () => {
  const auth = await getAuthCookie();
  userId = auth.user.id;

  const services = await apiGet<Array<{ id: number; code: string | null }>>("/api/services/all");
  abServiceId = services.data.find((s) => s.code === "alltagsbegleitung")!.id;

  const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
    vorname: "Rebook",
    nachname: `NetZero-${uniqueId()}`,
    geburtsdatum: "1942-05-10",
    email: `rebook-${uniqueId()}@test.local`,
    strasse: "Musterweg",
    nr: "12",
    plz: "01067",
    stadt: "Dresden",
    telefon: "+4917600000002",
    pflegegrad: 3,
    pflegegradSeit: "2024-01-01",
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  expect(custRes.status, `create customer: ${JSON.stringify(custRes.data)}`).toBe(201);
  customerId = custRes.data.id;

  const emp = await createTestEmployee({ vorname: "Marcel", nachnamePrefix: "Rebook_Integ" });
  employeeId = emp.id;
  const assignRes = await apiPatch(`/api/admin/customers/${customerId}/assign`, {
    primaryEmployeeId: employeeId,
    backupEmployeeId: null,
    backupEmployeeId2: null,
  });
  expect(assignRes.status, `assign: ${JSON.stringify(assignRes.data)}`).toBe(200);

  // §45b komfortabel ausgestattet (für die Re-Derivation/Re-Buchung).
  const init45b = await apiPost(`/api/budget/${customerId}/initial-budget`, {
    budgetType: "entlastungsbetrag_45b",
    currentMonthAmountCents: 13100,
    carryoverAmountCents: 0,
    budgetStartDate: `${YEAR}-0${MONTH}-01`,
  });
  expect([200, 201]).toContain(init45b.status);

  const typesRes = await apiPut(`/api/budget/${customerId}/type-settings`, {
    settings: [
      { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: 13100, yearlyLimitCents: null, validFrom: null, validTo: null },
      { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
      { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
    ],
  });
  expect(typesRes.status, `type-settings: ${JSON.stringify(typesRes.data)}`).toBe(200);

  netZeroAppt = await createAppt("13:00", "13:30");
  selbstzahlerAppt = await createAppt("14:00", "14:30");

  // netZeroAppt: eine §45b-Konsumption, sofort wieder storniert (netto null).
  const [orig] = await db.insert(budgetTransactions).values({
    customerId, budgetType: "entlastungsbetrag_45b", transactionDate: APPT_DATE,
    transactionType: "consumption", amountCents: -2380, appointmentId: netZeroAppt,
    notes: "§45b (wird storniert)",
  }).returning({ id: budgetTransactions.id });
  await db.insert(budgetTransactions).values({
    customerId, budgetType: "entlastungsbetrag_45b", transactionDate: APPT_DATE,
    transactionType: "reversal", amountCents: 2380, appointmentId: netZeroAppt,
    reversedTransactionId: orig.id, notes: "Storno §45b",
  });
  // selbstzahlerAppt: KEINE Konsumption (echter Selbstzahler / Alt-Daten).
});

afterAll(async () => {
  for (const id of cleanupApptIds) {
    try { await apiDelete(`/api/appointments/${id}`); } catch { /* best-effort */ }
  }
  await cleanupCustomer(customerId);
  await deactivateTestEmployee(employeeId);
  await runCleanup();
});

describe("rebookNetZeroAppointmentConsumption (Task #1014)", () => {
  it("bucht für netto-null-Termine frische §45b-Konsumption, idempotent, ignoriert Selbstzahler", async () => {
    // Vorher: netZeroAppt hat KEINE Live-Konsumption (alles storniert).
    expect(await liveConsumptions(netZeroAppt)).toHaveLength(0);

    // 1) Re-Book über beide Termine.
    const first = await rebookNetZeroAppointmentConsumption({
      customerId,
      appointmentIds: [netZeroAppt, selbstzahlerAppt],
      userId,
    });
    // Nur der netto-null-Termin wird re-gebucht; der Selbstzahler-Termin nicht.
    expect(first.rebookedAppointmentIds).toEqual([netZeroAppt]);

    const live = await liveConsumptions(netZeroAppt);
    expect(live).toHaveLength(1);
    expect(live[0].budgetType).toBe("entlastungsbetrag_45b");
    expect(live[0].amountCents).toBeLessThan(0); // Konsumption = negativ

    // Selbstzahler-Termin bleibt unbelegt.
    expect(await liveConsumptions(selbstzahlerAppt)).toHaveLength(0);

    // 2) Idempotenz: zweiter Aufruf bucht NICHTS erneut.
    const second = await rebookNetZeroAppointmentConsumption({
      customerId,
      appointmentIds: [netZeroAppt, selbstzahlerAppt],
      userId,
    });
    expect(second.rebookedAppointmentIds).toEqual([]);
    expect(await liveConsumptions(netZeroAppt)).toHaveLength(1);
  }, 120_000);
});

/**
 * Task #1353 — Re-Buchung darf für reine Pflegekassen-Kunden (kein
 * Selbstzahler, `acceptsPrivatePayment=false`) NIE still einen 19%-Privat-Rest
 * abrechnen. Reichen die gesetzlichen Töpfe beim Re-Book nicht aus, MUSS der
 * Lauf laut abbrechen (Sperre mit der betroffenen Termin-Nummer) statt einen
 * verbotenen Privattopf zu buchen. Selbstzahler/`acceptsPrivatePayment=true`
 * bleiben unberührt (eigene Suiten).
 */
describe("rebookNetZeroAppointmentConsumption Privat-Sperre (Task #1353)", () => {
  it("blockiert reinen Pflegekassen-Kunden mit echtem Rest, nennt die Termin-Nummer", async () => {
    // Eigener Kunde: Pflegekasse, KEIN Privatzahler, KEINE gesetzlichen Töpfe
    // (alle deaktiviert) → ein netto-null-Termin lässt sich nicht decken.
    const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
      vorname: "Rebook",
      nachname: `NoPrivate-${uniqueId()}`,
      geburtsdatum: "1940-03-03",
      email: `rebook-noprivate-${uniqueId()}@test.local`,
      strasse: "Musterweg",
      nr: "7",
      plz: "01067",
      stadt: "Dresden",
      telefon: "+4917600000009",
      pflegegrad: 3,
      pflegegradSeit: "2024-01-01",
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
    });
    expect(custRes.status, `create customer: ${JSON.stringify(custRes.data)}`).toBe(201);
    const noPrivateCustomerId = custRes.data.id;

    try {
      const assignRes = await apiPatch(`/api/admin/customers/${noPrivateCustomerId}/assign`, {
        primaryEmployeeId: employeeId,
        backupEmployeeId: null,
        backupEmployeeId2: null,
      });
      expect(assignRes.status, `assign: ${JSON.stringify(assignRes.data)}`).toBe(200);

      // Alle gesetzlichen Töpfe deaktiviert → keine Deckung beim Re-Book.
      const typesRes = await apiPut(`/api/budget/${noPrivateCustomerId}/type-settings`, {
        settings: [
          { budgetType: "entlastungsbetrag_45b", enabled: false, priority: 1, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
          { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
          { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
        ],
      });
      expect(typesRes.status, `type-settings: ${JSON.stringify(typesRes.data)}`).toBe(200);

      const apptRes = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
        customerId: noPrivateCustomerId,
        date: APPT_DATE,
        scheduledStart: "15:00",
        scheduledEnd: "15:30",
        notes: `Rebook-NoPrivate-${uniqueId()}`,
        assignedEmployeeId: employeeId,
        services: [{ serviceId: abServiceId, durationMinutes: 30 }],
      });
      expect(apptRes.status, `create appt: ${JSON.stringify(apptRes.data)}`).toBe(201);
      const restAppt = apptRes.data.id;
      cleanupApptIds.push(restAppt);
      await db.update(appointmentServices)
        .set({ actualDurationMinutes: 30 })
        .where(eq(appointmentServices.appointmentId, restAppt));

      // Netto-null-Zustand herstellen: rohe §45b-Konsumption + sofortige Storno.
      const [orig] = await db.insert(budgetTransactions).values({
        customerId: noPrivateCustomerId, budgetType: "entlastungsbetrag_45b",
        transactionDate: APPT_DATE, transactionType: "consumption",
        amountCents: -2380, appointmentId: restAppt, notes: "§45b (wird storniert)",
      }).returning({ id: budgetTransactions.id });
      await db.insert(budgetTransactions).values({
        customerId: noPrivateCustomerId, budgetType: "entlastungsbetrag_45b",
        transactionDate: APPT_DATE, transactionType: "reversal", amountCents: 2380,
        appointmentId: restAppt, reversedTransactionId: orig.id, notes: "Storno §45b",
      });

      // Re-Book MUSS laut abbrechen (kein Privattopf, echter Rest) und die
      // Termin-Nummer nennen.
      await expect(rebookNetZeroAppointmentConsumption({
        customerId: noPrivateCustomerId,
        appointmentIds: [restAppt],
        userId,
      })).rejects.toThrow(new RegExp(`Termin #${restAppt}`));

      // Sperre rollt zurück → keine neue (private) Live-Konsumption gebucht.
      expect(await liveConsumptions(restAppt)).toHaveLength(0);
    } finally {
      await cleanupCustomer(noPrivateCustomerId);
    }
  }, 120_000);
});
