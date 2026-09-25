// @vitest-environment jsdom
import React from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  budgetAllocations, budgetTransactions, customerBudgetTypeSettings,
  customerCareLevelHistory, customers,
} from "@shared/schema";
import { cleanupCustomer, getAuthCookie } from "../test-utils";

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

/**
 * Die KONSTANTE wird umgelegt, nicht ein Parameter gesetzt.
 *
 * Eine Zwischenfassung reichte `{ resetDisplacesAllSources: true }` an
 * `getBudgetSummary` durch. Das prüfte einen Pfad, den kein produktiver
 * Aufrufer nimmt, und musste `totalAllocatedCents` von Hand nachziehen —
 * „Ein Testhaken ist kein Zeuge".
 *
 * Schlimmer: weil nur dieser eine Weg geprüft wurde, blieb unbemerkt, dass
 * zwei weitere Leser des Schalters gar nicht an ihm hingen. Beim Umlegen der
 * Konstante fiel `allocatedCur` gemessen auf **−1.048,00 €** (Gate 2 zu #180,
 * B1). Mit dieser Fassung wäre es beim Schreiben aufgefallen.
 */
vi.mock("../../server/storage/budget/allocation-window", async (orig) => ({
  ...(await orig<typeof import("../../server/storage/budget/allocation-window")>()),
  RESET_DISPLACES_ALL_SOURCES_DEFAULT: true,
}));

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
let kundeOhneStartwert: number;
let dtoOhne: Record<string, unknown>;
let dtoMit: Record<string, unknown>;

beforeAll(async () => {
  await getAuthCookie();
  const { getBudgetSummary, mergeServed45b } = await import("../../server/storage/budget/summary-queries");
  const { readUnifiedBudgetAvailability } = await import("../../server/storage/budget/unified-reader");

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
      kassenauskunftId: 90001,
      validFrom: `${JAHR}-06-01`, expiresAt: null, notes: "E4K-startwert" },
  ]).returning({ id: budgetAllocations.id, notes: budgetAllocations.notes });
  await db.insert(budgetTransactions).values({
    customerId: kundeId, budgetType: "entlastungsbetrag_45b",
    allocationId: zeilen.find(a => a.notes === "E4K-uebertrag")!.id,
    transactionType: "consumption", amountCents: -VERBRAUCH,
    transactionDate: `${JAHR}-06-10`, description: "E4K-verbrauch",
  });

  /**
   * Die GEGENRICHTUNG kommt aus den Daten, nicht aus einem Flag: ein Kunde
   * ohne Startwert hat nichts, was verdrängen könnte — unabhängig davon, wie
   * die Konstante steht. Das ist die ehrlichere Gegenprobe, weil sie denselben
   * Code-Pfad nimmt wie der Hauptfall.
   */
  const [k2] = await db.insert(customers).values({
    name: "E4-Karte ohne Startwert", address: "Teststr. 6", pflegegrad: 3,
    billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: false,
  } as never).returning({ id: customers.id });
  kundeOhneStartwert = k2.id;
  await db.delete(customerCareLevelHistory).where(eq(customerCareLevelHistory.customerId, kundeOhneStartwert));
  await db.insert(customerBudgetTypeSettings).values({
    customerId: kundeOhneStartwert, budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1,
    monthlyLimitCents: null, yearlyLimitCents: null, validFrom: `${JAHR}-01-01`, validTo: null,
  });
  await db.insert(budgetAllocations).values({
    customerId: kundeOhneStartwert, budgetType: "entlastungsbetrag_45b", year: JAHR, month: null,
    amountCents: UEBERTRAG, source: "carryover",
    validFrom: `${JAHR}-01-01`, expiresAt: `${JAHR}-06-30`, notes: "E4K-nur-uebertrag",
  });

  // KEIN `opts` mehr — beide Seiten laufen ueber denselben produktiven Pfad,
  // die Konstante oben entscheidet.
  const legacyMit = await getBudgetSummary(kundeId, undefined, undefined, STICHTAG);
  const potMit = (await readUnifiedBudgetAvailability(kundeId, STICHTAG)).pots.entlastungsbetrag_45b;
  const legacyOhne = await getBudgetSummary(kundeOhneStartwert, undefined, undefined, STICHTAG);
  const potOhne = (await readUnifiedBudgetAvailability(kundeOhneStartwert, STICHTAG)).pots.entlastungsbetrag_45b;

  dtoMit = mergeServed45b(legacyMit, potMit) as unknown as Record<string, unknown>;
  dtoOhne = mergeServed45b(legacyOhne, potOhne) as unknown as Record<string, unknown>;
}, 180_000);

afterAll(async () => {
  /**
   * Aufraeumen ueber `cleanupCustomer` — anders als die Zwischenfassung, die
   * die Fixture in der geteilten Leg-DB stehen liess (Gate 2 zu #180, S6).
   *
   * NICHT von Hand loeschen: `budget_transactions` traegt einen Trigger
   * `budget_transactions_prevent_delete()`, der jedes DELETE ablehnt
   * (GoBD-Unveraenderlichkeit). Ein erster Versuch mit direkten `db.delete`
   * ist genau daran gescheitert — der Purge-Endpunkt kennt den richtigen Weg.
   */
  await cleanupCustomer(kundeId);
  await cleanupCustomer(kundeOhneStartwert);
});

afterEach(() => cleanup());

async function karteZeigen(dto: unknown, kundeNr: number) {
  aktuellesDto = dto;
  const { BudgetLedgerSection } = await import("@/components/budget/BudgetLedgerSection");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <BudgetLedgerSection customerId={kundeNr} customerName="E4-Karte Probe" onRefresh={() => {}} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("text-45b-allocated")).toBeTruthy(), { timeout: 8000 });
}

describe("§45b-Übersichtskarte — der ersetzte Übertrag steht als ersetzt da", () => {
  it("KA-1 – ohne Startwert: Übertrag als normaler Betrag, kein Ersetzt-Hinweis", async () => {
    // Gegenprobe aus den DATEN: kein Startwert, also nichts zu verdrängen —
    // bei derselben scharfen Konstante.
    await karteZeigen(dtoOhne, kundeOhneStartwert);
    expect(screen.getByTestId("text-45b-carryover").textContent).toContain("1.179,00");
    expect(
      screen.queryByTestId("text-45b-carryover-verdraengt"),
      "ein durchgestrichener Betrag erscheint, obwohl nichts verdrängt wurde",
    ).toBeNull();
    expect(
      screen.queryByTestId("text-45b-carryover-ersetzt"),
      "ein Ersetzt-Hinweis erscheint, obwohl nichts verdrängt wurde",
    ).toBeNull();
  }, 60_000);

  it("KA-2 – mit Verdrängung: zugewiesen sinkt UND der Übertrag ist als ersetzt gekennzeichnet", async () => {
    await karteZeigen(dtoMit, kundeId);

    expect(screen.getByTestId("text-45b-allocated").textContent).toContain("131,00");

    // Der Kern: der Betrag bleibt lesbar, mit Grund daneben.
    const verdraengt = screen.getByTestId("text-45b-carryover-verdraengt");
    expect(verdraengt.textContent, "der ersetzte Übertrag ist verschwunden statt gekennzeichnet")
      .toContain("1.179,00");
    expect(verdraengt.className, "der ersetzte Betrag ist nicht durchgestrichen")
      .toContain("line-through");
    // Und der ZÄHLENDE Übertrag steht weiter da (hier 0,00) — bei
    // Teil-Verdrängung wäre er sonst vom Schirm (Gate 2 zu #180, S3).
    expect(screen.getByTestId("text-45b-carryover"), "der zählende Übertrag fehlt").toBeTruthy();
    expect(
      screen.getByTestId("text-45b-carryover-ersetzt").textContent,
      "der Grund fehlt — dann bleibt „wo ist mein Übertrag hin?“",
    ).toContain("ersetzt durch Startwert 06/2026");
  }, 60_000);

  it("KA-3 – die Verbrauchs-Zeile nennt BEIDE Fälle, nicht nur den Verfall", async () => {
    // Der Verbrauch liegt am 10.06., der Reset zum 01.06. — also NICHT in einem
    // abgeschlossenen Zeitraum. Die frühere Beschriftung „aus abgeschlossenem
    // Zeitraum" war dafür irreführend.
    await karteZeigen(dtoMit, kundeId);
    const zeile = screen.getByTestId("text-45b-used-expired");
    expect(zeile.textContent).toContain("500,00");
    expect(zeile.textContent, "die Beschriftung nennt den Ersetzt-Fall nicht")
      .toContain("verfallenes oder ersetztes Guthaben");
  }, 60_000);
});
