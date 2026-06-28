import { describe, it, expect, afterEach } from "vitest";
import { db } from "../../server/lib/db";
import { budgetTransactions } from "@shared/schema";
import { createTestCustomer, cleanupCustomer } from "../test-utils";
import { upsertBudgetTypeSettings } from "../../server/storage/budget/preferences-storage";
import { checkBudgetConservation } from "../../server/lib/budget-conservation";

// Task #1462 — Regression-Guard für die Periode-Bewusstheit der
// Budget-Konservierung (`checkBudgetConservation`).
//
// `checkBudgetConservation` MUSS die Überzogen-Aussage am übergebenen
// MONATSSTICHTAG treffen, nicht an „heute". Würde jemand den Aufruf wieder auf
// `todayISO()` zurückdrehen, wäre die Aussage für ältere/andere Zeiträume
// falsch. Dieser Test sichert direkt die SSoT-Naht ab:
// derselbe Kunde muss zu einem frühen Stichtag überzogen, zu einem späteren
// Stichtag aber sauber gemeldet werden — weil die projizierte §45b-Aufstockung
// über die Monate wächst.
//
// Der Test misst die projizierte Allocation ERST an beiden Stichtagen und bucht
// dann einen Konsum exakt dazwischen — damit ist er robust gegen die genaue
// Höhe der monatlichen §45b-Aufstockung.

const curYear = new Date().getFullYear();
const ANCHOR = `${curYear}-01-01`;
const CONSUMPTION_DATE = `${curYear}-01-15`;
// Beide Stichtage liegen in der Vergangenheit relativ zu „heute" (kein
// Future-Projektions-Edgecase).
const EARLY_AS_OF = `${curYear}-02-28`;
const LATE_AS_OF = `${curYear}-05-31`;
const POT = "entlastungsbetrag_45b";

let customerId: number | null = null;

afterEach(async () => {
  await cleanupCustomer(customerId);
  customerId = null;
});

function pot45b(
  conservation: Awaited<ReturnType<typeof checkBudgetConservation>>,
  cId: number,
) {
  const row = conservation.potRows.find(
    (r) => r.customerId === cId && r.budgetType === POT,
  );
  expect(row, "§45b-Topf muss in der Conservation-Population auftauchen").toBeDefined();
  return row!;
}

describe("Budget-Blocker sind periode-bewusst (checkBudgetConservation asOfDate)", () => {
  it("derselbe §45b-Topf flippt 'überzogen' zwischen frühem und spätem Stichtag", async () => {
    const customer = await createTestCustomer({
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      pflegegradSeit: ANCHOR,
    });
    customerId = customer.id as number;

    await upsertBudgetTypeSettings(customerId, [
      {
        budgetType: POT,
        enabled: true,
        priority: 1,
        monthlyLimitCents: null,
        yearlyLimitCents: null,
        validFrom: null,
        validTo: null,
      },
    ]);

    // (1) Projizierte Allocation OHNE Konsum an beiden Stichtagen messen.
    const earlyAllocated = pot45b(
      await checkBudgetConservation(db, EARLY_AS_OF),
      customerId,
    ).allocatedCents;
    const lateAllocated = pot45b(
      await checkBudgetConservation(db, LATE_AS_OF),
      customerId,
    ).allocatedCents;

    // §45b stockt monatlich auf ⇒ die spätere Allocation ist echt größer; nur
    // dann existiert ein Konsum, der den frühen Stichtag überzieht und den
    // späten nicht.
    expect(lateAllocated).toBeGreaterThan(earlyAllocated + 1);

    // (2) Konsum exakt zwischen früher und später Allocation buchen.
    const consumedCents = Math.floor((earlyAllocated + lateAllocated) / 2);
    expect(consumedCents).toBeGreaterThan(earlyAllocated);
    expect(consumedCents).toBeLessThan(lateAllocated);

    await db.insert(budgetTransactions).values({
      customerId,
      budgetType: POT,
      transactionDate: CONSUMPTION_DATE,
      transactionType: "consumption",
      amountCents: -consumedCents,
    });

    // (3) Kernaussage: allein der Stichtag entscheidet über „überzogen".
    const early = pot45b(await checkBudgetConservation(db, EARLY_AS_OF), customerId);
    const late = pot45b(await checkBudgetConservation(db, LATE_AS_OF), customerId);

    expect(early.overdrawn).toBe(true);
    expect(late.overdrawn).toBe(false);
  });
});
