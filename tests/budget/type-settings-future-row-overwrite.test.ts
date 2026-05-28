/**
 * Task #754 — BUG-13: PUT `/type-settings` ohne `validFrom` auf eine offene
 * Zeile mit zukünftigem `validFrom` muss die Zeile auf den heutigen Tag
 * vorziehen, damit die neuen Werte SOFORT aktiv werden.
 *
 * Reproducer (E2E-Protokoll 2026-05-28, Block C):
 *   1) PUT mit `validFrom = today + 30` → offene Zeile mit Zukunftsdatum.
 *   2) PUT OHNE `validFrom` mit anderen Werten → vor dem Fix blieb
 *      `validFrom = today + 30` erhalten, sodass `getActiveBudgetTypeSettings
 *      (today)` keine aktive §45a-Zeile lieferte und `monthly_auto` keine
 *      Allocation für den laufenden Monat erzeugte.
 *
 * Erwartung nach Fix: nach Schritt 2 hat die Zeile `validFrom <= today` und
 * trägt die neuen Werte; explizites validFrom hat weiterhin Vorrang.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { customerBudgetTypeSettings } from "@shared/schema";
import { addDays, todayISO } from "@shared/utils/datetime";
import {
  getActiveBudgetTypeSettings,
  upsertBudgetTypeSettings,
} from "../../server/storage/budget/preferences-storage";
import { createTestCustomer, getAuthCookie, runCleanup } from "../test-utils";

const ORIGINAL_TZ = process.env.TZ;

beforeAll(async () => {
  process.env.TZ = "Europe/Berlin";
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

async function actorId(): Promise<number> {
  const rows = await db.execute(/* sql */ `SELECT id FROM users ORDER BY id ASC LIMIT 1`);
  const r = (rows as { rows: Array<{ id: number }> }).rows;
  if (!r[0]) throw new Error("Kein User für Audit-Akteur verfügbar");
  return r[0].id;
}

async function listPhases(customerId: number, budgetType: string) {
  return db
    .select()
    .from(customerBudgetTypeSettings)
    .where(eq(customerBudgetTypeSettings.customerId, customerId))
    .orderBy(asc(customerBudgetTypeSettings.validFrom), asc(customerBudgetTypeSettings.id))
    .then(rows => rows.filter(r => r.budgetType === budgetType));
}

describe("Task #754 BUG-13 — PUT ohne validFrom auf Zukunfts-Zeile zieht vor", () => {
  it("ohne validFrom → Zukunfts-Zeile wird auf today vorgezogen, neue Werte sofort aktiv", async () => {
    const c = await createTestCustomer({
      vorname: "T754-BUG13",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
    });
    const customerId = c.id as number;
    const userId = await actorId();
    const today = todayISO();
    const future = addDays(today, 30);

    // Schritt 1: Zukunfts-Zeile anlegen (Phasen-Append-Pfad).
    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 10000, validFrom: future }],
      undefined,
      userId,
    );

    // Schritt 2: PUT OHNE validFrom mit anderem Limit. Erwartung: gleiche
    // Zeile, aber validFrom <= today, Limit = 22222.
    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 22222 }],
      undefined,
      userId,
    );

    const phases = await listPhases(customerId, "umwandlung_45a");
    expect(phases).toHaveLength(1);
    expect(phases[0].monthlyLimitCents).toBe(22222);
    expect(phases[0].validFrom).not.toBeNull();
    expect(phases[0].validFrom! <= today).toBe(true);
    expect(phases[0].validTo).toBeNull();

    // Read-Pfad: heute liefert die §45a-Zeile mit dem NEUEN Limit.
    const active = await getActiveBudgetTypeSettings(customerId, today);
    const row = active.find(r => r.budgetType === "umwandlung_45a");
    expect(row).toBeDefined();
    expect(row!.monthlyLimitCents).toBe(22222);
  }, 60_000);

  it("ohne validFrom auf same-day-Zeile (nicht zukünftig) bleibt validFrom unverändert", async () => {
    const c = await createTestCustomer({
      vorname: "T754-BUG13-SD",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
    });
    const customerId = c.id as number;
    const userId = await actorId();
    const today = todayISO();

    // Erstanlage ohne validFrom → NULL-Baseline (rückwirkend).
    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 10000 }],
      undefined,
      userId,
    );

    // Edit ohne validFrom → in-place, validFrom bleibt NULL (kein
    // Pull-Forward, weil oldValidFrom != "in Zukunft").
    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 15000 }],
      undefined,
      userId,
    );

    const phases = await listPhases(customerId, "umwandlung_45a");
    expect(phases).toHaveLength(1);
    expect(phases[0].validFrom).toBeNull();
    expect(phases[0].monthlyLimitCents).toBe(15000);

    const active = await getActiveBudgetTypeSettings(customerId, today);
    expect(active.find(r => r.budgetType === "umwandlung_45a")?.monthlyLimitCents).toBe(15000);
  }, 60_000);

  it("explizites validFrom im Payload überschreibt den Pull-Forward NICHT", async () => {
    const c = await createTestCustomer({
      vorname: "T754-BUG13-EXP",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
    });
    const customerId = c.id as number;
    const userId = await actorId();
    const today = todayISO();
    const future1 = addDays(today, 30);
    const future2 = addDays(today, 60);

    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 10000, validFrom: future1 }],
      undefined,
      userId,
    );
    // Explizites zweites Zukunftsdatum → Phasen-Append, NICHT Pull-Forward.
    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 20000, validFrom: future2 }],
      undefined,
      userId,
    );

    const phases = await listPhases(customerId, "umwandlung_45a");
    expect(phases).toHaveLength(2);
    expect(phases.map(p => p.validFrom)).toEqual([future1, future2]);
  }, 60_000);
});
