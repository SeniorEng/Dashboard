import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetAllocations, insuranceProviders } from "@shared/schema";
import { apiPost, cleanupCustomer, getAuthCookie, uniqueId } from "../test-utils";

/**
 * Eine festgestellte Null überlebt BEIDE Eingabewege gleich (S5, Alrik 24.09.2026).
 *
 * ── Warum das ein eigener Test ist ──────────────────────────────────────
 * Die Regel „0 € ist eine festgestellte Null, keine fehlende Angabe" sitzt in
 * `applyInitialBudget` (`!= null`, gesichert von `NS-4`) — dort wurde sie bei
 * #163 auch behoben. Die Route `POST /budget/:id/initial-budget` übersetzte den
 * Body aber vorher selbst:
 *
 *     carryoverAmountCents: carryoverAmountCents > 0 ? carryoverAmountCents : null
 *
 * Damit warf der WEG zur Funktion die Unterscheidung weg, die die Funktion
 * trifft. Der Anwender bekam `201` samt Audit-Eintrag über einen Betrag, den
 * niemand gespeichert hat. Der Wizard-Weg
 * (`customer-creation-helpers`, `?? null`) trug sie bereits durch — also taten
 * zwei Wege zur selben fachlichen Frage Verschiedenes.
 *
 * ── Warum der Vergleich und nicht zwei Einzelzusagen ────────────────────
 * Ein Test pro Weg wäre grün, sobald jeder Weg IN SICH stimmig ist — auch wenn
 * beide etwas anderes speichern. Geprüft wird deshalb die GLEICHHEIT der
 * geschriebenen Zeile: dieselbe Eingabe, dasselbe Ergebnis, egal wo sie
 * hereinkommt. Das ist die Drei-Schichten-Pflicht auf den Midlayer angewandt,
 * und der Midlayer ist hier der Täter.
 *
 * Beide Wege laufen über HTTP. Ein Aufruf von `applyInitialBudget` als
 * „Wizard-Ersatz" würde genau die Schicht überspringen, in der der Fehler saß —
 * derselbe Fehler, der bei #184 vier Tests grün ließ, während die Route kaputt
 * war.
 */

const JAHR = new Date().getFullYear();
/** Stichmonat und Übertrags-Gültigkeit im selben Jahr — die Verdrängung ist hier nicht Gegenstand. */
const START = `${JAHR}-03-01`;

let insuranceProviderId: number;

async function zeilen(customerId: number) {
  return db
    .select({
      source: budgetAllocations.source,
      year: budgetAllocations.year,
      month: budgetAllocations.month,
      amountCents: budgetAllocations.amountCents,
      validFrom: budgetAllocations.validFrom,
      expiresAt: budgetAllocations.expiresAt,
    })
    .from(budgetAllocations)
    .where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
    ))
    .orderBy(budgetAllocations.source, budgetAllocations.validFrom);
}

/** Der Wizard-Weg: `POST /api/admin/customers` mit `budgets.*`. */
async function ueberWizard(uebertragCents: number | undefined, startwertCents: number | undefined) {
  const res = await apiPost<any>("/api/admin/customers", {
    vorname: "S5-Wizard",
    nachname: `Null-${uniqueId()}`,
    geburtsdatum: "1940-01-15",
    strasse: "Teststraße", nr: "1", plz: "10115", stadt: "Berlin",
    pflegegrad: 3,
    pflegegradSeit: `${JAHR - 1}-01-01`,
    insurance: {
      providerId: insuranceProviderId,
      versichertennummer: "A" + String(Math.floor(100000000 + Math.random() * 900000000)),
      validFrom: `${JAHR - 1}-01-01`,
    },
    contacts: [{
      contactType: "familie", isPrimary: true,
      vorname: "Kontakt", nachname: "Test", mobilnummer: "+4917600000001",
    }],
    budgets: {
      entlastungsbetrag45b: 0,
      verhinderungspflege39: 0,
      pflegesachleistungen36: 0,
      validFrom: `${JAHR - 1}-01-01`,
      ...(startwertCents != null ? { override45bCents: startwertCents, override45bStichmonatStart: START } : {}),
      ...(uebertragCents != null ? { carryoverAmountCents: uebertragCents } : {}),
    },
  });
  expect(res.status, `Wizard-Anlage fehlgeschlagen: ${JSON.stringify(res.data)}`).toBe(201);
  return (res.data?.customer?.id ?? res.data?.id) as number;
}

/** Der Routen-Weg: derselbe Betrag über `POST /budget/:id/initial-budget`. */
async function ueberRoute(uebertragCents: number | undefined, startwertCents: number | undefined) {
  // Ein Kunde ohne jedes Startbudget — die Zeile entsteht erst durch den Aufruf unten.
  const id = await ueberWizard(undefined, undefined);
  const res = await apiPost<any>(`/api/budget/${id}/initial-budget`, {
    budgetType: "entlastungsbetrag_45b",
    budgetStartDate: START,
    ...(startwertCents != null ? { currentMonthAmountCents: startwertCents } : {}),
    ...(uebertragCents != null ? { carryoverAmountCents: uebertragCents } : {}),
  });
  expect([200, 201], `Routen-Aufruf fehlgeschlagen: ${JSON.stringify(res.data)}`).toContain(res.status);
  return id;
}

describe("§45b — die festgestellte Null überlebt Wizard und Route gleich", () => {
  beforeAll(async () => {
    await getAuthCookie();
    const [p] = await db.select({ id: insuranceProviders.id }).from(insuranceProviders).limit(1);
    expect(p, "keine Kasse in den Referenzdaten — Seed fehlt").toBeTruthy();
    insuranceProviderId = p!.id;
  }, 60_000);

  it("FN-1 – Übertrag 0 €: Wizard und Route schreiben dieselbe Zeile", async () => {
    const wizardId = await ueberWizard(0, undefined);
    const routeId = await ueberRoute(0, undefined);
    try {
      const w = await zeilen(wizardId);
      const r = await zeilen(routeId);

      /**
       * Erst die Substanz, dann die Gleichheit.
       *
       * Ohne diese Zeile wäre FN-1 auch dann grün, wenn BEIDE Wege nichts
       * schreiben — genau der Zustand vor S5 auf der Routen-Seite. Eine
       * Gleichheitszusage allein ist gegen „beide tun nichts" blind.
       */
      expect(
        w.filter((z) => z.source === "carryover"),
        "der Wizard hat für die festgestellte Null keine Übertragszeile geschrieben",
      ).toHaveLength(1);
      expect(
        r.filter((z) => z.source === "carryover"),
        "die Route hat für die festgestellte Null keine Übertragszeile geschrieben — "
        + "0 wird wieder auf `null` gemappt",
      ).toHaveLength(1);

      expect(r, "dieselbe 0 € ergibt über die Route eine andere Zeile als über den Wizard").toEqual(w);
    } finally {
      await cleanupCustomer(wizardId);
      await cleanupCustomer(routeId);
    }
  }, 120_000);

  it("FN-2 – Startwert 0 €: Wizard und Route schreiben dieselbe Zeile", async () => {
    // Die andere Hälfte derselben Übersetzung: `currentMonthAmountCents` hatte
    // in der Route dieselbe `> 0`-Falte.
    const wizardId = await ueberWizard(undefined, 0);
    const routeId = await ueberRoute(undefined, 0);
    try {
      const w = await zeilen(wizardId);
      const r = await zeilen(routeId);

      expect(
        w.filter((z) => z.source === "initial_balance"),
        "der Wizard hat für den 0-€-Startwert keine Zeile geschrieben",
      ).toHaveLength(1);
      expect(
        r.filter((z) => z.source === "initial_balance"),
        "die Route hat für den 0-€-Startwert keine Zeile geschrieben",
      ).toHaveLength(1);

      expect(r, "derselbe 0-€-Startwert ergibt über die Route eine andere Zeile").toEqual(w);
    } finally {
      await cleanupCustomer(wizardId);
      await cleanupCustomer(routeId);
    }
  }, 120_000);

  it("FN-3 – WEGGELASSEN bleibt weggelassen: kein Weg erfindet eine 0-Zeile", async () => {
    /**
     * Die Gegenrichtung, und der Grund, warum `carryoverAmountCents` sein
     * `.default(0)` verloren hat.
     *
     * Mit dem Default wäre ein nicht gesendetes Feld zu `0` geworden — und
     * sobald `0` eine festgestellte Null ist, hätte jeder Aufrufer, der den
     * Übertrag gar nicht erwähnt, eine Übertragszeile erzeugt. Gemessen: 92
     * Stellen im Repo schicken `carryoverAmountCents: 0` als Füllwert; ein
     * Default hätte die Zahl still auf „alle Aufrufer" erweitert.
     *
     * „Keine Angabe" und „festgestellte Null" müssen deshalb BEIDE
     * unterscheidbar bleiben, nicht nur die zweite ausdrückbar sein.
     */
    const wizardId = await ueberWizard(undefined, 13_100);
    const routeId = await ueberRoute(undefined, 13_100);
    try {
      const w = await zeilen(wizardId);
      const r = await zeilen(routeId);

      expect(
        w.filter((z) => z.source === "carryover"),
        "der Wizard hat einen Übertrag erfunden, den niemand angegeben hat",
      ).toHaveLength(0);
      expect(
        r.filter((z) => z.source === "carryover"),
        "die Route hat einen Übertrag erfunden — `.default(0)` ist zurück",
      ).toHaveLength(0);

      // Und der Startwert ist trotzdem da: sonst wäre FN-3 auch grün, wenn
      // überhaupt nichts geschrieben wird.
      expect(w.filter((z) => z.source === "initial_balance"), "kein Startwert beim Wizard").toHaveLength(1);
      expect(r.filter((z) => z.source === "initial_balance"), "kein Startwert bei der Route").toHaveLength(1);

      expect(r, "derselbe Startwert ohne Übertrag ergibt über die Route eine andere Zeile").toEqual(w);
    } finally {
      await cleanupCustomer(wizardId);
      await cleanupCustomer(routeId);
    }
  }, 120_000);
});
