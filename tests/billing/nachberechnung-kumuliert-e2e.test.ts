/**
 * ABNAHME — Nachberechnung nach Storno: die Kasse bekommt nie mehr, als im Topf ist.
 * (Entscheidung Alrik 25.09.2026, Tabelle D; eigener Geldfehler, unabhängig vom Flip.)
 *
 * ── Der Fehler ──────────────────────────────────────────────────────────
 * Nach einem Voll-Storno kommen die Termine auf zwei Wegen zurück:
 *   · die VORSCHAU prüfte jeden Termin gegen die VOLLE Verfügbarkeit —
 *     drei Termine, die einzeln passen, passten zusammen auch;
 *   · das ERSTELLEN buchte in der Ladereihenfolge der Buchungen, nicht nach
 *     Datum. Ein früher datierter Termin liest die Verfügbarkeit zu SEINEM
 *     Datum und sieht die Buchung eines später datierten nicht — er nimmt
 *     den Topf ein zweites Mal. Gemessen: die Kassen-Summe stieg über den Topf.
 *
 * ── Die Regel (Tabelle D) ───────────────────────────────────────────────
 *   §45b: Summe über ALLE Termine des Laufs, chronologisch.
 *   §45a: dieselbe Summe, je Kalendermonat getrennt.
 *
 * ── Der Fall ────────────────────────────────────────────────────────────
 * Funkes Zahlen, aber OHNE Übertrag — der Flip ist nicht Teil dieses PRs, und
 * der Fall entsteht ohne ihn genauso: Startwert Juni 184,60 €, drei
 * Juni-Termine über 194,20 €, jeder einzeln kleiner als der Topf.
 *
 * Chronologisch gegen 184,60 €: 72,20 → Kasse, 61,00 → Kasse,
 * 61,00 → 51,40 Kasse + 9,60 privat.
 *
 * Die Termine werden in UMGEKEHRTER Reihenfolge angelegt und dokumentiert,
 * damit IDs und Ladereihenfolge NICHT zufällig chronologisch sind.
 *
 * Preise aus `shared/config/services.ts`: Hauswirtschaft 38,00 €/h,
 * Alltagsbegleitung 42,00 €/h, Fahrt-km 0,35 € (`travel_km` zählt gegen §45b).
 * Termine in 15-Minuten-Schritten (Validierung); die 0,20 € kommen über 2 km.
 */
import { validSignatureDataUrl } from "../helpers/valid-signature";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetAllocations, budgetTransactions } from "@shared/schema";
import {
  apiGet, apiPost, apiPut, apiPatch, apiDelete,
  getAuthCookie, uniqueId, cleanupCustomer, runCleanup,
} from "../test-utils";
import { assertTestClockActive, clearTestClock, useTestClock } from "../helpers/test-clock";
import { readUnifiedBudgetAvailability } from "../../server/storage/budget/unified-reader";

const J = 2026;
const HEUTE = `${J}-09-25`;

const STARTWERT_JUNI = 184_60;

/** Drei Juni-Termine, Summe 194,20 €. Jeder EINZELN < 184,60 €. */
const TERMINE = [
  { datum: `${J}-06-03`, hw: 30, ab: 75, km: 2, cents: 72_20 },
  { datum: `${J}-06-10`, hw: 30, ab: 60, km: 0, cents: 61_00 },
  { datum: `${J}-06-17`, hw: 30, ab: 60, km: 0, cents: 61_00 },
] as const;
const SUMME = 194_20;
const KASSE = 184_60;
const PRIVAT = 9_60;
/**
 * Tabelle D (Alrik, 25.09.2026): gegen alle Töpfe wird NETTO gerechnet, USt
 * entsteht nur auf der Privatrechnung und verbraucht nie Budget.
 * 184,60 Kasse + 9,60 privat netto + 1,82 USt (19 % auf 9,60) = 196,02 €.
 */
const BRUTTO = 196_02;

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let hwId: number;
let abId: number;
let customerId: number;
const apptIdNachDatum = new Map<string, number>();
const cleanup = { appts: [] as number[], srs: [] as number[], invoices: [] as number[] };

async function lebenderVerbrauch(budgetType: string): Promise<{ summe: number; nachTermin: Map<number, number> }> {
  const verbrauch = await db.select().from(budgetTransactions).where(and(
    eq(budgetTransactions.customerId, customerId),
    eq(budgetTransactions.budgetType, budgetType),
    eq(budgetTransactions.transactionType, "consumption"),
  ));
  const storniert = new Set((await db.select({ ref: budgetTransactions.reversedTransactionId })
    .from(budgetTransactions).where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.transactionType, "reversal"),
    ))).map(r => r.ref).filter((x): x is number => x != null));
  const nachTermin = new Map<number, number>();
  let summe = 0;
  for (const v of verbrauch) {
    if (storniert.has(v.id)) continue;
    summe += Math.abs(v.amountCents);
    if (v.appointmentId != null) {
      nachTermin.set(v.appointmentId, (nachTermin.get(v.appointmentId) ?? 0) + Math.abs(v.amountCents));
    }
  }
  return { summe, nachTermin };
}

async function generiere(): Promise<any[]> {
  const gen = await apiPost<any>("/api/billing/generate", {
    customerId, billingMonth: 6, billingYear: J,
  });
  expect(gen.status, `generate: ${JSON.stringify(gen.data)}`).toBe(200);
  const invoices: any[] = gen.data?.splitInvoices ? gen.data.invoices : [gen.data];
  for (const i of invoices) if (i?.id) cleanup.invoices.push(i.id);
  return invoices;
}

beforeAll(async () => {
  useTestClock(HEUTE);
  assertTestClockActive();
  auth = await getAuthCookie();
  const services = await apiGet<Array<{ id: number; code: string | null }>>("/api/services/all");
  hwId = services.data.find(s => s.code === "hauswirtschaft")!.id;
  abId = services.data.find(s => s.code === "alltagsbegleitung")!.id;
});

afterAll(async () => {
  const list = await apiGet<any[]>(`/api/billing?customerId=${customerId}`).catch(() => null);
  for (const i of (list?.data as any[] | undefined) ?? []) if (!cleanup.invoices.includes(i.id)) cleanup.invoices.push(i.id);
  for (const id of cleanup.invoices) { try { await apiDelete(`/api/billing/${id}`); } catch { /* best-effort */ } }
  for (const id of cleanup.srs) { try { await apiDelete(`/api/service-records/${id}`); } catch { /* best-effort */ } }
  for (const id of cleanup.appts) { try { await apiDelete(`/api/appointments/${id}`); } catch { /* best-effort */ } }
  if (customerId) await cleanupCustomer(customerId);
  await runCleanup();
  clearTestClock();
});

describe("Nachberechnung nach Storno — kumuliert und chronologisch (Tabelle D)", () => {
  it("NB-1 – storniert → Erstellen: 184,60 € Kasse / 9,60 € privat, Vorschau gleich, Juli stimmt", async () => {
    // ── Kunde ──────────────────────────────────────────────────────────
    const k = await apiPost<{ id: number }>("/api/admin/customers", {
      vorname: "Nachberechnung", nachname: `Kumuliert-${uniqueId()}`, geburtsdatum: "1938-04-02",
      email: `nachberechnung-${uniqueId()}@test.local`, strasse: "Musterweg", nr: "1",
      plz: "09111", stadt: "Chemnitz", telefon: "+4917600000089",
      pflegegrad: 3, pflegegradSeit: "2024-01-01",
      billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: true,
    });
    expect(k.status, JSON.stringify(k.data)).toBe(201);
    customerId = k.data.id;
    expect((await apiPatch(`/api/admin/customers/${customerId}/assign`, {
      primaryEmployeeId: auth.user.id, backupEmployeeId: null, backupEmployeeId2: null,
    })).status).toBe(200);
    expect((await apiPut(`/api/budget/${customerId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
      ],
    })).status).toBe(200);

    // ── Startwert Juni (von Anfang an) ─────────────────────────────────
    await db.insert(budgetAllocations).values({
      customerId, budgetType: "entlastungsbetrag_45b", year: J, month: 6,
      amountCents: STARTWERT_JUNI, source: "initial_balance",
      validFrom: `${J}-06-01`, expiresAt: null, notes: "Nachberechnung-Startwert-Juni",
    });

    // ── Drei Juni-Termine, in UMGEKEHRTER Reihenfolge angelegt ─────────
    // Damit sind die IDs NICHT zufällig chronologisch — sonst könnte der Test
    // gar nicht sehen, ob nach Datum oder nach ID gebucht wird.
    for (const t of [...TERMINE].reverse()) {
      const r = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
        customerId, date: t.datum, scheduledStart: "09:00",
        notes: `Nachberechnung-${t.datum}`, assignedEmployeeId: auth.user.id,
        services: [{ serviceId: hwId, durationMinutes: t.hw }, { serviceId: abId, durationMinutes: t.ab }],
      });
      expect(r.status, `Termin ${t.datum}: ${JSON.stringify(r.data)}`).toBe(201);
      cleanup.appts.push(r.data.id);
      apptIdNachDatum.set(t.datum, r.data.id);
      const d = await apiPost<unknown>(`/api/appointments/${r.data.id}/document`, {
        actualStart: "09:00", travelOriginType: "home", travelKilometers: t.km, customerKilometers: 0,
        services: [
          { serviceId: hwId, actualDurationMinutes: t.hw, details: "Nachberechnung-Abnahme" },
          { serviceId: abId, actualDurationMinutes: t.ab, details: "Nachberechnung-Abnahme" },
        ],
      });
      expect(d.status, `dokumentieren ${t.datum}: ${JSON.stringify(d.data)}`).toBe(200);
    }

    // ── Leistungsnachweis + erste Rechnung (= RE-2026-0694) ────────────
    const sr = await apiPost<{ id: number }>("/api/service-records", {
      customerId, employeeId: auth.user.id, year: J, month: 6,
    });
    expect(sr.status, JSON.stringify(sr.data)).toBe(201);
    cleanup.srs.push(sr.data.id);
    for (const signerType of ["employee", "customer"] as const) {
      expect((await apiPost(`/api/service-records/${sr.data.id}/sign`, {
        signerType, signatureData: validSignatureDataUrl(),
      })).status).toBe(200);
    }
    // Die erste Rechnung wird NICHT zugesichert. Beim Dokumentieren außer der
    // Reihenfolge kann schon der normale Buchungspfad zu viel in die Kasse
    // legen (FINDING im PR, eigener Vorgang) — Gegenstand dieses Tests ist
    // die Neuabrechnung nach dem Storno.
    const erste = await generiere();
    expect(erste.length, "Vorbedingung: es gibt eine erste Rechnung").toBeGreaterThan(0);

    // ── Storno über die Schnittstelle ───────────────────────────────────
    const st = await apiPatch<any>(`/api/billing/${erste[0].id}/status`, { status: "storniert", cascadeRun: true });
    expect(st.status, `storno: ${JSON.stringify(st.data)}`).toBe(200);

    const nachStorno = await readUnifiedBudgetAvailability(customerId, `${J}-06-30`);
    expect(
      nachStorno.pots.entlastungsbetrag_45b.availableCents,
      "Vorbedingung: nach dem Storno steht der Juni-Topf wieder voll auf dem Startwert",
    ).toBe(STARTWERT_JUNI);

    // Ledger-Stand VOR Vorschau und Liste — beide fahren einen Probelauf der
    // Neubuchung und müssen ihn zurückrollen (Gate 2 zu #193, S-2).
    const buchungenVorher = (await db.select({ id: budgetTransactions.id }).from(budgetTransactions)
      .where(eq(budgetTransactions.customerId, customerId))).length;

    // ── Vorschau: muss dasselbe zeigen wie das Erstellen ───────────────
    const vorschau = await apiGet<any>(`/api/billing/preview?customerId=${customerId}&month=6&year=${J}`);
    expect(vorschau.status, JSON.stringify(vorschau.data)).toBe(200);
    expect(
      vorschau.data.splitPots,
      "die Vorschau kündigt andere Töpfe an, als das Erstellen erzeugt",
    ).toEqual(["entlastungsbetrag_45b", "private"]);

    // Die Vorschau zeigt den Bruttobetrag der Rechnung, die entstehen wird.
    expect(vorschau.data.totalCents, "Vorschau: Bruttobetrag").toBe(BRUTTO);

    // Die Liste „Bereit zum Abrechnen" zeigt denselben Betrag — der dritte
    // Ort, an dem der Nutzer ihn sieht (`GET /api/billing/customer-amounts`).
    const liste = await apiGet<Record<string, { actualAmountCents: number | null }>>(
      `/api/billing/customer-amounts?year=${J}&month=6&customerIds=${customerId}`,
    );
    expect(liste.status, JSON.stringify(liste.data)).toBe(200);
    expect(
      liste.data[String(customerId)]?.actualAmountCents,
      "die Liste „Bereit zum Abrechnen“ zeigt einen anderen Betrag als die Vorschau",
    ).toBe(BRUTTO);

    // Der Probelauf bucht NICHTS: nach Vorschau und Liste steht der Ledger
    // unverändert. Ohne diese Prüfung bliebe NB-1 grün, auch wenn der
    // Probelauf dauerhaft schriebe — die Liste und das Erstellen fänden dann
    // Live-Buchungen und kämen auf dieselben Beträge.
    // Mutations-gegengeprüft: `throw new ProbelaufZurueckrollen()` entfernt → rot.
    const buchungenNachher = (await db.select({ id: budgetTransactions.id }).from(budgetTransactions)
      .where(eq(budgetTransactions.customerId, customerId))).length;
    expect(buchungenNachher, "Vorschau/Liste haben Buchungen hinterlassen — der Probelauf rollt nicht zurück").toBe(buchungenVorher);
    const nachVorschau = await readUnifiedBudgetAvailability(customerId, `${J}-06-30`);
    expect(
      nachVorschau.pots.entlastungsbetrag_45b.availableCents,
      "Vorschau/Liste haben den Topf verbraucht — der Probelauf rollt nicht zurück",
    ).toBe(STARTWERT_JUNI);

    // ── Erstellen ──────────────────────────────────────────────────────
    const neu = await generiere();

    // Vorschau = Erstellen auf dem BETRAG, den der Nutzer in der Vorschau sieht
    // (Gate 2 zu #193, S-5). Die Vorschau nennt Töpfe und Gesamtbetrag; der
    // Gesamtbetrag hängt an der Aufteilung, weil auf den Privat-Anteil 19 % USt
    // kommen. Eine Vorschau, die dieselben Töpfe mit anderer Aufteilung
    // ankündigte, fiele hier auf.
    expect(
      vorschau.data.totalCents,
      "die Vorschau kündigt einen anderen Gesamtbetrag an, als das Erstellen erzeugt",
    ).toBe(neu.reduce((n, i) => n + i.grossAmountCents, 0));
    const kasse = neu.filter(i => i.budgetType === "entlastungsbetrag_45b");
    const privat = neu.filter(i => i.billingType === "selbstzahler");
    expect(kasse.reduce((n, i) => n + i.netAmountCents, 0), "Kasse").toBe(KASSE);
    expect(privat.reduce((n, i) => n + i.netAmountCents, 0), "privat").toBe(PRIVAT);

    // Ledger und Rechnung decken sich — pro Topf.
    const l45b = await lebenderVerbrauch("entlastungsbetrag_45b");
    const lPriv = await lebenderVerbrauch("private");
    expect(l45b.summe, "§45b-Ledger = §45b-Rechnung").toBe(KASSE);
    expect(lPriv.summe, "Privat-Ledger = Privat-Rechnung").toBe(PRIVAT);

    // CHRONOLOGISCH: der Rest trifft den LETZTEN Termin (17.06.).
    //
    // Gemessen (Gegenprobe M4): in Ladereihenfolge gebucht wird schon die
    // KASSEN-Summe falsch, nicht erst die Zuordnung. Ein früher datierter
    // Termin liest die Verfügbarkeit zu SEINEM Datum und sieht die Buchung
    // eines später datierten nicht — er nimmt den Topf ein zweites Mal.
    const t17 = apptIdNachDatum.get(`${J}-06-17`)!;
    expect(
      [...lPriv.nachTermin.keys()],
      "der Privat-Anteil liegt nicht beim chronologisch letzten Termin — gebucht wurde nach ID",
    ).toEqual([t17]);

    // ── Folgemonat ─────────────────────────────────────────────────────
    const juli = await readUnifiedBudgetAvailability(customerId, `${J}-07-31`);
    expect(
      juli.pots.entlastungsbetrag_45b.availableCents,
      "Juli: Startwert 184,60 − Juni 184,60 + Juli-Aufstockung 131,00",
    ).toBe(131_00);
  }, 300_000);
});
