import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetAllocations, customerBudgetTypeSettings, customerCareLevelHistory } from "@shared/schema";
import { apiPost, createTestCustomer, cleanupCustomer, getAuthCookie } from "../test-utils";

/**
 * Ein Wiederholungs-Versuch überschreibt keinen erfassten Startwert.
 * (Alrik, 24.09.2026 — dritter Teil der B1-Auflösung.)
 *
 * ── Der Fall ───────────────────────────────────────────────────────────
 * Der Banner „Startbudgets erneut versuchen" spielt einen GESPEICHERTEN
 * Payload gegen `POST /budget/:id/initial-budget` ab.
 * `upsertInitialBalanceAllocation` macht bei vorhandener aktiver Zeile ein
 * `UPDATE … SET amount_cents = <Payload-Wert>`. Trägt der Payload eine `0` —
 * weil sein Kontrakt „keine Angabe" nicht ausdrücken konnte —, dann setzt ein
 * Klick einen inzwischen erfassten Startwert still auf null.
 *
 * Alriks Vorgabe: **entweder idempotent über denselben Payload, oder Konflikt
 * melden.** Beide Richtungen stehen hier.
 *
 * ── Warum die Schranke nicht in der Storage-Funktion sitzt ─────────────
 * Der Startwert-EDITOR (`POST /budget/:id/initial-balance/:budgetType`) geht an
 * `applyInitialBudget` vorbei und MUSS weiter korrigieren dürfen. Eine
 * Schranke in `upsertInitialBalanceAllocation` hätte ihm das genommen —
 * `RU-4` hält das fest.
 */

const JAHR = 2026;
const MONAT = 6;
const ERFASST = 184_60;

async function kundeMitStartwert(): Promise<number> {
  await getAuthCookie();
  const c = await createTestCustomer({
    pflegegrad: 3, billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: false,
  });
  const id = c.id as number;
  await db.delete(customerCareLevelHistory).where(eq(customerCareLevelHistory.customerId, id));
  await db.insert(customerCareLevelHistory).values({
    customerId: id, pflegegrad: 3, validFrom: `${JAHR - 1}-01-01`, validTo: null,
  });
  await db.insert(customerBudgetTypeSettings).values({
    customerId: id, budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1,
    monthlyLimitCents: null, yearlyLimitCents: null, validFrom: `${JAHR}-01-01`, validTo: null,
  });
  await db.insert(budgetAllocations).values({
    customerId: id, budgetType: "entlastungsbetrag_45b", year: JAHR, month: MONAT,
    amountCents: ERFASST, source: "initial_balance",
    validFrom: `${JAHR}-0${MONAT}-01`, expiresAt: null, notes: "RU-erfasst",
  });
  return id;
}

async function startwerte(customerId: number) {
  return db.select({ amountCents: budgetAllocations.amountCents })
    .from(budgetAllocations)
    .where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
      eq(budgetAllocations.source, "initial_balance"),
    ));
}

describe("§45b — ein Retry überschreibt keinen erfassten Startwert", () => {
  it("RU-1 – ein 0-Payload auf einen erfassten Startwert wird mit 409 abgelehnt", async () => {
    const id = await kundeMitStartwert();
    try {
      const res = await apiPost<any>(`/api/budget/${id}/initial-budget`, {
        budgetType: "entlastungsbetrag_45b",
        currentMonthAmountCents: 0,
        budgetStartDate: `${JAHR}-0${MONAT}-01`,
      });
      expect(res.status, `erwartet 409, bekommen ${res.status}`).toBe(409);

      // Der Kern: der Betrag steht unverändert.
      expect(
        await startwerte(id),
        "der erfasste Startwert wurde trotz Ablehnung verändert",
      ).toEqual([{ amountCents: ERFASST }]);
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);

  it("RU-2 – die Meldung nennt beide Beträge, sonst rät der Anwender", async () => {
    const id = await kundeMitStartwert();
    try {
      const res = await apiPost<any>(`/api/budget/${id}/initial-budget`, {
        budgetType: "entlastungsbetrag_45b",
        currentMonthAmountCents: 0,
        budgetStartDate: `${JAHR}-0${MONAT}-01`,
      });
      const text = String(res.data?.message ?? res.data?.error ?? "");
      expect(text, "der erfasste Betrag fehlt in der Meldung").toContain("184,60");
      expect(text, "der Monat fehlt in der Meldung").toContain(`0${MONAT}/${JAHR}`);
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);

  it("RU-3 – DERSELBE Payload ist idempotent, kein Fehler", async () => {
    /**
     * Die Gegenrichtung, und Alriks ausdrückliche Alternative: ein Retry, der
     * genau das wiederholt, was schon steht, ist kein Konflikt.
     *
     * Ohne diesen Test wäre `RU-1` auch erfüllt, wenn der Endpunkt JEDEN
     * Wiederholungs-Versuch ablehnt — dann wäre der Banner nutzlos statt
     * gefährlich.
     */
    const id = await kundeMitStartwert();
    try {
      const res = await apiPost<any>(`/api/budget/${id}/initial-budget`, {
        budgetType: "entlastungsbetrag_45b",
        currentMonthAmountCents: ERFASST,
        budgetStartDate: `${JAHR}-0${MONAT}-01`,
      });
      expect([200, 201], `derselbe Betrag wurde abgelehnt: ${JSON.stringify(res.data)}`)
        .toContain(res.status);
      expect(
        await startwerte(id),
        "der idempotente Lauf hat den Bestand verändert",
      ).toEqual([{ amountCents: ERFASST }]);
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);

  it("RU-4 – der Startwert-EDITOR darf weiter korrigieren", async () => {
    /**
     * Die Schranke sitzt in `applyInitialBudget`, nicht in der
     * Storage-Funktion. Dieser Test hält den Grund fest: der Editor geht einen
     * anderen Weg und muss einen Startwert ändern können — das ist seine
     * einzige Aufgabe.
     *
     * Säße die Schranke eine Ebene tiefer, wäre dieser Test rot, und der
     * Fehler wäre erst im Betrieb aufgefallen.
     */
    const id = await kundeMitStartwert();
    try {
      const res = await apiPost<any>(`/api/budget/${id}/initial-balance/entlastungsbetrag_45b`, {
        amountCents: 250_00,
        // Der Editor nimmt `YYYY-MM` (`initialBalanceSchema`), nicht das
        // Tagesdatum des Anlage-Pfads — zwei Kontrakte, ein Vorgang.
        validFrom: `${JAHR}-0${MONAT}`,
      });
      expect([200, 201], `der Editor wurde blockiert: ${JSON.stringify(res.data)}`)
        .toContain(res.status);
      expect(
        await startwerte(id),
        "der Editor konnte den Startwert nicht korrigieren",
      ).toEqual([{ amountCents: 250_00 }]);
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);
  it("RU-5 – bei 409 wird NICHTS geschrieben, auch nicht der Topf-Status", async () => {
    /**
     * Die Ablehnung darf nichts hinterlassen (Gate 2 zum B1-Delta, S-2).
     *
     * Die Schranke stand zuerst direkt über dem Upsert — also NACH
     * `ensureBudgetTypeEnabledInPlace`, das für §45a/§39 bereits schreibt. Auf
     * dem Standalone-Endpunkt gibt es keine Transaktion: ein 409 ließ dort eine
     * re-aktivierte Topf-Zeile zurück und meldete dazu „die Anlage überschreibt
     * ihn nicht".
     *
     * `EO-1` sichert dieselbe Zusage für das Entweder-oder. Für den 409 gab es
     * sie nicht — hier ist sie.
     */
    const id = await kundeMitStartwert();
    try {
      // §45a-Startwert anlegen und den Topf danach deaktivieren, damit
      // `ensureBudgetTypeEnabledInPlace` beim nächsten Aufruf etwas zu tun hätte.
      await db.insert(budgetAllocations).values({
        customerId: id, budgetType: "umwandlung_45a", year: JAHR, month: MONAT,
        amountCents: 300_00, source: "initial_balance",
        validFrom: `${JAHR}-0${MONAT}-01`, expiresAt: null, notes: "RU5-45a",
      });
      const vorher = await db.select({ id: customerBudgetTypeSettings.id })
        .from(customerBudgetTypeSettings)
        .where(and(
          eq(customerBudgetTypeSettings.customerId, id),
          eq(customerBudgetTypeSettings.budgetType, "umwandlung_45a"),
        ));

      const res = await apiPost<any>(`/api/budget/${id}/initial-budget`, {
        budgetType: "umwandlung_45a",
        currentMonthAmountCents: 500_00,
        budgetStartDate: `${JAHR}-0${MONAT}-01`,
      });
      expect(res.status, `erwartet 409, bekommen ${res.status}`).toBe(409);

      const nachher = await db.select({ id: customerBudgetTypeSettings.id })
        .from(customerBudgetTypeSettings)
        .where(and(
          eq(customerBudgetTypeSettings.customerId, id),
          eq(customerBudgetTypeSettings.budgetType, "umwandlung_45a"),
        ));
      expect(
        nachher.length,
        "die Ablehnung hat eine Topf-Einstellung hinterlassen — sie läuft nach "
        + "dem ersten Schreibvorgang",
      ).toBe(vorher.length);

      const zeilen45a = await db.select({ amountCents: budgetAllocations.amountCents })
        .from(budgetAllocations)
        .where(and(
          eq(budgetAllocations.customerId, id),
          eq(budgetAllocations.budgetType, "umwandlung_45a"),
        ));
      expect(zeilen45a, "der §45a-Startwert wurde trotz Ablehnung verändert")
        .toEqual([{ amountCents: 300_00 }]);
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);

  it("RU-6 – ein Übertrag für einen Topf ohne Übertrag wird abgelehnt", async () => {
    /**
     * Gate 2 zum B1-Delta, S-1: die `refine`-Regel schloss nur die halbe
     * Klasse. Sie fing den Body, der NUR einen Übertrag trägt — nicht den, der
     * ihn NEBEN einem Startwert trägt.
     *
     * Gemessen am Beispiel aus dem Review: §45a mit 300 € Startwert und 500 €
     * Übertrag ergab `201`, schrieb nur die 300 € und verlor die 500 €
     * still — während der Audit-Eintrag sie protokollierte.
     */
    const id = await kundeMitStartwert();
    try {
      const res = await apiPost<any>(`/api/budget/${id}/initial-budget`, {
        budgetType: "umwandlung_45a",
        currentMonthAmountCents: 300_00,
        carryoverAmountCents: 500_00,
        budgetStartDate: `${JAHR}-0${MONAT}-01`,
      });
      expect(res.status, "der Übertrag für §45a wurde angenommen").toBe(400);
      expect(
        String(res.data?.message ?? ""),
        "die Meldung sagt nicht, warum — dann rät der Anwender",
      ).toContain("§45b");

      const zeilen45a = await db.select({ id: budgetAllocations.id })
        .from(budgetAllocations)
        .where(and(
          eq(budgetAllocations.customerId, id),
          eq(budgetAllocations.budgetType, "umwandlung_45a"),
        ));
      expect(zeilen45a, "trotz Ablehnung wurde für §45a geschrieben").toEqual([]);
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);
});
