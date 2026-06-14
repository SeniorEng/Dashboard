/**
 * Task #1281 (Phase 2 / 2.5) — Regressions-Pin für den prod-Referenzfall
 * „1.669,55 €" §45b-Gesamtzuweisung, vollständig aus dem zur LAUFZEIT aus der
 * Pflegegrad-Historie abgeleiteten Anker (KEINE gespeicherte
 * `budget_start_date`-Spalte mehr, vgl. Task #1204).
 *
 * Prod-Referenz reproduziert synthetisch (kein echter Prod-Datensatz):
 *   166.955 ct = 88.355 ct Vorjahres-Übertrag (H2-Restguthaben)
 *              + 6 × 13.100 ct gesetzliche Monatsansammlung (Jan–Jun).
 *
 * Determinismus gegen die Monatsgrenzen-Falle: Statt sich auf den realen
 * Kalendermonat zu verlassen, wird der Allokations-SSoT
 * (`calculateAllocatedCents`, = die Anker-Ableitung, die auch der eine
 * Budget-Reader nutzt) mit fixem `asOfDate = ${YEAR}-06-15` UND
 * `projectFuture: true` aufgerufen. So ist der Horizont (Juni) unabhängig vom
 * realen Lauf-Monat exakt 6 Monate ab dem auf den 1.1. gebodeten Anker.
 * Alle Datums-Anker leiten sich aus EINEM einmalig berechneten `YEAR` ab.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../server/lib/db";
import {
  calculateAllocatedCents,
  upsertCarryoverAllocation,
} from "../../server/storage/budget/allocation-storage";
import {
  apiPut,
  cleanupCustomer,
  createTestCustomer,
  getAuthCookie,
  runCleanup,
} from "../test-utils";

const YEAR = new Date().getFullYear();
const MONTHLY_45B_CENTS = 13100;
const STICHMONAT = 6; // Juni
const AS_OF = `${YEAR}-0${STICHMONAT}-15`;
// Pflegegrad seit Februar des Vorjahres → Anker wird §45b-seitig auf den 1.1.
// des laufenden Jahres gebodet (Vorjahr gilt als aufgebraucht, Task #860).
const PFLEGEGRAD_SEIT = `${YEAR - 1}-02-01`;

// Vorjahres-Restguthaben (H2) als Übertrag ins laufende Jahr.
const CARRYOVER_CENTS = 88355;
// Gesetzliche Ansammlung Jan–Jun (6 Monate × 131 €).
const STATUTORY_ACCRUAL_CENTS = STICHMONAT * MONTHLY_45B_CENTS; // 78.600
// Prod-Referenz „1.669,55 €".
const EXPECTED_TOTAL_CENTS = CARRYOVER_CENTS + STATUTORY_ACCRUAL_CENTS; // 166.955

const createdCustomers: number[] = [];

beforeAll(async () => {
  await getAuthCookie();
});

afterEach(async () => {
  while (createdCustomers.length) {
    await cleanupCustomer(createdCustomers.pop());
  }
});

afterAll(async () => {
  await runCleanup();
});

async function getActorUserId(): Promise<number> {
  const rows = await db.execute(
    /* sql */ `SELECT id FROM users ORDER BY id ASC LIMIT 1`,
  );
  const r = (rows as { rows: Array<{ id: number }> }).rows;
  if (!r[0]) throw new Error("Kein User für Audit-Akteur verfügbar");
  return r[0].id;
}

async function freshCustomer(): Promise<number> {
  const c = await createTestCustomer({
    vorname: "T1281",
    nachname: `AnchorAccrual_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    pflegegrad: 2,
    pflegegradSeit: PFLEGEGRAD_SEIT,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  const id = c.id as number;
  createdCustomers.push(id);
  return id;
}

async function enable45b(customerId: number): Promise<void> {
  // Kein explizites validFrom → §45b-Zeile wird mit validFrom = NULL angelegt
  // („gilt rückwirkend ab Beginn"), verschiebt den Anker also NICHT auf heute.
  const res = await apiPut(`/api/budget/${customerId}/type-settings`, {
    settings: [
      { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
      { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
      { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
    ],
  });
  expect(res.status, `type-settings: ${res.status} ${JSON.stringify(res.data)}`).toBe(200);
}

describe("Task #1281 — §45b-Anker aus Pflegegrad-Historie (Prod-Referenz 1.669,55 €)", () => {
  it("reproduziert 166.955 ct = 88.355 ct Übertrag + 6 × 13.100 ct Laufzeit-Ansammlung", async () => {
    const userId = await getActorUserId();
    const customerId = await freshCustomer();
    await enable45b(customerId);

    // Vorjahres-Restguthaben als Übertrag: sourceYear = YEAR-1 → Zieljahr YEAR,
    // validFrom = ${YEAR}-01-01, expiresAt = ${YEAR}-06-30 (zählt im Stichtag
    // Mitte Juni voll mit).
    await upsertCarryoverAllocation(
      { customerId, budgetType: "entlastungsbetrag_45b", sourceYear: YEAR - 1, amountCents: CARRYOVER_CENTS },
      userId,
    );

    // Anker-Ableitung deterministisch über fixen Horizont (Juni) ansteuern.
    const allocated = await calculateAllocatedCents(
      customerId,
      "entlastungsbetrag_45b",
      { asOfDate: AS_OF, projectFuture: true },
    );

    expect(allocated).toBe(EXPECTED_TOTAL_CENTS);
    // Defense-in-Depth: explizit gegen die Prod-Referenz 166.955 ct (1.669,55 €).
    expect(allocated).toBe(166955);
  }, 60_000);
});
