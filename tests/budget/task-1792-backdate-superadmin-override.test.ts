/**
 * Task #1792 — Superadmin-Override für die Rückdatierungssperre (Task #1623).
 *
 * Ausgangslage: Task #1623 lehnt die rückwirkende Änderung eines bereits
 * geltenden Budget-Betrags GoBD-konform hart ab. Task #1792 erlaubt EINEM
 * Superadmin, diese Sperre punktuell und revisionssicher aufzuheben:
 *
 *  - Nur ein Superadmin darf den Override auslösen (sonst 403).
 *  - Eine Begründung mit ≥ 20 Zeichen ist Pflicht (sonst 400).
 *  - Der Default-Block bleibt ohne Override unverändert bestehen (400).
 *  - Ein erfolgreicher Override erhält die Phasen-GRENZEN (Vorgänger klemmen,
 *    neue Phase einklemmen). Trifft das `validFrom` EXAKT den Beginn einer
 *    bestehenden (ggf. geschlossenen) Zeile, wird sie GoBD-konform in-place
 *    korrigiert — der Immutability-Trigger sperrt nur den Hard-Delete, nicht
 *    das UPDATE, und die Wertänderung ist im Audit lückenlos belegt.
 *  - Jeder betroffene Topf wird als `budget_backdate_override` protokolliert.
 *
 * Diese Suite prüft den HTTP-Request-Pfad (Route-Gate) inkl. Audit-Nachweis
 * UND den SSoT-Storage-Gate direkt (Defense-in-Depth): der Bypass darf auch bei
 * direktem Storage-Aufruf nur mit Flag + Akteur-ID + Begründung ≥ 20 greifen.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { auditLog, customerBudgetTypeSettings } from "@shared/schema";
import { addDays, todayISO } from "@shared/utils/datetime";
import {
  apiPutAs,
  createTestCustomer,
  createTestEmployee,
  getAuthCookie,
  loginAs,
  runCleanup,
} from "../test-utils";
import {
  upsertBudgetTypeSettings,
  BudgetBackdateNotAllowedError,
} from "../../server/storage/budget/preferences-storage";

const ORIGINAL_TZ = process.env.TZ;
const BUDGET = "ersatzpflege_39_42a";
const VALID_REASON = "Korrektur nach schriftlicher Rücksprache mit der Pflegekasse (Beleg liegt vor).";

beforeAll(async () => {
  process.env.TZ = "Europe/Berlin";
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

async function freshCustomer(prefix: string): Promise<number> {
  const c = await createTestCustomer({
    vorname: prefix,
    nachname: `T1792_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    pflegegrad: 3,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  return c.id as number;
}

/** Eine bereits in Kraft befindliche, WERTBELEGTE Zeile (löst die Sperre aus). */
async function seedValuedRow(customerId: number): Promise<void> {
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
}

/**
 * Zwei-Phasen-Historie: eine GESCHLOSSENE, wertbelegte historische Phase
 * [2020-01-01 .. 2020-12-31] plus die aktuelle offene Folgephase ab 2021-01-01.
 * Nötig, um den exactMatch-Zweig unter Override zu treffen: Rückdatierung auf
 * EXAKT den Beginn der offenen Zeile würde die Sperre gar nicht auslösen
 * (`backdateShiftsStart=false`), daher braucht es die frühere geschlossene Zeile.
 */
async function seedTwoPhaseHistory(customerId: number): Promise<void> {
  await db.insert(customerBudgetTypeSettings).values([
    {
      customerId,
      budgetType: BUDGET,
      enabled: true,
      priority: 3,
      monthlyLimitCents: 10000,
      yearlyLimitCents: null,
      validFrom: "2020-01-01",
      validTo: "2020-12-31",
    },
    {
      customerId,
      budgetType: BUDGET,
      enabled: true,
      priority: 3,
      monthlyLimitCents: 15000,
      yearlyLimitCents: null,
      validFrom: "2021-01-01",
      validTo: null,
    },
  ]);
}

async function listPhases(customerId: number) {
  return db
    .select()
    .from(customerBudgetTypeSettings)
    .where(eq(customerBudgetTypeSettings.customerId, customerId))
    .orderBy(asc(customerBudgetTypeSettings.validFrom), asc(customerBudgetTypeSettings.id))
    .then(rows => rows.filter(r => r.budgetType === BUDGET));
}

function bodyWith(validFrom: string, monthlyLimitCents: number, extra: Record<string, unknown> = {}) {
  return {
    settings: [{ budgetType: BUDGET, enabled: true, priority: 3, monthlyLimitCents, validFrom }],
    ...extra,
  };
}

const PATH = (customerId: number) => `/api/budget/${customerId}/type-settings`;

describe("Task #1792 — Superadmin-Override der Rückdatierungssperre", () => {
  it("403: ein Admin (kein Superadmin) darf den Override NICHT auslösen (SUPERADMIN_REQUIRED)", async () => {
    const customerId = await freshCustomer("T1792-403");
    await seedValuedRow(customerId);
    const backdate = addDays(todayISO(), -10);

    const emp = await createTestEmployee({ isAdmin: true, nachnamePrefix: "T1792Admin" });
    const adminAuth = await loginAs(emp.email, emp.password);

    const res = await apiPutAs<{ error?: string; message?: string }>(
      adminAuth,
      PATH(customerId),
      bodyWith(backdate, 20000, { overrideBackdateGuard: true, overrideReason: VALID_REASON }),
    );

    expect(res.status).toBe(403);
    expect(res.data.error).toBe("SUPERADMIN_REQUIRED");

    // GoBD/Atomicity: unverändert — die Alt-Zeile bleibt exakt bestehen.
    const phases = await listPhases(customerId);
    expect(phases).toHaveLength(1);
    expect(phases[0].validFrom).toBe("2020-01-01");
    expect(phases[0].monthlyLimitCents).toBe(10000);
  }, 60_000);

  it("400: Superadmin mit Override, aber Begründung < 20 Zeichen → VALIDATION_ERROR", async () => {
    const customerId = await freshCustomer("T1792-400");
    await seedValuedRow(customerId);
    const backdate = addDays(todayISO(), -10);
    const superadmin = await getAuthCookie();

    const res = await apiPutAs<{ error?: string; message?: string }>(
      superadmin,
      PATH(customerId),
      bodyWith(backdate, 20000, { overrideBackdateGuard: true, overrideReason: "zu kurz" }),
    );

    expect(res.status).toBe(400);
    expect(res.data.error).toBe("VALIDATION_ERROR");
    expect(res.data.message).toMatch(/20 Zeichen/);

    const phases = await listPhases(customerId);
    expect(phases).toHaveLength(1);
    expect(phases[0].monthlyLimitCents).toBe(10000);
  }, 60_000);

  it("400: ohne Override bleibt die Rückdatierungssperre bestehen (BUDGET_BACKDATE_NOT_ALLOWED)", async () => {
    const customerId = await freshCustomer("T1792-DEFAULT");
    await seedValuedRow(customerId);
    const backdate = addDays(todayISO(), -10);
    const superadmin = await getAuthCookie();

    const res = await apiPutAs<{ code?: string; message?: string }>(
      superadmin,
      PATH(customerId),
      bodyWith(backdate, 20000),
    );

    expect(res.status).toBe(400);
    expect(res.data.code).toBe("BUDGET_BACKDATE_NOT_ALLOWED");

    const phases = await listPhases(customerId);
    expect(phases).toHaveLength(1);
    expect(phases[0].validFrom).toBe("2020-01-01");
    expect(phases[0].monthlyLimitCents).toBe(10000);
  }, 60_000);

  it("200: Superadmin + gültige Begründung → append-only Phasen + revisionssicheres Override-Audit", async () => {
    const customerId = await freshCustomer("T1792-OK");
    await seedValuedRow(customerId);
    const today = todayISO();
    const backdate = addDays(today, -10);
    const superadmin = await getAuthCookie();

    const res = await apiPutAs(
      superadmin,
      PATH(customerId),
      bodyWith(backdate, 20000, { overrideBackdateGuard: true, overrideReason: VALID_REASON }),
    );

    expect(res.status).toBe(200);

    // Append-only: Alt-Zeile erhalten (auf backdate-1 geschlossen), neue Phase ab backdate.
    const phases = await listPhases(customerId);
    expect(phases).toHaveLength(2);

    const oldRow = phases.find(p => p.validFrom === "2020-01-01");
    const newRow = phases.find(p => p.validFrom === backdate);
    expect(oldRow).toBeDefined();
    expect(newRow).toBeDefined();
    expect(oldRow!.validTo).toBe(addDays(backdate, -1));
    expect(oldRow!.monthlyLimitCents).toBe(10000);
    expect(newRow!.monthlyLimitCents).toBe(20000);
    expect(newRow!.validTo).toBeNull();
    // Genau eine offene Zeile, keine doppelten Stichtage.
    expect(phases.filter(p => p.validTo == null)).toHaveLength(1);
    expect(new Set(phases.map(p => p.validFrom)).size).toBe(phases.length);

    // Revisionssicheres Override-Protokoll: genau ein `budget_backdate_override`
    // für diesen Topf, mit Akteur, Begründung und Vorher/Nachher-Stichtagen.
    const overrideAudits = await db
      .select()
      .from(auditLog)
      .where(and(
        eq(auditLog.entityType, "budget"),
        eq(auditLog.entityId, customerId),
        eq(auditLog.action, "budget_backdate_override"),
      ));
    expect(overrideAudits).toHaveLength(1);
    const meta = overrideAudits[0].metadata as Record<string, unknown>;
    expect(overrideAudits[0].userId).toBe(superadmin.user.id);
    expect(meta.budgetType).toBe(BUDGET);
    expect(meta.reason).toBe(VALID_REASON);
    expect(meta.oldValidFrom).toBe("2020-01-01");
    expect(meta.newValidFrom).toBe(backdate);
  }, 60_000);

  it("200 (exactMatch): Override auf EXAKT bestehenden Phasen-Beginn → GoBD-konforme In-Place-Korrektur + Audit", async () => {
    const customerId = await freshCustomer("T1792-EXACT");
    await seedTwoPhaseHistory(customerId);
    const superadmin = await getAuthCookie();

    // Rückdatierung auf EXAKT den Beginn der geschlossenen historischen Phase.
    const res = await apiPutAs(
      superadmin,
      PATH(customerId),
      bodyWith("2020-01-01", 99000, { overrideBackdateGuard: true, overrideReason: VALID_REASON }),
    );
    expect(res.status).toBe(200);

    // KEINE neue Phase: die exakt getroffene historische Zeile wird in-place
    // korrigiert, ihre Fenstergrenze (validTo) bleibt unverändert; die spätere
    // offene Folgephase bleibt vollständig unangetastet.
    const phases = await listPhases(customerId);
    expect(phases).toHaveLength(2);
    const historical = phases.find(p => p.validFrom === "2020-01-01");
    const successor = phases.find(p => p.validFrom === "2021-01-01");
    expect(historical).toBeDefined();
    expect(successor).toBeDefined();
    expect(historical!.monthlyLimitCents).toBe(99000);
    expect(historical!.validTo).toBe("2020-12-31");
    expect(successor!.monthlyLimitCents).toBe(15000);
    expect(successor!.validTo).toBeNull();
    // Genau eine offene Zeile, keine doppelten Stichtage.
    expect(phases.filter(p => p.validTo == null)).toHaveLength(1);
    expect(new Set(phases.map(p => p.validFrom)).size).toBe(phases.length);

    // Revisionssicher: genau eine Override-Zeile, oldValidFrom === newValidFrom,
    // mit dem ALTEN Wert im before-Block und dem neuen Wert im after-Block.
    const overrideAudits = await db
      .select()
      .from(auditLog)
      .where(and(
        eq(auditLog.entityType, "budget"),
        eq(auditLog.entityId, customerId),
        eq(auditLog.action, "budget_backdate_override"),
      ));
    expect(overrideAudits).toHaveLength(1);
    const meta = overrideAudits[0].metadata as Record<string, unknown>;
    expect(meta.oldValidFrom).toBe("2020-01-01");
    expect(meta.newValidFrom).toBe("2020-01-01");
    const before = meta.before as Record<string, unknown> | null;
    expect(before?.monthlyLimitCents).toBe(10000);
    const after = meta.after as Record<string, unknown>;
    expect(after.monthlyLimitCents).toBe(99000);
  }, 60_000);

  it("Storage-Gate (Defense-in-Depth): Flag OHNE Akteur bzw. mit zu kurzer Begründung bleibt hart gesperrt", async () => {
    const customerId = await freshCustomer("T1792-STORAGE");
    await seedValuedRow(customerId);
    const backdate = addDays(todayISO(), -10);
    const superadmin = await getAuthCookie();
    const setting = {
      budgetType: BUDGET,
      enabled: true,
      priority: 3,
      monthlyLimitCents: 20000,
      yearlyLimitCents: null,
      validFrom: backdate,
    };

    // (a) Flag + gültige Begründung, aber KEINE overrideUserId → weiterhin gesperrt.
    await expect(
      upsertBudgetTypeSettings(customerId, [setting], undefined, superadmin.user.id, {
        overrideBackdateGuard: true,
        overrideReason: VALID_REASON,
      }),
    ).rejects.toBeInstanceOf(BudgetBackdateNotAllowedError);

    // (b) Flag + overrideUserId, aber Begründung < 20 Zeichen → weiterhin gesperrt.
    await expect(
      upsertBudgetTypeSettings(customerId, [setting], undefined, superadmin.user.id, {
        overrideBackdateGuard: true,
        overrideUserId: superadmin.user.id,
        overrideReason: "zu kurz",
      }),
    ).rejects.toBeInstanceOf(BudgetBackdateNotAllowedError);

    // Die wertbelegte Alt-Zeile bleibt exakt bestehen (kein Teil-Write).
    const phases = await listPhases(customerId);
    expect(phases).toHaveLength(1);
    expect(phases[0].validFrom).toBe("2020-01-01");
    expect(phases[0].monthlyLimitCents).toBe(10000);
  }, 60_000);
});
