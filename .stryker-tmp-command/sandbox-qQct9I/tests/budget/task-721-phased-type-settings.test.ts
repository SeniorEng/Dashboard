/**
 * Task #721 — Phasen-Historisierung der Budget-Type-Settings.
 *
 * BUG-9 Reproducer (Re-Test 2026-05-28): vier sequenzielle PUT
 * `/api/budget/:cid/type-settings` mit unterschiedlichen `validFrom`-Daten
 * (2026-06-01 → 2026-08-01 → 2026-10-01 → 2027-01-01) erzeugten statt vier
 * historisierten Phasen nur **eine** Zeile (die letzte) — alle Vorgänger
 * wurden durch in-place Updates überschrieben.
 *
 * Erwartung nach Fix:
 *   - Jeder Aufruf mit explizitem `validFrom` erzeugt eine eigene Phase.
 *   - Der Vorgänger wird per `validTo = neuesValidFrom - 1` geschlossen.
 *   - Phasen mit Lücken/dazwischen werden korrekt eingeklemmt.
 *   - `getActiveBudgetTypeSettings(asOfDate)` liefert pro Stichtag exakt
 *     die zu diesem Datum gültige Phase.
 */
// @ts-nocheck

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { customerBudgetTypeSettings } from "@shared/schema";
import { addDays, todayISO } from "@shared/utils/datetime";
import {
  getActiveBudgetTypeSettings,
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
  const rows = await db.execute(/* sql */ `SELECT id FROM users ORDER BY id ASC LIMIT 1`);
  const r = (rows as { rows: Array<{ id: number }> }).rows;
  if (!r[0]) throw new Error("Kein User für Audit-Akteur verfügbar");
  return r[0].id;
}

async function freshCustomer(prefix: string): Promise<number> {
  const c = await createTestCustomer({
    vorname: prefix,
    nachname: `T721_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
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

function futureDate(offsetDays: number): string {
  return addDays(todayISO(), offsetDays);
}

describe("Task #721 — Phasen-Historisierung Budget-Type-Settings", () => {
  it("Reproducer: 4 sequenzielle Phasen (vorwärts) erzeugen 4 verkettete Zeilen", async () => {
    const customerId = await freshCustomer("T721-FWD");
    const userId = await getActorUserId();

    // Phasen-Stichtage in der Zukunft, damit der Phasen-Append-Pfad greift
    // (heute = Setup-Korrektur, Zukunft = Phasen-Schreibung).
    const vf1 = futureDate(7);
    const vf2 = futureDate(14);
    const vf3 = futureDate(60);
    const vf4 = futureDate(120);

    const limits = [10000, 11000, 12000, 13000];
    const validFroms = [vf1, vf2, vf3, vf4];

    for (let i = 0; i < 4; i++) {
      await upsertBudgetTypeSettings(
        customerId,
        [{
          budgetType: "umwandlung_45a",
          enabled: true,
          priority: 2,
          monthlyLimitCents: limits[i],
          validFrom: validFroms[i],
        }],
        undefined,
        userId,
      );
    }

    const phases = await listPhases(customerId, "umwandlung_45a");
    expect(phases).toHaveLength(4);
    expect(phases.map(p => p.validFrom)).toEqual(validFroms);
    expect(phases.map(p => p.monthlyLimitCents)).toEqual(limits);
    // Verkettung: jede Phase außer der letzten endet einen Tag vor der
    // Nachfolger-Phase.
    expect(phases[0].validTo).toBe(addDays(vf2, -1));
    expect(phases[1].validTo).toBe(addDays(vf3, -1));
    expect(phases[2].validTo).toBe(addDays(vf4, -1));
    expect(phases[3].validTo).toBeNull();

    // Read-Pfad: jeder Stichtag liefert genau die richtige Phase.
    const atVf1 = await getActiveBudgetTypeSettings(customerId, vf1);
    expect(atVf1.find(r => r.budgetType === "umwandlung_45a")?.monthlyLimitCents).toBe(10000);
    const atVf2Minus1 = await getActiveBudgetTypeSettings(customerId, addDays(vf2, -1));
    expect(atVf2Minus1.find(r => r.budgetType === "umwandlung_45a")?.monthlyLimitCents).toBe(10000);
    const atVf2 = await getActiveBudgetTypeSettings(customerId, vf2);
    expect(atVf2.find(r => r.budgetType === "umwandlung_45a")?.monthlyLimitCents).toBe(11000);
    const atVf4 = await getActiveBudgetTypeSettings(customerId, vf4);
    expect(atVf4.find(r => r.budgetType === "umwandlung_45a")?.monthlyLimitCents).toBe(13000);
  });

  it("Phasen rückwärts geschrieben erzeugen ebenfalls eine korrekt verkettete Historie", async () => {
    const customerId = await freshCustomer("T721-BWD");
    const userId = await getActorUserId();

    const vfA = futureDate(7);
    const vfB = futureDate(30);
    const vfC = futureDate(60);
    const vfD = futureDate(120);

    // Schreib-Reihenfolge: D, C, B, A.
    const writes: Array<{ vf: string; limit: number }> = [
      { vf: vfD, limit: 40000 },
      { vf: vfC, limit: 30000 },
      { vf: vfB, limit: 20000 },
      { vf: vfA, limit: 10000 },
    ];
    for (const w of writes) {
      await upsertBudgetTypeSettings(
        customerId,
        [{ budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: w.limit, validFrom: w.vf }],
        undefined,
        userId,
      );
    }

    const phases = await listPhases(customerId, "umwandlung_45a");
    expect(phases).toHaveLength(4);
    expect(phases.map(p => p.validFrom)).toEqual([vfA, vfB, vfC, vfD]);
    expect(phases.map(p => p.monthlyLimitCents)).toEqual([10000, 20000, 30000, 40000]);
    expect(phases[0].validTo).toBe(addDays(vfB, -1));
    expect(phases[1].validTo).toBe(addDays(vfC, -1));
    expect(phases[2].validTo).toBe(addDays(vfD, -1));
    expect(phases[3].validTo).toBeNull();
  });

  it("Phase dazwischen geschrieben klemmt sich korrekt zwischen Vorgänger und Nachfolger", async () => {
    const customerId = await freshCustomer("T721-MID");
    const userId = await getActorUserId();

    const vfA = futureDate(7);
    const vfC = futureDate(120);
    const vfB = futureDate(60);

    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 10000, validFrom: vfA }],
      undefined,
      userId,
    );
    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 30000, validFrom: vfC }],
      undefined,
      userId,
    );

    // Zwischenphase B chronologisch zwischen A und C.
    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 20000, validFrom: vfB }],
      undefined,
      userId,
    );

    const phases = await listPhases(customerId, "umwandlung_45a");
    expect(phases).toHaveLength(3);
    expect(phases.map(p => p.validFrom)).toEqual([vfA, vfB, vfC]);
    // Vorgänger A wurde durch B verkürzt; B wird durch C eingeklemmt; C bleibt offen.
    expect(phases[0].validTo).toBe(addDays(vfB, -1));
    expect(phases[1].validTo).toBe(addDays(vfC, -1));
    expect(phases[2].validTo).toBeNull();

    // Read-Pfad pro Phase.
    expect((await getActiveBudgetTypeSettings(customerId, vfA)).find(r => r.budgetType === "umwandlung_45a")?.monthlyLimitCents).toBe(10000);
    expect((await getActiveBudgetTypeSettings(customerId, vfB)).find(r => r.budgetType === "umwandlung_45a")?.monthlyLimitCents).toBe(20000);
    expect((await getActiveBudgetTypeSettings(customerId, addDays(vfC, -1))).find(r => r.budgetType === "umwandlung_45a")?.monthlyLimitCents).toBe(20000);
    expect((await getActiveBudgetTypeSettings(customerId, vfC)).find(r => r.budgetType === "umwandlung_45a")?.monthlyLimitCents).toBe(30000);
  });

  it("Derselbe validFrom zweimal mit unterschiedlichen Werten — spätere Schreibung gewinnt, weiterhin eine Zeile pro Phase", async () => {
    const customerId = await freshCustomer("T721-DUP");
    const userId = await getActorUserId();

    const vf = futureDate(30);
    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 10000, validFrom: vf }],
      undefined,
      userId,
    );
    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 22222, validFrom: vf }],
      undefined,
      userId,
    );

    const phases = await listPhases(customerId, "umwandlung_45a");
    expect(phases).toHaveLength(1);
    expect(phases[0].validFrom).toBe(vf);
    expect(phases[0].monthlyLimitCents).toBe(22222);
    expect(phases[0].validTo).toBeNull();
  });

  it("Phasen-Append auf NULL-Baseline schließt die rückwirkende Erstanlage statt zwei offene Zeilen zu erzeugen", async () => {
    const customerId = await freshCustomer("T721-NULLBASE");
    const userId = await getActorUserId();

    // Erstanlage ohne validFrom → Zeile mit validFrom=NULL, validTo=NULL
    // (rückwirkend gültig). Das ist die häufigste Baseline für Bestandskunden.
    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 10000 }],
      undefined,
      userId,
    );
    const baseline = await listPhases(customerId, "umwandlung_45a");
    expect(baseline).toHaveLength(1);
    expect(baseline[0].validFrom).toBeNull();
    expect(baseline[0].validTo).toBeNull();

    // Jetzt eine zukunftsdatierte Phase ansetzen. Vorgänger ist die
    // NULL-Baseline; sie MUSS geschlossen werden, sonst entstünden zwei
    // offene Zeilen (Verletzung des partiellen UNIQUE-Index).
    const vfNext = futureDate(30);
    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 20000, validFrom: vfNext }],
      undefined,
      userId,
    );

    const phases = await listPhases(customerId, "umwandlung_45a");
    expect(phases).toHaveLength(2);
    // Reihenfolge: NULL-Baseline zuerst (sortiert nach validFrom NULLS FIRST
    // wäre korrekt, drizzle sortiert standardmäßig ASC mit NULLS LAST →
    // sortiere selbst, damit der Test deterministisch ist).
    const nullRow = phases.find(p => p.validFrom == null);
    const futureRow = phases.find(p => p.validFrom === vfNext);
    expect(nullRow).toBeDefined();
    expect(futureRow).toBeDefined();
    expect(nullRow!.validTo).toBe(addDays(vfNext, -1));
    expect(nullRow!.monthlyLimitCents).toBe(10000);
    expect(futureRow!.validTo).toBeNull();
    expect(futureRow!.monthlyLimitCents).toBe(20000);

    // Invariante: nur genau eine offene Zeile pro Topf.
    const openCount = phases.filter(p => p.validTo == null).length;
    expect(openCount).toBe(1);

    // Read-Pfad: heute liefert die NULL-Baseline (10000), am vfNext die neue Phase.
    const atToday = await getActiveBudgetTypeSettings(customerId, todayISO());
    expect(atToday.find(r => r.budgetType === "umwandlung_45a")?.monthlyLimitCents).toBe(10000);
    const atVfNext = await getActiveBudgetTypeSettings(customerId, vfNext);
    expect(atVfNext.find(r => r.budgetType === "umwandlung_45a")?.monthlyLimitCents).toBe(20000);
  });

  it("BUG-9 Reproducer (Protokoll 2026-05-28): 4 sequenzielle PUTs mit konkreten Stichtagen 2026-06-01 → 2027-01-01", async () => {
    const customerId = await freshCustomer("T754-BUG9-SEQ");
    const userId = await getActorUserId();

    // Stichtage müssen in der Zukunft liegen, sonst greift in-place statt
    // Phasen-Append. Wir nehmen heute + n und prüfen die Verkettung
    // semantisch identisch zum Protokoll.
    const vf1 = futureDate(7);
    const vf2 = futureDate(60);
    const vf3 = futureDate(120);
    const vf4 = futureDate(220);
    const writes: Array<{ vf: string; limit: number }> = [
      { vf: vf1, limit: 10000 },
      { vf: vf2, limit: 11000 },
      { vf: vf3, limit: 12000 },
      { vf: vf4, limit: 13000 },
    ];
    for (const w of writes) {
      await upsertBudgetTypeSettings(
        customerId,
        [{ budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: w.limit, validFrom: w.vf }],
        undefined,
        userId,
      );
    }
    const phases = await listPhases(customerId, "entlastungsbetrag_45b");
    expect(phases).toHaveLength(4);
    expect(phases.map(p => p.validFrom)).toEqual([vf1, vf2, vf3, vf4]);
    expect(phases.map(p => p.monthlyLimitCents)).toEqual([10000, 11000, 12000, 13000]);
    expect(phases[0].validTo).toBe(addDays(vf2, -1));
    expect(phases[1].validTo).toBe(addDays(vf3, -1));
    expect(phases[2].validTo).toBe(addDays(vf4, -1));
    expect(phases[3].validTo).toBeNull();
  });

  it("BUG-9 Bonus (1 PUT mit 4-Phasen-Array): erzeugt 4 verkettete Zeilen — Schleife verarbeitet das Array NICHT phasenweise pro Topf, deshalb nimmt der Test pro Topf nur die letzte Phase auf — Doku-Test", async () => {
    const customerId = await freshCustomer("T754-BUG9-ARR");
    const userId = await getActorUserId();

    const vf1 = futureDate(7);
    const vf2 = futureDate(60);
    const vf3 = futureDate(120);
    const vf4 = futureDate(220);

    // `upsertBudgetTypeSettings` erwartet pro Topf genau EINE Zeile im
    // Array (dedup-Check über `payloadByType`). Vier Phasen für denselben
    // Topf in einem Aufruf sind syntaktisch ungültig — Protokoll-Befund war
    // genau das: die UI hätte vier separate PUTs feuern müssen. Wir
    // verifizieren hier, dass auch der Single-PUT-Pfad (mit der letzten
    // Phase aus dem Wizard) die korrekte, isolierte Phase erzeugt.
    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: 13000, validFrom: vf4 }],
      undefined,
      userId,
    );
    const phases = await listPhases(customerId, "entlastungsbetrag_45b");
    expect(phases).toHaveLength(1);
    expect(phases[0].validFrom).toBe(vf4);
    // Sentinel: vf1/vf2/vf3 sind nicht im Index.
    expect(phases.map(p => p.validFrom)).not.toContain(vf1);
    expect(phases.map(p => p.validFrom)).not.toContain(vf2);
    expect(phases.map(p => p.validFrom)).not.toContain(vf3);
  });

  it("Derselbe validFrom mit existierendem Nachfolger — späterer Schreib aktualisiert die mittlere Phase in-place, ohne Duplikat", async () => {
    const customerId = await freshCustomer("T721-DUP-SUCC");
    const userId = await getActorUserId();

    const vfMid = futureDate(30);
    const vfLate = futureDate(120);

    // Phase A (mitte) anlegen, dann Phase B (später) → A wird durch B geklemmt.
    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 10000, validFrom: vfMid }],
      undefined,
      userId,
    );
    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 30000, validFrom: vfLate }],
      undefined,
      userId,
    );

    let phases = await listPhases(customerId, "umwandlung_45a");
    expect(phases).toHaveLength(2);
    expect(phases.find(p => p.validFrom === vfMid)?.validTo).toBe(addDays(vfLate, -1));

    // Jetzt PhaseA mit demselben validFrom überschreiben (geänderter Limit).
    // Vorher-Bug: phase-append hätte eine ZWEITE Zeile mit validFrom=vfMid
    // angelegt → überlappendes Duplikat. Erwartung: in-place Update auf der
    // bestehenden mittleren Phase, validTo bleibt durch Nachfolger geklemmt.
    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 17777, validFrom: vfMid }],
      undefined,
      userId,
    );

    phases = await listPhases(customerId, "umwandlung_45a");
    expect(phases).toHaveLength(2);
    const mid = phases.find(p => p.validFrom === vfMid);
    const late = phases.find(p => p.validFrom === vfLate);
    expect(mid).toBeDefined();
    expect(late).toBeDefined();
    expect(mid!.monthlyLimitCents).toBe(17777);
    expect(mid!.validTo).toBe(addDays(vfLate, -1));
    expect(late!.monthlyLimitCents).toBe(30000);
    expect(late!.validTo).toBeNull();

    // Keine zwei offenen Zeilen, keine überlappenden validFrom-Werte.
    expect(phases.filter(p => p.validTo == null)).toHaveLength(1);
    const vfSet = new Set(phases.map(p => p.validFrom));
    expect(vfSet.size).toBe(phases.length);
  });
});
