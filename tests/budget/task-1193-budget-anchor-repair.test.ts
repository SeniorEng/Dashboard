/**
 * Task #1193 — Report + idempotenter Bulk-Fix für festhängende Budget-Anker.
 *
 * Spiegelt den Prod-Fall „Mentke" #182 (Pflegegrad 2 seit Vorjahr-Februar,
 * Kunde im Mai angelegt, Anker auf den Stichmonat Mai gepinnt, `origin = NULL`):
 *
 *   - VORHER (origin NULL, Anker Mai): §45b liest den Anker ROH → nur Mai+Juni
 *     ansammeln (2 × 131 €) + 883,55 € Carryover = 1.145,55 €.
 *   - NACHHER (origin 'derived_pflegegrad', Anker per Anker-SSoT auf 01.01.):
 *     Jan–Juni ansammeln (6 × 131 €) + 883,55 € Carryover = 1.669,55 €.
 *   - Differenz: 4 fehlende Monate / 524,00 €.
 *
 * Pins:
 *   1) Report erkennt den Kunden (Population: origin NULL, aktiver Topf,
 *      Anker > Soll-Anker) und meldet fehlende Monate/Betrag + Carryover.
 *   2) `--apply` setzt Anker = Soll-Anker (resolveBudgetAnchor) + Origin
 *      'derived_pflegegrad', schreibt EINEN GoBD-Audit-Eintrag, §45b-Allocated
 *      steigt auf 1.669,55 €.
 *   3) Idempotent: ein zweiter Lauf findet den Kunden nicht mehr.
 *   4) Ein reiner §45a-Kunde (kein §45b) wird NICHT angefasst.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { auditLog, customerBudgetPreferences } from "@shared/schema";
import { calculateAllocatedCents, upsertCarryoverAllocation } from "../../server/storage/budget/allocation-storage";
import { budgetLedgerStorage } from "../../server/storage/budget-ledger";
import { runBudgetAnchorRepair, missingMonthsFromCents } from "../../server/scripts/repair-45b-stuck-anchor";
import {
  apiPut,
  cleanupCustomer,
  createTestCustomer,
  getAuthCookie,
  runCleanup,
} from "../test-utils";

const YEAR = new Date().getFullYear();
const MONTHLY_45B_CENTS = 13100;
const CARRYOVER_CENTS = 88355; // 883,55 €
const STUCK_ANCHOR = `${YEAR}-05-01`; // Kreations-/Stichmonat
const SOLL_ANCHOR = `${YEAR}-01-01`; // resolveBudgetAnchor(max(Vorjahr-Feb, 01.01.))
const PG_SEIT = `${YEAR - 1}-02-01`;
const AS_OF = `${YEAR}-06-15`; // Stichtag Mitte Juni → 6 berechtigte Monate
const TODAY = `${YEAR}-06-15`;

// 6 × 131 € + 883,55 € = 1.669,55 €
const EXPECTED_AFTER = 6 * MONTHLY_45B_CENTS + CARRYOVER_CENTS;
// 2 × 131 € + 883,55 € = 1.145,55 €
const EXPECTED_BEFORE = 2 * MONTHLY_45B_CENTS + CARRYOVER_CENTS;
const EXPECTED_MISSING = EXPECTED_AFTER - EXPECTED_BEFORE; // 524,00 €

const createdCustomers: number[] = [];

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  while (createdCustomers.length) {
    await cleanupCustomer(createdCustomers.pop());
  }
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

async function freshCustomer(prefix: string, opts: { acceptsPrivatePayment?: boolean } = {}): Promise<number> {
  const c = await createTestCustomer({
    vorname: prefix,
    nachname: `T1193_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    pflegegrad: 2,
    pflegegradSeit: PG_SEIT,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: opts.acceptsPrivatePayment ?? false,
  });
  const id = c.id as number;
  createdCustomers.push(id);
  return id;
}

async function setPots(
  customerId: number,
  pots: { b45?: boolean; a45?: boolean; e39?: boolean },
): Promise<void> {
  const res = await apiPut(`/api/budget/${customerId}/type-settings`, {
    settings: [
      { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: pots.b45 ?? false, monthlyLimitCents: null },
      { budgetType: "umwandlung_45a", priority: 2, enabled: pots.a45 ?? false, monthlyLimitCents: null },
      { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: pots.e39 ?? false, yearlyLimitCents: null },
    ],
  });
  expect(res.status, `type-settings: ${res.status} ${JSON.stringify(res.data)}`).toBe(200);
}

/** Forciert den „festhängenden" Zustand: Anker auf Stichmonat, origin NULL. */
async function forceStuckAnchor(customerId: number): Promise<void> {
  await budgetLedgerStorage.upsertBudgetPreferences({
    customerId,
    budgetStartDate: STUCK_ANCHOR,
    budgetStartDateOrigin: null,
  });
  const [prefs] = await db
    .select()
    .from(customerBudgetPreferences)
    .where(eq(customerBudgetPreferences.customerId, customerId));
  expect(prefs?.budgetStartDate).toBe(STUCK_ANCHOR);
  expect(prefs?.budgetStartDateOrigin).toBeNull();
}

describe("Task #1193 — Budget-Anker-Reparatur", () => {
  it("missingMonthsFromCents rundet gegen den §45b-Standardbetrag", () => {
    expect(missingMonthsFromCents(52400)).toBe(4);
    expect(missingMonthsFromCents(0)).toBe(0);
    expect(missingMonthsFromCents(13100)).toBe(1);
  });

  it("repariert den festhängenden §45b-Anker (Mentke #182-Szenario)", async () => {
    const customerId = await freshCustomer("T1193-stuck");
    await setPots(customerId, { b45: true });
    const userId = await getActorUserId();

    // §45b-Restguthaben Vorjahr (Carryover, läuft 30.06. ab).
    await upsertCarryoverAllocation(
      { customerId, budgetType: "entlastungsbetrag_45b", sourceYear: YEAR - 1, amountCents: CARRYOVER_CENTS },
      userId,
    );
    await forceStuckAnchor(customerId);

    // VORHER: Anker roh (Mai) → nur 2 Monate + Carryover.
    const before = await calculateAllocatedCents(customerId, "entlastungsbetrag_45b", { asOfDate: AS_OF });
    expect(before).toBe(EXPECTED_BEFORE);

    // DRY-RUN: meldet den Kunden + fehlende Monate/Betrag, schreibt aber NICHT.
    const dry = await runBudgetAnchorRepair({
      onlyCustomer: customerId,
      apply: false,
      includeUnaffected: true,
      today: TODAY,
      asOfDate: AS_OF,
      operatorUserId: userId,
    });
    expect(dry.affectedCount).toBe(1);
    const dryRow = dry.rows.find((r) => r.customerId === customerId)!;
    expect(dryRow.willCorrect).toBe(true);
    expect(dryRow.currentAnchor).toBe(STUCK_ANCHOR);
    expect(dryRow.sollAnchor).toBe(SOLL_ANCHOR);
    expect(dryRow.pgSeit).toBe(PG_SEIT);
    expect(dryRow.missingCents).toBe(EXPECTED_MISSING);
    expect(dryRow.missingMonths).toBe(4);
    expect(dryRow.existingCarryoverCents).toBe(CARRYOVER_CENTS);

    // Dry-Run hat nichts persistiert.
    const stillStuck = await calculateAllocatedCents(customerId, "entlastungsbetrag_45b", { asOfDate: AS_OF });
    expect(stillStuck).toBe(EXPECTED_BEFORE);

    // APPLY: schreibt Anker + Origin + Audit.
    const applied = await runBudgetAnchorRepair({
      onlyCustomer: customerId,
      apply: true,
      today: TODAY,
      asOfDate: AS_OF,
      operatorUserId: userId,
    });
    expect(applied.affectedCount).toBe(1);

    // NACHHER: voller Jahres-Anteil + Carryover = 1.669,55 €.
    const after = await calculateAllocatedCents(customerId, "entlastungsbetrag_45b", { asOfDate: AS_OF });
    expect(after).toBe(EXPECTED_AFTER);

    // Anker + Origin persistiert.
    const [prefs] = await db
      .select()
      .from(customerBudgetPreferences)
      .where(eq(customerBudgetPreferences.customerId, customerId));
    expect(prefs?.budgetStartDate).toBe(SOLL_ANCHOR);
    expect(prefs?.budgetStartDateOrigin).toBe("derived_pflegegrad");

    // GoBD: genau ein Audit-Eintrag für die Korrektur.
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(
        eq(auditLog.action, "budget_initial_setup"),
        eq(auditLog.entityType, "budget"),
        eq(auditLog.entityId, customerId),
      ));
    expect(audits.length).toBe(1);

    // IDEMPOTENT: zweiter Lauf findet den Kunden nicht mehr (origin nicht NULL).
    const second = await runBudgetAnchorRepair({
      onlyCustomer: customerId,
      apply: true,
      includeUnaffected: true,
      today: TODAY,
      asOfDate: AS_OF,
      operatorUserId: userId,
    });
    expect(second.affectedCount).toBe(0);
    expect(second.rows.find((r) => r.customerId === customerId)).toBeUndefined();
  }, 90_000);

  it("lässt einen reinen §45a-Kunden unangetastet", async () => {
    const customerId = await freshCustomer("T1193-45a", { acceptsPrivatePayment: true });
    await setPots(customerId, { a45: true }); // nur §45a aktiv, KEIN §45b
    const userId = await getActorUserId();
    await forceStuckAnchor(customerId);

    const res = await runBudgetAnchorRepair({
      onlyCustomer: customerId,
      apply: true,
      includeUnaffected: true,
      today: TODAY,
      asOfDate: AS_OF,
      operatorUserId: userId,
    });

    // In der Population (aktiver Topf + Anker > Soll), aber NICHT korrigiert.
    expect(res.affectedCount).toBe(0);
    const row = res.rows.find((r) => r.customerId === customerId);
    if (row) {
      expect(row.enabled45b).toBe(false);
      expect(row.willCorrect).toBe(false);
    }

    // Anker unverändert (origin bleibt NULL, Datum bleibt Stichmonat).
    const [prefs] = await db
      .select()
      .from(customerBudgetPreferences)
      .where(eq(customerBudgetPreferences.customerId, customerId));
    expect(prefs?.budgetStartDate).toBe(STUCK_ANCHOR);
    expect(prefs?.budgetStartDateOrigin).toBeNull();
  }, 90_000);

  it("korrigiert einen §45b-Kandidaten auch ohne Betragsänderung (willCorrect ⊥ Delta)", async () => {
    // §45b-Kunde, dessen Anker-Korrektur den Allocated-Betrag NICHT verändert
    // (Stichtag VOR beiden Ankern ⇒ 0 Monate Ansammlung vorher wie nachher).
    // Er MUSS trotzdem gelistet, gezählt und (apply) geschrieben + auditiert
    // werden — die Origin-Korrektur NULL → 'derived_pflegegrad' ist für sich
    // schon eine GoBD-relevante Reparatur. Beweist die Entkopplung
    // „Korrektur-Kandidat" von „Allocated-Differenz".
    const customerId = await freshCustomer("T1193-zerodelta");
    await setPots(customerId, { b45: true });
    const userId = await getActorUserId();

    const pgSeit = `${YEAR}-03-01`;
    const stuck = `${YEAR}-05-01`;
    const sollAnchor = `${YEAR}-03-01`; // resolveBudgetAnchor(max(Mär-1, 01.01.))
    const asOfBeforeAnchors = `${YEAR}-02-15`; // Stichtag vor beiden Ankern

    // Pflegegrad-Beginn auf März verschieben (überschreibt die Default-Historie).
    await db
      .update(customerBudgetPreferences)
      .set({ budgetStartDate: stuck, budgetStartDateOrigin: null })
      .where(eq(customerBudgetPreferences.customerId, customerId));
    // careLevelHistory direkt setzen ist nicht nötig: createTestCustomer hat sie
    // bereits aus pflegegradSeit (Vorjahr-Feb) geseedet; für diesen Fall säen wir
    // sie passend über die DB.
    await db.execute(
      /* sql */ `UPDATE customer_care_level_history SET valid_from = '${pgSeit}' WHERE customer_id = ${customerId}`,
    );
    await forceStuckAnchor(customerId);

    // Beide Stichtags-Allocated = 0 (Ansammlung erst ab Anker, Stichtag davor).
    const before = await calculateAllocatedCents(
      customerId, "entlastungsbetrag_45b", { asOfDate: asOfBeforeAnchors },
    );
    expect(before).toBe(0);

    const res = await runBudgetAnchorRepair({
      onlyCustomer: customerId,
      apply: true,
      today: TODAY,
      asOfDate: asOfBeforeAnchors,
      operatorUserId: userId,
    });

    // Trotz 0-Delta: gelistet, gezählt, geschrieben.
    expect(res.affectedCount).toBe(1);
    const row = res.rows.find((r) => r.customerId === customerId)!;
    expect(row.willCorrect).toBe(true);
    expect(row.missingCents).toBe(0);
    expect(row.sollAnchor).toBe(sollAnchor);

    const [prefs] = await db
      .select()
      .from(customerBudgetPreferences)
      .where(eq(customerBudgetPreferences.customerId, customerId));
    expect(prefs?.budgetStartDate).toBe(sollAnchor);
    expect(prefs?.budgetStartDateOrigin).toBe("derived_pflegegrad");

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(
        eq(auditLog.action, "budget_initial_setup"),
        eq(auditLog.entityType, "budget"),
        eq(auditLog.entityId, customerId),
      ));
    expect(audits.length).toBe(1);
  }, 90_000);
});
