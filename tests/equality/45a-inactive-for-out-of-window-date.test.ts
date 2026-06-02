/**
 * Task #915 — §45a `isCurrentlyActive` muss den Stichtag respektieren.
 *
 * Seit Task #911 akzeptieren `getBudgetSummary*` einen optionalen `asOfDate`.
 * `getBudgetSummary45a` liest die zum Stichtag gültige Topf-Konfiguration über
 * `readBudgetTypeSettings({ kind: "forDate", asOfDate })`. Liegt der Stichtag
 * VOR dem `validFrom` (oder NACH dem `validTo`) der §45a-Zeile, filtert dieser
 * Lookup die Zeile heraus — `s45a` ist dann `undefined`.
 *
 * Vorher defaultete der `!s45a ? true`-Zweig auf AKTIV und meldete einen
 * noch-nicht (bzw. nicht-mehr) konfigurierten §45a-Topf fälschlich als aktiv
 * für den abgefragten Stichtag. Dieser Test pflanzt eine §45a-Zeile, die erst
 * in der ZUKUNFT wirksam wird (`validFrom` = erster Tag des nächsten Monats),
 * und erwartet, dass `getBudgetSummary45a` für HEUTE `isCurrentlyActive=false`
 * liefert.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { getAuthCookie, runCleanup } from "../test-utils";
import { todayISO } from "@shared/utils/datetime";
import {
  setupBudgetScenario,
  type BudgetScenarioHandle,
} from "../helpers/budget-scenarios";
import { getBudgetSummary45a } from "../../server/storage/budget/summary-queries";

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

function firstOfNextMonth(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1; // 1-based
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-01`;
}

describe("§45a Stichtag — nicht wirksam ⇒ isCurrentlyActive=false (Task #915)", () => {
  it("§45a validFrom liegt in der Zukunft ⇒ heute NICHT aktiv", async () => {
    const futureValidFrom = firstOfNextMonth();
    const scenario: BudgetScenarioHandle = await setupBudgetScenario({
      customerNamePrefix: "TASK915-45A-FUTURE",
      pflegegrad: 2,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: false },
        // §45a erst ab dem nächsten Monatsersten wirksam → für HEUTE filtert
        // readBudgetTypeSettings(forDate, today) die Zeile heraus.
        {
          type: "umwandlung_45a",
          priority: 2,
          enabled: true,
          validFrom: futureValidFrom,
        },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
      ],
      appointments: [],
    });
    try {
      const today = todayISO();
      const summaryToday = await getBudgetSummary45a(
        scenario.customerId,
        undefined,
        undefined,
        undefined,
        today,
      );
      expect(
        summaryToday.isCurrentlyActive,
        `§45a darf für HEUTE (${today}) nicht aktiv sein, weil die Zeile erst ` +
          `ab ${futureValidFrom} gilt und der forDate-Lookup sie herausfiltert. ` +
          `Vorher defaultete der !s45a-Zweig fälschlich auf aktiv=true.`,
      ).toBe(false);

      // Gegenprobe: an einem Stichtag im Wirksamkeits-Fenster IST §45a aktiv.
      const summaryFuture = await getBudgetSummary45a(
        scenario.customerId,
        undefined,
        undefined,
        undefined,
        futureValidFrom,
      );
      expect(
        summaryFuture.isCurrentlyActive,
        `§45a muss ab ${futureValidFrom} (validFrom) aktiv sein.`,
      ).toBe(true);
    } finally {
      await scenario.cleanup();
    }
  }, 120_000);
});
