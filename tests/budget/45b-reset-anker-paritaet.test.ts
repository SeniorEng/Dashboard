import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetAllocations, customerBudgetTypeSettings, customerCareLevelHistory } from "@shared/schema";
import { createTestCustomer, cleanupCustomer, getAuthCookie } from "../test-utils";
import {
  readResetAnchor,
  read45bAllocationDiagnostics,
} from "../../server/storage/budget/allocation-storage";

/**
 * Zwei Wege zum Reset-Anker — und sie müssen denselben liefern.
 *
 * ── Woher die Frage kommt (Gate 2 zu #180, S2) ──────────────────────────
 * Die SQL-Pfade holen den Anker über `readResetAnchor`, der Anspruchspfad
 * rechnet ihn in `calculateAllocated45b`. Der Reviewer hat gemeldet, die
 * beiden könnten auseinanderlaufen: `calculateAllocated45b` steigt bei
 * `anchor.kind === "ineligible"` VOR der Anker-Berechnung aus und liefert
 * `null`, `readResetAnchor` kennt diesen Zweig nicht.
 *
 * Folge wäre auf der Karte „ersetzt durch Startwert MM/JJJJ" bei einem Kunden,
 * dessen Anspruchspfad nie verdrängt hat — eine falsche Begründung an genau
 * der Stelle, an der jemand nachsieht, warum eine Zahl nicht stimmt. Dieselbe
 * Klasse wie `EK-2`, nur eine Schicht höher.
 *
 * ── Gemessen: der Fall ist nicht erreichbar, und zwar per Konstruktion ───
 * `readResetAnchor` liefert nur dann einen Anker, wenn eine aktive
 * `initial_balance`-Zeile mit gesetztem `month` existiert. `validFrom` ist in
 * `budget_allocations` **`notNull`**. Also findet `earliestValidFrom(…,
 * "initial_balance")` dieselbe Zeile, und `resolve45bAnchor` liefert
 * `kind: "anchor"` in seiner Stufe 2 — der `ineligible`-Zweig liegt DAHINTER
 * und wird nie erreicht.
 *
 * Der vom Reviewer genannte Auslöser (kein Pflegegrad-Verlauf, §45b-Einstellung
 * deaktiviert, `initial_balance`-Zeile) ergibt gemessen `anspruch = 131,00 €`
 * und in BEIDEN Wegen denselben Anker. `AP-1` hält genau ihn fest.
 *
 * ── Warum dann ein Test und kein Fix ────────────────────────────────────
 * Eine Ineligible-Prüfung in `readResetAnchor` würde die Anker-Auflösung ein
 * zweites Mal aufbauen — für einen Fall, den es nicht gibt. Das ist Hinzufügen
 * ohne Ersetzen. Was fehlte, war nicht der Fix, sondern der Beleg, dass die
 * beiden Wege übereinstimmen — und ein Wächter, der es beim nächsten Umbau
 * merkt.
 */

const JAHR = 2026;
const STICHTAG = `${JAHR}-06-15`;

async function kunde(opts: {
  settings45bAktiv: boolean;
  pflegegradVerlauf: boolean;
  allocations?: Array<Record<string, unknown>>;
}): Promise<number> {
  await getAuthCookie();
  const c = await createTestCustomer({
    pflegegrad: 3, billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: false,
  });
  const id = c.id as number;
  if (!opts.pflegegradVerlauf) {
    await db.delete(customerCareLevelHistory).where(eq(customerCareLevelHistory.customerId, id));
  }
  await db.delete(customerBudgetTypeSettings).where(eq(customerBudgetTypeSettings.customerId, id));
  await db.insert(customerBudgetTypeSettings).values({
    customerId: id, budgetType: "entlastungsbetrag_45b",
    enabled: opts.settings45bAktiv, priority: 1,
    monthlyLimitCents: null, yearlyLimitCents: null, validFrom: `${JAHR}-01-01`, validTo: null,
  });
  if (opts.allocations?.length) {
    await db.insert(budgetAllocations).values(
      opts.allocations.map(a => ({
        customerId: id, budgetType: "entlastungsbetrag_45b", ...a,
      })) as never,
    );
  }
  return id;
}

/** Beide Wege, auf dieselbe Form gebracht. */
async function beideAnker(id: number) {
  const viaSql = await readResetAnchor(id, STICHTAG);
  const viaAnspruch = (await read45bAllocationDiagnostics(id, { asOfDate: STICHTAG })).resetAnchor;
  return { viaSql, viaAnspruch };
}

const STARTWERT = {
  year: JAHR, month: 6, amountCents: 131_00, source: "initial_balance",
  validFrom: `${JAHR}-06-01`, expiresAt: null,
};

describe("§45b — die zwei Wege zum Reset-Anker stimmen überein", () => {
  it("AP-1 – der gemeldete ineligible-Fall: Startwert ohne Pflegegrad-Verlauf und mit deaktivierter Einstellung", async () => {
    const id = await kunde({
      settings45bAktiv: false,
      pflegegradVerlauf: false,
      allocations: [{ ...STARTWERT, notes: "AP1" }],
    });
    try {
      const { viaSql, viaAnspruch } = await beideAnker(id);
      expect(
        viaSql,
        "die SQL-Pfade sehen einen anderen Anker als der Anspruchspfad — "
        + "dann steht auf der Karte „ersetzt durch Startwert“ für einen Kunden, "
        + "dessen Anspruch nie verdrängt wurde",
      ).toEqual(viaAnspruch);
      // Und der Anker ist WIRKLICH gesetzt — sonst wäre die Gleichheit
      // dadurch erfüllt, dass beide `null` sind.
      expect(viaAnspruch, "kein Anker — dann prüft AP-1 nichts").not.toBeNull();
      expect(viaAnspruch?.cutoffDate).toBe(`${JAHR}-06-01`);
    } finally {
      await cleanupCustomer(id);
    }
  });

  it("AP-2 – echt ineligible (keine Zuweisung, Einstellung aus): BEIDE null", async () => {
    // Die andere Richtung. `readResetAnchor` darf keinen Anker erfinden, wo der
    // Anspruchspfad keinen hat.
    const id = await kunde({ settings45bAktiv: false, pflegegradVerlauf: false });
    try {
      const { viaSql, viaAnspruch } = await beideAnker(id);
      expect(viaSql, "die SQL-Pfade erfinden einen Anker").toBeNull();
      expect(viaAnspruch, "der Anspruchspfad hat unerwartet einen Anker").toBeNull();
    } finally {
      await cleanupCustomer(id);
    }
  });

  it("AP-3 – ein Startwert NACH dem Stichtag löst in beiden Wegen keinen Reset aus", async () => {
    const id = await kunde({
      settings45bAktiv: true,
      pflegegradVerlauf: true,
      allocations: [{
        year: JAHR, month: 11, amountCents: 131_00, source: "initial_balance",
        validFrom: `${JAHR}-11-01`, expiresAt: null, notes: "AP3-zukunft",
      }],
    });
    try {
      const { viaSql, viaAnspruch } = await beideAnker(id);
      expect(viaSql, "ein zukünftiger Startwert löst in den SQL-Pfaden einen Reset aus").toBeNull();
      expect(viaAnspruch).toBeNull();
    } finally {
      await cleanupCustomer(id);
    }
  });

  it("AP-4 – bei zwei wirksamen Startwerten zeigen beide Wege auf den SPÄTEREN", async () => {
    const id = await kunde({
      settings45bAktiv: true,
      pflegegradVerlauf: true,
      allocations: [
        { year: JAHR, month: 2, amountCents: 500_00, source: "initial_balance",
          validFrom: `${JAHR}-02-01`, expiresAt: null, notes: "AP4-frueh" },
        { ...STARTWERT, notes: "AP4-spaet" },
      ],
    });
    try {
      const { viaSql, viaAnspruch } = await beideAnker(id);
      expect(viaSql).toEqual(viaAnspruch);
      expect(viaAnspruch?.month, "nicht der spätere Startwert").toBe(6);
    } finally {
      await cleanupCustomer(id);
    }
  });
});
