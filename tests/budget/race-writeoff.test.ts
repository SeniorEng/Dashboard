import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { getAuthCookie } from "../test-utils";
import { db } from "../../server/lib/db";
import { budgetAllocations, budgetTransactions } from "@shared/schema";
import {
  setupBudgetScenario,
  type BudgetScenarioHandle,
} from "../helpers/budget-scenarios";
import { runInParallel } from "../helpers/race";
import { freezeTime, thawTime } from "../helpers/frozen-clock";
import { expirySubjectAnchor } from "../helpers/billing-month";
import { addDays } from "@shared/utils/datetime";
import { processExpiredCarryover } from "../../server/storage/budget/allocation-storage";

const ORIGINAL_TZ = process.env.TZ;

describe("Race K7 — paralleler Write-Off auf abgelaufenen §45b-Carryover", () => {
  let scenario: BudgetScenarioHandle;

  beforeAll(async () => {
    // Berlin als deterministische Zeitzone — `processExpiredCarryover`
    // vergleicht via `todayISO()` lokale Tage, sonst wäre der Test unter
    // UTC-Containern wertlos (analog tests/budget/timezone.test.ts).
    process.env.TZ = "Europe/Berlin";
    await getAuthCookie();
  });

  afterEach(async () => {
    if (scenario) {
      await scenario.cleanup();
    }
    thawTime();
    if (ORIGINAL_TZ === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = ORIGINAL_TZ;
    }
  });

  it("RACE-K7 — Zwei parallele processExpiredCarryover-Aufrufe erzeugen genau einen write_off mit korrektem Betrag", async () => {
    const carryoverAmountCents = 5000;
    // Frist-SUBJEKT: Der Test prüft die Verfallsmechanik selbst, der Anker muss
    // deshalb zur eingefrorenen Zeit passen — nicht umgekehrt. Zieljahr liegt im
    // nächsten Kalenderjahr, die Frist also real in der Zukunft; sonst schreibt
    // der App-Server (eigener Prozess, reale Uhr) den Übertrag schon während
    // `setupBudgetScenario` ab und die Vorab-Sanity unten fällt. Details im
    // Docstring von `expirySubjectAnchor`.
    const { sourceYear, targetYear, expiresAt, frozenJustAfterExpiry } = expirySubjectAnchor();

    scenario = await setupBudgetScenario({
      customerNamePrefix: "RACE-K7",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
        { type: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
      carryover: { type: "entlastungsbetrag_45b", amountCents: carryoverAmountCents, year: sourceYear },
    });

    // Genau eine §45b-carryover-Allokation existiert, Frist exakt der 30.06.
    // des Zieljahres (§45b Abs. 3 — die Frist selbst bleibt unangetastet).
    const allocations = await db
      .select()
      .from(budgetAllocations)
      .where(
        and(
          eq(budgetAllocations.customerId, scenario.customerId),
          eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
          eq(budgetAllocations.source, "carryover"),
        ),
      );
    expect(allocations).toHaveLength(1);
    const carryAlloc = allocations[0];
    expect(carryAlloc.amountCents).toBe(carryoverAmountCents);
    expect(carryAlloc.expiresAt).toBe(expiresAt);
    expect(expiresAt).toBe(`${targetYear}-06-30`);

    // Vorab-Sanity: Es darf noch keinerlei write_off für die Allokation geben.
    const preWriteOffs = await db
      .select({ c: sql<number>`COUNT(*)` })
      .from(budgetTransactions)
      .where(
        and(
          eq(budgetTransactions.allocationId, carryAlloc.id),
          eq(budgetTransactions.transactionType, "write_off"),
        ),
      );
    expect(Number(preWriteOffs[0]?.c ?? 0)).toBe(0);

    // Frist 30.06. abgelaufen → 01.07. 00:01 MESZ des Zieljahres. Ab hier ist
    // die Uhr des TESTPROZESSES maßgeblich; `processExpiredCarryover` wird
    // unten in-process gerufen, dort wirkt der Freeze.
    freezeTime(frozenJustAfterExpiry);

    // Echte Race: zwei parallele Storage-Aufrufe in derselben Mikrotask.
    // Ohne die partielle UNIQUE auf (customer_id, allocation_id) WHERE
    // transaction_type='write_off' würde jeder Lauf den existsCheck umgehen
    // und einen eigenen write_off einfügen — Doppel-Buchung.
    const results = await runInParallel([
      async (arrive) => {
        await arrive();
        return processExpiredCarryover(scenario.customerId);
      },
      async (arrive) => {
        await arrive();
        return processExpiredCarryover(scenario.customerId);
      },
    ]);

    // Beide Calls müssen sauber durchlaufen — die UNIQUE-Constraint löst per
    // ON CONFLICT DO NOTHING und poisoniert die Transaktion nicht.
    const failures = results.filter((r) => r.status === "rejected");
    expect(
      failures,
      `Race-Calls sollen nicht hart fehlschlagen, war: ${failures
        .map((f) => String((f as PromiseRejectedResult).reason?.message ?? f))
        .join(" | ")}`,
    ).toHaveLength(0);

    // Genau 1 write_off-Transaktion für die Allokation.
    const writeOffs = await db
      .select()
      .from(budgetTransactions)
      .where(
        and(
          eq(budgetTransactions.customerId, scenario.customerId),
          eq(budgetTransactions.allocationId, carryAlloc.id),
          eq(budgetTransactions.transactionType, "write_off"),
        ),
      );
    expect(writeOffs).toHaveLength(1);
    expect(writeOffs[0].amountCents).toBe(-carryoverAmountCents);
    expect(writeOffs[0].budgetType).toBe("entlastungsbetrag_45b");
    // Die Verfallsbuchung ist auf den ERSTEN Tag NACH der Frist datiert
    // (30.06. → 01.07.), NICHT auf die Frist selbst — siehe die ausführliche
    // Begründung an `writeOffDate` in `allocation-storage.ts`: der 30.06.
    // gehört noch zum nutzbaren Fenster, ein auf ihn datierter Write-Off
    // leerte den Topf an seinem letzten gültigen Tag und blockierte eine
    // legitime 30.06.-Buchung.
    //
    // Die bisherige Erwartung stand als Literal `"2026-06-30"` hier und
    // beschrieb den Stand VOR dieser bewussten Korrektur. Sie war nie
    // gescheitert, weil der Test schon an der Vorab-Sanity oben abbrach. Statt
    // eines neuen Literals wird jetzt die REGEL geprüft (`Frist + 1 Tag`),
    // damit die Erwartung nicht erneut von der Produktivlogik wegdriften kann.
    expect(writeOffs[0].transactionDate).toBe(addDays(expiresAt, 1));
    expect(writeOffs[0].transactionDate).toBe(`${targetYear}-07-01`);
  });
});
