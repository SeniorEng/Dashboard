import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetAllocations, customerBudgetTypeSettings, customerCareLevelHistory } from "@shared/schema";
import { createTestCustomer, cleanupCustomer, apiGet, getAuthCookie } from "../test-utils";

/**
 * P1 `6hXp9qMrXH2WGVVG`, E4 — der ersetzte Übertrag muss als ersetzt zu sehen
 * sein, nicht als gleichberechtigte Zeile.
 *
 * Die Budget-Einstellungen zeigten „Restguthaben aus Vorjahr … 1.179,00 €" und
 * darunter „Startwert (ab Juni 2026) … 131,00 €" nebeneinander — auch wenn die
 * eine die andere längst ersetzt hatte. Alrik sah 1.179 €, und die Karte
 * rechnete etwas anderes.
 *
 * **Verdrängen, nicht löschen.** Neben dem Übertrag steht ein Löschsymbol, und
 * das wäre die naheliegende und die falsche Handlung: beim Löschen ist die
 * Historie weg, beim Verdrängen bleibt nachvollziehbar, DASS es einen Übertrag
 * gab und WARUM er nicht mehr zählt.
 *
 * Die Kennzeichnung kommt aus `excludedSpecialAllocationIds` — derselben SSoT,
 * aus der sich die symmetrische Verbrauchs-Korrektur speist. Kein zweiter
 * Begriff, und sie wird von selbst richtig, sobald die Verdrängung scharf
 * geschaltet wird.
 */

const JAHR = new Date().getFullYear();

interface AllocationAntwort {
  id: number;
  source?: string;
  amountCents: number;
  zaehltNicht?: boolean;
  ersetztDurchStartwertMonat?: string | null;
}

async function kundeMitTopf(): Promise<number> {
  await getAuthCookie();
  const c = await createTestCustomer({
    pflegegrad: 3, billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: false,
  });
  const id = c.id as number;
  await db.delete(customerCareLevelHistory).where(eq(customerCareLevelHistory.customerId, id));
  await db.insert(customerBudgetTypeSettings).values({
    customerId: id, budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1,
    monthlyLimitCents: null, yearlyLimitCents: null, validFrom: `${JAHR}-01-01`, validTo: null,
  });
  return id;
}

async function holeAllocations(customerId: number): Promise<AllocationAntwort[]> {
  const res = await apiGet<AllocationAntwort[]>(
    `/api/budget/${customerId}/initial-balances/entlastungsbetrag_45b`,
  );
  expect(res.status).toBe(200);
  return res.data;
}

describe("§45b — ersetzter Übertrag ist als ersetzt gekennzeichnet", () => {
  it("EK-1 – ein früherer Startwert wird als ersetzt ausgewiesen", async () => {
    // Die Reset-Semantik (#1812) ist HEUTE schon aktiv: nur der Startwert des
    // spätesten wirksamen Monats zählt. Ein früherer fällt bereits jetzt aus
    // `initialBalanceTotal` — und stand trotzdem unmarkiert in der Liste.
    const id = await kundeMitTopf();
    try {
      await db.insert(budgetAllocations).values([
        {
          customerId: id, budgetType: "entlastungsbetrag_45b", year: JAHR, month: 1,
          amountCents: 500_00, source: "initial_balance",
          validFrom: `${JAHR}-01-01`, expiresAt: null, notes: "EK1-alt",
        },
        {
          customerId: id, budgetType: "entlastungsbetrag_45b", year: JAHR, month: 6,
          amountCents: 131_00, source: "initial_balance",
          validFrom: `${JAHR}-06-01`, expiresAt: null, notes: "EK1-neu",
        },
      ]);

      const zeilen = await holeAllocations(id);
      const alt = zeilen.find(z => z.amountCents === 500_00);
      const neu = zeilen.find(z => z.amountCents === 131_00);

      expect(alt?.ersetztDurchStartwertMonat,
        "der ersetzte Startwert steht unmarkiert neben dem gültigen")
        .toBe(`06/${JAHR}`);
      expect(neu?.ersetztDurchStartwertMonat,
        "der GÜLTIGE Startwert wurde als ersetzt markiert").toBeNull();
    } finally {
      await cleanupCustomer(id);
    }
  });

  it("EK-2 – ein verfallener Übertrag NEBEN einem Startwert wird nicht als ersetzt ausgegeben", async () => {
    /**
     * Die Gegenprobe — und die erste Fassung erreichte den Zweig gar nicht.
     *
     * Sie legte einen verfallenen Übertrag **ohne jeden Startwert** an. Damit
     * ist `hasReset === false`, `resetCutoffDate === null`, und die Bedingung
     * konnte nie zuschlagen: der Test war inhaltlich eine Kopie von EK-3 mit
     * anderer Quelle. **Geprüft wurde die Konstellation, nicht die
     * Eigenschaft** (Gate 2 zu #166, B1).
     *
     * Jetzt steht der Startwert daneben, der Reset ist wirksam, und der
     * Übertrag beginnt VOR ihm — also erfüllt er alles, was die alte
     * Bedingung verlangte. Er fällt trotzdem nicht wegen des Resets heraus,
     * sondern weil er **verfallen** ist. Genau das muss die Antwort sagen.
     */
    const id = await kundeMitTopf();
    try {
      await db.insert(budgetAllocations).values([
        {
          customerId: id, budgetType: "entlastungsbetrag_45b", year: JAHR, month: null,
          amountCents: 300_00, source: "carryover",
          validFrom: `${JAHR}-01-01`, expiresAt: `${JAHR}-01-31`, notes: "EK2-verfallen",
        },
        {
          customerId: id, budgetType: "entlastungsbetrag_45b", year: JAHR, month: 3,
          amountCents: 131_00, source: "initial_balance",
          validFrom: `${JAHR}-03-01`, expiresAt: null, notes: "EK2-startwert",
        },
      ]);

      const zeilen = await holeAllocations(id);
      const uebertrag = zeilen.find(z => z.source === "carryover");
      expect(uebertrag, "der Übertrag fehlt in der Antwort").toBeTruthy();
      expect(uebertrag!.zaehltNicht, "ein verfallener Übertrag zählt noch mit").toBe(true);
      expect(uebertrag!.ersetztDurchStartwertMonat,
        "ein VERFALLENER Übertrag wird als ersetzt-durch-Startwert ausgegeben — "
        + "die Zeile trüge dann zwei widersprechende Begründungen nebeneinander")
        .toBeNull();
    } finally {
      await cleanupCustomer(id);
    }
  });

  it("EK-3 – ohne Reset trägt keine Zeile eine Kennzeichnung", async () => {
    // Sonst wäre aus „meldet zu selten" ein „meldet immer" geworden.
    const id = await kundeMitTopf();
    try {
      await db.insert(budgetAllocations).values({
        customerId: id, budgetType: "entlastungsbetrag_45b", year: JAHR, month: 6,
        amountCents: 131_00, source: "initial_balance",
        validFrom: `${JAHR}-06-01`, expiresAt: null, notes: "EK3",
      });

      const zeilen = await holeAllocations(id);
      expect(zeilen.every(z => z.ersetztDurchStartwertMonat == null),
        "eine Kennzeichnung erscheint ohne Grund").toBe(true);
    } finally {
      await cleanupCustomer(id);
    }
  });
});
