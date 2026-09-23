// @vitest-environment jsdom
import React from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  budgetAllocations, customerBudgetTypeSettings, customerCareLevelHistory, customers,
} from "@shared/schema";
import { apiGet, cleanupCustomer, getAuthCookie } from "../test-utils";

/**
 * Pflichtwarnung beim Startwert, der einen noch gültigen Übertrag verdrängt.
 *
 * ── Warum es sie gibt (Alrik, 23.09.2026, mit dem Scharfschalten) ───────
 * Zwei einzeln entschiedene Regeln ergeben zusammen eine Folge, die niemand
 * ausgesprochen hatte: **0 € ist eine festgestellte Null** (22.09.) und
 * **`<=` für die Inventur zum 01.01.** (22.09.). Ein 0-€-Startwert zum
 * Jahresanfang löscht damit den Übertrag vollständig.
 *
 * Alriks Auflage: dieselbe Form wie die 0-€-Übertrags-Warnung, aber **mit dem
 * Betrag, der wegfällt**. Wer einen Startwert setzt, soll nicht erst an der
 * Karte merken, dass 1.179,00 € verschwunden sind.
 *
 * ── Der Betrag kommt vom SERVER ────────────────────────────────────────
 * Welche Überträge verdrängt werden, entscheidet `displacedByReset`. Würde der
 * Client das aus den Übertrags-Zeilen ableiten, stünde die Regel ein viertes
 * Mal im Code — an der Stelle, an der sie niemand als Regel erkennt
 * (Drei-Schichten-Pflicht, #164). Deshalb liest die Warnung, statt zu rechnen.
 *
 * Die DTOs hier kommen aus demselben Handler-Code wie im Betrieb: der Test
 * ruft den Endpunkt über die gemockte API-Schicht, die Daten stehen in der DB.
 */

const JAHR = 2026;
const UEBERTRAG = 1_179_00;

let kundeId: number;
beforeAll(async () => {
  await getAuthCookie();
  const [k] = await db.insert(customers).values({
    name: "Warnung Probe", address: "Teststr. 7", pflegegrad: 3,
    billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: false,
  } as never).returning({ id: customers.id });
  kundeId = k.id;
  await db.delete(customerCareLevelHistory).where(eq(customerCareLevelHistory.customerId, kundeId));
  await db.insert(customerBudgetTypeSettings).values({
    customerId: kundeId, budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1,
    monthlyLimitCents: null, yearlyLimitCents: null, validFrom: `${JAHR}-01-01`, validTo: null,
  });
  await db.insert(budgetAllocations).values([
    {
      customerId: kundeId, budgetType: "entlastungsbetrag_45b", year: JAHR, month: null,
      amountCents: UEBERTRAG, source: "carryover",
      validFrom: `${JAHR}-01-01`, expiresAt: `${JAHR}-06-30`, notes: "WP-uebertrag",
    },
    {
      /**
       * Ein Uebertrag, der zum Stichtag GUELTIG ist, aber NICHT verdraengt
       * werden darf: sein `year` liegt ueber dem Reset-Jahr, also greift die
       * VD-5-Verengung (`validFrom` UND `year` muessen vor dem Reset liegen).
       *
       * Ohne ihn sagt der Test nichts ueber `displacedByReset`: im
       * Mutations-Gegencheck blieb das Entfernen der Bedingung gruen, weil in
       * der Fixture ohnehin alles verdraengt wurde.
       */
      customerId: kundeId, budgetType: "entlastungsbetrag_45b", year: JAHR + 1, month: null,
      amountCents: 250_00, source: "carryover",
      validFrom: `${JAHR}-05-01`, expiresAt: `${JAHR + 1}-06-30`, notes: "WP-nicht-verdraengt",
    },
  ]);
}, 120_000);

afterAll(async () => { await cleanupCustomer(kundeId); });
afterEach(() => cleanup());

/**
 * Der ECHTE Endpunkt über HTTP — nicht nachgebaut.
 *
 * Eine erste Fassung rechnete die Filterkette hier noch einmal
 * (`resetAnchorFrom` + `allocationValidAt` + `displacedByReset`). Der
 * Mutations-Gegencheck hat sie widerlegt: eine Mutation IM ENDPUNKT (Stichtags-
 * Filter entfernt) ließ alle vier Tests grün — der Test prüfte seine eigene
 * Kopie.
 *
 * Genau der Zweitbegriff, gegen den dieser ganze Vorgang läuft, nur im
 * Prüfgerät statt im Produktivcode.
 */
async function antwortVomServer(validFrom: string): Promise<{
  verdraengt: Array<{ year: number; amountCents: number }>;
  summeCents: number;
}> {
  const res = await apiGet<{
    verdraengt: Array<{ year: number; amountCents: number }>;
    summeCents: number;
  }>(`/api/budget/${kundeId}/initial-balance-verdraengung/entlastungsbetrag_45b?validFrom=${validFrom}`);
  expect(res.status, "der Verdrängungs-Endpunkt antwortet nicht").toBe(200);
  return res.data;
}

describe("§45b-Startwert — Warnung, wenn ein gültiger Übertrag verdrängt wird", () => {
  it("WV-1 – der Endpunkt nennt den Übertrag, den ein Juni-Startwert ersetzt", async () => {
    const antwort = await antwortVomServer(`${JAHR}-06`);
    expect(
      antwort.verdraengt,
      "gemeldet wird nicht genau der verdrängte Übertrag — der mit `year` über "
      + "dem Reset darf NICHT dabei sein (VD-5-Verengung)",
    ).toEqual([{ year: JAHR, amountCents: UEBERTRAG }]);
    expect(antwort.summeCents).toBe(UEBERTRAG);
  }, 60_000);

  it("WV-2 – ein Startwert NACH dem Verfall verdrängt nichts", async () => {
    // Gegenprobe am Stichtag: am 01.07. ist der Übertrag ohnehin verfallen.
    // Eine Warnung dort wäre falsch — sie behauptete einen Verlust, den es
    // nicht gibt.
    const antwort = await antwortVomServer(`${JAHR}-07`);
    expect(antwort.verdraengt, "ein bereits verfallener Übertrag wird als verdrängt gemeldet")
      .toEqual([]);
  }, 60_000);

  it("WV-3 – die Warnung steht mit Betrag und Bezugsjahr auf dem Schirm", async () => {
    // Die Eingabe kommt aus dem Server-Aufruf oben, nicht aus der Hand — sonst
    // prüfte die Anzeige einen Zustand, den der Server womöglich nie liefert.
    const { VerdraengungsWarnung } = await import("@/components/budget/BudgetTypeSettings");
    render(<VerdraengungsWarnung verdraengung={await antwortVomServer(`${JAHR}-06`)} testId="probe" />);
    const warnung = screen.getByTestId("probe");
    expect(warnung.textContent).toContain("1.179,00");
    expect(warnung.textContent, "die Warnung nennt das Bezugsjahr nicht").toContain(String(JAHR));
    expect(warnung.textContent, "der Hinweis auf die Historie fehlt")
      .toContain("bleibt in der Historie sichtbar");
  }, 60_000);

  it("WV-4 – ohne Verdrängung erscheint keine Warnung", async () => {
    const { VerdraengungsWarnung } = await import("@/components/budget/BudgetTypeSettings");
    render(<VerdraengungsWarnung verdraengung={await antwortVomServer(`${JAHR}-07`)} testId="probe" />);
    expect(
      screen.queryByTestId("probe"),
      "eine Warnung erscheint, obwohl der Übertrag ohnehin verfallen ist",
    ).toBeNull();
  }, 60_000);
});
