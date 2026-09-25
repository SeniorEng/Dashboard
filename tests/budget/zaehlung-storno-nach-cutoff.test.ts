import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  budgetAllocations, budgetTransactions, customerBudgetTypeSettings, customerCareLevelHistory,
} from "@shared/schema";
import { createTestCustomer, cleanupCustomer, getAuthCookie } from "../test-utils";
import { ermittleFaelle } from "../../server/scripts/zaehle-storno-nach-cutoff";

/**
 * Selbstprobe der Bestandszählung zu `6hcfH98Qh2hVXpmp`.
 *
 * ── Warum eine Messung eine Selbstprobe braucht ─────────────────────────
 * Die Zahl, die aus dieser Zählung kommt, entscheidet über die Reihenfolge:
 * ist sie > 0, zieht der Fix vor den Klammer-PR. Eine Zählung, die **nichts
 * findet, weil sie nichts finden KANN**, sieht von außen genauso aus wie
 * eine, bei der der Bestand sauber ist.
 *
 * Deshalb beide Richtungen: der konstruierte Fall MUSS gefunden werden, und
 * die beiden Beinahe-Fälle dürfen NICHT gefunden werden.
 */

const J = 2026;
const STICHTAG = `${J}-05-15`;

/**
 * Kunde mit Reset-Cutoff 01.03. und einem Übertrag, gegen den gebucht wird.
 * Liefert die Allocation-ID des Übertrags.
 */
async function kundeMitCutoff(): Promise<{ id: number; uebertragId: number }> {
  await getAuthCookie();
  const id = (await createTestCustomer({
    pflegegrad: 3, billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: false,
  })).id as number;
  await db.delete(customerCareLevelHistory).where(eq(customerCareLevelHistory.customerId, id));
  await db.insert(customerCareLevelHistory).values({
    customerId: id, pflegegrad: 3, validFrom: `${J - 2}-01-01`, validTo: null,
  });
  await db.insert(customerBudgetTypeSettings).values({
    customerId: id, budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1,
    monthlyLimitCents: null, yearlyLimitCents: null, validFrom: `${J}-01-01`, validTo: null,
  });
  const [ue] = await db.insert(budgetAllocations).values({
    customerId: id, budgetType: "entlastungsbetrag_45b", year: J, month: null,
    amountCents: 500_00, source: "carryover",
    validFrom: `${J}-01-01`, expiresAt: `${J}-06-30`, notes: "ZS-uebertrag",
  }).returning({ id: budgetAllocations.id });
  await db.insert(budgetAllocations).values({
    customerId: id, budgetType: "entlastungsbetrag_45b", year: J, month: 3,
    amountCents: 300_00, source: "initial_balance",
    validFrom: `${J}-03-01`, expiresAt: null, notes: "ZS-startwert",
  });
  return { id, uebertragId: ue.id };
}

/** Verbrauch + zugehöriges Storno, mit frei wählbaren Daten. */
async function verbrauchMitStorno(
  id: number, uebertragId: number,
  verbrauchAm: string, stornoAm: string, verknuepft = true,
): Promise<void> {
  const [verbrauch] = await db.insert(budgetTransactions).values({
    customerId: id, budgetType: "entlastungsbetrag_45b", transactionType: "consumption",
    amountCents: -100_00, transactionDate: verbrauchAm,
    allocationId: uebertragId, description: "ZS-verbrauch",
  } as never).returning({ id: budgetTransactions.id });

  await db.insert(budgetTransactions).values({
    customerId: id, budgetType: "entlastungsbetrag_45b", transactionType: "reversal",
    amountCents: 100_00, transactionDate: stornoAm,
    allocationId: uebertragId, description: "ZS-storno",
    reversedTransactionId: verknuepft ? verbrauch.id : null,
  } as never);
}

describe("Bestandszählung „Storno nach dem Cutoff\" — Selbstprobe", () => {
  it("ZS-1 – der konstruierte Fall wird gefunden", async () => {
    // Verbrauch 20.01. (vor Cutoff 01.03.), Storno 20.04. (nach Cutoff).
    const { id, uebertragId } = await kundeMitCutoff();
    try {
      await verbrauchMitStorno(id, uebertragId, `${J}-01-20`, `${J}-04-20`);

      const { faelle } = await ermittleFaelle(STICHTAG);
      const meine = faelle.filter(f => f.customerId === id);

      expect(
        meine,
        "die Zählung findet den konstruierten Fall nicht — eine Zahl von 0 wäre "
        + "damit keine Aussage über den Bestand",
      ).toHaveLength(1);
      expect(meine[0].betragCents).toBe(100_00);
      expect(meine[0].cutoff).toBe(`${J}-03-01`);
      expect(meine[0].originalDatum).toBe(`${J}-01-20`);
      expect(meine[0].stornoDatum).toBe(`${J}-04-20`);
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);

  it("ZS-2 – ein Storno VOR dem Cutoff wird nicht gezählt", async () => {
    /**
     * Der Gegenfall. Ohne ihn wäre ZS-1 auch erfüllt, wenn die Zählung
     * schlicht jedes Storno meldet — und die Zahl wäre wertlos, weil sie
     * dann die Konstellation gar nicht prüft.
     */
    const { id, uebertragId } = await kundeMitCutoff();
    try {
      await verbrauchMitStorno(id, uebertragId, `${J}-01-20`, `${J}-01-25`);

      const { faelle } = await ermittleFaelle(STICHTAG);
      expect(
        faelle.filter(f => f.customerId === id),
        "ein Storno vor dem Cutoff wird mitgezählt — beide Zeilen sind "
        + "ausgeschlossen, da stimmt der Reader",
      ).toHaveLength(0);
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);

  it("ZS-4 – sind BEIDE Zeilen nach dem Cutoff, ist es kein Fall", async () => {
    /**
     * Entstanden aus dem Mutations-Gegencheck (25.09.2026).
     *
     * Erste Fassung der Selbstprobe: `ZS-1` fand den Fall, `ZS-2` schloss ein
     * Storno vor dem Cutoff aus. Die Mutation „Bedingung «Original VOR dem
     * Cutoff» entfernen" blieb trotzdem **grün** — denn in `ZS-2` liegt schon
     * das STORNO vor dem Cutoff und fällt an der Storno-Abfrage heraus, bevor
     * die Bedingung überhaupt erreicht wird.
     *
     * `ZS-2` prüfte also den Storno-Filter, nicht den Original-Filter. Dieser
     * Fall prüft ihn: Storno nach dem Cutoff (kommt durch), Original ebenfalls
     * nach dem Cutoff (darf NICHT zählen — beide Zeilen sind regulär, der
     * Reader rechnet hier richtig).
     */
    const { id, uebertragId } = await kundeMitCutoff();
    try {
      await verbrauchMitStorno(id, uebertragId, `${J}-04-10`, `${J}-04-20`);

      const { faelle } = await ermittleFaelle(STICHTAG);
      expect(
        faelle.filter(f => f.customerId === id),
        "ein Storno zu einem Verbrauch NACH dem Cutoff wird gezählt — dann "
        + "meldet die Zählung reguläre Buchungen als Fehlbestand",
      ).toHaveLength(0);
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);

  it("ZS-3 – ein Storno OHNE Verknüpfung wird getrennt ausgewiesen, nicht verschwiegen", async () => {
    /**
     * `reversed_transaction_id` ist nullable. Ein solches Storno lässt sich
     * seiner Originalbuchung nicht sicher zuordnen — es gehört deshalb NICHT
     * in die Antwort, aber sehr wohl in den Befund. Sonst wäre die gemeldete
     * Zahl eine Teilmenge im Gewand der Gesamtzahl.
     */
    const { id, uebertragId } = await kundeMitCutoff();
    try {
      await verbrauchMitStorno(id, uebertragId, `${J}-01-20`, `${J}-04-20`, false);

      const { faelle, stornosOhneVerknuepfung } = await ermittleFaelle(STICHTAG);
      expect(
        faelle.filter(f => f.customerId === id),
        "ein nicht zuordenbares Storno wird mitgezählt, obwohl seine "
        + "Originalbuchung unbekannt ist",
      ).toHaveLength(0);
      expect(
        stornosOhneVerknuepfung,
        "die Lücke wird nicht ausgewiesen — dann liest sich die Zahl wie eine "
        + "vollständige Erhebung",
      ).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);
});
