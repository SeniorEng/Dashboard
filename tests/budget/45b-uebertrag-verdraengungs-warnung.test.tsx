// @vitest-environment jsdom
import React from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  budgetAllocations, customerBudgetTypeSettings, customerCareLevelHistory, customers,
} from "@shared/schema";
import { apiGet, cleanupCustomer, getAuthCookie } from "../test-utils";
import { VerdraengungsWarnung, type Verdraengung } from "../../client/src/components/budget/BudgetTypeSettings";

/**
 * S1 — Pflichtwarnung im ÜBERTRAGS-Editor (Alrik, 24.09.2026).
 *
 * ── Die Gegenrichtung zu WV ─────────────────────────────────────────────
 * `45b-startwert-verdraengungs-warnung.test.tsx` sichert: wer einen STARTWERT
 * setzt, sieht, welche Überträge dadurch entfallen. Hier die andere Seite: wer
 * einen ÜBERTRAG einträgt, während schon ein Startwert existiert, soll sehen,
 * dass sein Betrag nicht mitzählt.
 *
 * Alriks Auflage war ausdrücklich: **derselbe Lese-Endpunkt, nicht ein
 * zweiter.** Die fachliche Frage ist in beiden Richtungen dieselbe —
 * `displacedByReset` gegen einen Reset-Anker. Ein zweiter Endpunkt wäre der
 * Zweitbegriff, den die SSoT-Regel verbietet: er liefe beim nächsten Umbau
 * auseinander, ohne dass es jemand merkt.
 *
 * **Warnen, nicht sperren.** Im Anlage-Assistenten lehnt der Server die
 * Kombination ab (#186) — dort entsteht sie aus Unkenntnis. Im Bestands-Editor
 * kann sie Absicht sein (Startwert wird gleich danach gelöscht); eine Sperre
 * nähme den Weg, eine Warnung nimmt nur die Überraschung.
 */

const JAHR = 2026;
/** Der Startwert, der bereits existiert — Juni, also im Übertrags-Fenster. */
const STARTWERT_MONAT = 6;
const NEUER_UEBERTRAG = 500_00;

let kundeId: number;

beforeAll(async () => {
  await getAuthCookie();
  const [k] = await db.insert(customers).values({
    name: "S1 Uebertrags-Warnung", address: "Teststr. 9", pflegegrad: 3,
    billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: false,
  } as never).returning({ id: customers.id });
  kundeId = k.id;

  await db.delete(customerCareLevelHistory).where(eq(customerCareLevelHistory.customerId, kundeId));
  await db.insert(customerCareLevelHistory).values({
    customerId: kundeId, pflegegrad: 3, validFrom: `${JAHR - 1}-01-01`, validTo: null,
  });
  await db.insert(customerBudgetTypeSettings).values({
    customerId: kundeId, budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1,
    monthlyLimitCents: null, yearlyLimitCents: null, validFrom: `${JAHR}-01-01`, validTo: null,
  });

  // Der BESTEHENDE Startwert — er ist hier der Anker, nicht die Hypothese.
  await db.insert(budgetAllocations).values({
    customerId: kundeId, budgetType: "entlastungsbetrag_45b",
    year: JAHR, month: STARTWERT_MONAT,
    amountCents: 184_60, source: "initial_balance",
    validFrom: `${JAHR}-${String(STARTWERT_MONAT).padStart(2, "0")}-01`,
    expiresAt: null, notes: "S1-startwert",
  });
}, 120_000);

afterAll(async () => { await cleanupCustomer(kundeId); });
afterEach(() => cleanup());

/**
 * Der ECHTE Endpunkt über HTTP, in der Übertrags-Richtung.
 *
 * Kein Nachbau der Filterkette — an genau dem ist die erste Fassung der
 * WV-Tests gescheitert: eine Mutation IM ENDPUNKT ließ alle vier grün, weil
 * der Test seine eigene Kopie prüfte.
 */
async function antwortVomServer(
  validFrom: string,
  uebertragJahr: number,
  betragCents: number,
): Promise<Verdraengung> {
  const res = await apiGet<Verdraengung>(
    `/api/budget/${kundeId}/initial-balance-verdraengung/entlastungsbetrag_45b`
    + `?validFrom=${validFrom}&uebertragJahr=${uebertragJahr}&uebertragBetragCents=${betragCents}`,
  );
  expect(res.status, "der Verdrängungs-Endpunkt antwortet nicht").toBe(200);
  return res.data;
}

describe("§45b-Übertrag — Warnung, wenn ein bestehender Startwert ihn ersetzt", () => {
  it("UW-1 – der Endpunkt meldet den neuen Übertrag als verdrängt und nennt den Startwert-Monat", async () => {
    const a = await antwortVomServer(`${JAHR}-06`, JAHR, NEUER_UEBERTRAG);

    expect(a.verdraengt, "der eingegebene Übertrag wird nicht als verdrängt gemeldet")
      .toEqual([{ year: JAHR, amountCents: NEUER_UEBERTRAG }]);
    expect(a.summeCents).toBe(NEUER_UEBERTRAG);
    /**
     * Der Monat ist die eigentliche Auskunft dieser Richtung: „wird vom
     * Startwert 06/2026 ersetzt". Ohne ihn müsste der Client ihn aus dem Anker
     * zusammensetzen — dieselbe Regel ein viertes Mal.
     */
    expect(a.ersetztDurchStartwertMonat, "der Startwert-Monat fehlt in der Antwort")
      .toBe(`06/${JAHR}`);
  });

  it("UW-2 – ohne bestehenden Startwert gibt es nichts zu warnen", async () => {
    /**
     * Die Gegenrichtung. Ohne sie wäre UW-1 auch dadurch erfüllt, dass der
     * Endpunkt JEDEN Übertrag als verdrängt meldet.
     *
     * Ein zweiter Kunde statt Löschen des Startwerts: `budget_allocations`
     * verbietet hartes DELETE (GoBD-Trigger), und ein Soft-Delete ließe die
     * Zeile für `readResetAnchor` ohnehin verschwinden — aber über einen
     * anderen Mechanismus als „es gab nie einen Startwert".
     */
    const [ohne] = await db.insert(customers).values({
      name: "S1 ohne Startwert", address: "Teststr. 10", pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: false,
    } as never).returning({ id: customers.id });
    try {
      await db.delete(customerCareLevelHistory).where(eq(customerCareLevelHistory.customerId, ohne.id));
      await db.insert(customerCareLevelHistory).values({
        customerId: ohne.id, pflegegrad: 3, validFrom: `${JAHR - 1}-01-01`, validTo: null,
      });
      await db.insert(customerBudgetTypeSettings).values({
        customerId: ohne.id, budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1,
        monthlyLimitCents: null, yearlyLimitCents: null, validFrom: `${JAHR}-01-01`, validTo: null,
      });
      const res = await apiGet<Verdraengung>(
        `/api/budget/${ohne.id}/initial-balance-verdraengung/entlastungsbetrag_45b`
        + `?validFrom=${JAHR}-06&uebertragJahr=${JAHR}&uebertragBetragCents=${NEUER_UEBERTRAG}`,
      );
      expect(res.status).toBe(200);
      expect(res.data.verdraengt, "ohne Startwert wird trotzdem eine Verdrängung gemeldet").toEqual([]);
      expect(res.data.ersetztDurchStartwertMonat).toBeNull();
    } finally {
      await cleanupCustomer(ohne.id);
    }
  });

  it("UW-3 – ein Startwert NACH dem Übertragsbeginn wird trotzdem gefunden", async () => {
    /**
     * Der Fehler, der sonst unsichtbar bliebe.
     *
     * `resetAnchorFrom` überspringt Startwerte, die NACH dem Stichtag
     * beginnen. Schickte der Client den Beginn des Übertrags (`2026-01`) statt
     * des laufenden Monats, fiele der Juni-Startwert aus der Anker-Suche — und
     * die Warnung bliebe still, obwohl genau er den Übertrag ersetzt.
     *
     * Eine AUSBLEIBENDE Warnung ist die teuerste Fehlerform hier: sie sieht
     * aus wie „alles in Ordnung".
     */
    const mitJanuar = await antwortVomServer(`${JAHR}-01`, JAHR, NEUER_UEBERTRAG);
    expect(mitJanuar.verdraengt, "zum Januar-Stichtag ist der Juni-Startwert noch nicht wirksam")
      .toEqual([]);

    const mitJuni = await antwortVomServer(`${JAHR}-06`, JAHR, NEUER_UEBERTRAG);
    expect(
      mitJuni.verdraengt.length,
      "zum Juni-Stichtag muss der Juni-Startwert den Übertrag ersetzen — "
      + "findet der Endpunkt ihn nicht, bleibt die Warnung still",
    ).toBe(1);
  });

  it("UW-4 – was die Vorschau ankündigt, tritt beim Speichern ein", async () => {
    /**
     * Sonst warnt die Vorschau über eine andere Zeile als die, die entsteht.
     *
     * `applyInitialBudget` schreibt einen §45b-Übertrag mit
     * `validFrom = ${jahr}-01-01`, `expiresAt = ${jahr}-06-30`, `year = jahr`.
     * Genau diese Felder setzt der Endpunkt für den hypothetischen Übertrag
     * ein. Laufen sie auseinander, sieht das kein Test, der nur eine Seite
     * prüft.
     *
     * ── Warum NICHT gegen die Startwert-Richtung verglichen wird ──────────
     * Eine erste Fassung schrieb die echte Zeile und fragte die
     * Startwert-Richtung erneut — und bekam `[]` statt der angekündigten
     * Verdrängung. Das war kein Fehler im Code, sondern in der Probe: ein
     * bereits verdrängter Übertrag wird bewusst NICHT erneut gemeldet (#184,
     * „ein Verlust, der bereits eingetreten ist"). Nach dem Speichern
     * beantworten die beiden Richtungen verschiedene Fragen.
     *
     * Die haltbare Probe ist deshalb nicht „sagen beide dasselbe", sondern
     * **„tritt die angekündigte Wirkung ein"** — gemessen an der Stelle, die
     * dem Nutzer den Bestand zeigt.
     */
    const [k2] = await db.insert(customers).values({
      name: "S1 Feld-Gleichheit", address: "Teststr. 11", pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: false,
    } as never).returning({ id: customers.id });
    try {
      await db.delete(customerCareLevelHistory).where(eq(customerCareLevelHistory.customerId, k2.id));
      await db.insert(customerCareLevelHistory).values({
        customerId: k2.id, pflegegrad: 3, validFrom: `${JAHR - 1}-01-01`, validTo: null,
      });
      await db.insert(customerBudgetTypeSettings).values({
        customerId: k2.id, budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1,
        monthlyLimitCents: null, yearlyLimitCents: null, validFrom: `${JAHR}-01-01`, validTo: null,
      });
      await db.insert(budgetAllocations).values({
        customerId: k2.id, budgetType: "entlastungsbetrag_45b",
        year: JAHR, month: STARTWERT_MONAT, amountCents: 184_60, source: "initial_balance",
        validFrom: `${JAHR}-${String(STARTWERT_MONAT).padStart(2, "0")}-01`,
        expiresAt: null, notes: "S1-startwert-2",
      });

      // 1) Vorschau VOR dem Schreiben: was kündigt sie an?
      const vorschau = await apiGet<Verdraengung>(
        `/api/budget/${k2.id}/initial-balance-verdraengung/entlastungsbetrag_45b`
        + `?validFrom=${JAHR}-06&uebertragJahr=${JAHR}&uebertragBetragCents=${NEUER_UEBERTRAG}`,
      );
      expect(vorschau.status).toBe(200);
      expect(
        vorschau.data.verdraengt,
        "die Vorschau kündigt gar keine Verdrängung an — dann sagt der Rest nichts",
      ).toEqual([{ year: JAHR, amountCents: NEUER_UEBERTRAG }]);

      // 2) Die ECHTE Zeile, mit genau den Feldern des Schreibpfads.
      await db.insert(budgetAllocations).values({
        customerId: k2.id, budgetType: "entlastungsbetrag_45b", year: JAHR, month: null,
        amountCents: NEUER_UEBERTRAG, source: "carryover",
        validFrom: `${JAHR}-01-01`, expiresAt: `${JAHR}-06-30`, notes: "S1-echt",
      });

      // 3) Tritt die angekündigte Wirkung ein? Der Bestands-Endpunkt ist die
      //    Stelle, an der der Nutzer es sieht.
      const liste = await apiGet<Array<{
        id: number; source?: string; amountCents: number;
        zaehltNicht?: boolean; ersetztDurchStartwertMonat?: string | null;
      }>>(`/api/budget/${k2.id}/initial-balances/entlastungsbetrag_45b`);
      expect(liste.status).toBe(200);
      const echterUebertrag = liste.data.find(
        z => z.source === "carryover" && z.amountCents === NEUER_UEBERTRAG,
      );
      expect(echterUebertrag, "die geschriebene Übertragszeile ist nicht auffindbar").toBeTruthy();
      expect(
        echterUebertrag!.zaehltNicht,
        "die Vorschau kündigte eine Verdrängung an — die gespeicherte Zeile zählt aber mit",
      ).toBe(true);
      /**
       * Der Startwert-MONAT wird hier bewusst NICHT verglichen.
       *
       * Der Bestands-Endpunkt rechnet zu „heute", die Vorschau zum angefragten
       * Stichtag. Ab dem 01.07. ist der Übertrag verfallen, und dann meldet der
       * Bestand absichtlich `null` statt eines Startwert-Monats — sonst stünde
       * „ersetzt durch Startwert 06/2026" direkt neben „verfällt 30.06.2026"
       * (#166, B1: zwei widersprechende Auskünfte an der Stelle, an der jemand
       * nachsieht, warum eine Zahl nicht stimmt).
       *
       * Ein Vergleich der beiden Felder wäre deshalb datums-fragil und würde
       * eine Übereinstimmung verlangen, die fachlich falsch wäre. Die Zusage
       * dieses Tests ist die WIRKUNG, und die trägt `zaehltNicht`.
       */
    } finally {
      await cleanupCustomer(k2.id);
    }
  });

  it("UW-5 – die Warnung steht mit dem Startwert-Monat auf dem Schirm", async () => {
    /**
     * Die Zusage steht auf dem GERENDERTEN TEXT, nicht auf einer `data-testid`.
     *
     * Am 23.09.2026 blieb ein Anzeige-Test grün, der nur die Testid prüfte,
     * während der Kopf genau das Irreführende zeigte, das er abfangen sollte.
     * Geprüft wird deshalb, was der Nutzer liest.
     */
    render(
      <VerdraengungsWarnung
        verdraengung={await antwortVomServer(`${JAHR}-06`, JAHR, NEUER_UEBERTRAG)}
        richtung="uebertrag"
        testId="probe"
      />,
    );
    const warnung = screen.getByTestId("probe");
    expect(warnung.textContent, "die Warnung sagt nicht, dass der Übertrag nicht mitzählt")
      .toContain("zählt nicht mit");
    expect(warnung.textContent, "die Warnung nennt den Startwert nicht, der ersetzt")
      .toContain(`06/${JAHR}`);
    expect(warnung.textContent, "der Hinweis auf die Historie fehlt")
      .toContain("Historie");
  });

  it("UW-6 – ohne Verdrängung erscheint keine Warnung", async () => {
    render(
      <VerdraengungsWarnung
        verdraengung={{ verdraengt: [], summeCents: 0, ersetztDurchStartwertMonat: null }}
        richtung="uebertrag"
        testId="probe"
      />,
    );
    expect(screen.queryByTestId("probe"), "ohne Verdrängung wird gewarnt").toBeNull();
  });

  it("UW-7 – die Startwert-Richtung behält ihren eigenen Text", async () => {
    /**
     * Eine Komponente, zwei Lesarten — und die alte darf sich nicht verschoben
     * haben. Ohne diese Probe wäre „dieselbe Form" auch erfüllt, wenn beide
     * Richtungen denselben, für eine davon falschen Satz zeigen.
     */
    render(
      <VerdraengungsWarnung
        verdraengung={{
          verdraengt: [{ year: JAHR, amountCents: 1_179_00 }],
          summeCents: 1_179_00,
          ersetztDurchStartwertMonat: `06/${JAHR}`,
        }}
        testId="probe"
      />,
    );
    const warnung = screen.getByTestId("probe");
    expect(warnung.textContent, "die Startwert-Richtung nennt den entfallenden Betrag nicht")
      .toContain("1.179,00");
    expect(warnung.textContent, "die Startwert-Richtung zeigt den Übertrags-Text")
      .not.toContain("zählt nicht mit:");
  });
});
