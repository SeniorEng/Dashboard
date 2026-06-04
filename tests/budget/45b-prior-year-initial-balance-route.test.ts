/**
 * Task #970 — End-to-end Guard: §45b-Startwert aus einem Vorjahr wird vom
 * HTTP-Route + DB-Pfad abgelehnt (POST `/api/budget/:cid/initial-balance/:type`,
 * Code `BUDGET_45B_PRIOR_YEAR_INITIAL_BALANCE`).
 *
 * Task #964 hat den reinen Validator
 * (`validate45bInitialBalanceNotPriorYear`) eingeführt und unit-getestet.
 * Diese Suite pinnt das tatsächliche Wire-Verhalten der Route fest:
 *
 *   1) §45b + Vorjahres-`validFrom`  → 400, deutscher "Übertrag aus Vorjahr"-
 *      Hinweis, KEINE Allokation angelegt.
 *   2) §45b + aktuelles-Jahr-`validFrom` → Erfolg (Allokation entsteht).
 *   3) §45a + Vorjahres-`validFrom`  → akzeptiert (Guard ist §45b-only).
 *   4) §39/§42a + Vorjahres-`validFrom` → akzeptiert (Guard ist §45b-only).
 *   5) Direkter Storage-Layer-Write (Migration/Korrektur) akzeptiert weiterhin
 *      eine §45b-Vorjahres-Zeile — KEIN harter Storage-Wall.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetAllocations } from "@shared/schema";
import { upsertInitialBalanceAllocation } from "../../server/storage/budget/allocation-storage";
import {
  apiPost,
  createTestCustomer,
  getAuthCookie,
  runCleanup,
} from "../test-utils";

const CURRENT_YEAR = new Date().getFullYear();
const PRIOR_YEAR = CURRENT_YEAR - 1;
const PRIOR_YEAR_VALID_FROM = `${PRIOR_YEAR}-03`;
const CURRENT_YEAR_VALID_FROM = `${CURRENT_YEAR}-03`;

beforeAll(async () => {
  await getAuthCookie();
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

async function freshCustomer(prefix: string): Promise<number> {
  const c = await createTestCustomer({
    vorname: prefix,
    nachname: `T970_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    pflegegrad: 3,
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

describe("Task #970 — §45b Vorjahres-Startwert via Route abgelehnt", () => {
  it("§45b + Vorjahres-validFrom → 400 mit 'Übertrag aus Vorjahr'-Hinweis, keine Allokation", async () => {
    const customerId = await freshCustomer("T970-45b-prior");

    const res = await apiPost<{ code?: string; message?: string }>(
      `/api/budget/${customerId}/initial-balance/entlastungsbetrag_45b`,
      { amountCents: 13_100, validFrom: PRIOR_YEAR_VALID_FROM },
    );

    expect(res.status).toBe(400);
    expect(res.data.code).toBe("BUDGET_45B_PRIOR_YEAR_INITIAL_BALANCE");
    expect(res.data.message).toContain("Übertrag aus dem Vorjahr");

    // Es darf KEINE Startwert-Allokation entstanden sein.
    const rows = await getInitialBalances(customerId, "entlastungsbetrag_45b");
    expect(rows.length).toBe(0);
  });

  it("§45b + aktuelles-Jahr-validFrom → Erfolg, Allokation wird angelegt", async () => {
    const customerId = await freshCustomer("T970-45b-current");

    const res = await apiPost(
      `/api/budget/${customerId}/initial-balance/entlastungsbetrag_45b`,
      { amountCents: 13_100, validFrom: CURRENT_YEAR_VALID_FROM },
    );

    expect([200, 201]).toContain(res.status);

    const rows = await getInitialBalances(customerId, "entlastungsbetrag_45b");
    expect(rows.length).toBe(1);
    expect(rows[0].year).toBe(CURRENT_YEAR);
    expect(rows[0].month).toBe(3);
    expect(rows[0].amountCents).toBe(13_100);
  });

  it("§45a + Vorjahres-validFrom → akzeptiert (Guard ist §45b-only)", async () => {
    const customerId = await freshCustomer("T970-45a-prior");

    const res = await apiPost(
      `/api/budget/${customerId}/initial-balance/umwandlung_45a`,
      { amountCents: 25_000, validFrom: PRIOR_YEAR_VALID_FROM },
    );

    expect([200, 201]).toContain(res.status);

    const rows = await getInitialBalances(customerId, "umwandlung_45a");
    expect(rows.length).toBe(1);
    expect(rows[0].year).toBe(PRIOR_YEAR);
    expect(rows[0].month).toBe(3);
  });

  it("§39/§42a + Vorjahres-validFrom → akzeptiert (Guard ist §45b-only)", async () => {
    const customerId = await freshCustomer("T970-39-prior");

    const res = await apiPost(
      `/api/budget/${customerId}/initial-balance/ersatzpflege_39_42a`,
      { amountCents: 150_000, validFrom: PRIOR_YEAR_VALID_FROM },
    );

    expect([200, 201]).toContain(res.status);

    const rows = await getInitialBalances(customerId, "ersatzpflege_39_42a");
    expect(rows.length).toBe(1);
    expect(rows[0].year).toBe(PRIOR_YEAR);
    expect(rows[0].month).toBe(3);
  });

  it("Direkter Storage-Write akzeptiert §45b-Vorjahres-Zeile (kein harter Wall)", async () => {
    const userId = await getActorUserId();
    const customerId = await freshCustomer("T970-storage-prior");

    await upsertInitialBalanceAllocation(
      {
        customerId,
        budgetType: "entlastungsbetrag_45b",
        year: PRIOR_YEAR,
        month: 3,
        amountCents: 13_100,
        validFrom: `${PRIOR_YEAR}-03-01`,
        expiresAt: null,
        notes: "Migration/Korrektur Vorjahres-Startwert",
      },
      userId,
    );

    const rows = await getInitialBalances(customerId, "entlastungsbetrag_45b");
    expect(rows.length).toBe(1);
    expect(rows[0].year).toBe(PRIOR_YEAR);
    expect(rows[0].amountCents).toBe(13_100);
  });
});
