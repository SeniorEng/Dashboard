import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetAllocations, customerBudgetTypeSettings, customerCareLevelHistory } from "@shared/schema";
import { createTestCustomer, cleanupCustomer } from "../test-utils";
import {
  calculateAllocatedCents,
  getExcluded45bConsumption,
} from "../../server/storage/budget/allocation-storage";
import { readBudgetTypeSettings } from "../../server/storage/budget/preferences-storage";
import { todayISO } from "@shared/utils/datetime";

/**
 * P1 `6hXp9qMrXH2WGVVG` — der §45b-Startwert verdrängt den Übertrag nicht.
 *
 * ── Der Fall ────────────────────────────────────────────────────────────
 * Ein Startwert ist eine **Inventur**: er sagt nicht „hier kommt etwas dazu",
 * sondern „ab hier gilt dieser Bestand". Die Verbrauchsseite hält sich daran —
 * der Reader blendet jede Buchung vor dem Reset-Monat aus. Die Anspruchsseite
 * nicht: `carryoverCounted` prüft ausschließlich das Zeitfenster.
 *
 * Bei Bernd Funke (Kunde 89) ergab das zu jedem Juni-Stichtag
 * `131,00 € + 1.179,00 € = 1.310,00 €` bei einem Topf, der 131,00 € haben
 * sollte — und eine Rechnung über 194,20 € lief vollständig in den
 * Entlastungsbetrag.
 *
 * ── Was hier NICHT neu gebaut wird ──────────────────────────────────────
 * Die Verdrängung existiert bereits, zweimal:
 *  - **IB-Supersession** (#959/#1392) — Übertrag für T sperrt Startwert T-1.
 *    Zweck ist Doppelzählung, nicht Inventur.
 *  - **Reset-Semantik** (#1812) — nur der Startwert des spätesten wirksamen
 *    Reset-Monats zählt. Das IST die Inventur-Regel, aber `ibCounted` prüft
 *    `source === "initial_balance"`, also greift sie nur auf einer Quelle.
 *
 * Das Flag `resetDisplacesAllSources` erweitert deshalb **dieselbe Grenze**
 * (`resetCutoffDate`) auf die zweite Quelle, statt eine zweite Verdrängung
 * danebenzustellen.
 */

const ANKER_JAHR = 2026;

async function kundeFunke(): Promise<number> {
  const c = await createTestCustomer({
    pflegegrad: 3,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  const id = c.id as number;
  // Ohne Pflegegrad-Historie würde der Anker auf den 01.01. des LAUFENDEN
  // Jahres gebodet (Muster aus `45b-year-pool-carryover-shift`).
  await db.delete(customerCareLevelHistory).where(eq(customerCareLevelHistory.customerId, id));
  await db.insert(customerBudgetTypeSettings).values({
    customerId: id, budgetType: "entlastungsbetrag_45b",
    enabled: true, priority: 1,
    monthlyLimitCents: null, yearlyLimitCents: null,
    validFrom: `${ANKER_JAHR}-01-01`, validTo: null,
  });
  // Übertrag aus 2025, gültig 01.01.–30.06.2026 — beginnt VOR dem Startwert.
  await db.insert(budgetAllocations).values({
    customerId: id, budgetType: "entlastungsbetrag_45b",
    year: ANKER_JAHR, month: null, amountCents: 1_179_00, source: "carryover",
    validFrom: `${ANKER_JAHR}-01-01`, expiresAt: `${ANKER_JAHR}-06-30`,
    notes: "Funke-Uebertrag 2025",
  });
  // Startwert ab 06/2026 — die Inventur.
  await db.insert(budgetAllocations).values({
    customerId: id, budgetType: "entlastungsbetrag_45b",
    year: ANKER_JAHR, month: 6, amountCents: 131_00, source: "initial_balance",
    validFrom: `${ANKER_JAHR}-06-01`, expiresAt: null,
    notes: "Funke-Startwert 06/2026",
  });
  return id;
}

describe("§45b — der Startwert verdrängt jede früher beginnende Zuweisung", () => {
  it("VD-1 – in der alten Lesart zählt der Übertrag mit, in der Inventur-Lesart nicht mehr", async () => {
    const id = await kundeFunke();
    try {
      const stichtag = `${ANKER_JAHR}-06-15`;
      // Die ALTE (additive) Lesart wird seit dem Scharfschalten ausdruecklich
      // angefordert — sie ist nicht mehr der Default.
      const alt = await calculateAllocatedCents(
        id, "entlastungsbetrag_45b", { asOfDate: stichtag, resetDisplacesAllSources: false },
      );
      const neu = await calculateAllocatedCents(
        id, "entlastungsbetrag_45b", { asOfDate: stichtag, resetDisplacesAllSources: true },
      );

      // Die Differenz ist GENAU der Übertrag — nicht mehr und nicht weniger.
      // Wäre sie größer, hätte das Flag über `latestValidCarryoverYear` auch
      // den `allocStart`-Shift und damit die Monatsaufstockung verschoben.
      expect(alt - neu, "die Verdrängung trifft nicht genau den Übertrag").toBe(1_179_00);
      expect(neu, "der Startwert selbst darf nicht mitverdrängt werden")
        .toBeGreaterThanOrEqual(131_00);
    } finally {
      await cleanupCustomer(id);
    }
  });

  it("VD-2 – ein Stichtag VOR dem Startwert bleibt unverändert", async () => {
    // Ein rein zukünftiger Startwert ist noch nicht wirksam und löst keinen
    // Reset aus. Rückwirkende Reads (GoBD) müssen unberührt bleiben — sonst
    // ändert die Korrektur die Vergangenheit.
    const id = await kundeFunke();
    try {
      const vorher = `${ANKER_JAHR}-03-15`;
      const heute = await calculateAllocatedCents(
        id, "entlastungsbetrag_45b", { asOfDate: vorher, resetDisplacesAllSources: false },
      );
      const neu = await calculateAllocatedCents(
        id, "entlastungsbetrag_45b", { asOfDate: vorher, resetDisplacesAllSources: true },
      );
      expect(neu, "ein Stichtag vor dem Reset darf sich nicht ändern").toBe(heute);
    } finally {
      await cleanupCustomer(id);
    }
  });

  it("VD-3 – der verdrängte Übertrag landet in der Ausschlussliste", async () => {
    // Die Symmetrie ist der eigentliche Punkt: ein Übertrag, der aus dem
    // Anspruch fällt, muss auch aus der Verbrauchs-Korrektur fallen. Sonst
    // senkt die Verdrängung den Anspruch und zieht den zugehörigen Verbrauch
    // weiter ab — die Drift, vor der `getExcluded45bConsumption` warnt.
    const id = await kundeFunke();
    try {
      const stichtag = `${ANKER_JAHR}-06-15`;
      const typeSettings = await readBudgetTypeSettings(
        id, { kind: "forDate", asOfDate: todayISO() },
      );
      const exHeute = await getExcluded45bConsumption(
        id, stichtag, db, typeSettings, { resetDisplacesAllSources: false },
      );
      const exNeu = await getExcluded45bConsumption(
        id, stichtag, db, typeSettings, { resetDisplacesAllSources: true },
      );

      const zusaetzlich = exNeu.excludedSpecialAllocationIds
        .filter(x => !exHeute.excludedSpecialAllocationIds.includes(x));
      expect(zusaetzlich.length,
        "der verdrängte Übertrag fehlt in der Ausschlussliste — Anspruch und "
        + "Verbrauch folgen dann verschiedenen Grenzen").toBe(1);

      const [zeile] = await db.select().from(budgetAllocations)
        .where(eq(budgetAllocations.id, zusaetzlich[0]));
      expect(zeile.source, "ausgeschlossen wurde nicht der Übertrag").toBe("carryover");
    } finally {
      await cleanupCustomer(id);
    }
  });

  it("VD-4 – der Default IST die Inventur-Lesart, und der Schalter trennt beide Richtungen", async () => {
    /**
     * Diese Zusage ist mit dem Scharfschalten gekippt.
     *
     * Vorher hiess sie „ohne Flag aendert sich nichts" und begruendete das mit
     * der Messung aus Schritt 2. Die ist gefahren und ausgewertet (21 Kunden,
     * Σ −20.395,73 €); der Default ist seither `true`.
     *
     * Der Test behauptet jetzt zwei Dinge, die BEIDE gebraucht werden:
     *  1. ohne Optionen gilt die Inventur-Lesart — sonst waere der Flip nicht
     *     angekommen;
     *  2. `false` stellt die alte Lesart vollstaendig wieder her — sonst waere
     *     der Schalter eine Einbahnstrasse und ein Rueckbau nicht pruefbar.
     */
    const id = await kundeFunke();
    try {
      for (const stichtag of [`${ANKER_JAHR}-03-15`, `${ANKER_JAHR}-06-15`, `${ANKER_JAHR}-08-15`]) {
        const ohneOpt = await calculateAllocatedCents(id, "entlastungsbetrag_45b", { asOfDate: stichtag });
        const explizitTrue = await calculateAllocatedCents(
          id, "entlastungsbetrag_45b", { asOfDate: stichtag, resetDisplacesAllSources: true },
        );
        const explizitFalse = await calculateAllocatedCents(
          id, "entlastungsbetrag_45b", { asOfDate: stichtag, resetDisplacesAllSources: false },
        );
        expect(ohneOpt, `der Default ist nicht die Inventur-Lesart bei ${stichtag}`)
          .toBe(explizitTrue);
        // Die Gegenrichtung: ohne sie waere (1) auch dadurch erfuellt, dass
        // das Flag ueberhaupt nichts tut.
        if (stichtag === `${ANKER_JAHR}-06-15`) {
          expect(explizitFalse, `\`false\` stellt die alte Lesart nicht wieder her`)
            .toBe(explizitTrue + 1_179_00);
        }
      }
    } finally {
      await cleanupCustomer(id);
    }
  });

  it("VD-5 – ein Übertrag, dessen `year` über dem Reset liegt, darf den Anspruch nicht ERHÖHEN", async () => {
    /**
     * Alriks Auflage vor dem Scharfschalten.
     *
     * Die Entwarnung lautete: die Verdrängung kann den Anspruch nicht erhöhen,
     * weil `enumStart = max(allocStart, Reset+1)` und der Shift eines
     * verdrängten Übertrags bei `(a.year, 1) <= (resetYear, 1)` liegt.
     *
     * **Diese Herleitung steht auf einer Annahme, die der Code nicht erzwingt:**
     * `carryover.year === Jahr(carryover.validFrom)`. Der `allocStart`-Shift
     * liest `a.year`, die Verdrängung liest `a.validFrom` — **zwei
     * verschiedene Felder für zwei Entscheidungen über dieselbe Zeile.**
     *
     * Laufen sie auseinander, wird ein Übertrag verdrängt (validFrom vor dem
     * Reset), dessen Shift ÜBER dem Reset lag — und mit ihm fällt eine
     * Schranke weg, die den Anspruch gedeckelt hat.
     *
     * Der Fall kommt im Bestand nicht vor (Mess-Lauf: bei allen 20 Kunden
     * `resetCutoff > accrualFloor`). Das macht ihn nicht unmöglich, nur
     * ungetestet — und genau das ist der Grund für diesen Test.
     */
    const c = await createTestCustomer({
      pflegegrad: 3, billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: false,
    });
    const id = c.id as number;
    try {
      await db.delete(customerCareLevelHistory).where(eq(customerCareLevelHistory.customerId, id));
      await db.insert(customerBudgetTypeSettings).values({
        customerId: id, budgetType: "entlastungsbetrag_45b",
        enabled: true, priority: 1, monthlyLimitCents: null, yearlyLimitCents: null,
        validFrom: `${ANKER_JAHR}-01-01`, validTo: null,
      });
      // Startwert 06/2026 — der Reset.
      await db.insert(budgetAllocations).values({
        customerId: id, budgetType: "entlastungsbetrag_45b",
        year: ANKER_JAHR, month: 6, amountCents: 131_00, source: "initial_balance",
        validFrom: `${ANKER_JAHR}-06-01`, expiresAt: null, notes: "VD5-Startwert",
      });
      // Der inkonsistente Übertrag: `year` ZWEI Jahre über dem Reset,
      // `validFrom` ein Jahr DARUNTER. Der Shift zieht auf 2028, die
      // Verdrängung greift wegen validFrom < resetCutoff.
      // Der Betrag ist KLEIN und der Stichtag SPAET — beides mit Absicht.
      // Die erste Fassung dieses Tests nahm 500 EUR und den 15.08.: sie bestand,
      // weil der weggefallene Uebertrag (500) groesser war als die freigelegte
      // Aufstockung (262). Das war ein Zufall der Betraege, kein Nachweis.
      // Gemessen kippt es bei 50 EUR und Dezember: 181,00 -> 524,00.
      await db.insert(budgetAllocations).values({
        customerId: id, budgetType: "entlastungsbetrag_45b",
        year: ANKER_JAHR + 2, month: null, amountCents: 50_00, source: "carryover",
        validFrom: `${ANKER_JAHR - 1}-01-01`, expiresAt: `${ANKER_JAHR + 2}-06-30`,
        notes: "VD5-inkonsistenter-Uebertrag",
      });

      const stichtag = `${ANKER_JAHR}-12-15`;
      /**
       * `false` AUSDRUECKLICH — und das ist der Grund, warum dieser Test einmal
       * wertlos war.
       *
       * Beim Scharfschalten (23.09.2026) wurden `VD-1/2/3/4/6` auf `false`
       * umgestellt, `VD-5` nicht. Ohne Optionen galt dann der neue Default
       * `true`, beide Seiten rechneten dasselbe, und die Assertion lautete
       * `x <= x`: der Test, dessen Titel eine Invariante behauptet, konnte
       * nicht mehr rot werden.
       *
       * Gefunden hat es Gate 2 zu #184, B1 — nicht der Mutations-Gegencheck,
       * denn der lief auf den anderen fuenf und blieb dort korrekt rot.
       */
      const heute = await calculateAllocatedCents(
        id, "entlastungsbetrag_45b", { asOfDate: stichtag, resetDisplacesAllSources: false },
      );
      const neu = await calculateAllocatedCents(
        id, "entlastungsbetrag_45b", { asOfDate: stichtag, resetDisplacesAllSources: true },
      );
      /**
       * Hier stand kurzzeitig `expect(heute).not.toBe(neu)` als Absicherung
       * gegen „beide Seiten identisch". Das war falsch: in DIESER Fixture
       * VERHINDERT die VD-5-Verengung die Verdraengung, beide Seiten gleich
       * ist also das gewollte Ergebnis.
       *
       * Was den Test scharf macht, ist nicht Ungleichheit, sondern die
       * Mutation: nimmt man `year <= reset.year` aus `displacedByReset`
       * heraus, wird der Uebertrag verdraengt, die freigelegte
       * Monatsaufstockung schlaegt durch und `neu` steigt UEBER `heute`.
       * Gegengeprueft.
       */

      // Die Zusage, die vor dem Scharfschalten tragen muss: die Verdrängung
      // nimmt weg, sie gibt nie dazu.
      expect(neu, `die Verdrängung hat den Anspruch ERHÖHT (${heute} -> ${neu})`)
        .toBeLessThanOrEqual(heute);
    } finally {
      await cleanupCustomer(id);
    }
  });

  it("VD-6 – ein Startwert im JANUAR verdrängt den Übertrag ab 01.01.", async () => {
    /**
     * Alriks Entscheidung zu S3, und der Grund dafür.
     *
     * Mit `<` griff die Regel ausgerechnet im häufigsten Fall nie:
     * Jahreswechsel, Übertrag ab 01.01., Inventur im Januar. `cutoffDate` ist
     * dann ebenfalls der 01.01., und `validFrom < cutoffDate` ist falsch.
     * Gemessen ergab das `ohne=157200 mit=157200` — das Flag änderte nichts
     * in genau der Konstellation, für die der Mechanismus gemacht ist.
     *
     * Fachlich: eine Inventur zum 01.01. stellt den Bestand fest, und ein
     * Übertrag, der am selben Tag beginnt, ist Teil dessen, was festgestellt
     * wurde.
     */
    const c = await createTestCustomer({
      pflegegrad: 3, billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: false,
    });
    const id = c.id as number;
    try {
      await db.delete(customerCareLevelHistory).where(eq(customerCareLevelHistory.customerId, id));
      await db.insert(customerBudgetTypeSettings).values({
        customerId: id, budgetType: "entlastungsbetrag_45b",
        enabled: true, priority: 1, monthlyLimitCents: null, yearlyLimitCents: null,
        validFrom: `${ANKER_JAHR}-01-01`, validTo: null,
      });
      await db.insert(budgetAllocations).values([
        {
          customerId: id, budgetType: "entlastungsbetrag_45b",
          year: ANKER_JAHR, month: 1, amountCents: 131_00, source: "initial_balance",
          validFrom: `${ANKER_JAHR}-01-01`, expiresAt: null, notes: "VD6-Januar-Inventur",
        },
        {
          customerId: id, budgetType: "entlastungsbetrag_45b",
          year: ANKER_JAHR, month: null, amountCents: 1_179_00, source: "carryover",
          validFrom: `${ANKER_JAHR}-01-01`, expiresAt: `${ANKER_JAHR}-06-30`,
          notes: "VD6-Uebertrag-ab-Januar",
        },
      ]);

      const stichtag = `${ANKER_JAHR}-03-15`;
      const alt = await calculateAllocatedCents(
        id, "entlastungsbetrag_45b", { asOfDate: stichtag, resetDisplacesAllSources: false },
      );
      const neu = await calculateAllocatedCents(
        id, "entlastungsbetrag_45b", { asOfDate: stichtag, resetDisplacesAllSources: true },
      );

      expect(alt - neu,
        "der Übertrag ab 01.01. wird vom Januar-Startwert nicht verdrängt — "
        + "genau der Fall, für den der Mechanismus gemacht ist")
        .toBe(1_179_00);
    } finally {
      await cleanupCustomer(id);
    }
  });
});
