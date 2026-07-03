/**
 * Task #1623 — Rückdatierung des „Gültig ab" auf der Budget-Einstellungen-Seite.
 *
 * Ausgangs-Bug: Trägt man für einen Budget-Topf einen Betrag ein und setzt
 * „Gültig ab" auf ein VERGANGENES Datum, verwarf der Transitions-Pfad das Datum
 * stillschweigend und schob die neue Phase auf `morgen`.
 *
 * Fix (Option 1, mit Alrik bestätigt):
 *  - ERLAUBT ist die Rückdatierung NUR beim Ersteintrag, solange der Topf im
 *    gewünschten Zeitraum noch KEINEN Betrag in Kraft hatte (Leer-Topf, im UI
 *    „Bis dahin gilt: —"). Dann wird die Rückdatierung als echte, eingeklemmte
 *    Phase übernommen (Lücken-Füllung, append-only).
 *  - ABGELEHNT wird die rückwirkende Änderung eines bereits geltenden Betrags
 *    mit einer klaren deutschen Meldung (GoBD — kein rückwirkendes Überschreiben
 *    einer schon aktiven Zahl).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { customerBudgetTypeSettings } from "@shared/schema";
import { addDays, todayISO } from "@shared/utils/datetime";
import {
  BudgetBackdateNotAllowedError,
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
    nachname: `T1623_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
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

describe("Task #1623 — Rückdatierung nur beim Leer-Topf, sonst harte Ablehnung", () => {
  it("ERLAUBT: rückdatierter Ersteintrag auf einem Topf ohne Betrag im Fenster → eingeklemmte Phase (append-only) + Round-Trip", async () => {
    const customerId = await freshCustomer("T1623-SAFE");
    const userId = await actorId();
    const today = todayISO();
    const backdate = addDays(today, -10);
    const BUDGET = "ersatzpflege_39_42a";

    // Ausgangszustand: eine bereits in Kraft befindliche, aber WERTLOSE Zeile
    // (kein Monats-/Jahresbetrag). Im UI ist das „Bis dahin gilt: —".
    await db.insert(customerBudgetTypeSettings).values({
      customerId,
      budgetType: BUDGET,
      enabled: true,
      priority: 3,
      monthlyLimitCents: null,
      yearlyLimitCents: null,
      validFrom: "2020-01-01",
      validTo: null,
    });

    // PUT: erstmals einen Betrag eintragen UND „Gültig ab" rückdatieren.
    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: BUDGET, enabled: true, priority: 3, monthlyLimitCents: 20000, validFrom: backdate }],
      undefined,
      userId,
    );

    const phases = await listPhases(customerId, BUDGET);
    // Append-only: Alt-Zeile bleibt erhalten (KEIN DELETE), neue Phase kommt dazu.
    expect(phases).toHaveLength(2);

    const emptyRow = phases.find(p => p.validFrom === "2020-01-01");
    const valuedRow = phases.find(p => p.validFrom === backdate);
    expect(emptyRow).toBeDefined();
    expect(valuedRow).toBeDefined();

    // Alt-Zeile (wertlos) auf backdate-1 geschlossen, Betrag bleibt null.
    expect(emptyRow!.validTo).toBe(addDays(backdate, -1));
    expect(emptyRow!.monthlyLimitCents).toBeNull();

    // Neue, rückdatierte Phase trägt den Betrag und ist offen.
    expect(valuedRow!.monthlyLimitCents).toBe(20000);
    expect(valuedRow!.validFrom).toBe(backdate);
    expect(valuedRow!.validTo).toBeNull();

    // Genau eine offene Zeile, keine doppelten Stichtage.
    expect(phases.filter(p => p.validTo == null)).toHaveLength(1);
    expect(new Set(phases.map(p => p.validFrom)).size).toBe(phases.length);

    // Round-Trip (GoBD „welcher Betrag galt an Tag X?"):
    // - vor backdate → weiterhin wertlos (kein Betrag rückwirkend erfunden)
    const before = await getActiveBudgetTypeSettings(customerId, addDays(today, -20));
    expect(before.find(r => r.budgetType === BUDGET)?.monthlyLimitCents ?? null).toBeNull();
    // - ab backdate → der rückdatierte Betrag greift
    const atBackdate = await getActiveBudgetTypeSettings(customerId, backdate);
    expect(atBackdate.find(r => r.budgetType === BUDGET)?.monthlyLimitCents).toBe(20000);
    // - heute → derselbe Betrag (offene Phase)
    const now = await getActiveBudgetTypeSettings(customerId, today);
    const nowRows = now.filter(r => r.budgetType === BUDGET);
    expect(nowRows).toHaveLength(1);
    expect(nowRows[0].monthlyLimitCents).toBe(20000);
  }, 60_000);

  it("ABGELEHNT: rückwirkende Änderung eines bereits geltenden Betrags → BudgetBackdateNotAllowedError (400), DB unverändert", async () => {
    const customerId = await freshCustomer("T1623-REJECT");
    const userId = await actorId();
    const today = todayISO();
    const backdate = addDays(today, -10);
    const BUDGET = "umwandlung_45a";

    // Ausgangszustand: eine bereits in Kraft befindliche Zeile MIT Betrag.
    const [seeded] = await db
      .insert(customerBudgetTypeSettings)
      .values({
        customerId,
        budgetType: BUDGET,
        enabled: true,
        priority: 2,
        monthlyLimitCents: 10000,
        yearlyLimitCents: null,
        validFrom: "2020-01-01",
        validTo: null,
      })
      .returning();

    // PUT: den bereits geltenden Betrag rückwirkend ändern → muss abgelehnt werden.
    let caught: unknown;
    try {
      await upsertBudgetTypeSettings(
        customerId,
        [{ budgetType: BUDGET, enabled: true, priority: 2, monthlyLimitCents: 20000, validFrom: backdate }],
        undefined,
        userId,
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(BudgetBackdateNotAllowedError);
    const err = caught as BudgetBackdateNotAllowedError;
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("BUDGET_BACKDATE_NOT_ALLOWED");
    // Deutsche, handlungsleitende Meldung inkl. Topf-Name.
    expect(err.message).toContain("§45a");
    expect(err.message).toMatch(/rückwirkend/i);

    // GoBD/Atomicity: die Transaktion wurde zurückgerollt, die Zeile ist unverändert.
    const phases = await listPhases(customerId, BUDGET);
    expect(phases).toHaveLength(1);
    expect(phases[0].id).toBe(seeded.id);
    expect(phases[0].monthlyLimitCents).toBe(10000);
    expect(phases[0].validFrom).toBe("2020-01-01");
    expect(phases[0].validTo).toBeNull();
  }, 60_000);

  it("Abgrenzung: reine Datums-Rückdatierung OHNE Wertänderung auf leerem Topf bleibt ein No-Op (keine Phantom-Phase)", async () => {
    const customerId = await freshCustomer("T1623-NOOP");
    const userId = await actorId();
    const today = todayISO();
    const backdate = addDays(today, -5);
    const BUDGET = "ersatzpflege_39_42a";

    // Wertlose, in Kraft befindliche Zeile.
    await db.insert(customerBudgetTypeSettings).values({
      customerId,
      budgetType: BUDGET,
      enabled: true,
      priority: 3,
      monthlyLimitCents: null,
      yearlyLimitCents: null,
      validFrom: "2020-01-01",
      validTo: null,
    });

    // PUT ohne Wertänderung (weiterhin kein Betrag), nur rückdatiertes validFrom.
    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: BUDGET, enabled: true, priority: 3, monthlyLimitCents: null, validFrom: backdate }],
      undefined,
      userId,
    );

    // settingsEqual ignoriert validFrom bewusst → keine neue Phase, keine Umdatierung.
    const phases = await listPhases(customerId, BUDGET);
    expect(phases).toHaveLength(1);
    expect(phases[0].validFrom).toBe("2020-01-01");
    expect(phases[0].validTo).toBeNull();
    expect(phases[0].monthlyLimitCents).toBeNull();
  }, 60_000);

  it("ABGELEHNT (Bypass 1): nach Same-Day-Transition (offene Zeile = frisch/morgen) wird ein zweites, rückdatiertes Save über den wertbelegten Vorgänger abgelehnt", async () => {
    const customerId = await freshCustomer("T1623-FRESH-BYPASS");
    const userId = await actorId();
    const today = todayISO();
    const backdate = addDays(today, -10);
    const BUDGET = "umwandlung_45a";

    // Ausgangszustand: eine bereits in Kraft befindliche Zeile MIT Betrag.
    await db.insert(customerBudgetTypeSettings).values({
      customerId,
      budgetType: BUDGET,
      enabled: true,
      priority: 2,
      monthlyLimitCents: 10000,
      yearlyLimitCents: null,
      validFrom: "2020-01-01",
      validTo: null,
    });

    // 1) Normaler Same-Day-Edit OHNE validFrom → Transition: Alt-Zeile
    //    validTo=heute, neue offene Zeile validFrom=morgen (frisch).
    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: BUDGET, enabled: true, priority: 2, monthlyLimitCents: 15000 }],
      undefined,
      userId,
    );
    const afterTransition = await listPhases(customerId, BUDGET);
    expect(afterTransition).toHaveLength(2);
    const freshRow = afterTransition.find(p => p.validFrom === addDays(today, 1));
    expect(freshRow).toBeDefined();
    expect(freshRow!.validTo).toBeNull();

    // 2) Zweites Save MIT rückdatiertem validFrom + geänderter Zahl. Die offene
    //    Zeile ist „frisch" (validFrom=morgen) — vor dem Fix lief das in den
    //    In-Place-Pfad und überschrieb den wertbelegten Vorgänger rückwirkend.
    let caught: unknown;
    try {
      await upsertBudgetTypeSettings(
        customerId,
        [{ budgetType: BUDGET, enabled: true, priority: 2, monthlyLimitCents: 20000, validFrom: backdate }],
        undefined,
        userId,
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(BudgetBackdateNotAllowedError);
    expect((caught as BudgetBackdateNotAllowedError).statusCode).toBe(400);

    // GoBD/Atomicity: unverändert — weiterhin genau die 2 Phasen aus Schritt 1,
    // kein rückdatiertes Überschreiben, keine dritte Zeile.
    const after = await listPhases(customerId, BUDGET);
    expect(after).toHaveLength(2);
    expect(after.some(p => p.validFrom === backdate)).toBe(false);
    expect(after.find(p => p.validFrom === addDays(today, 1))!.monthlyLimitCents).toBe(15000);
  }, 60_000);

  it("ABGELEHNT (Bypass 2): Topf mit NUR geschlossener wertbelegter Phase (keine offene Zeile) — rückdatierte Erstanlage ins Fenster wird abgelehnt", async () => {
    const customerId = await freshCustomer("T1623-CLOSED-BYPASS");
    const userId = await actorId();
    const today = todayISO();
    const backdate = addDays(today, -10);
    const BUDGET = "umwandlung_45a";

    // Ausgangszustand: NUR eine geschlossene, wertbelegte Phase, die das
    // Fenster [backdate .. heute] überschneidet (validTo=heute-3 >= backdate).
    // Keine offene Zeile → `current` ist undefined.
    await db.insert(customerBudgetTypeSettings).values({
      customerId,
      budgetType: BUDGET,
      enabled: true,
      priority: 2,
      monthlyLimitCents: 10000,
      yearlyLimitCents: null,
      validFrom: addDays(today, -30),
      validTo: addDays(today, -3),
    });

    // PUT: rückdatierte Erstanlage einer offenen Zeile MIT Betrag ins bereits
    // wertbelegte Fenster → muss abgelehnt werden (vor dem Fix: Erstanlage-Pfad
    // fügte eine offene, rückdatierte Zeile über der geschlossenen Wert-Phase ein).
    let caught: unknown;
    try {
      await upsertBudgetTypeSettings(
        customerId,
        [{ budgetType: BUDGET, enabled: true, priority: 2, monthlyLimitCents: 20000, validFrom: backdate }],
        undefined,
        userId,
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(BudgetBackdateNotAllowedError);
    expect((caught as BudgetBackdateNotAllowedError).statusCode).toBe(400);

    // Unverändert: weiterhin nur die geschlossene Phase, keine neue offene Zeile.
    const after = await listPhases(customerId, BUDGET);
    expect(after).toHaveLength(1);
    expect(after[0].validTo).toBe(addDays(today, -3));
    expect(after[0].monthlyLimitCents).toBe(10000);
  }, 60_000);
});
