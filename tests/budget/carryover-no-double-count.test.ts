/**
 * Task #601 — Regression: §45b-Carryover darf bei Kundenanlage über den
 * Wizard NICHT doppelt gezählt werden.
 *
 * Vorher: POST /initial-budget schrieb die manuelle Carryover-Zeile mit
 * `year = sourceYear`, `ensureYearlyCarryover45b` deduplizierte aber gegen
 * `year = targetYear`. Folge: beim ersten `PUT /type-settings` (oder einem
 * anderen Pfad, der `syncCarryoverAndExpiry` triggert) legte der Auto-Pfad
 * ein zweites Carryover (12 × monthly = 1572 €) an → Budget-Overview zeigte
 * 3144 € statt der eingegebenen 1572 €.
 *
 * Diese Suite fährt den realen Wizard-Pfad (POST /initial-budget +
 * PUT /type-settings) nach und vergleicht:
 *   - `getTotalCarryoverCents` (intern, Lifecycle-Engine) == eingegebener Betrag
 *   - `carryoverCents` aus `GET /api/customers/:id/budget-overview` == eingegeben
 *
 * Toleranz 0 — jede Cent-Drift wäre die alte Doppelzählung.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetAllocations } from "@shared/schema";
import {
  apiGet,
  apiPost,
  apiPut,
  createTestCustomer,
  getAuthCookie,
  runCleanup,
} from "../test-utils";
import { getTotalCarryoverCents } from "../../server/storage/budget/summary-queries";

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

interface BudgetOverviewResponse {
  entlastungsbetrag45b: {
    carryoverCents: number;
    totalAllocatedCents: number;
    availableCents: number;
  };
}

describe("Task #601 — §45b-Carryover wird nicht doppelt gezählt", () => {
  it("Wizard-Flow (initial-budget + type-settings) liefert exakt den eingegebenen Carryover", async () => {
    const customer = await createTestCustomer({
      vorname: "T601",
      nachname: `Carryover_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
    });
    const customerId = customer.id as number;

    const carryoverCents = 157_200; // 1.572 € — Wert aus dem Bug-Report

    // Frist-STÖRFAKTOR: Prüfgegenstand ist die Doppelzählung, nicht der Verfall.
    // Ein §45b-Übertrag für Zieljahr Y gilt aber nur vom 01.01. bis zum 30.06.
    // dieses Jahres — ab Juli trägt er per Gesetz 0 bei, und BEIDE Pfade unten
    // lieferten 0 statt 157200 (gemessen). Statt die Erwartungen aufzuweichen,
    // bekommt der Test einen STICHTAG im Gültigkeitsfenster.
    //
    // Das JAHR muss dabei aus der ECHT-Uhr kommen, NICHT aus `carryoverAnchor()`:
    // `POST /initial-budget` bodet den §45b-Anker serverseitig auf das laufende
    // Jahr der Echt-Uhr (`server/services/budget-initial-setup.ts:86-92`,
    // `floorAutoAnchor45bToCurrentYear`) und leitet daraus `year`, `validFrom`
    // und `expiresAt` der Carryover-Zeile ab — was der Test als
    // `budgetStartDate` schickt, ist dafür unerheblich. Ein Anker-Jahr, das am
    // 01.01. um eins zurückrollt, liefe deshalb gegen die Server-Wahrheit und
    // machte den Test an genau diesem Tag rot.
    //
    // Bewusst auch NICHT `toISOString()`: das rechnet nach UTC um und lieferte
    // in den frühen Stunden des 01.01. den 31.12. des Vorjahres — dieselbe
    // Null-Falle, nur von der anderen Seite.
    const now = new Date();
    const year = now.getFullYear();
    const todayLocal = `${year}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    // Im H1 ist „heute" selbst der ehrlichste Stichtag; ab dem 01.07. weichen
    // wir auf Mitte Juni aus, den spätesten unbedenklichen Punkt im Fenster.
    const asOf = todayLocal <= `${year}-06-30` ? todayLocal : `${year}-06-15`;
    const budgetStartDate = `${year}-01-01`;

    // 1) Wizard-Schritt 1: initial-budget mit Carryover
    const initRes = await apiPost(
      `/api/budget/${customerId}/initial-budget`,
      {
        budgetType: "entlastungsbetrag_45b",
        currentMonthAmountCents: 0,
        carryoverAmountCents: carryoverCents,
        budgetStartDate,
      },
    );
    expect([200, 201]).toContain(initRes.status);

    // 2) Wizard-Schritt 2: type-settings PUT (löst syncCarryoverAndExpiry aus,
    //    der vorher den zweiten Carryover anlegte).
    const typeRes = await apiPut(`/api/budget/${customerId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", enabled: true,  priority: 1, monthlyLimitCents: null, yearlyLimitCents: null },
        { budgetType: "umwandlung_45a",        enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null },
        { budgetType: "ersatzpflege_39_42a",   enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null },
      ],
    });
    expect(typeRes.status).toBe(200);

    // 3) Mehrfaches type-settings PUT darf den Carryover NICHT vermehren.
    for (let i = 0; i < 3; i++) {
      const r = await apiPut(`/api/budget/${customerId}/type-settings`, {
        settings: [
          { budgetType: "entlastungsbetrag_45b", enabled: true,  priority: 1, monthlyLimitCents: null, yearlyLimitCents: null },
          { budgetType: "umwandlung_45a",        enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null },
          { budgetType: "ersatzpflege_39_42a",   enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null },
        ],
      });
      expect(r.status).toBe(200);
    }

    // 4) Interner Pfad: getTotalCarryoverCents (Lifecycle-Engine-Anker, summiert
    //    alle aktiven Carryover-Allokationen; da hier nur §45b aktiv ist, muss
    //    der Wert exakt dem eingegebenen Betrag entsprechen).
    const internalTotal = await getTotalCarryoverCents(customerId, asOf);
    expect(internalTotal).toBe(carryoverCents);

    // 5) Anzeige-Pfad: budget-overview API muss denselben Wert zeigen — zum
    //    SELBEN Stichtag wie der interne Pfad oben. `/overview` unterstützt
    //    `?date=` (Task #911, `parseAsOfDateQuery`); der Test bleibt damit ein
    //    echter API-Test und muss nicht auf einen In-Process-Reader ausweichen.
    //    Wichtig ist gerade die Gleichheit BEIDER Pfade — das war der Bug.
    const overviewRes = await apiGet<BudgetOverviewResponse>(
      `/api/budget/${customerId}/overview?date=${asOf}`,
    );
    expect(overviewRes.status).toBe(200);
    expect(overviewRes.data.entlastungsbetrag45b.carryoverCents).toBe(carryoverCents);

    // 6) Roh-DB-Check: genau eine lebende Carryover-Zeile mit korrekter Year-
    //    Konvention (`year = Zieljahr`).
    const liveCarryovers = await db
      .select()
      .from(budgetAllocations)
      .where(
        and(
          eq(budgetAllocations.customerId, customerId),
          eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
          eq(budgetAllocations.source, "carryover"),
          isNull(budgetAllocations.deletedAt),
        ),
      );
    expect(liveCarryovers).toHaveLength(1);
    expect(liveCarryovers[0].amountCents).toBe(carryoverCents);
    expect(liveCarryovers[0].year).toBe(year);
    expect(liveCarryovers[0].validFrom).toBe(`${year}-01-01`);
    expect(liveCarryovers[0].expiresAt).toBe(`${year}-06-30`);
  });
});
