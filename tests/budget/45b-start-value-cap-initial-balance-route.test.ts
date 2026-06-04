/**
 * Task #971 — End-to-end Guard: Ein überhöhter §45b-Startwert wird vom
 * Admin-Startwert-Editor (POST `/api/budget/:cid/initial-balance/:type`)
 * abgelehnt (Code `BUDGET_45B_START_VALUE_EXCEEDED`), konsistent zum
 * `/initial-budget`-Pfad (Task #959).
 *
 * Der §45b-Startwert (`initial_balance`) darf höchstens (berechtigte Monate ab
 * Accrual-Anker bis Startmonat) × 131 € betragen. Die Testkunden haben
 * `pflegegradSeit` im Vorjahr/früher → Accrual-Anker < Startjahr →
 * Cap = Startmonat × 131 €.
 *
 *   1) §45b + Betrag über Cap  → 400, deutscher Hinweis, KEINE Allokation.
 *   2) §45b + Betrag exakt am Cap → Erfolg (Allokation entsteht).
 *   3) §45a + identisch hoher Betrag → akzeptiert (Cap ist §45b-only).
 *   4) §39/§42a + identisch hoher Betrag → akzeptiert (Cap ist §45b-only).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetAllocations } from "@shared/schema";
import { BUDGET_45B_MAX_MONTHLY_CENTS } from "@shared/domain/budgets";
import {
  apiPost,
  createTestCustomer,
  getAuthCookie,
  runCleanup,
} from "../test-utils";

const CURRENT_YEAR = new Date().getFullYear();
const START_MONTH = 3;
const VALID_FROM = `${CURRENT_YEAR}-0${START_MONTH}`;
// Accrual-Anker liegt vor dem Startjahr (createTestCustomer → pflegegradSeit
// "2024-01-01"), daher Cap = Startmonat × Monatsaufstockung.
const CAP_CENTS = START_MONTH * BUDGET_45B_MAX_MONTHLY_CENTS;
const OVER_CAP_CENTS = CAP_CENTS + 1;

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

async function freshCustomer(prefix: string): Promise<number> {
  const c = await createTestCustomer({
    vorname: prefix,
    nachname: `T971_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    pflegegrad: 3,
    pflegegradSeit: "2024-01-01",
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  return c.id as number;
}

async function getInitialBalances(customerId: number, budgetType: string) {
  return db
    .select()
    .from(budgetAllocations)
    .where(
      and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.budgetType, budgetType),
        eq(budgetAllocations.source, "initial_balance"),
        isNull(budgetAllocations.deletedAt),
      ),
    );
}

describe("Task #971 — §45b überhöhter Startwert via Route abgelehnt", () => {
  it("§45b + Betrag über Cap → 400 mit Cap-Hinweis, keine Allokation", async () => {
    const customerId = await freshCustomer("T971-45b-over");

    const res = await apiPost<{ code?: string; message?: string }>(
      `/api/budget/${customerId}/initial-balance/entlastungsbetrag_45b`,
      { amountCents: OVER_CAP_CENTS, validFrom: VALID_FROM },
    );

    expect(res.status).toBe(400);
    expect(res.data.code).toBe("BUDGET_45B_START_VALUE_EXCEEDED");
    expect(res.data.message).toContain("höchstens");

    const rows = await getInitialBalances(customerId, "entlastungsbetrag_45b");
    expect(rows.length).toBe(0);
  });

  it("§45b + Betrag exakt am Cap → Erfolg, Allokation wird angelegt", async () => {
    const customerId = await freshCustomer("T971-45b-atcap");

    const res = await apiPost(
      `/api/budget/${customerId}/initial-balance/entlastungsbetrag_45b`,
      { amountCents: CAP_CENTS, validFrom: VALID_FROM },
    );

    expect([200, 201]).toContain(res.status);

    const rows = await getInitialBalances(customerId, "entlastungsbetrag_45b");
    expect(rows.length).toBe(1);
    expect(rows[0].amountCents).toBe(CAP_CENTS);
  });

  it("§45a + identisch hoher Betrag → akzeptiert (Cap ist §45b-only)", async () => {
    const customerId = await freshCustomer("T971-45a-over");

    const res = await apiPost(
      `/api/budget/${customerId}/initial-balance/umwandlung_45a`,
      { amountCents: OVER_CAP_CENTS, validFrom: VALID_FROM },
    );

    expect([200, 201]).toContain(res.status);

    const rows = await getInitialBalances(customerId, "umwandlung_45a");
    expect(rows.length).toBe(1);
    expect(rows[0].amountCents).toBe(OVER_CAP_CENTS);
  });

  it("§39/§42a + identisch hoher Betrag → akzeptiert (Cap ist §45b-only)", async () => {
    const customerId = await freshCustomer("T971-39-over");

    const res = await apiPost(
      `/api/budget/${customerId}/initial-balance/ersatzpflege_39_42a`,
      { amountCents: OVER_CAP_CENTS, validFrom: VALID_FROM },
    );

    expect([200, 201]).toContain(res.status);

    const rows = await getInitialBalances(customerId, "ersatzpflege_39_42a");
    expect(rows.length).toBe(1);
    expect(rows[0].amountCents).toBe(OVER_CAP_CENTS);
  });
});
