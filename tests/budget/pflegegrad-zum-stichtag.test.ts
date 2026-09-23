import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { customerCareLevelHistory } from "@shared/schema";
import { createTestCustomer, cleanupCustomer, apiGet, getAuthCookie } from "../test-utils";
import { getCareLevelAt } from "../../server/storage/customer-mgmt/care-level";

/**
 * Replit #1916 / Gate 2 — Alriks Satz hängt an Pflegegrad 1, und der wurde
 * als „heute" gelesen.
 *
 * ── Warum das mehr ist als ein Datums-Detail ───────────────────────────
 * „Kein Ausweichbudget verfügbar." ist **keine Fehlermeldung, sondern eine
 * Aussage über Leistungsansprüche**, die eine Mitarbeiterin gegenüber dem
 * Kunden vertritt. Deshalb ist der Wortlaut von Alrik — und deshalb darf die
 * Bedingung nicht „heute" lesen, wenn die Aussage sich auf einen Termin im
 * nächsten Monat bezieht.
 *
 * Konkret: Hochstufung zum 01.10., Termin am 15.10. Mit `customers.pflegegrad`
 * (aktuell = 1) stünde der Satz da, obwohl der Kunde im Oktober PG 2 hat und
 * damit sehr wohl einen Ausweichtopf.
 *
 * Das ist die `todayISO()`-vs-`asOf`-Falle aus CLAUDE.md — dort steht, sie sei
 * bereits dreimal aufgetreten. Dies wäre das vierte Mal gewesen.
 *
 * ── Die zweite Lücke, die hier geschlossen wird ────────────────────────
 * `MG-6`/`MG-8` bekommen das Boolean **von Hand**. Die ABLEITUNG war nirgends
 * geprüft: würde `pflegegrad` je nicht geladen, verschwände der Satz still.
 * `PS-3` geht deshalb über die Route.
 */

const JAHR = new Date().getFullYear();

async function kundeMitHistorie(stufen: Array<{ pflegegrad: number; validFrom: string; validTo: string | null }>) {
  await getAuthCookie();
  const c = await createTestCustomer({
    pflegegrad: stufen[stufen.length - 1].pflegegrad,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  const id = c.id as number;
  await db.delete(customerCareLevelHistory).where(eq(customerCareLevelHistory.customerId, id));
  await db.insert(customerCareLevelHistory).values(
    stufen.map(s => ({ customerId: id, pflegegrad: s.pflegegrad, validFrom: s.validFrom, validTo: s.validTo })),
  );
  return id;
}

describe("Pflegegrad zum Stichtag — nicht „heute“", () => {
  it("PS-1 – die SSoT liefert den Grad, der zum Stichtag galt", async () => {
    const id = await kundeMitHistorie([
      { pflegegrad: 1, validFrom: `${JAHR}-01-01`, validTo: `${JAHR}-09-30` },
      { pflegegrad: 2, validFrom: `${JAHR}-10-01`, validTo: null },
    ]);
    try {
      expect(await getCareLevelAt(id, `${JAHR}-09-15`), "der September-Grad stimmt nicht").toBe(1);
      expect(await getCareLevelAt(id, `${JAHR}-10-15`), "der Oktober-Grad stimmt nicht").toBe(2);
      // Die Grenze selbst: am 01.10. gilt bereits die neue Stufe.
      expect(await getCareLevelAt(id, `${JAHR}-10-01`)).toBe(2);
      expect(await getCareLevelAt(id, `${JAHR}-09-30`)).toBe(1);
    } finally {
      await cleanupCustomer(id);
    }
  });

  it("PS-2 – ohne passende Historienzeile: null, kein stiller Rückfall", async () => {
    // Lieber keine Aussage als eine ungedeckte. Der Aufrufer entscheidet, was
    // `null` heißt — die SSoT fällt NICHT auf den aktuellen Grad zurück.
    const id = await kundeMitHistorie([
      { pflegegrad: 2, validFrom: `${JAHR}-06-01`, validTo: null },
    ]);
    try {
      expect(await getCareLevelAt(id, `${JAHR}-03-15`),
        "vor der ersten Historienzeile wird ein Grad erfunden").toBeNull();
    } finally {
      await cleanupCustomer(id);
    }
  });

  it("PS-3 – die Kostenschätzung liest den Grad zum TERMIN-Datum", async () => {
    /**
     * Der eigentliche Fall — und er prüft die ABLEITUNG, nicht das Boolean.
     *
     * Derselbe Kunde, zwei Termine: im September trägt er PG 1 und hat keinen
     * Ausweichtopf, im Oktober PG 2. Der Satz muss mitwandern.
     */
    const id = await kundeMitHistorie([
      { pflegegrad: 1, validFrom: `${JAHR}-01-01`, validTo: `${JAHR}-09-30` },
      { pflegegrad: 2, validFrom: `${JAHR}-10-01`, validTo: null },
    ]);
    try {
      const q = "&hauswirtschaftMinutes=600&alltagsbegleitungMinutes=0&travelKilometers=0&customerKilometers=0";
      const september = await apiGet<{ warning: string | null }>(
        `/api/budget/${id}/cost-estimate?date=${JAHR}-09-15${q}`);
      const oktober = await apiGet<{ warning: string | null }>(
        `/api/budget/${id}/cost-estimate?date=${JAHR}-10-15${q}`);

      expect(september.status).toBe(200);
      expect(oktober.status).toBe(200);

      // Im September: PG 1, keine Privatzahlung → der Satz gehört dazu.
      expect(september.data.warning ?? "",
        "der Satz fehlt, obwohl der Kunde im September PG 1 trägt")
        .toContain("Kein Ausweichbudget verfügbar.");

      // Im Oktober: PG 2 → der Satz wäre eine falsche Auskunft über
      // Leistungsansprüche.
      expect(oktober.data.warning ?? "",
        "der Satz steht im Oktober, obwohl der Kunde dort PG 2 hat")
        .not.toContain("Ausweichbudget");
    } finally {
      await cleanupCustomer(id);
    }
  });
});
