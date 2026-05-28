/**
 * Task #723 — Equality: Σ Service-Felder über alle Cascade-Legs ==
 * appointment.<feld>Cents.
 *
 * Hintergrund / Bug (#723, BUG-10): Vor #723 übergab
 * `createCascadeConsumption` die Service-Felder (hauswirtschaftCents,
 * alltagsbegleitungCents, travelCents, customerKilometersCents) nur an die
 * ERSTE Cascade-`consumeFifo`-Buchung. Folge-Töpfe (z.B. `umwandlung_45a`
 * nach §45b-Erschöpfung) bekamen nur `{appointmentId,userId}` →
 * die Service-Felder landeten als NULL in der DB.
 *
 * Konsequenz: Lexware-Export, §45b-Anzeige, Statistik und Rechnungs-
 * Splits, die diese Spalten pro Termin aufsummieren, sahen Σ ≠
 * appointment.<feld>Cents (bis zu ~50 %-Drift in einem 2-Topf-Cascade).
 *
 * Fix: `totalAmountCents`-Skalierungsnenner in `buildConsumptionTxData` +
 * `reconcileAppointmentLegFieldDrift` am Cascade-Ende. Dieser Test prüft
 * den Invariant über ECHTE Engine-Buchungen.
 *
 * Verwandte Tests:
 *   - tests/equality/consumption-leg-sum.test.ts (#441): Σ legs ==
 *     |amountCents| pro EINZELNER Tx.
 *   - dieser Test (#723):                          Σ legs ==
 *     appointment.<feld>Cents pro APPOINTMENT (über alle Legs).
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { eq } from "drizzle-orm";
import {
  getAuthCookie,
  getTodayDate,
  runCleanup,
} from "../test-utils";
import { setupBudgetScenario } from "../helpers/budget-scenarios";
import { bookConsumption } from "../helpers/budget-booking";
import { db } from "../../server/lib/db";
import { budgetTransactions } from "@shared/schema";
import { calculateAppointmentCost } from "../../server/storage/budget/appointment-cost-calculator";

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

async function getAppointmentTxs(appointmentId: number) {
  return db
    .select({
      id: budgetTransactions.id,
      type: budgetTransactions.transactionType,
      budgetType: budgetTransactions.budgetType,
      amountCents: budgetTransactions.amountCents,
      hwCents: budgetTransactions.hauswirtschaftCents,
      abCents: budgetTransactions.alltagsbegleitungCents,
      tvCents: budgetTransactions.travelCents,
      ckCents: budgetTransactions.customerKilometersCents,
    })
    .from(budgetTransactions)
    .where(eq(budgetTransactions.appointmentId, appointmentId));
}

function sumField(
  txs: Array<{ type: string; [k: string]: number | string | null }>,
  field: "hwCents" | "abCents" | "tvCents" | "ckCents",
): number {
  let s = 0;
  for (const t of txs) {
    if (t.type !== "consumption") continue;
    const v = t[field];
    if (typeof v === "number") s += v;
  }
  return s;
}

describe("Equality Σ Service-Felder == appointment-Total über alle Cascade-Legs (Task #723)", () => {
  it("§45b knapp + §45a-Cascade: Σ hwCents/abCents/tvCents/ckCents über alle Töpfe = costs.<feld>Cents", async () => {
    const auth = await getAuthCookie();
    const date = getTodayDate();
    // Setup forciert eine echte Cascade über mindestens 2 Töpfe:
    // §45b ist deaktiviert (verhindert die übliche Monats-/Carryover-
    // Akkumulation, die jeden Test-Cent absorbiert hätte), §45a hat einen
    // sehr engen Monats-Cap (1000ct), §39_42a einen kleinen Jahres-Cap
    // (2000ct). Cost wird damit zwangsweise über §45a → §39_42a → private
    // ausgespielt.
    const scenario = await setupBudgetScenario({
      customerNamePrefix: "T723-CASC",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: true,
      preferences: { budgetStartDate: "2024-01-01" },
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: false },
        { type: "umwandlung_45a", priority: 2, enabled: true, monthlyLimitCents: 1000 },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: true, yearlyLimitCents: 2000 },
      ],
    });
    try {
      const hwMinutes = 47;
      const abMinutes = 31;
      const travelKm = 7.3;
      const customerKm = 2.4;

      // Ground-Truth: wir lesen die identische Cost-Berechnung, die die
      // Engine intern verwendet, damit der Test nicht von externer
      // Preis-Konfig abhängt.
      const expected = await calculateAppointmentCost({
        customerId: scenario.customerId,
        hauswirtschaftMinutes: hwMinutes,
        alltagsbegleitungMinutes: abMinutes,
        travelKilometers: travelKm,
        customerKilometers: customerKm,
        date,
      });

      const booked = await bookConsumption({
        customerId: scenario.customerId,
        employeeId: scenario.employeeId,
        date,
        hwMinutes,
        abMinutes,
        travelKm,
        customerKm,
        userId: auth.user.id,
      });

      const txs = await getAppointmentTxs(booked.appointmentId);
      const consumptions = txs.filter(t => t.type === "consumption");
      // Pre-Condition: Cascade muss MEHRERE Legs erzeugt haben, sonst
      // testet dieser Test den Bug nicht (Single-Leg-Pfad ist von #441
      // abgedeckt).
      expect(
        consumptions.length,
        `Test-Setup deckt Cascade-Pfad nicht ab: nur ${consumptions.length} Konsum-Tx (erwartet ≥2).`,
      ).toBeGreaterThanOrEqual(2);

      // Vor #723 hatten Folge-Töpfe alle vier Felder = NULL. Mit Fix
      // sind sie auf den jeweiligen Leg-Anteil gesetzt — kein NULL mehr
      // in nachgelagerten Konsum-Tx.
      for (const tx of consumptions) {
        expect(
          tx.hwCents,
          `Tx #${tx.id} (${tx.budgetType}): hwCents=NULL trotz hwMinutes>0 — #723 Regression.`,
        ).not.toBeNull();
        expect(tx.abCents, `Tx #${tx.id} (${tx.budgetType}): abCents=NULL`).not.toBeNull();
        expect(tx.tvCents, `Tx #${tx.id} (${tx.budgetType}): tvCents=NULL`).not.toBeNull();
        expect(tx.ckCents, `Tx #${tx.id} (${tx.budgetType}): ckCents=NULL`).not.toBeNull();
      }

      const totalBooked = consumptions.reduce(
        (s, t) => s + Math.abs(t.amountCents),
        0,
      );
      expect(totalBooked).toBe(expected.totalCents);

      // KERN-Invariant (Task #723).
      expect(sumField(consumptions, "hwCents")).toBe(expected.hauswirtschaftCents);
      expect(sumField(consumptions, "abCents")).toBe(expected.alltagsbegleitungCents);
      expect(sumField(consumptions, "tvCents")).toBe(expected.travelCents);
      expect(sumField(consumptions, "ckCents")).toBe(expected.customerKilometersCents);
    } finally {
      await scenario.cleanup();
    }
  });

  it("§45b → Privatzahlung-Overflow: Σ Service-Felder über cascade + privat = costs", async () => {
    const auth = await getAuthCookie();
    const date = getTodayDate();
    // §45b deaktiviert (Akkumulation würde sonst alles absorbieren), nur
    // §45a mit sehr kleinem Monats-Cap aktiv → der Rest läuft zwangsweise
    // in den private-Overflow-Pfad und erzeugt eine zweite Tx.
    const scenario = await setupBudgetScenario({
      customerNamePrefix: "T723-PRIV",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: true,
      preferences: { budgetStartDate: "2024-01-01" },
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: false },
        { type: "umwandlung_45a", priority: 2, enabled: true, monthlyLimitCents: 500 },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
      ],
    });
    try {
      const hwMinutes = 60;
      const abMinutes = 30;
      const travelKm = 3.7;
      const customerKm = 1.9;

      const expected = await calculateAppointmentCost({
        customerId: scenario.customerId,
        hauswirtschaftMinutes: hwMinutes,
        alltagsbegleitungMinutes: abMinutes,
        travelKilometers: travelKm,
        customerKilometers: customerKm,
        date,
      });

      const booked = await bookConsumption({
        customerId: scenario.customerId,
        employeeId: scenario.employeeId,
        date,
        hwMinutes,
        abMinutes,
        travelKm,
        customerKm,
        userId: auth.user.id,
      });

      const txs = await getAppointmentTxs(booked.appointmentId);
      const consumptions = txs.filter(t => t.type === "consumption");
      expect(consumptions.length).toBeGreaterThanOrEqual(2);

      expect(sumField(consumptions, "hwCents")).toBe(expected.hauswirtschaftCents);
      expect(sumField(consumptions, "abCents")).toBe(expected.alltagsbegleitungCents);
      expect(sumField(consumptions, "tvCents")).toBe(expected.travelCents);
      expect(sumField(consumptions, "ckCents")).toBe(expected.customerKilometersCents);
    } finally {
      await scenario.cleanup();
    }
  });
});
