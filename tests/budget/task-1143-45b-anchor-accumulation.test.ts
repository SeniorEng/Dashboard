/**
 * Task #1143 / #1204 — §45b-Akkumulation ab Pflegegrad-Beginn bei Neuanlage.
 *
 * Der §45b-Entlastungsbetrag (131 €/Monat) muss ab dem Pflegegrad-Beginn über
 * alle Monate des laufenden Jahres ansammeln (Pflegegrad seit 01.01., Stichtag
 * im Juni → 6 × 131 € = 786 €), NICHT nur den Stichmonat zeigen (#209).
 *
 * Seit Task #1204 gibt es KEINE gespeicherte `customer_budget_preferences`-
 * Anker-Spalte (`budget_start_date` / `budget_start_date_origin`) mehr. Der
 * Budget-Anker wird zur Laufzeit PRO TOPF aus der Pflegegrad-Historie abgeleitet:
 *   - §45a/§39: roher frühester Pflegegrad-Beginn (uncapped),
 *   - §45b: auf den 1.1. des laufenden Jahres gebodet.
 *
 * Diese Suite pinnt das beobachtbare Verhalten fest:
 *   1) Standard-Onboarding (Pflegegrad 01.01., §45b aktiv, KEIN Startwert/
 *      Override nötig) → §45b „Gesamt zugewiesen" zeigt die volle Ansammlung
 *      bis zum Stichmonat allein aus dem Laufzeit-Anker.
 *   2) Ein §45a-Startwert (eigener, roher Anker) verändert die §45b-Ansammlung
 *      NICHT — die Anker werden pro Topf unabhängig abgeleitet.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  apiGet,
  apiPost,
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
const PFLEGEGRAD_SEIT = `${YEAR}-01-01`;
// Pflegegrad seit Januar, Stichtag Mitte Juni → 6 berechtigte Monate.
const EXPECTED_FULL_ACCRUAL = STICHMONAT * MONTHLY_45B_CENTS;

interface OverviewDTO {
  entlastungsbetrag45b: { totalAllocatedCents: number };
  umwandlung45a: { currentMonthAllocatedCents: number };
}

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

async function freshCustomer(prefix: string): Promise<number> {
  const c = await createTestCustomer({
    vorname: prefix,
    nachname: `T1143_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    pflegegrad: 3,
    pflegegradSeit: PFLEGEGRAD_SEIT,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  const id = c.id as number;
  createdCustomers.push(id);
  return id;
}

async function enable45b(customerId: number, enable45a = false): Promise<void> {
  const res = await apiPut(`/api/budget/${customerId}/type-settings`, {
    settings: [
      { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
      { budgetType: "umwandlung_45a", priority: 2, enabled: enable45a, monthlyLimitCents: null },
      { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
    ],
  });
  expect(res.status, `type-settings: ${res.status} ${JSON.stringify(res.data)}`).toBe(200);
}

async function get45bAllocated(customerId: number): Promise<number> {
  const res = await apiGet<OverviewDTO>(`/api/budget/${customerId}/overview?date=${AS_OF}`);
  expect(res.status, `overview: ${res.status} ${JSON.stringify(res.data)}`).toBe(200);
  return res.data.entlastungsbetrag45b.totalAllocatedCents;
}

describe("Task #1143 — §45b-Akkumulation ab Pflegegrad-Beginn (Laufzeit-Anker)", () => {
  it("Standard-Onboarding (Pflegegrad 01.01., §45b aktiv, kein Startwert) → volle Ansammlung bis Stichmonat", async () => {
    const customerId = await freshCustomer("T1143-onboarding");
    await enable45b(customerId);

    // Kein /initial-budget, kein Anker-PUT: Der §45b-Anker wird allein aus dem
    // Pflegegrad-Beginn (01.01. laufendes Jahr) abgeleitet und auf den 1.1.
    // gebodet → 6 berechtigte Monate bis zum Stichtag Mitte Juni.
    expect(await get45bAllocated(customerId)).toBe(EXPECTED_FULL_ACCRUAL);
  }, 60_000);

  it("§45a-Startwert verändert die §45b-Ansammlung NICHT (pro-Topf-Anker)", async () => {
    const customerId = await freshCustomer("T1143-45a-independence");
    await enable45b(customerId, /* enable45a */ true);

    // Volle §45b-Ansammlung als Baseline.
    expect(await get45bAllocated(customerId)).toBe(EXPECTED_FULL_ACCRUAL);

    // §45a-Startwert (eigener, roher Anker) — darf die §45b-Akkumulation, die
    // über einen separat gebodeten Anker berechnet wird, NICHT beeinflussen.
    const res = await apiPost(
      `/api/budget/${customerId}/initial-balance/umwandlung_45a`,
      { amountCents: 31840, validFrom: `${YEAR}-0${STICHMONAT}` },
    );
    expect([200, 201]).toContain(res.status);

    // §45b unverändert: der §45a-Topf hat einen eigenen, unabhängigen Anker.
    expect(await get45bAllocated(customerId)).toBe(EXPECTED_FULL_ACCRUAL);
  }, 60_000);
});
