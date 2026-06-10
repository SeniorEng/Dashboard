/**
 * Task #1143 — §45b-Akkumulation ab Pflegegrad-Beginn bei Neuanlage.
 *
 * Der §45b-Entlastungsbetrag (131 €/Monat) muss ab dem Pflegegrad-Beginn über
 * alle Monate des laufenden Jahres ansammeln (Pflegegrad seit 01.01., Anlage im
 * Juni → 6 × 131 € = 786 €), NICHT nur den Stichmonat zeigen (#209).
 *
 * Wurzel: Der kunden-weite `budget_start_date` wird von ALLEN Töpfen gelesen
 * (§45a/§39 roh, §45b origin-aware gekappt). Schrieb der generische Startwert-
 * Editor (`POST /:cid/initial-balance/:type`) den Anker ohne
 * `budget_start_date_origin`, blieb die Spalte NULL — der §45b-Lesepfad konnte
 * weder den Jan-1-Floor noch den Pflegegrad-Fallback nutzen und pinnte das
 * §45b-Budget auf den Stichmonat.
 *
 * Diese Suite pinnt fest:
 *   1) Standard-Onboarding (Pflegegrad 01.01., kein Startwert/Override) →
 *      §45b „Gesamt zugewiesen" zeigt die volle Ansammlung bis zum Stichmonat.
 *   2) `POST initial-balance` (§45b) schreibt den Anker mit Origin
 *      'derived_pflegegrad' und überschreibt einen manuellen Anker NICHT.
 *   3) Wird der §45b-Startwert gelöscht, wird der Anker neu aus dem Pflegegrad-
 *      Beginn abgeleitet und die volle Ansammlung kehrt zurück.
 *   4) §45a/§39 bleiben unberührt (Cap ist §45b-spezifisch, Anker bleibt roh).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  apiDelete,
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

interface PrefsDTO {
  budgetStartDate: string | null;
  budgetStartDateOrigin: string | null;
}
interface OverviewDTO {
  entlastungsbetrag45b: { totalAllocatedCents: number };
  umwandlung45a: { currentMonthAllocatedCents: number };
}
interface AllocationDTO {
  id: number;
  budgetType: string;
  source: string;
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

async function enable45b(customerId: number): Promise<void> {
  const res = await apiPut(`/api/budget/${customerId}/type-settings`, {
    settings: [
      { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
      { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
      { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
    ],
  });
  expect(res.status, `type-settings: ${res.status} ${JSON.stringify(res.data)}`).toBe(200);
}

async function getPrefs(customerId: number): Promise<PrefsDTO> {
  const res = await apiGet<PrefsDTO>(`/api/budget/${customerId}/preferences`);
  expect(res.status).toBe(200);
  return res.data;
}

async function get45bAllocated(customerId: number): Promise<number> {
  const res = await apiGet<OverviewDTO>(`/api/budget/${customerId}/overview?date=${AS_OF}`);
  expect(res.status, `overview: ${res.status} ${JSON.stringify(res.data)}`).toBe(200);
  return res.data.entlastungsbetrag45b.totalAllocatedCents;
}

describe("Task #1143 — §45b-Akkumulation ab Pflegegrad-Beginn", () => {
  it("Standard-Onboarding (Pflegegrad 01.01., kein Startwert) → volle Ansammlung bis Stichmonat", async () => {
    const customerId = await freshCustomer("T1143-onboarding");
    await enable45b(customerId);

    // Wizard-Pfad: §45b-Anker setzen (origin 'derived_pflegegrad'), KEIN
    // Startwert (currentMonthAmountCents=0, Task #960).
    const res = await apiPost(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentMonthAmountCents: 0,
      carryoverAmountCents: 0,
      budgetStartDate: PFLEGEGRAD_SEIT,
    });
    expect(res.status, `initial-budget: ${res.status} ${JSON.stringify(res.data)}`).toBe(201);

    const prefs = await getPrefs(customerId);
    expect(prefs.budgetStartDateOrigin).toBe("derived_pflegegrad");

    expect(await get45bAllocated(customerId)).toBe(EXPECTED_FULL_ACCRUAL);
  }, 60_000);

  it("POST initial-balance (§45b) schreibt Anker mit Origin 'derived_pflegegrad'", async () => {
    const customerId = await freshCustomer("T1143-origin");
    await enable45b(customerId);

    const res = await apiPost(
      `/api/budget/${customerId}/initial-balance/entlastungsbetrag_45b`,
      { amountCents: MONTHLY_45B_CENTS, validFrom: `${YEAR}-0${STICHMONAT}` },
    );
    expect([200, 201]).toContain(res.status);

    const prefs = await getPrefs(customerId);
    expect(prefs.budgetStartDate).toBe(`${YEAR}-0${STICHMONAT}-01`);
    expect(prefs.budgetStartDateOrigin).toBe("derived_pflegegrad");
  }, 60_000);

  it("POST initial-balance (§45b) überschreibt einen manuellen Anker NICHT", async () => {
    const customerId = await freshCustomer("T1143-manual");
    await enable45b(customerId);

    // Bewusst gesetzter manueller Anker (origin 'manual').
    const manualDate = `${YEAR}-05-01`;
    const putRes = await apiPut(`/api/budget/${customerId}/preferences`, {
      budgetStartDate: manualDate,
    });
    expect(putRes.status).toBe(200);
    expect((await getPrefs(customerId)).budgetStartDateOrigin).toBe("manual");

    // Startwert mit FRÜHEREM validFrom (würde den Anker normalerweise nach vorne
    // ziehen) — der manuelle Anker muss gewinnen.
    const res = await apiPost(
      `/api/budget/${customerId}/initial-balance/entlastungsbetrag_45b`,
      { amountCents: MONTHLY_45B_CENTS, validFrom: `${YEAR}-02` },
    );
    expect([200, 201]).toContain(res.status);

    const prefs = await getPrefs(customerId);
    expect(prefs.budgetStartDate).toBe(manualDate);
    expect(prefs.budgetStartDateOrigin).toBe("manual");
  }, 60_000);

  it("Löschen des §45b-Startwerts leitet den Anker neu aus dem Pflegegrad-Beginn ab", async () => {
    const customerId = await freshCustomer("T1143-delete");
    await enable45b(customerId);

    // Startwert im Stichmonat pinnt den (zuvor NULL-)Anker auf Juni.
    const postRes = await apiPost<AllocationDTO[]>(
      `/api/budget/${customerId}/initial-balance/entlastungsbetrag_45b`,
      { amountCents: MONTHLY_45B_CENTS, validFrom: `${YEAR}-0${STICHMONAT}` },
    );
    expect([200, 201]).toContain(postRes.status);
    expect((await getPrefs(customerId)).budgetStartDate).toBe(`${YEAR}-0${STICHMONAT}-01`);

    const allocId = postRes.data.find(
      a => a.budgetType === "entlastungsbetrag_45b" && a.source === "initial_balance",
    )?.id;
    expect(allocId, "Startwert-Allokation nicht gefunden").toBeTypeOf("number");

    const delRes = await apiDelete(
      `/api/budget/${customerId}/initial-balance/${allocId}`,
    );
    expect(delRes.status).toBe(200);

    // Anker neu aus Pflegegrad-Beginn abgeleitet → volle Ansammlung zurück.
    const prefs = await getPrefs(customerId);
    expect(prefs.budgetStartDate).toBe(PFLEGEGRAD_SEIT);
    expect(prefs.budgetStartDateOrigin).toBe("derived_pflegegrad");
    expect(await get45bAllocated(customerId)).toBe(EXPECTED_FULL_ACCRUAL);
  }, 60_000);

  it("§45a-Startwert bleibt unberührt: kein §45b-Origin-Stempel, voller Betrag", async () => {
    const customerId = await freshCustomer("T1143-45a");

    // §45a-Startwert (uncapped) — darf den kunden-weiten Anker NICHT mit einem
    // §45b-Origin-Stempel versehen.
    const res = await apiPost(
      `/api/budget/${customerId}/initial-balance/umwandlung_45a`,
      { amountCents: 31840, validFrom: `${YEAR}-0${STICHMONAT}` },
    );
    expect([200, 201]).toContain(res.status);

    const prefs = await getPrefs(customerId);
    // §45a schreibt den §45b-spezifischen Anker-Origin nicht.
    expect(prefs.budgetStartDateOrigin).not.toBe("derived_pflegegrad");
  }, 60_000);
});
