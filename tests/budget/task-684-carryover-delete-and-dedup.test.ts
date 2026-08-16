/**
 * Task #684 — §45b-Carryover: Löschen wirkt nicht & Doppelzählung.
 *
 * Sichert die beiden Kernkonsequenzen des Fixes ab:
 *
 *   1) Löschen ist endgültig: nach Soft-Delete einer Carryover-Allokation
 *      darf `syncCarryoverAndExpiry` keine neue Auto-Carryover-Zeile für
 *      dasselbe Quelljahr anlegen (vorher: 131 € regenerierten sich sofort).
 *
 *   2) Manuelle Carryover-Zeile blockiert den Auto-Pfad: existiert für ein
 *      Quelljahr bereits eine aktive manuelle Carryover-Zeile (z.B. 344,50 €),
 *      legt `syncCarryoverAndExpiry` keine zweite Auto-Zeile für dasselbe
 *      Quelljahr/Zieljahr an — auch nach mehrfachem Aufruf.
 *
 *   3) Summary-Math: nach manueller Carryover-Anlage entspricht
 *      `totalAllocatedCents` exakt `elapsedMonths × monthlyAmount + carryover`
 *      (kein 131 €-Drift mehr).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetAllocations } from "@shared/schema";
import {
  syncCarryoverAndExpiry,
  upsertInitialBalanceAllocation,
} from "../../server/storage/budget/allocation-storage";
import { upsertCarryoverAllocation } from "../../server/storage/budget/allocation-storage";
import { getBudgetSummary } from "../../server/storage/budget/summary-queries";
import {
  createTestCustomer,
  getAuthCookie,
  runCleanup,
  apiPut,
} from "../test-utils";
import { useTestClock } from "../helpers/test-clock";
import { freezeTime, thawTime } from "../helpers/frozen-clock";

beforeAll(async () => {
  await getAuthCookie();
});

// Die Uhr IMMER auftauen — sonst erben die nachfolgenden Tests dieser Datei die
// eingefrorene Zeit. (Der globale Hook in `tests/setup.ts` täte es auch; hier
// explizit, weil in dieser Datei mehrere Tests hintereinander laufen.)
afterEach(() => {
  thawTime();
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

async function fresh45bCustomer(prefix: string): Promise<number> {
  const c = await createTestCustomer({
    vorname: prefix,
    nachname: `T684_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    pflegegrad: 3,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  const customerId = c.id as number;
  // §45b aktivieren, ohne Startwert/Carryover. Aktivieren ab Anfang
  // letztes Jahr, damit Auto-Carryover für letztes Jahr (sourceYear =
  // letztes Jahr) ein Zieljahr in der Gegenwart erzeugen würde.
  const lastYear = new Date().getFullYear() - 1;
  await apiPut(`/api/budget/${customerId}/type-settings`, {
    settings: [
      { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: `${lastYear}-01-01`, validTo: null },
      { budgetType: "umwandlung_45a",        enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null },
      { budgetType: "ersatzpflege_39_42a",   enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null },
    ],
  });
  return customerId;
}

async function getActiveCarryovers(customerId: number) {
  return db.select().from(budgetAllocations).where(and(
    eq(budgetAllocations.customerId, customerId),
    eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
    eq(budgetAllocations.source, "carryover"),
    isNull(budgetAllocations.deletedAt),
  ));
}

describe("T684 — §45b-Carryover Delete-Stickiness & Anti-Dedup", () => {
  it("nach Soft-Delete legt syncCarryoverAndExpiry KEINEN neuen Auto-Carryover an", async () => {
    const userId = await getActorUserId();
    const customerId = await fresh45bCustomer("T684-DELETE");
    const sourceYear = new Date().getFullYear() - 1;

    // Manuellen Carryover anlegen → eine aktive Zeile mit year=currentYear.
    await upsertCarryoverAllocation(
      { customerId, budgetType: "entlastungsbetrag_45b", sourceYear, amountCents: 34_450 },
      userId,
    );
    const beforeDelete = await getActiveCarryovers(customerId);
    expect(beforeDelete).toHaveLength(1);
    const allocationId = beforeDelete[0].id;

    // Admin löscht (soft-delete, analog zum DELETE-Route-Pfad).
    await db.update(budgetAllocations)
      .set({ deletedAt: new Date() })
      .where(eq(budgetAllocations.id, allocationId));

    // Mehrfach syncCarryoverAndExpiry triggern (Budget-Overview, Buchung,
    // Series-Anlage rufen das alle auf). Vor dem Fix legt der Auto-Pfad
    // sofort wieder einen 131 €-Carryover für sourceYear an.
    await syncCarryoverAndExpiry(customerId);
    await syncCarryoverAndExpiry(customerId);
    await syncCarryoverAndExpiry(customerId);

    const afterDelete = await getActiveCarryovers(customerId);
    expect(afterDelete).toHaveLength(0);
  });

  it("manueller Carryover blockiert Auto-Carryover für dasselbe Quelljahr (genau eine aktive Zeile)", async () => {
    const userId = await getActorUserId();
    const customerId = await fresh45bCustomer("T684-DEDUP");
    const sourceYear = new Date().getFullYear() - 1;

    await upsertCarryoverAllocation(
      { customerId, budgetType: "entlastungsbetrag_45b", sourceYear, amountCents: 34_450 },
      userId,
    );

    // Auto-Pfad mehrfach feuern.
    await syncCarryoverAndExpiry(customerId);
    await syncCarryoverAndExpiry(customerId);

    const active = await getActiveCarryovers(customerId);
    expect(active).toHaveLength(1);
    expect(active[0].amountCents).toBe(34_450);
    expect(active[0].createdByUserId).toBe(userId);
  });

  it("Summary zählt nicht doppelt: totalAllocated = elapsedMonths × monthly + carryover", async () => {
    // Frist-STÖRFAKTOR: Prüfgegenstand ist die Doppelzählung, nicht der Verfall.
    // Ein §45b-Übertrag für Zieljahr Y gilt aber nur vom 01.01. bis zum 30.06.
    // dieses Jahres — ab Juli trägt er per Gesetz 0 bei, und die Formel
    // `elapsedMonths × monthly + carryover` ginge nicht mehr auf (gemessen:
    // 104800 statt 139250). Wir verankern den Stichtag deshalb im H1 des
    // Zieljahres, statt die Erwartung aufzuweichen.
    //
    // §45b-Präventions-Cluster Welle 1 — Stichtag ist jetzt ein Literal statt eines relativen Ankers:
    // `useTestClock` stellt Testprozess UND App-Server auf denselben Tag, die
    // Jahreszahlen driften also nicht mehr mit dem Lauftag. `freezeTime` bleibt
    // daneben stehen, weil die in-process gerufenen Pfade
    // (`upsertCarryoverAllocation`, `syncCarryoverAndExpiry`, `getBudgetSummary`)
    // zusätzlich rohes `new Date()` für Zeitstempel benutzen; beide MÜSSEN
    // denselben Zeitpunkt zeigen (siehe Vorrang-Hinweis in helpers/test-clock.ts).
    //
    // 15.06.2026 liegt im H1 des Zieljahres — der Übertrag aus 2025 gilt dort
    // noch, und die Formel `elapsedMonths × monthly + carryover` geht auf. Ab
    // Juli trüge er per Gesetz 0 bei (gemessen: 104800 statt 139250).
    const sourceYear = 2025;
    const targetYear = 2026;
    const asOf = "2026-06-15";
    useTestClock(`${asOf}T12:00:00`);
    freezeTime(`${asOf}T12:00:00`);

    const userId = await getActorUserId();
    const customerId = await fresh45bCustomer("T684-MATH");
    const carryoverCents = 34_450; // 344,50 €

    // Beide Werte kommen aus dem STICHTAG, nicht aus `new Date()`. Letzteres
    // wäre zwar korrekt, solange der Freeze zwei Zeilen weiter oben steht — aber
    // genau dieses Muster ersetzt dieser PR sonst überall, und beim Verschieben
    // des Freeze driftete es lautlos auf die reale Uhr zurück.
    const curYear = targetYear;
    const curMonth = Number(asOf.slice(5, 7));
    // Dieser PUT ist faktisch wirkungslos: `fresh45bCustomer` hat die
    // §45b-Settings-Zeile bereits mit `validFrom = ${targetYear - 1}-01-01`
    // angelegt, und der PUT ändert sie nicht. Dass die Aufstockung im Januar des
    // ZIELJAHRES startet, macht der Produktions-Anker
    // (`floorAutoAnchor45bToCurrentYear`) unter der eingefrorenen Uhr — nicht
    // dieser Aufruf. Er bleibt als Teil des nachgestellten Wizard-Flows stehen.
    await apiPut(`/api/budget/${customerId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: `${curYear}-01-01`, validTo: null },
        { budgetType: "umwandlung_45a",        enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null },
        { budgetType: "ersatzpflege_39_42a",   enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null },
      ],
    });

    await upsertCarryoverAllocation(
      { customerId, budgetType: "entlastungsbetrag_45b", sourceYear, amountCents: carryoverCents },
      userId,
    );

    // Auto-Pfad triggern — darf KEINEN zweiten Carryover anlegen.
    await syncCarryoverAndExpiry(customerId);

    const summary = await getBudgetSummary(customerId);
    const monthlyAmount = 13_100; // 131,00 € gesetzlicher Default
    const expected = curMonth * monthlyAmount + carryoverCents;
    expect(summary.totalAllocatedCents).toBe(expected);
    expect(summary.carryoverCents).toBe(carryoverCents);
  });

  it("Startwert + gelöschter Carryover: kein Auto-Carryover-Regenerat (Step 3 des Tasks)", async () => {
    const userId = await getActorUserId();
    const customerId = await fresh45bCustomer("T684-IB-DELETE");
    const lastYear = new Date().getFullYear() - 1;

    // Startwert für Vorjahr → unterdrückt Auto-Carryover bereits via #101.
    // Setzt aber zusätzlich einen manuellen Carryover, der dann gelöscht
    // wird — Sicherheitsnetz, dass auch dieser Pfad nicht regeneriert.
    await upsertInitialBalanceAllocation({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      year: lastYear,
      month: 1,
      amountCents: 50_000,
      validFrom: `${lastYear}-01-01`,
      expiresAt: null,
    }, userId);

    await upsertCarryoverAllocation(
      { customerId, budgetType: "entlastungsbetrag_45b", sourceYear: lastYear, amountCents: 20_000 },
      userId,
    );

    const carryovers = await getActiveCarryovers(customerId);
    expect(carryovers).toHaveLength(1);
    await db.update(budgetAllocations)
      .set({ deletedAt: new Date() })
      .where(eq(budgetAllocations.id, carryovers[0].id));

    await syncCarryoverAndExpiry(customerId);
    await syncCarryoverAndExpiry(customerId);

    const after = await getActiveCarryovers(customerId);
    expect(after).toHaveLength(0);
  });
});
