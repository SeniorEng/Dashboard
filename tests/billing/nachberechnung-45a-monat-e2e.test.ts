/**
 * ABNAHME — Nachberechnung nach Storno, §45a: je KALENDERMONAT, Vorschau = Erstellen.
 * (Tabelle D, Entscheidung Alrik 25.09.2026: „§45a: dieselbe Summe, aber je
 * Kalendermonat getrennt.")
 *
 * ERSETZT AL-3 (#193, Runde 2). AL-3 prüfte eine eigene Nachbildung der
 * Vorschau mit gestelltem Reader. Seit die Vorschau ein Probelauf der echten
 * Neubuchung ist, gibt es die Nachbildung nicht mehr, und die Monatsregel
 * sitzt allein in der Buchungs-Engine (`consumption-engine.ts`, Fenster
 * `umwandlung_45a`). Dieser Test fährt BEIDE Wege gegen dieselbe Engine und
 * prüft das Ergebnis im Ledger (Gate 2 zu #193, S-3).
 *
 * Der Fall: §45a 50,00 € je Monat, drei netto-null belegte Termine zu je
 * 42,00 € (60 min Alltagsbegleitung), einer im Juni, zwei im Juli:
 *
 *   03.06.  42,00 → §45a 42,00                    (Juni: 8,00 bleiben liegen)
 *   08.07.  42,00 → §45a 42,00                    (Juli: frisch)
 *   15.07.  42,00 → §45a  8,00 + privat 34,00     (Juli: 50 beansprucht)
 *
 * Der Juni lässt bewusst einen REST übrig. Nur so ist die Monatstrennung
 * sichtbar: ohne sie wanderten die 8,00 € aus dem Juni in den Juli, und der
 * 15.07. bekäme 16,00 € aus §45a. Eine erste Fassung schöpfte den Juni genau
 * aus — dann gibt es keinen Rest, der wandern könnte, und der Test blieb grün,
 * als die Monatsfenster abgeschaltet waren (Mutations-Gegencheck, „unerreich-
 * bare Konstellation").
 *
 * Grenze: Rechnungen laufen monatlich; ein Lauf über die Monatsgrenze kommt
 * beim echten Aufrufer kaum vor. Geprüft sind die zwei Funktionen, die
 * Vorschau und Erstellen aufrufen, nicht die HTTP-Strecke — die sichert NB-1.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetTransactions, customerBudgetTypeSettings } from "@shared/schema";
import {
  apiGet, apiPost, apiPut, apiPatch, apiDelete,
  getAuthCookie, uniqueId, cleanupCustomer, runCleanup,
} from "../test-utils";
import { assertTestClockActive, clearTestClock, useTestClock } from "../helpers/test-clock";
import { getBudgetSplitForAppointments } from "../../server/services/invoice-data";
import { rebookNetZeroAppointmentConsumption } from "../../server/storage/budget/rebook-storage";

const J = 2026;
const HEUTE = `${J}-09-25`;
const MONAT_45A = 50_00;
const TERMINE = [`${J}-06-03`, `${J}-07-08`, `${J}-07-15`] as const;
const ERWARTET: Record<string, Record<string, number>> = {
  [`${J}-06-03`]: { umwandlung_45a: 42_00 },
  [`${J}-07-08`]: { umwandlung_45a: 42_00 },
  [`${J}-07-15`]: { umwandlung_45a: 8_00, private: 34_00 },
};

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let abId: number;
let customerId: number;
const termin = new Map<string, number>();
const cleanupAppts: number[] = [];

/** Lebender Verbrauch je Termin und Topf (Konsum ohne Storno). */
async function ledgerJeTermin(): Promise<Map<number, Record<string, number>>> {
  const ids = [...termin.values()];
  const verbrauch = await db.select().from(budgetTransactions).where(and(
    eq(budgetTransactions.customerId, customerId),
    eq(budgetTransactions.transactionType, "consumption"),
    inArray(budgetTransactions.appointmentId, ids),
  ));
  const storniert = new Set((await db.select({ ref: budgetTransactions.reversedTransactionId })
    .from(budgetTransactions).where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.transactionType, "reversal"),
    ))).map(r => r.ref).filter((x): x is number => x != null));
  const out = new Map<number, Record<string, number>>();
  for (const v of verbrauch) {
    if (storniert.has(v.id) || v.appointmentId == null) continue;
    const e = out.get(v.appointmentId) ?? {};
    e[v.budgetType] = (e[v.budgetType] ?? 0) + Math.abs(v.amountCents);
    out.set(v.appointmentId, e);
  }
  return out;
}

beforeAll(async () => {
  useTestClock(HEUTE);
  assertTestClockActive();
  auth = await getAuthCookie();
  const services = await apiGet<Array<{ id: number; code: string | null }>>("/api/services/all");
  abId = services.data.find(s => s.code === "alltagsbegleitung")!.id;
});

afterAll(async () => {
  for (const id of cleanupAppts) { try { await apiDelete(`/api/appointments/${id}`); } catch { /* best-effort */ } }
  if (customerId) await cleanupCustomer(customerId);
  await runCleanup();
  clearTestClock();
});

describe("Nachberechnung nach Storno — §45a je Kalendermonat (Tabelle D)", () => {
  it("AL-3 – Vorschau (Probelauf) und Erstellen: im Monat kumuliert, der Juni-Rest wandert nicht in den Juli", async () => {
    const k = await apiPost<{ id: number }>("/api/admin/customers", {
      vorname: "Nachberechnung", nachname: `Monat45a-${uniqueId()}`, geburtsdatum: "1937-03-09",
      email: `nachberechnung-45a-${uniqueId()}@test.local`, strasse: "Musterweg", nr: "3",
      plz: "09111", stadt: "Chemnitz", telefon: "+4917600000091",
      pflegegrad: 3, pflegegradSeit: "2024-01-01",
      billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: true,
    });
    expect(k.status, JSON.stringify(k.data)).toBe(201);
    customerId = k.data.id;
    expect((await apiPatch(`/api/admin/customers/${customerId}/assign`, {
      primaryEmployeeId: auth.user.id, backupEmployeeId: null, backupEmployeeId2: null,
    })).status).toBe(200);
    const init = await apiPost(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "umwandlung_45a", currentMonthAmountCents: MONAT_45A,
      carryoverAmountCents: 0, budgetStartDate: `${J}-06-01`,
    });
    expect([200, 201], `init §45a: ${JSON.stringify(init.data)}`).toContain(init.status);
    expect((await apiPut(`/api/budget/${customerId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", enabled: false, priority: 1, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: MONAT_45A, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
      ],
    })).status).toBe(200);
    // Die Typ-Einstellung wird historisiert: das Limit gälte erst ab morgen
    // (Test-Uhr), Juni–September stünde eine Zeile OHNE Limit (= gesetzlicher
    // Höchstbetrag 598,80 €). Gemessen: dann bekommt der Juli 84,00 € aus §45a,
    // und der Test sagt nichts über den Monat. Das Limit gilt hier für alle
    // Zeilen des Kunden.
    await db.update(customerBudgetTypeSettings).set({ monthlyLimitCents: MONAT_45A })
      .where(and(eq(customerBudgetTypeSettings.customerId, customerId), eq(customerBudgetTypeSettings.budgetType, "umwandlung_45a")));

    // Umgekehrt angelegt: IDs NICHT zufällig chronologisch.
    for (const datum of [...TERMINE].reverse()) {
      const r = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
        customerId, date: datum, scheduledStart: "09:00", notes: `Monat45a-${datum}`,
        assignedEmployeeId: auth.user.id, services: [{ serviceId: abId, durationMinutes: 60 }],
      });
      expect(r.status, `Termin ${datum}: ${JSON.stringify(r.data)}`).toBe(201);
      cleanupAppts.push(r.data.id);
      termin.set(datum, r.data.id);
      const d = await apiPost<unknown>(`/api/appointments/${r.data.id}/document`, {
        actualStart: "09:00", travelOriginType: "home", travelKilometers: 0, customerKilometers: 0,
        services: [{ serviceId: abId, actualDurationMinutes: 60, details: "Monat45a-Abnahme" }],
      });
      expect(d.status, `dokumentieren ${datum}: ${JSON.stringify(d.data)}`).toBe(200);
    }

    // Netto-null machen, wie nach einem Storno: jede Konsum-Zeile storniert.
    const ids = [...termin.values()];
    const konsum = await db.select().from(budgetTransactions).where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.transactionType, "consumption"),
      inArray(budgetTransactions.appointmentId, ids),
    ));
    expect(konsum.length, "Vorbedingung: das Dokumentieren hat gebucht").toBeGreaterThan(0);
    for (const v of konsum) {
      await db.insert(budgetTransactions).values({
        customerId, budgetType: v.budgetType, transactionType: "reversal",
        amountCents: -v.amountCents, transactionDate: v.transactionDate,
        appointmentId: v.appointmentId, allocationId: v.allocationId,
        reversedTransactionId: v.id, description: `Monat45a-Storno-${v.id}`,
      } as never);
    }
    expect((await ledgerJeTermin()).size, "Vorbedingung: alle Termine netto null").toBe(0);

    // ── Vorschau (Probelauf) ─────────────────────────────────────────────
    const vorschau = await getBudgetSplitForAppointments(customerId, ids);
    for (const datum of TERMINE) {
      expect(vorschau.get(termin.get(datum)!)?.cents, `Vorschau ${datum}`).toEqual(ERWARTET[datum]);
    }
    expect((await ledgerJeTermin()).size, "die Vorschau hat gebucht").toBe(0);

    // ── Erstellen ──────────────────────────────────────────────────────
    await rebookNetZeroAppointmentConsumption({ customerId, appointmentIds: ids, userId: auth.user.id });
    const ledger = await ledgerJeTermin();
    for (const datum of TERMINE) {
      expect(ledger.get(termin.get(datum)!), `Erstellen ${datum}`).toEqual(ERWARTET[datum]);
    }
  }, 300_000);
});
