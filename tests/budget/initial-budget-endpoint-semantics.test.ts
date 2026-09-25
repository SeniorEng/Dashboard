/**
 * Task #725 / #731 — `POST /api/budget/:cid/initial-budget` Semantik pro Topf.
 *
 * Reproducer-Test: der Parameter ist semantisch ein **Monatswert**, nicht
 * ein Jahreswert. Der kanonische Name ist `currentMonthAmountCents`; der
 * alte Name `currentYearAmountCents` wurde nach einem Release-Zyklus
 * entfernt (#731) und wird vom Schema mit 400 abgelehnt. Pro Topf-Typ
 * (§45b / §45a / §39_42a) prüft diese Suite, dass GENAU EINE
 * `initial_balance`-Allokation für den durch `budgetStartDate`
 * adressierten Monat angelegt wird — nicht zwölf, nicht eine Jahres-Zeile
 * mit `month=null`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetAllocations } from "@shared/schema";
import {
  apiPost,
  createTestCustomer,
  getAuthCookie,
  runCleanup,
} from "../test-utils";

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

async function freshCustomer(prefix: string): Promise<number> {
  const c = await createTestCustomer({
    vorname: prefix,
    nachname: `T725_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    pflegegrad: 3,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  return c.id as number;
}

async function getInitialBalances(customerId: number, budgetType: string) {
  return db
    .select()
    .from(budgetAllocations)
    .where(
      and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.budgetType, budgetType),
        eq(budgetAllocations.source, "initial_balance"),
        isNull(budgetAllocations.deletedAt),
      ),
    );
}

describe("Task #725 — initial-budget Endpoint-Semantik (Monatswert)", () => {
  it("§45b: currentMonthAmountCents bucht eine Monats-Allokation für den Startmonat", async () => {
    const customerId = await freshCustomer("T725-45b");
    const budgetStartDate = "2026-05-15";
    const amount = 13_100;

    const res = await apiPost(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentMonthAmountCents: amount,
      // Kein `carryoverAmountCents: 0` — hier ist „kein Übertrag“ gemeint.
      // Beim Aufräumen der neun Füllwerte übersehen (Gate 2 zu #186, S7); der
      // Test blieb grün, weil `getInitialBalances` auf `source =
      // 'initial_balance'` filtert und die zusätzlich entstehende
      // Übertragszeile für die Zusage unsichtbar war.
      budgetStartDate,
    });
    expect([200, 201]).toContain(res.status);

    const rows = await getInitialBalances(customerId, "entlastungsbetrag_45b");
    expect(rows.length).toBe(1);
    expect(rows[0].year).toBe(2026);
    expect(rows[0].month).toBe(5);
    expect(rows[0].amountCents).toBe(amount);
    expect(rows[0].validFrom).toBe(budgetStartDate);
    // §45b läuft nicht ab — Verfallsfenster wird über carryover verwaltet.
    expect(rows[0].expiresAt).toBeNull();
  });

  it("§45a: bucht eine Monats-Allokation für den Startmonat", async () => {
    const customerId = await freshCustomer("T725-45a");
    const budgetStartDate = "2026-05-15";
    const amount = 25_000;

    const res = await apiPost(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "umwandlung_45a",
      currentMonthAmountCents: amount,
      budgetStartDate,
    });
    expect([200, 201]).toContain(res.status);

    const rows = await getInitialBalances(customerId, "umwandlung_45a");
    expect(rows.length).toBe(1);
    expect(rows[0].year).toBe(2026);
    expect(rows[0].month).toBe(5);
    expect(rows[0].amountCents).toBe(amount);
  });

  it("§39/§42a: bucht eine Monats-Allokation mit Verfall zum Jahresende", async () => {
    const customerId = await freshCustomer("T725-39");
    const budgetStartDate = "2026-05-15";
    const amount = 150_000;

    const res = await apiPost(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "ersatzpflege_39_42a",
      currentMonthAmountCents: amount,
      budgetStartDate,
    });
    expect([200, 201]).toContain(res.status);

    const rows = await getInitialBalances(customerId, "ersatzpflege_39_42a");
    expect(rows.length).toBe(1);
    expect(rows[0].year).toBe(2026);
    expect(rows[0].month).toBe(5);
    expect(rows[0].amountCents).toBe(amount);
    // §39/§42a: jährlicher Anspruch, verfällt am 31.12.
    expect(rows[0].expiresAt).toBe("2026-12-31");
  });

  it("Task #731: alter Alias `currentYearAmountCents` wird vom Schema mit 400 abgelehnt", async () => {
    /**
     * Der Füllwert `carryoverAmountCents: 0` ist am 24.09.2026 RAUS — er hat
     * diesen Test um seine Aussage gebracht.
     *
     * Gemessen: `initialBudgetSchema` ist NICHT `.strict()`; der unbekannte
     * Alias-Schlüssel wird still verworfen. Die `400` kam also nie vom Alias,
     * sondern davon, dass kein bekannter Betrag übrigblieb. Mit dem Füllwert
     * daneben — sobald `0` als festgestellte Null zählt (S5) — nennt der Body
     * einen bekannten Betrag, und derselbe Test meldet `201`.
     *
     * Die Zusage, die er trägt, ist damit genau: **ein Aufrufer, der nur den
     * alten Alias schickt, kommt nicht still durch.** Dafür darf im Body kein
     * zweiter Betrag stehen.
     *
     * FINDING dazu (still ignorierte Unbekannte) steht im PR-Body; ein
     * `.strict()` hat eigenen Blast-Radius und gehört nicht in diesen Diff.
     */
    const customerId = await freshCustomer("T731-alias-removed");
    const res = await apiPost(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentYearAmountCents: 13_100,
      budgetStartDate: "2026-05-15",
    });
    expect(res.status).toBe(400);

    // Es darf KEINE Allokation angelegt worden sein.
    const rows = await getInitialBalances(customerId, "entlastungsbetrag_45b");
    expect(rows.length).toBe(0);
  });

  it("Validation: ohne JEDE Angabe (weder Startwert noch Übertrag) → 400", async () => {
    /**
     * Der Name hat sich am 24.09.2026 geändert, die Zusage nicht.
     *
     * Vorher hielt dieser Test die Pflichtfeld-Eigenschaft von
     * `currentMonthAmountCents` fest. Das Feld ist jetzt optional, damit „nur
     * Übertrag" überhaupt ausdrückbar ist (Alriks Entweder-oder) — die Zusage
     * dahinter war aber nie „dieses Feld muss da sein", sondern **„der
     * Endpunkt darf nicht 201 melden und nichts schreiben"**.
     *
     * Die prüft er weiter, nur über die `refine`-Regel statt über das
     * Pflichtfeld.
     *
     * Der Füllwert `carryoverAmountCents: 0` ist dabei RAUS: seit `0` eine
     * festgestellte Null ist, wäre er eine Angabe — der Test hätte „ohne jede
     * Angabe" behauptet und eine gemacht.
     */
    const customerId = await freshCustomer("T725-validation");
    const res = await apiPost(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      budgetStartDate: "2026-01-01",
    });
    expect(res.status).toBe(400);
  });
});
