/**
 * ABNAHME Funke (Kunde 89) — Flip ohne Klammer, Entscheidung Alrik 25.09.2026.
 *
 * ── Der Fall ────────────────────────────────────────────────────────────
 * Übertrag 1.179,00 € (gültig bis 30.06.), Startwert Juni 184,60 € nach
 * Kassenauskunft. Drei Juni-Termine (03./10./17.06.) über zusammen 194,20 €
 * liefen vollständig in den §45b-Topf — RE-2026-0694 —, weil der Übertrag
 * trotz Startwert weiter zählte. Die Rechnung ist in Prod storniert, die drei
 * Termine stehen wieder unter „Bereit zum Abrechnen".
 *
 * ── Die Abnahme (Alrik) ─────────────────────────────────────────────────
 *   storniert → Erstellen → 184,60 € Kasse / 9,60 € privat,
 *   danach Juli-Verfügbarkeit korrekt.
 *
 * ── Was die Fixture nachbildet, und warum so ─────────────────────────────
 * Die Juni-Buchungen liegen in Prod auf dem ÜBERTRAG (die Engine bucht ihn
 * zuerst). Um diese Form mit dem echten Code zu erzeugen statt Zeilen von Hand
 * zu setzen, wird dokumentiert, BEVOR der Startwert existiert — dann ist der
 * Übertrag gültig und die echte Engine stempelt die Buchungen auf ihn. Danach
 * läuft der echte Verfalls-Lauf (`syncCarryoverAndExpiry`) und schreibt den
 * Rest ab, erst dann kommt der Startwert, dann das Storno über die
 * Schnittstelle. Jede Zeile im Ledger stammt damit aus Produktivcode.
 *
 * Die Abschreibung trägt das Datum 01.07. — den Tag NACH Ablauf
 * (`allocation-storage.ts`: `addDays(expiresAt, 1)`), damit der 30.06. noch
 * nutzbar bleibt. Eine Juni-Sicht KANN sie deshalb nicht sehen; ob sie
 * fälschlich zählt, zeigt erst der Juli. In Prod können ältere Abschreibungen
 * noch auf den 30.06. datiert sein — die Regel greift unabhängig vom Datum.
 *
 * Preise aus `shared/config/services.ts`: Hauswirtschaft 38,00 €/h,
 * Alltagsbegleitung 42,00 €/h, Fahrt-km 0,35 €. Funkes echte Aufteilung auf
 * die drei Termine ist nicht bekannt; zugesichert ist die Summe 194,20 € und
 * die Lage „jeder Termin einzeln kleiner als der Topf".
 *
 * ── ANNAHMEN, die Alrik bestätigen muss ─────────────────────────────────
 *  · §39/§42a ist in der Fixture AUS. Laut Stammticket war Funkes
 *    Verhinderungspflege im Juni aktiv (Phase 01.06.–16.09.); ist sie es in
 *    Prod noch, landen die 9,60 € dort und nicht privat.
 *  · Funke lässt Privatzahlung zu. Sonst bricht die Neuabrechnung mit
 *    „Re-Abrechnung nicht möglich" ab (`rebook-storage.ts`).
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
import { syncCarryoverAndExpiry } from "../../server/storage/budget/allocation-storage";

const J = 2026;
const HEUTE = `${J}-09-25`;

const UEBERTRAG = 1_179_00;
const VERBRAUCH_JAN_BIS_MAI = 929_58; // vor dem Startwert — im Startwert abgebildet
const STARTWERT_JUNI = 184_60;

/**
 * Drei Juni-Termine, Summe 194,20 €. Jeder EINZELN < 184,60 € — genau die Lage,
 * in der die alte Vorschau jeden Termin für sich in den Topf passen ließ.
 *
 * Termine liegen in 15-Minuten-Schritten (Validierung). Hauswirtschaft und
 * Alltagsbegleitung ergeben damit nur Vielfache von 0,50 €; die 0,20 € kommen
 * über 2 Fahrt-km (0,35 €/km, `travel_km` zählt gegen §45b).
 *
 * Chronologisch gegen 184,60 €: 72,20 → Kasse, 61,00 → Kasse,
 * 61,00 → 51,40 Kasse + 9,60 privat.
 */
const TERMINE = [
  { datum: `${J}-06-03`, hw: 30, ab: 75, km: 2, cents: 72_20 },
  { datum: `${J}-06-10`, hw: 30, ab: 60, km: 0, cents: 61_00 },
  { datum: `${J}-06-17`, hw: 30, ab: 60, km: 0, cents: 61_00 },
] as const;
const SUMME = 194_20;
const KASSE = 184_60;
const PRIVAT = 9_60;

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let hwId: number;
let abId: number;
let customerId: number;
let uebertragId: number;
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

describe("Abnahme Funke — storniert → Erstellen → 184,60 € Kasse / 9,60 € privat", () => {
  it("F-1 – die Neuabrechnung teilt kumuliert und chronologisch, der Juli stimmt", async () => {
    // ── Kunde ──────────────────────────────────────────────────────────
    const k = await apiPost<{ id: number }>("/api/admin/customers", {
      vorname: "Abnahme", nachname: `Funke-${uniqueId()}`, geburtsdatum: "1938-04-02",
      email: `funke-${uniqueId()}@test.local`, strasse: "Musterweg", nr: "1",
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

    // ── Übertrag + Verbrauch Jan–Mai (vor dem späteren Startwert) ─────
    const [ue] = await db.insert(budgetAllocations).values({
      customerId, budgetType: "entlastungsbetrag_45b", year: J, month: null,
      amountCents: UEBERTRAG, source: "carryover",
      validFrom: `${J}-01-01`, expiresAt: `${J}-06-30`, notes: "Funke-Uebertrag-2025",
    }).returning({ id: budgetAllocations.id });
    uebertragId = ue.id;
    await db.insert(budgetTransactions).values({
      customerId, budgetType: "entlastungsbetrag_45b", transactionType: "consumption",
      amountCents: -VERBRAUCH_JAN_BIS_MAI, transactionDate: `${J}-03-16`,
      allocationId: uebertragId, description: "Funke-Verbrauch-Jan-Mai",
    } as never);

    // ── Drei Juni-Termine, in UMGEKEHRTER Reihenfolge angelegt ─────────
    // Damit sind die IDs NICHT zufällig chronologisch — sonst könnte der Test
    // gar nicht sehen, ob nach Datum oder nach ID gebucht wird.
    for (const t of [...TERMINE].reverse()) {
      const r = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
        customerId, date: t.datum, scheduledStart: "09:00",
        notes: `Funke-${t.datum}`, assignedEmployeeId: auth.user.id,
        services: [{ serviceId: hwId, durationMinutes: t.hw }, { serviceId: abId, durationMinutes: t.ab }],
      });
      expect(r.status, `Termin ${t.datum}: ${JSON.stringify(r.data)}`).toBe(201);
      cleanup.appts.push(r.data.id);
      apptIdNachDatum.set(t.datum, r.data.id);
      const d = await apiPost<unknown>(`/api/appointments/${r.data.id}/document`, {
        actualStart: "09:00", travelOriginType: "home", travelKilometers: t.km, customerKilometers: 0,
        services: [
          { serviceId: hwId, actualDurationMinutes: t.hw, details: "Funke-Abnahme" },
          { serviceId: abId, actualDurationMinutes: t.ab, details: "Funke-Abnahme" },
        ],
      });
      expect(d.status, `dokumentieren ${t.datum}: ${JSON.stringify(d.data)}`).toBe(200);
    }

    // Vorbedingung: die echte Engine hat auf den ÜBERTRAG gebucht — Prods Form.
    const aufUebertrag = await db.select().from(budgetTransactions).where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.allocationId, uebertragId),
      eq(budgetTransactions.transactionType, "consumption"),
    ));
    expect(
      aufUebertrag.filter(r => r.transactionDate >= `${J}-06-01`).reduce((n, r) => n + Math.abs(r.amountCents), 0),
      "Vorbedingung: die Juni-Buchungen liegen auf dem Übertrag (wie in Prod)",
    ).toBe(SUMME);

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
    const erste = await generiere();
    expect(erste.length, "die alte Rechnung war EINE §45b-Rechnung").toBe(1);
    expect(erste[0].netAmountCents, "RE-2026-0694: alles in §45b").toBe(SUMME);

    // ── Verfalls-Lauf zum 30.06. (echter Code), dann der Startwert ─────
    await syncCarryoverAndExpiry(customerId);
    const abschreibung = await db.select().from(budgetTransactions).where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.allocationId, uebertragId),
      eq(budgetTransactions.transactionType, "write_off"),
    ));
    expect(abschreibung.length, "Vorbedingung: der Verfalls-Lauf hat den Übertrag abgeschrieben").toBe(1);
    expect(
      abschreibung[0].transactionDate,
      "Vorbedingung: die Abschreibung liegt auf dem 01.07. — nur deshalb prüft die "
      + "Juli-Zusage unten die Abschreibungs-Regel und die Juni-Zusage nicht",
    ).toBe(`${J}-07-01`);

    await db.insert(budgetAllocations).values({
      customerId, budgetType: "entlastungsbetrag_45b", year: J, month: 6,
      amountCents: STARTWERT_JUNI, source: "initial_balance",
      validFrom: `${J}-06-01`, expiresAt: null, notes: "Funke-Startwert-Kassenauskunft",
    });

    // N-P1 in Funkes eigener Geschichte: VOR dem Storno ist der Juni belegt.
    // Ohne den Fix fielen die Juni-Buchungen (auf dem ersetzten Übertrag,
    // NACH dem Startwert) aus dem Verbrauch, und der Topf stünde voll frei da.
    const vorStorno = await readUnifiedBudgetAvailability(customerId, `${J}-06-30`);
    expect(
      vorStorno.pots.entlastungsbetrag_45b.availableCents,
      "vor dem Storno ist der Juni-Topf verbraucht — die Juni-Buchungen zählen (R4)",
    ).toBe(0);

    // ── Storno über die Schnittstelle ───────────────────────────────────
    const st = await apiPatch<any>(`/api/billing/${erste[0].id}/status`, { status: "storniert", cascadeRun: true });
    expect(st.status, `storno: ${JSON.stringify(st.data)}`).toBe(200);

    const nachStorno = await readUnifiedBudgetAvailability(customerId, `${J}-06-30`);
    expect(
      nachStorno.pots.entlastungsbetrag_45b.availableCents,
      "nach dem Storno steht der Juni-Topf wieder auf dem Startwert — Buchung und Storno heben sich auf",
    ).toBe(STARTWERT_JUNI);

    // ── Vorschau: muss dasselbe zeigen wie das Erstellen ───────────────
    const vorschau = await apiGet<any>(`/api/billing/preview?customerId=${customerId}&month=6&year=${J}`);
    expect(vorschau.status, JSON.stringify(vorschau.data)).toBe(200);
    expect(
      vorschau.data.splitPots,
      "die Vorschau kündigt keinen Privat-Anteil an — sie prüft jeden Termin gegen den vollen Topf",
    ).toEqual(["entlastungsbetrag_45b", "private"]);

    // ── Erstellen ──────────────────────────────────────────────────────
    const neu = await generiere();
    const kasse = neu.filter(i => i.budgetType === "entlastungsbetrag_45b");
    const privat = neu.filter(i => i.billingType === "selbstzahler");
    expect(kasse.reduce((n, i) => n + i.netAmountCents, 0), "Kasse").toBe(KASSE);
    expect(privat.reduce((n, i) => n + i.netAmountCents, 0), "privat").toBe(PRIVAT);
    // Steuerfrei (§ 4 Nr. 16 g UStG, PG 3 — seit #195 live) und gesamt 194,20 €
    // (Abnahme Alrik 25.09.2026): der Privat-Anteil trägt keine USt, die
    // Summe aller Rechnungen brutto ist genau der Terminwert.
    expect(privat.reduce((n, i) => n + i.vatAmountCents, 0), "privat steuerfrei").toBe(0);
    expect(neu.reduce((n, i) => n + i.grossAmountCents, 0), "gesamt brutto").toBe(SUMME);

    // Ledger und Rechnung decken sich — pro Topf.
    const l45b = await lebenderVerbrauch("entlastungsbetrag_45b");
    const lPriv = await lebenderVerbrauch("private");
    expect(l45b.summe - VERBRAUCH_JAN_BIS_MAI, "§45b-Ledger (Juni) = §45b-Rechnung").toBe(KASSE);
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
    // Zugleich die Zusage zur Abschreibung (E2): sie liegt auf dem 01.07. auf
    // dem ERSETZTEN Übertrag. Zählte sie, stünde der Juli um ihren Betrag zu
    // niedrig — dasselbe Guthaben ginge zweimal ab.
    const juli = await readUnifiedBudgetAvailability(customerId, `${J}-07-31`);
    expect(
      juli.pots.entlastungsbetrag_45b.availableCents,
      "Juli: Startwert 184,60 − Juni 184,60 + Juli-Aufstockung 131,00 — und die "
      + "Abschreibung vom 01.07. auf dem ersetzten Übertrag zählt NICHT (E2)",
    ).toBe(131_00);
  }, 300_000);
});
