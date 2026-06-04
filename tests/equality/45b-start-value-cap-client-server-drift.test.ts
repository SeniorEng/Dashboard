/**
 * Task #980 — Drift-Detektor: §45b-Startwert-Obergrenze CLIENT-Anzeige vs.
 * SERVER-Durchsetzung.
 *
 * Die §45b-Startwert-Obergrenze (`initial_balance`) wird an ZWEI Stellen
 * berechnet, beide über dieselbe reine SSoT `max45bStartValueCents`
 * (`shared/domain/budget/carryover-eligibility.ts`):
 *
 *  - CLIENT (`client/src/components/budget/BudgetTypeSettings.tsx`): zeigt den
 *    Cap als Label an ("Maximal X € möglich …") und blockt das Speichern, bevor
 *    der Round-Trip startet.
 *  - SERVER (`server/routes/budget.ts`, POST /budget/:id/initial-balance/:type):
 *    erzwingt denselben Cap und antwortet sonst mit 400
 *    (`BUDGET_45B_START_VALUE_EXCEEDED`).
 *
 * Beide leiten den Accrual-Anker aus DERSELBEN Pflegegrad-Historie ab, aber über
 * UNTERSCHIEDLICHE Ausdrücke:
 *  - Client: frühestes `validFrom` (`history.map(validFrom).sort()[0]`),
 *    Fallback = Startmonat.
 *  - Server: letztes Element der `desc(validFrom)`-sortierten Historie
 *    (`history[history.length - 1].validFrom`) — also ebenfalls das früheste —,
 *    Fallback = Startmonat.
 *
 * Solange beide Ausdrücke denselben Anker liefern, ist der angezeigte Cap ==
 * dem durchgesetzten Cap. Dieser Test kodiert beide Ableitungen und schlägt
 * fehl, sobald eine Seite ihre Anker-Wahl oder die Fallback-Regel ändert
 * (Anzeige ≠ Buchung). Reiner Wert-Test, keine DB/kein Server.
 */
import { describe, it, expect } from "vitest";
import {
  max45bStartValueCents,
  resolve45bAccrualAnchor,
} from "@shared/domain/budget/carryover-eligibility";
import { BUDGET_45B_MAX_MONTHLY_CENTS } from "@shared/domain/budgets";

/**
 * Eine Pflegegrad-Historienzeile (nur das fürs Anker-Mapping relevante Feld).
 * Die Test-Szenarien geben die Zeilen in CHRONOLOGISCHER Reihenfolge (ältester
 * zuerst) an; `toDesc` dreht sie in die `desc(validFrom)`-Ordnung, die
 * `getCustomerCareLevelHistory` real liefert.
 */
type CareLevelRow = { validFrom: string };

/**
 * Task #981 — Beide Seiten leiten den Accrual-Anker jetzt über DIESELBE reine
 * SSoT `resolve45bAccrualAnchor` ab (reihenfolge-unabhängig). Der Test ruft
 * dieselbe Funktion einmal mit der chronologisch sortierten (Client-Sicht) und
 * einmal mit der `desc(validFrom)`-sortierten Historie (Server-/DB-Sicht) auf —
 * das Ergebnis MUSS identisch sein, unabhängig von der Sortierung.
 */
function clientCapCents(history: CareLevelRow[], month: string): number {
  const validFromDate = `${month}-01`;
  const accrualAnchor = resolve45bAccrualAnchor(history, validFromDate);
  return max45bStartValueCents(accrualAnchor, validFromDate);
}

function serverCapCents(historyDesc: CareLevelRow[], month: string): number {
  const validFromDate = `${month}-01`;
  const accrualAnchor = resolve45bAccrualAnchor(historyDesc, validFromDate);
  return max45bStartValueCents(accrualAnchor, validFromDate);
}

/** Dreht eine chronologische Historie in die `desc(validFrom)`-DB-Ordnung. */
function toDesc(historyChrono: CareLevelRow[]): CareLevelRow[] {
  return [...historyChrono].sort((a, b) => (a.validFrom < b.validFrom ? 1 : -1));
}

describe("Drift §45b-Startwert-Cap — Client-Anzeige == Server-Durchsetzung (Task #980)", () => {
  const cases: Array<{
    name: string;
    // Pflegegrad-Historie in CHRONOLOGISCHER Reihenfolge (ältester zuerst).
    historyChrono: CareLevelRow[];
    month: string; // Startmonat "YYYY-MM"
    expectedCents: number;
  }> = [
    {
      name: "Leere Historie → Anker = Startmonat (Onboarding) → 131 €",
      historyChrono: [],
      month: "2026-03",
      expectedCents: BUDGET_45B_MAX_MONTHLY_CENTS,
    },
    {
      name: "Anker im selben Jahr (Januar), Startwert Mai → Jan..Mai = 5 Monate",
      historyChrono: [{ validFrom: "2026-01-10" }],
      month: "2026-05",
      expectedCents: BUDGET_45B_MAX_MONTHLY_CENTS * 5,
    },
    {
      name: "Anker in einem Vorjahr → ab Januar → Jan..Apr = 4 Monate",
      historyChrono: [{ validFrom: "2023-08-01" }],
      month: "2026-04",
      expectedCents: BUDGET_45B_MAX_MONTHLY_CENTS * 4,
    },
    {
      name: "Mehrere Historienzeilen → FRÜHESTE zählt (Jan 2026 statt Aug 2026)",
      historyChrono: [
        { validFrom: "2026-01-15" },
        { validFrom: "2026-08-01" },
      ],
      month: "2026-09",
      expectedCents: BUDGET_45B_MAX_MONTHLY_CENTS * 9,
    },
    {
      name: "Anker beginnt erst NACH dem Startmonat im Startjahr → 0",
      historyChrono: [{ validFrom: "2026-06-01" }],
      month: "2026-03",
      expectedCents: 0,
    },
    {
      name: "Anker liegt komplett in einem späteren Jahr (Vorjahr-Anker-Fall) → 0",
      historyChrono: [{ validFrom: "2027-01-01" }],
      month: "2026-05",
      expectedCents: 0,
    },
  ];

  for (const c of cases) {
    it(`[${c.name}] Client-Cap == Server-Cap == ${c.expectedCents} ct`, () => {
      const clientCents = clientCapCents(c.historyChrono, c.month);
      const serverCents = serverCapCents(toDesc(c.historyChrono), c.month);

      // Kern-Invariante: Beide Pfade leiten denselben Cap ab (Anzeige == Buchung).
      expect(
        clientCents,
        `Client-Cap (${clientCents}) ≠ Server-Cap (${serverCents}) — ` +
          `Anzeige würde von der 400-Schwelle abweichen`,
      ).toBe(serverCents);

      // Beide stimmen mit dem fachlich erwarteten Cap überein (pinnt die SSoT).
      expect(clientCents).toBe(c.expectedCents);
      expect(serverCents).toBe(c.expectedCents);
    });
  }

  it("Empty-Care-Level-History-Fallback: Anker = Startmonat → exakt 131 € (eine Monatsaufstockung)", () => {
    expect(clientCapCents([], "2026-07")).toBe(BUDGET_45B_MAX_MONTHLY_CENTS);
    expect(serverCapCents([], "2026-07")).toBe(BUDGET_45B_MAX_MONTHLY_CENTS);
  });

  it("Prior-Year-Anker (Anker erst nach dem Startmonat) → 0 (kein Startwert erlaubt)", () => {
    const history = [{ validFrom: "2027-04-01" }];
    expect(clientCapCents(history, "2026-08")).toBe(0);
    expect(serverCapCents(toDesc(history), "2026-08")).toBe(0);
  });
});
