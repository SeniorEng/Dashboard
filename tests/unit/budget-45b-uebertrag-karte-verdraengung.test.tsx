// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  budgetAllocations, budgetTransactions, customerBudgetTypeSettings,
  customerCareLevelHistory, customers,
} from "@shared/schema";

/**
 * P1 `6hXp9qMrXH2WGVVG`, E4 an der ZWEITEN Stelle — die Übersichtskarte.
 *
 * ── Der gemessene Fall ──────────────────────────────────────────────────
 * E4 hat den ersetzten Übertrag in den Budget-EINSTELLUNGEN gekennzeichnet.
 * Auf der Übersichts-KARTE stand er unverändert weiter: gerendert zeigte sie
 * mit scharfer Verdrängung „Gesamt zugewiesen 131,00 €" und direkt daneben
 * „Übertrag 1.179,00 €" — der Widerspruch, gegen den das ganze Ticket läuft,
 * eine Schicht höher.
 *
 * Ursache: `carryoverCents` kam aus einer Abfrage, die den Schalter nicht las,
 * während `totalAllocatedCents` ihm folgte.
 *
 * ── Warum die DTOs aus den echten Server-Funktionen kommen ──────────────
 * Ein von Hand getipptes DTO kodiert einen Zustand, den der Server womöglich
 * gar nicht erzeugen kann (die `MA-3`/`MA-4`-Falle: Fixture mit veralteter
 * Mathematik, Anzeige-Test per Konstruktion blind). Hier baut `beforeAll` die
 * Kunden-Zeilen und lässt `getBudgetSummary` + `mergeServed45b` rechnen —
 * dieselben Funktionen, die die Route ruft.
 *
 * ── Warum der Verbrauch auf den 10.06. datiert ist ──────────────────────
 * Ein Verbrauch VOR dem Reset-Stichtag wird schon ohne Flag ausgeblendet
 * (#1812). Die erste Fassung dieser Fixture buchte auf den 10.03. — beide
 * Seiten lieferten dann identisch `angerechnet=0`, und der Lauf sagte nichts.
 * Das ist der erste `VD-5` in anderer Form: eine Konstellation, in der die
 * geprüften Größen gar nicht auseinanderlaufen können.
 */

const JAHR = 2026;
const STICHTAG = `${JAHR}-06-15`;
const UEBERTRAG = 1_179_00;
const STARTWERT = 131_00;
const VERBRAUCH = 500_00;

let aktuellesDto: unknown = null;

vi.mock("@/lib/api/client", () => ({
  api: {
    get: vi.fn(async (path: string) => {
      if (path.includes("/type-settings")) {
        return { success: true, data: [{
          budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1,
          validFrom: null, validTo: null,
        }] };
      }
      if (path.includes("/transactions")) return { success: true, data: [] };
      if (path.includes("/overview")) {
        return { success: true, data: {
          entlastungsbetrag45b: aktuellesDto, umwandlung45a: null, ersatzpflege39_42a: null,
        } };
      }
      return { success: true, data: null };
    }),
  },
  unwrapResult: (r: { data: unknown }) => r.data,
}));

let kundeId: number;
let dtoOhne: Record<string, unknown>;
let dtoMit: Record<string, unknown>;

beforeAll(async () => {
  const { getBudgetSummary, mergeServed45b } = await import("../../server/storage/budget/summary-queries");
  const { readUnifiedBudgetAvailability } = await import("../../server/storage/budget/unified-reader");
  const { calculateAllocatedCents } = await import("../../server/storage/budget/allocation-storage");

  const [k] = await db.insert(customers).values({
    name: "E4-Karte Probe", address: "Teststr. 5", pflegegrad: 3,
    billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: false,
  } as never).returning({ id: customers.id });
  kundeId = k.id;
  await db.delete(customerCareLevelHistory).where(eq(customerCareLevelHistory.customerId, kundeId));
  await db.insert(customerBudgetTypeSettings).values({
    customerId: kundeId, budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1,
    monthlyLimitCents: null, yearlyLimitCents: null, validFrom: `${JAHR}-01-01`, validTo: null,
  });
  const zeilen = await db.insert(budgetAllocations).values([
    { customerId: kundeId, budgetType: "entlastungsbetrag_45b", year: JAHR, month: null,
      amountCents: UEBERTRAG, source: "carryover",
      validFrom: `${JAHR}-01-01`, expiresAt: `${JAHR}-06-30`, notes: "E4K-uebertrag" },
    { customerId: kundeId, budgetType: "entlastungsbetrag_45b", year: JAHR, month: 6,
      amountCents: STARTWERT, source: "initial_balance",
      validFrom: `${JAHR}-06-01`, expiresAt: null, notes: "E4K-startwert" },
  ]).returning({ id: budgetAllocations.id, notes: budgetAllocations.notes });
  await db.insert(budgetTransactions).values({
    customerId: kundeId, budgetType: "entlastungsbetrag_45b",
    allocationId: zeilen.find(a => a.notes === "E4K-uebertrag")!.id,
    transactionType: "consumption", amountCents: -VERBRAUCH,
    transactionDate: `${JAHR}-06-10`, description: "E4K-verbrauch",
  });

  const legacyOhne = await getBudgetSummary(kundeId, undefined, undefined, STICHTAG);
  const legacyMit = await getBudgetSummary(kundeId, undefined, undefined, STICHTAG, {
    resetDisplacesAllSources: true,
  });
  const potOhne = (await readUnifiedBudgetAvailability(kundeId, STICHTAG)).pots.entlastungsbetrag_45b;
  const potMit = (await readUnifiedBudgetAvailability(kundeId, STICHTAG, undefined, {
    resetDisplacesAllSources: true,
  })).pots.entlastungsbetrag_45b;
  // Der Default-Umschwung aendert in `getBudgetSummary` genau EIN weiteres
  // Feld: `totalAllocatedCents` folgt dem Default in `calculateAllocated45b`.
  const allocMit = await calculateAllocatedCents(kundeId, "entlastungsbetrag_45b", {
    asOfDate: STICHTAG, resetDisplacesAllSources: true,
  });

  dtoOhne = mergeServed45b(legacyOhne, potOhne) as unknown as Record<string, unknown>;
  dtoMit = mergeServed45b(
    { ...legacyMit, totalAllocatedCents: allocMit }, potMit,
  ) as unknown as Record<string, unknown>;
}, 180_000);

afterEach(() => cleanup());

async function karteZeigen(dto: unknown) {
  aktuellesDto = dto;
  const { BudgetLedgerSection } = await import("@/components/budget/BudgetLedgerSection");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <BudgetLedgerSection customerId={kundeId} customerName="E4-Karte Probe" onRefresh={() => {}} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("text-45b-allocated")).toBeTruthy(), { timeout: 8000 });
}

describe("§45b-Übersichtskarte — der ersetzte Übertrag steht als ersetzt da", () => {
  it("KA-1 – ohne Verdrängung: Übertrag als normaler Betrag, kein Ersetzt-Hinweis", async () => {
    await karteZeigen(dtoOhne);
    expect(screen.getByTestId("text-45b-allocated").textContent).toContain("1.310,00");
    expect(screen.getByTestId("text-45b-carryover").textContent).toContain("1.179,00");
    expect(
      screen.queryByTestId("text-45b-carryover-ersetzt"),
      "ein Ersetzt-Hinweis erscheint, obwohl nichts verdrängt wurde",
    ).toBeNull();
  }, 60_000);

  it("KA-2 – mit Verdrängung: zugewiesen sinkt UND der Übertrag ist als ersetzt gekennzeichnet", async () => {
    await karteZeigen(dtoMit);

    expect(screen.getByTestId("text-45b-allocated").textContent).toContain("131,00");

    // Der Kern: der Betrag bleibt lesbar, mit Grund daneben.
    const uebertrag = screen.getByTestId("text-45b-carryover");
    expect(uebertrag.textContent, "der ersetzte Übertrag ist verschwunden statt gekennzeichnet")
      .toContain("1.179,00");
    expect(uebertrag.className, "der ersetzte Betrag ist nicht durchgestrichen")
      .toContain("line-through");
    expect(
      screen.getByTestId("text-45b-carryover-ersetzt").textContent,
      "der Grund fehlt — dann bleibt „wo ist mein Übertrag hin?“",
    ).toContain("ersetzt durch Startwert 06/2026");
  }, 60_000);

  it("KA-3 – die Verbrauchs-Zeile nennt BEIDE Fälle, nicht nur den Verfall", async () => {
    // Der Verbrauch liegt am 10.06., der Reset zum 01.06. — also NICHT in einem
    // abgeschlossenen Zeitraum. Die frühere Beschriftung „aus abgeschlossenem
    // Zeitraum" war dafür irreführend.
    await karteZeigen(dtoMit);
    const zeile = screen.getByTestId("text-45b-used-expired");
    expect(zeile.textContent).toContain("500,00");
    expect(zeile.textContent, "die Beschriftung nennt den Ersetzt-Fall nicht")
      .toContain("verfallenes oder ersetztes Guthaben");
  }, 60_000);
});
