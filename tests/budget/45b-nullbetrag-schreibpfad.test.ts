import { describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetAllocations } from "@shared/schema";
import { apiPost, createTestCustomer, cleanupCustomer } from "../test-utils";
import { applyInitialBudget } from "../../server/services/budget-initial-setup";

/**
 * P1 `6hXp9qMrXH2WGVVG` — 0 € muss durch den SCHREIBPFAD kommen, nicht nur
 * durch die Anzeige.
 *
 * Alriks Entscheidung, Inventur-Lesart: **eine Inventur, die „null" nicht
 * sagen kann, ist keine.** Der häufigste Anlass ist Dauerbetrieb — rechnet ein
 * anderer Pflegedienst gegen §45b ab, ist das Budget verbraucht, und in
 * EngelDesk entsteht dazu nie eine Buchung; bekannt ist dann oft nur der
 * Restbestand, und der kann null sein.
 *
 * Vier Schranken sind dafür gefallen (zweimal Server `min(1)`, zweimal Client),
 * eine fünfte in der Übersichtskarte. **Keine davon hatte einen Test auf dem
 * Schreibpfad** (Gate 2 zu #163, S7) — die halbe Entscheidung war damit
 * ungesichert, und der nächste Umbau hätte sie lautlos zurückgedreht.
 *
 * Der entscheidende Nachweis ist nicht „HTTP 200", sondern **dass eine ZEILE
 * entsteht**: der Lesepfad hängt an der Existenz der Zeile
 * (`initialBalanceMonths` filtert auf sie, nicht auf den Betrag), nicht am
 * Betrag. Eine angenommene, quittierte und dann verworfene 0 wäre die
 * schlechteste aller Varianten.
 */

const JAHR = new Date().getFullYear();
const VALID_FROM = `${JAHR}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;

async function frischerKunde(prefix: string): Promise<number> {
  const c = await createTestCustomer({
    vorname: prefix,
    nachname: `NB_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    pflegegrad: 3,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  return c.id as number;
}

async function zeilen(customerId: number, source: "initial_balance" | "carryover") {
  return db.select().from(budgetAllocations).where(and(
    eq(budgetAllocations.customerId, customerId),
    eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
    eq(budgetAllocations.source, source),
    isNull(budgetAllocations.deletedAt),
  ));
}

describe("§45b — 0 € ist ein gültiger Wert auf dem Schreibpfad", () => {
  it("NS-1 – ein Startwert über 0 € wird angenommen UND angelegt", async () => {
    const customerId = await frischerKunde("NS1");
    try {
      const res = await apiPost(
        `/api/budget/${customerId}/initial-balance/entlastungsbetrag_45b`,
        { amountCents: 0, validFrom: VALID_FROM },
      );
      expect(res.status, "der Server lehnt 0 € weiterhin ab").toBeLessThan(400);

      // Die eigentliche Zusage: es entsteht eine ZEILE. Ohne sie gäbe es
      // keinen Anker, keinen Reset und keine Verdrängung — die 0 wäre
      // quittiert und verworfen.
      const rows = await zeilen(customerId, "initial_balance");
      expect(rows.length, "0 € wurde angenommen, aber keine Zeile angelegt").toBe(1);
      expect(rows[0].amountCents).toBe(0);
    } finally {
      await cleanupCustomer(customerId);
    }
  });

  it("NS-2 – ein Übertrag über 0 € wird angenommen UND angelegt", async () => {
    // Ausdrücklich ein EIGENER Vorgang, nicht dieselbe Regel: „im Vorjahr
    // blieb nichts übrig" ist eine andere Feststellung als „der Bestand wurde
    // zu null inventarisiert". Dass beide Schranken fallen, macht sie nicht
    // zu einem Fall.
    const customerId = await frischerKunde("NS2");
    try {
      const res = await apiPost(
        `/api/budget/${customerId}/carryover/entlastungsbetrag_45b`,
        { amountCents: 0, sourceYear: JAHR - 1 },
      );
      expect(res.status, "der Server lehnt einen 0-€-Übertrag weiterhin ab").toBeLessThan(400);

      const rows = await zeilen(customerId, "carryover");
      expect(rows.length, "0 € wurde angenommen, aber keine Zeile angelegt").toBe(1);
      expect(rows[0].amountCents).toBe(0);
    } finally {
      await cleanupCustomer(customerId);
    }
  });

  it("NS-3 – ein negativer Betrag bleibt abgelehnt", async () => {
    // Die Gegenprobe. Aus „0 ist erlaubt" darf nicht „alles ist erlaubt"
    // werden — sonst wäre aus einer zu strengen Schranke eine fehlende
    // geworden, dieselbe Klasse Fehler mit umgekehrtem Vorzeichen.
    const customerId = await frischerKunde("NS3");
    try {
      const startwert = await apiPost(
        `/api/budget/${customerId}/initial-balance/entlastungsbetrag_45b`,
        { amountCents: -100, validFrom: VALID_FROM },
      );
      expect(startwert.status, "ein negativer Startwert wird angenommen").toBeGreaterThanOrEqual(400);

      const uebertrag = await apiPost(
        `/api/budget/${customerId}/carryover/entlastungsbetrag_45b`,
        { amountCents: -100, sourceYear: JAHR - 1 },
      );
      expect(uebertrag.status, "ein negativer Übertrag wird angenommen").toBeGreaterThanOrEqual(400);

      expect((await zeilen(customerId, "initial_balance")).length).toBe(0);
      expect((await zeilen(customerId, "carryover")).length).toBe(0);
    } finally {
      await cleanupCustomer(customerId);
    }
  });

  it("NS-4 – der Anlage-Pfad legt eine festgestellte Null an, statt sie zu verwerfen", async () => {
    // Schranke 6/7 (Gate 2 zu #163, S6): `applyInitialBudget` prüfte die HÖHE
    // (`> 0`) und verwarf eine 0 nach der Validierung — die Route meldete
    // trotzdem Erfolg, und der Audit-Eintrag behauptete `0`, während in der DB
    // nichts stand. Ein Audit-Eintrag, der etwas behauptet, was nicht
    // geschrieben wurde, ist kein Beleg, sondern eine Behauptung.
    //
    // Geprüft wird jetzt die ANGABE, nicht ihre Höhe: `undefined` = keine
    // Angabe, `0` = festgestellte Null.
    const customerId = await frischerKunde("NS4");
    try {
      await applyInitialBudget({
        customerId,
        budgetType: "entlastungsbetrag_45b",
        currentMonthAmountCents: 0,
        carryoverAmountCents: 0,
        budgetStartDate: `${JAHR}-${String(new Date().getMonth() + 1).padStart(2, "0")}-01`,
        customer: { billingType: "pflegekasse_gesetzlich", pflegegrad: 3 },
      });

      const ib = await zeilen(customerId, "initial_balance");
      expect(ib.length, "die festgestellte Null wurde verworfen").toBe(1);
      expect(ib[0].amountCents).toBe(0);

      const co = await zeilen(customerId, "carryover");
      expect(co.length, "der 0-€-Übertrag wurde verworfen").toBe(1);
      expect(co[0].amountCents).toBe(0);
    } finally {
      await cleanupCustomer(customerId);
    }
  });

  it("NS-5 – keine Angabe legt weiterhin nichts an", async () => {
    // Die Gegenprobe zu NS-4, und der eigentliche Grund für `!= null` statt
    // `>= 0`: „nicht angegeben" darf nicht zu einer Zeile werden. Sonst hätte
    // jeder Kunde ohne Startwert plötzlich einen Reset-Anker.
    const customerId = await frischerKunde("NS5");
    try {
      await applyInitialBudget({
        customerId,
        budgetType: "entlastungsbetrag_45b",
        budgetStartDate: `${JAHR}-${String(new Date().getMonth() + 1).padStart(2, "0")}-01`,
        customer: { billingType: "pflegekasse_gesetzlich", pflegegrad: 3 },
      });

      expect((await zeilen(customerId, "initial_balance")).length,
        "aus „keine Angabe“ ist eine Zeile geworden").toBe(0);
      expect((await zeilen(customerId, "carryover")).length,
        "aus „keine Angabe“ ist ein Übertrag geworden").toBe(0);
    } finally {
      await cleanupCustomer(customerId);
    }
  });
});
