/**
 * Task #703 — `getLatestBudgetTypeSettingsWithTransition` liefert pro Topf
 * neben der Latest-Intent-Zeile eine `effectiveToday`-Momentaufnahme, sobald
 * eine ältere Vorgänger-Zeile den heutigen Tag noch abdeckt (nahtloser
 * GoBD-Übergang). Das ist die Datengrundlage, mit der das UI das irreführende
 * „Noch nicht aktiv (ab MORGEN gültig)"-Banner unterdrückt.
 *
 * Drei Szenarien:
 *   (a) Transition heute: alte Zeile validTo=heute, neue Zeile validFrom=morgen
 *       → effectiveToday referenziert die alte Zeile, latest-intent ist die neue.
 *   (b) Echter Future-Start: einzige Zeile mit validFrom > heute
 *       → effectiveToday = null, Banner erscheint.
 *   (c) Abgelaufen: einzige Zeile mit validTo < heute
 *       → effectiveToday = null, Banner erscheint.
 */
// @ts-nocheck

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { customerBudgetTypeSettings } from "@shared/schema";
import { addDays, todayISO } from "@shared/utils/datetime";
import {
  getLatestBudgetTypeSettingsWithTransition,
  upsertBudgetTypeSettings,
} from "../../server/storage/budget/preferences-storage";
import {
  createTestCustomer,
  getAuthCookie,
  runCleanup,
} from "../test-utils";

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
    nachname: `T703_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    pflegegrad: 3,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  return c.id as number;
}

describe("Task #703 — getLatestBudgetTypeSettingsWithTransition", () => {
  it("(a) Transition: alte Zeile deckt heute ab → effectiveToday gesetzt auf alte Werte, latest-intent = neue Zeile", async () => {
    const customerId = await freshCustomer("T703-TRANS");
    const userId = await getActorUserId();

    // Initialer Save → eine offene Zeile mit validFrom=null (rückwirkend gültig).
    await upsertBudgetTypeSettings(
      customerId,
      [
        { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: 8000 },
      ],
      undefined,
      userId,
    );

    // Erste Zeile "altern" lassen, damit der nächste Save als echte Transition
    // erkannt wird (createdAt < heute). Wir setzen createdAt zwei Tage zurück.
    const before = await db.select().from(customerBudgetTypeSettings).where(eq(customerBudgetTypeSettings.customerId, customerId));
    expect(before).toHaveLength(1);
    await db.execute(
      /* sql */ `UPDATE customer_budget_type_settings SET created_at = now() - interval '2 days' WHERE id = ${before[0].id}`,
    );

    // Zweiter Save mit anderem Limit → Transition: alte Zeile validTo=heute,
    // neue Zeile validFrom=morgen.
    await upsertBudgetTypeSettings(
      customerId,
      [
        { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: 12000 },
      ],
      undefined,
      userId,
    );

    const result = await getLatestBudgetTypeSettingsWithTransition(customerId);
    expect(result).toHaveLength(1);
    const row = result[0];
    // Latest-Intent ist die neue Zeile (gilt ab morgen).
    expect(row.validFrom).toBe(addDays(todayISO(), 1));
    expect(row.monthlyLimitCents).toBe(12000);
    // effectiveToday referenziert die alte Zeile (deckt heute noch ab).
    expect(row.effectiveToday).not.toBeNull();
    expect(row.effectiveToday!.validTo).toBe(todayISO());
    expect(row.effectiveToday!.monthlyLimitCents).toBe(8000);
  });

  it("(b) Echter Future-Start ohne Vorgänger → effectiveToday = null", async () => {
    const customerId = await freshCustomer("T703-FUTURE");
    const userId = await getActorUserId();

    // Eine Zeile mit Future-validFrom, kein heute-aktiver Vorgänger.
    await upsertBudgetTypeSettings(
      customerId,
      [
        {
          budgetType: "entlastungsbetrag_45b",
          enabled: true,
          priority: 1,
          monthlyLimitCents: 10000,
          validFrom: addDays(todayISO(), 14),
        },
      ],
      undefined,
      userId,
    );

    const result = await getLatestBudgetTypeSettingsWithTransition(customerId);
    expect(result).toHaveLength(1);
    expect(result[0].validFrom).toBe(addDays(todayISO(), 14));
    expect(result[0].effectiveToday).toBeNull();
  });

  it("(c) Abgelaufen (validTo in der Vergangenheit) → effectiveToday = null", async () => {
    const customerId = await freshCustomer("T703-EXPIRED");
    const userId = await getActorUserId();

    // Setup: eine offene Zeile, dann manuell auf abgelaufenes Intervall setzen
    // (validFrom & validTo in der Vergangenheit). upsertBudgetTypeSettings
    // bietet dafür keine direkte API — wir schreiben die Datums direkt.
    await upsertBudgetTypeSettings(
      customerId,
      [
        { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: 5000 },
      ],
      undefined,
      userId,
    );
    const rows = await db.select().from(customerBudgetTypeSettings).where(eq(customerBudgetTypeSettings.customerId, customerId));
    expect(rows).toHaveLength(1);
    await db.execute(
      /* sql */ `UPDATE customer_budget_type_settings SET valid_from = '2024-01-01', valid_to = '2024-06-30' WHERE id = ${rows[0].id}`,
    );

    const result = await getLatestBudgetTypeSettingsWithTransition(customerId);
    expect(result).toHaveLength(1);
    expect(result[0].validTo).toBe("2024-06-30");
    // Keine heute-aktive Zeile → effectiveToday muss null sein, damit das UI
    // das „Abgelaufen"-Banner zeigt.
    expect(result[0].effectiveToday).toBeNull();
  });
});
