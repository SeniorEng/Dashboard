/**
 * Task #1169 — Budget-Einstellungen revisionssicher historisieren (GoBD).
 *
 * GoBD-Anforderung: "Welches Budget-Limit galt an Tag X?" muss jederzeit
 * rekonstruierbar sein. Diese Suite pinnt die im Audit beschriebene
 * 3-Schritt-Sequenz gegen den aktuellen Code:
 *
 *   1) Ausgangszeile (z.B. §39/§42a) mit offenem `validFrom` (in Kraft).
 *   2) PUT mit ZUKÜNFTIGEM `validFrom` schließt die Alt-Zeile
 *      (`validTo = validFrom_neu - 1`) und legt eine neue Zeile an — die
 *      Alt-Zeile bleibt erhalten (KEIN DELETE / KEINE Umdatierung).
 *   3) PUT OHNE `validFrom` wird als NEUER Versionssatz „ab heute" angelegt,
 *      NICHT als Umdatierung der bestehenden (Zukunfts-)Zeile. Die geplante
 *      Zukunftsphase bleibt unangetastet, und `forDate(vergangenheit)` liefert
 *      weiterhin die historische Vorgängerzeile.
 *
 * Abgrenzung zu BUG-13 (Task #754): Liegt KEINE bereits in Kraft befindliche
 * Vorgängerphase vor (einzige Zeile ist zukunftsdatiert), bleibt der
 * Pull-Forward erhalten — das deckt `type-settings-future-row-overwrite.test.ts`
 * ab und wird hier zusätzlich als Abgrenzung mitgeprüft.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { auditLog, customerBudgetTypeSettings } from "@shared/schema";
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

async function freshCustomer(prefix: string): Promise<number> {
  const c = await createTestCustomer({
    vorname: prefix,
    nachname: `T1169_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    pflegegrad: 3,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  return c.id as number;
}

async function listPhases(customerId: number, budgetType: string) {
  return db
    .select()
    .from(customerBudgetTypeSettings)
    .where(eq(customerBudgetTypeSettings.customerId, customerId))
    .orderBy(asc(customerBudgetTypeSettings.validFrom), asc(customerBudgetTypeSettings.id))
    .then(rows => rows.filter(r => r.budgetType === budgetType));
}

describe("Task #1169 — Settings revisionssicher (Audit-3-Schritt-Sequenz)", () => {
  it("Schritt 1→3: Baseline → Zukunfts-Phase → PUT ohne validFrom = neuer Versionssatz ab heute (Zukunftsphase bleibt, kein Overlap)", async () => {
    const customerId = await freshCustomer("T1169-SEQ");
    const userId = await actorId();
    const today = todayISO();
    const future = addDays(today, 30);
    const BUDGET = "ersatzpflege_39_42a";

    // Schritt 1: Ausgangszeile mit offenem validFrom (bereits in Kraft).
    // Wir setzen die Baseline direkt mit einem Vergangenheits-validFrom auf,
    // damit sie als "in Kraft gewesen" gilt (nicht der Same-Day-Pfad).
    await db.insert(customerBudgetTypeSettings).values({
      customerId,
      budgetType: BUDGET,
      enabled: true,
      priority: 3,
      monthlyLimitCents: 10000,
      yearlyLimitCents: null,
      validFrom: "2020-01-01",
      validTo: null,
    });

    // Schritt 2: PUT mit ZUKÜNFTIGEM validFrom → Phasen-Append.
    // Alt-Zeile wird geschlossen (validTo = future - 1), neue Zeile angelegt.
    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: BUDGET, enabled: true, priority: 3, monthlyLimitCents: 20000, validFrom: future }],
      undefined,
      userId,
    );

    let phases = await listPhases(customerId, BUDGET);
    expect(phases).toHaveLength(2);
    const baselineAfter2 = phases.find(p => p.validFrom === "2020-01-01");
    const futureAfter2 = phases.find(p => p.validFrom === future);
    expect(baselineAfter2).toBeDefined();
    expect(futureAfter2).toBeDefined();
    // Alt-Zeile bleibt erhalten, nur geschlossen — KEIN DELETE.
    expect(baselineAfter2!.validTo).toBe(addDays(future, -1));
    expect(baselineAfter2!.monthlyLimitCents).toBe(10000);
    expect(futureAfter2!.validTo).toBeNull();
    expect(futureAfter2!.monthlyLimitCents).toBe(20000);

    // Schritt 3: PUT OHNE validFrom → neuer Versionssatz "ab heute".
    // Erwartung: die Zukunftsphase (future..null) bleibt UNVERÄNDERT, es
    // entsteht eine neue Zeile [heute .. future-1], und die Baseline wird auf
    // heute-1 geschlossen. KEINE Umdatierung der Zukunftszeile auf heute.
    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: BUDGET, enabled: true, priority: 3, monthlyLimitCents: 33333 }],
      undefined,
      userId,
    );

    phases = await listPhases(customerId, BUDGET);
    expect(phases).toHaveLength(3);

    const baseline = phases.find(p => p.validFrom === "2020-01-01");
    const todayRow = phases.find(p => p.validFrom === today);
    const futureRow = phases.find(p => p.validFrom === future);

    expect(baseline).toBeDefined();
    expect(todayRow).toBeDefined();
    expect(futureRow).toBeDefined();

    // Baseline: erhalten, auf heute-1 geschlossen.
    expect(baseline!.monthlyLimitCents).toBe(10000);
    expect(baseline!.validTo).toBe(addDays(today, -1));

    // Neuer Versionssatz "ab heute", eingeklemmt bis future-1.
    expect(todayRow!.monthlyLimitCents).toBe(33333);
    expect(todayRow!.validTo).toBe(addDays(future, -1));

    // Zukunftsphase UNANGETASTET — weiterhin [future..null] mit 20000.
    expect(futureRow!.monthlyLimitCents).toBe(20000);
    expect(futureRow!.validFrom).toBe(future);
    expect(futureRow!.validTo).toBeNull();

    // Invariante: genau eine offene Zeile, keine überlappenden validFrom.
    expect(phases.filter(p => p.validTo == null)).toHaveLength(1);
    expect(new Set(phases.map(p => p.validFrom)).size).toBe(phases.length);

    // Read-Pfad (GoBD "welches Limit galt an Tag X?"):
    // - Vergangenheit → Vorgängerzeile (10000)
    // - heute → neuer Versionssatz (33333)
    // - Zukunft → geplante Phase (20000)
    const past = await getActiveBudgetTypeSettings(customerId, "2021-06-15");
    expect(past.find(r => r.budgetType === BUDGET)?.monthlyLimitCents).toBe(10000);
    const now = await getActiveBudgetTypeSettings(customerId, today);
    const nowRows = now.filter(r => r.budgetType === BUDGET);
    expect(nowRows).toHaveLength(1); // KEIN Overlap (kein doppelter aktiver Topf)
    expect(nowRows[0].monthlyLimitCents).toBe(33333);
    const fut = await getActiveBudgetTypeSettings(customerId, future);
    expect(fut.find(r => r.budgetType === BUDGET)?.monthlyLimitCents).toBe(20000);
  }, 60_000);

  it("Schritt 2 ist append-only: kein DELETE auf customer_budget_type_settings, Transition wird auditiert", async () => {
    const customerId = await freshCustomer("T1169-AUDIT");
    const userId = await actorId();
    const today = todayISO();
    const future = addDays(today, 45);
    const BUDGET = "umwandlung_45a";

    await db.insert(customerBudgetTypeSettings).values({
      customerId,
      budgetType: BUDGET,
      enabled: true,
      priority: 2,
      monthlyLimitCents: 12500,
      yearlyLimitCents: null,
      validFrom: "2020-01-01",
      validTo: null,
    });

    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: BUDGET, enabled: true, priority: 2, monthlyLimitCents: 25000, validFrom: future }],
      undefined,
      userId,
    );

    // Beide Versionen existieren weiter (append-only, kein DELETE).
    const phases = await listPhases(customerId, BUDGET);
    expect(phases).toHaveLength(2);
    expect(phases.some(p => p.monthlyLimitCents === 12500)).toBe(true);
    expect(phases.some(p => p.monthlyLimitCents === 25000)).toBe(true);

    // Transition-Audit-Log bleibt erhalten (neue Phase = "create").
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(
        eq(auditLog.entityType, "budget"),
        eq(auditLog.entityId, customerId),
        eq(auditLog.action, "budget_type_settings_transition"),
      ))
      .orderBy(asc(auditLog.id));
    const kinds = audits.map(a => (a.metadata as { kind?: string } | null)?.kind);
    expect(kinds).toContain("create");
  }, 60_000);

  it("Abgrenzung BUG-13: OHNE in Kraft befindliche Vorgängerphase bleibt der Pull-Forward (Zukunftszeile zieht auf heute vor)", async () => {
    const customerId = await freshCustomer("T1169-BUG13");
    const userId = await actorId();
    const today = todayISO();
    const future = addDays(today, 30);
    const BUDGET = "umwandlung_45a";

    // Einzige Zeile ist zukunftsdatiert (kein Vorgänger, der heute überdeckt).
    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: BUDGET, enabled: true, priority: 2, monthlyLimitCents: 10000, validFrom: future }],
      undefined,
      userId,
    );

    // PUT ohne validFrom → Pull-Forward auf heute, weiterhin EINE Zeile.
    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: BUDGET, enabled: true, priority: 2, monthlyLimitCents: 22222 }],
      undefined,
      userId,
    );

    const phases = await listPhases(customerId, BUDGET);
    expect(phases).toHaveLength(1);
    expect(phases[0].monthlyLimitCents).toBe(22222);
    expect(phases[0].validFrom! <= today).toBe(true);
    expect(phases[0].validTo).toBeNull();

    const active = await getActiveBudgetTypeSettings(customerId, today);
    expect(active.find(r => r.budgetType === BUDGET)?.monthlyLimitCents).toBe(22222);
  }, 60_000);
});
