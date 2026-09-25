/**
 * Funke (Kunde 89), Prod-Lage 26.09.2026 — Nachbau aus den Prod-Zeilen
 * (read-only gelesen von Alrik).
 *
 * ── Befund Prod ──────────────────────────────────────────────────────────
 * Die Juni-Termine 1502/1553/1673 tragen AKTIVE Verbrauchs-Buchungen
 * 4013/4014/4015 (77,40 + 77,40 + 39,40 = 194,20 €) an Zuweisung 61
 * (Automatik-Übertrag 1.179 €, inzwischen gelöscht). Der Topf ist überzogen
 * (der Reader kappt „frei" bei 0). Die Rechnung übernahm die gespeicherten
 * Buchungen ungeprüft: RE-0696 = 194,20 € komplett Kasse, mit jedem Startwert.
 *
 * ── Regel (Alrik, 26.09.2026) ────────────────────────────────────────────
 * Überlauf über dem verfügbaren Budget → privat, auch bei bereits gebuchten
 * Terminen. Umgesetzt in `neuzubuchendeTermine` / `neubuchenFuerLauf`
 * (`server/services/invoice-data.ts`).
 *
 * F-3  Startwert 262,00 → 184,60 Kasse / 9,60 privat; 184,60 → 107,20 / 87,00.
 *      Vorschau (derselbe Entwurf wie `GET /api/billing/preview`), read-only
 *      Probelauf-Werkzeug, Rechnung und Ledger zeigen dasselbe; die bezahlte
 *      Juni-Rechnung bleibt unberührt.
 * F-4  Kunde OHNE Privatzahlung, Topf überzogen: Abbruch, Ledger unverändert
 *      (alles in einer Transaktion). Fachlich offen (rote Karte an Alrik).
 *
 * Termin-Daten der drei Termine sind im Test gewählt (09./16./23.06.); die
 * Beträge sind die aus Prod. Der bezahlte Termin (77,40 €) liegt am 02.06.
 */
import { validSignatureDataUrl } from "../helpers/valid-signature";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetAllocations, budgetTransactions } from "@shared/schema";
import {
  apiGet, apiPost, apiPut, apiPatch, apiDelete,
  getAuthCookie, uniqueId, cleanupCustomer, runCleanup,
} from "../test-utils";
import { assertTestClockActive, clearTestClock, useTestClock } from "../helpers/test-clock";
import { buildInvoiceDraft } from "../../server/services/invoice-calc";
import { neubuchenFuerLauf } from "../../server/services/invoice-data";
import { appendFileSync } from "node:fs";
import { probeUeberlauf, zaehleUeberlauf } from "../../server/scripts/probe-ueberlauf-45b";
import { readUnifiedBudgetAvailability } from "../../server/storage/budget/unified-reader";

const DIAG = process.env.FUNKE_DIAG;
const diag = (...a: unknown[]) => { if (DIAG) appendFileSync(DIAG, JSON.stringify(a) + "\n"); };

const J = 2026;
const HEUTE = `${J}-09-26`;
const UEBERTRAG = 1_179_00;
const VERBRAUCH_JAN_BIS_MAI = 929_58;
const SUMME = 194_20;

/** 77,40 € = 15 min HW (9,50) + 90 min AB (63,00) + 14 km (4,90); 39,40 € = 60 min HW (38,00) + 4 km (1,40). */
const BEZAHLT = { datum: `${J}-06-02`, hw: 15, ab: 90, km: 14 };
const OFFEN = [
  { datum: `${J}-06-09`, hw: 15, ab: 90, km: 14, betrag: 77_40 },
  { datum: `${J}-06-16`, hw: 15, ab: 90, km: 14, betrag: 77_40 },
  { datum: `${J}-06-23`, hw: 60, ab: 0, km: 4, betrag: 39_40 },
];

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let hwId: number;
let abId: number;
let laufNr = 0;
const cleanup = { customers: [] as number[], appts: [] as number[], srs: [] as number[], invoices: [] as number[] };

async function generiere(customerId: number): Promise<any[]> {
  const gen = await apiPost<any>("/api/billing/generate", { customerId, billingMonth: 6, billingYear: J });
  expect(gen.status, `generate: ${JSON.stringify(gen.data)}`).toBe(200);
  const invoices: any[] = gen.data?.splitInvoices ? gen.data.invoices : [gen.data];
  for (const i of invoices) if (i?.id) cleanup.invoices.push(i.id);
  return invoices;
}

async function ledgerZeilen(customerId: number): Promise<number> {
  return (await db.select({ id: budgetTransactions.id }).from(budgetTransactions)
    .where(eq(budgetTransactions.customerId, customerId))).length;
}

/** Lebende (nicht stornierte) Verbrauchs-Summen je Topf über die Termine. */
async function lebendJeTopf(client: any, customerId: number, apptIds: number[]): Promise<{ kasse: number; privat: number; zuweisungen: Array<number | null> }> {
  const verbrauch = await client.select().from(budgetTransactions).where(and(
    eq(budgetTransactions.customerId, customerId),
    eq(budgetTransactions.transactionType, "consumption"),
    inArray(budgetTransactions.appointmentId, apptIds),
  ));
  const storniert = new Set((await client.select({ ref: budgetTransactions.reversedTransactionId })
    .from(budgetTransactions).where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.transactionType, "reversal"),
    ))).map((r: any) => r.ref));
  let kasse = 0; let privat = 0; const zuweisungen: Array<number | null> = [];
  for (const v of verbrauch) {
    if (storniert.has(v.id)) continue;
    if (v.budgetType === "entlastungsbetrag_45b") { kasse += -v.amountCents; zuweisungen.push(v.allocationId); }
    else privat += -v.amountCents;
  }
  return { kasse, privat, zuweisungen };
}

/**
 * Baut die Prod-Lage: Übertrag 61 (automatisch) mit Verbrauch Jan–Mai, die
 * bezahlte Juni-Rechnung, drei dokumentierte Termine, die (wie in Prod am
 * 23.09.) auf 61 buchen — dann die Zeilen 829/841/850 und das Löschen von 61.
 */
async function prodLage(startwertCents: number, acceptsPrivatePayment = true): Promise<{ customerId: number; z61: number; offen: number[]; bezahltTermin: number }> {
  const k = await apiPost<{ id: number }>("/api/admin/customers", {
    vorname: "ProdLage", nachname: `Funke-${uniqueId()}`, geburtsdatum: "1938-04-02",
    email: `funke-prod-${uniqueId()}@test.local`, strasse: "Musterweg", nr: "1",
    plz: "09111", stadt: "Chemnitz", telefon: "+4917600000089",
    pflegegrad: 3, pflegegradSeit: "2024-01-01",
    billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment,
  });
  expect(k.status, JSON.stringify(k.data)).toBe(201);
  const customerId = k.data.id;
  // Eigene Uhrzeit je Aufbau — derselbe Mitarbeiter, sonst Terminüberschneidung.
  const start = `${String(8 + 3 * laufNr++).padStart(2, "0")}:00`;
  cleanup.customers.push(customerId);
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

  const [z61] = await db.insert(budgetAllocations).values({
    customerId, budgetType: "entlastungsbetrag_45b", year: J, month: null,
    amountCents: UEBERTRAG, source: "carryover",
    validFrom: `${J}-01-01`, expiresAt: `${J}-06-30`, notes: "Z61-Automatik-Uebertrag",
  }).returning({ id: budgetAllocations.id });
  await db.insert(budgetTransactions).values({
    customerId, budgetType: "entlastungsbetrag_45b", transactionType: "consumption",
    amountCents: -VERBRAUCH_JAN_BIS_MAI, transactionDate: `${J}-03-16`,
    allocationId: z61.id, description: "Verbrauch-Jan-Mai",
  } as never);

  async function termin(t: { datum: string; hw: number; ab: number; km: number }, start: string): Promise<number> {
    const leistungen = [
      ...(t.hw > 0 ? [{ serviceId: hwId, min: t.hw }] : []),
      ...(t.ab > 0 ? [{ serviceId: abId, min: t.ab }] : []),
    ];
    const r = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
      customerId, date: t.datum, scheduledStart: start, notes: `ProdLage-${t.datum}`, assignedEmployeeId: auth.user.id,
      services: leistungen.map(l => ({ serviceId: l.serviceId, durationMinutes: l.min })),
    });
    expect(r.status, `Termin ${t.datum}: ${JSON.stringify(r.data)}`).toBe(201);
    cleanup.appts.push(r.data.id);
    const d = await apiPost<unknown>(`/api/appointments/${r.data.id}/document`, {
      actualStart: start, travelOriginType: "home", travelKilometers: t.km, customerKilometers: 0,
      services: leistungen.map(l => ({ serviceId: l.serviceId, actualDurationMinutes: l.min, details: "ProdLage" })),
    });
    expect(d.status, `dokumentieren ${t.datum}: ${JSON.stringify(d.data)}`).toBe(200);
    return r.data.id;
  }
  async function leistungsnachweis(): Promise<void> {
    const sr = await apiPost<{ id: number }>("/api/service-records", { customerId, employeeId: auth.user.id, year: J, month: 6 });
    expect(sr.status, JSON.stringify(sr.data)).toBe(201);
    cleanup.srs.push(sr.data.id);
    for (const signerType of ["employee", "customer"] as const) {
      expect((await apiPost(`/api/service-records/${sr.data.id}/sign`, { signerType, signatureData: validSignatureDataUrl() })).status).toBe(200);
    }
  }

  // Bezahlte Juni-Rechnung 77,40 €.
  const bezahltTermin = await termin(BEZAHLT, start);
  await leistungsnachweis();
  const bezahlt = await generiere(customerId);
  expect(bezahlt.map(i => i.netAmountCents), "bezahlte Juni-Rechnung").toEqual([77_40]);
  await apiPatch<any>(`/api/billing/${bezahlt[0].id}/status`, { status: "versendet" });
  await apiPatch<any>(`/api/billing/${bezahlt[0].id}/status`, { status: "bezahlt" });

  // Die drei offenen Termine: dokumentiert, solange 61 aktiv ist → Buchung auf 61.
  const offen: number[] = [];
  for (const t of OFFEN) offen.push(await termin(t, start));
  const vorher = await lebendJeTopf(db, customerId, offen);
  expect(vorher.kasse, "aktive Buchungen 77,40 + 77,40 + 39,40").toBe(SUMME);
  diag("zuweisungen", vorher.zuweisungen, "z61", z61.id);
  expect(vorher.zuweisungen, "gebucht (auch) gegen Zuweisung 61").toContain(z61.id);

  // Zeilen wie in Prod.
  await db.insert(budgetAllocations).values({
    customerId, budgetType: "entlastungsbetrag_45b", year: J, month: 7,
    amountCents: 131_00, source: "initial_balance", validFrom: `${J}-07-01`, expiresAt: null,
    notes: "Z829-geloescht", deletedAt: new Date(`${J}-07-30T10:00:00Z`), createdByUserId: auth.user.id,
  } as never);
  await db.insert(budgetAllocations).values({
    customerId, budgetType: "entlastungsbetrag_45b", year: J, month: 6,
    amountCents: startwertCents, source: "initial_balance", validFrom: `${J}-06-01`, expiresAt: null,
    notes: "Z841-Startwert", createdByUserId: auth.user.id,
  } as never);
  await db.update(budgetAllocations).set({ deletedAt: new Date(`${J}-09-25T18:47:00Z`) }).where(eq(budgetAllocations.id, z61.id));
  await db.insert(budgetAllocations).values({
    customerId, budgetType: "entlastungsbetrag_45b", year: J, month: null,
    amountCents: 0, source: "carryover", validFrom: `${J}-01-01`, expiresAt: `${J}-06-30`,
    notes: "Z850-Uebertrag-0", createdByUserId: auth.user.id,
  } as never);

  await leistungsnachweis();
  return { customerId, z61: z61.id, offen, bezahltTermin };
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
  for (const c of cleanup.customers) {
    const list = await apiGet<any[]>(`/api/billing?customerId=${c}`).catch(() => null);
    for (const i of (list?.data as any[] | undefined) ?? []) if (!cleanup.invoices.includes(i.id)) cleanup.invoices.push(i.id);
  }
  for (const id of cleanup.invoices) { try { await apiDelete(`/api/billing/${id}`); } catch { /* best-effort */ } }
  for (const id of cleanup.srs) { try { await apiDelete(`/api/service-records/${id}`); } catch { /* best-effort */ } }
  for (const id of cleanup.appts) { try { await apiDelete(`/api/appointments/${id}`); } catch { /* best-effort */ } }
  for (const c of cleanup.customers) await cleanupCustomer(c);
  await runCleanup();
  clearTestClock();
});

describe("Funke (89), Prod-Lage: aktive Buchungen an gelöschter Zuweisung 61", () => {
  // [Startwert, Ledger Kasse, Ledger privat, Rechnung Kasse, Rechnung privat]
  it.each([
    [262_00, 184_60, 9_60, 184_60, 9_60],
    // Der Termin 16.06. teilt sich auf beide Töpfe; die Positions-Aufteilung
    // rundet 1 Cent zur Kasse (bestehend, FINDING P2). Festgeschrieben, damit
    // jede Änderung auffällt.
    [184_60, 107_20, 87_00, 107_21, 86_99],
  ])(
    "F-3 – Startwert %i: gespeicherte Buchungen über dem verfügbaren Budget gehen in den Privatanteil (Kasse %i / privat %i) — Vorschau = Rechnung",
    async (startwert, erwKasse, erwPrivat, erwKasseRechnung, erwPrivatRechnung) => {
      const { customerId, offen, bezahltTermin } = await prodLage(startwert);
      const bezahltVorher = await lebendJeTopf(db, customerId, [bezahltTermin]);

      for (const d of [`${J}-06-09`, `${J}-06-16`, `${J}-06-23`, `${J}-06-30`]) {
        const r = await readUnifiedBudgetAvailability(customerId, d);
        const t = r.pots.entlastungsbetrag_45b;
        diag("reader", d, { alloc: t.allocatedCents, cons: t.consumedNetCents, avail: t.availableCents });
      }
      const vorschau = await apiGet<any>(`/api/billing/preview?customerId=${customerId}&month=6&year=${J}`);
      expect(vorschau.status, JSON.stringify(vorschau.data)).toBe(200);
      diag("F-3", startwert, "vorschau", vorschau.data);
      // Der Dialog zeigt die Aufteilung aus `splitPots` („… + privat“), Beträge je Topf zeigt er nicht.
      expect(vorschau.data.splitInvoices, "Vorschau kündigt Aufteilung an").toBe(true);
      expect(vorschau.data.splitPots, "Vorschau zeigt Kasse und privat").toEqual(["entlastungsbetrag_45b", "private"]);
      expect(vorschau.data.totalCents).toBe(SUMME);
      // Beträge je Topf: die Route liefert sie nicht aus (FINDING, Midlayer) —
      // geprüft am selben Entwurf, aus dem sie `splitPots` baut.
      const entwurf = await buildInvoiceDraft({ customerId, billingMonth: 6, billingYear: J, mode: "preview" });
      const jeTopf = Object.fromEntries([...entwurf.potItems].map(([pot, items]) => [pot, items.reduce((n, i) => n + i.totalCents, 0)]));
      expect(jeTopf, "Vorschau-Entwurf: Beträge je Topf").toEqual({ entlastungsbetrag_45b: erwKasseRechnung, private: erwPrivatRechnung });
      expect(await lebendJeTopf(db, customerId, offen), "Vorschau schreibt nichts").toMatchObject({ kasse: SUMME, privat: 0 });

      // Read-only-Probelauf für Prod (Werkzeug) = echtes Erstellen (unten).
      const probe = await probeUeberlauf(customerId, J, 6);
      diag("F-3", startwert, "probe", probe);
      expect({ kasse: probe.kasseCents, privat: probe.privatCents }, "Probelauf").toEqual({ kasse: erwKasse, privat: erwPrivat });
      const zaehlung = await zaehleUeberlauf(J);
      expect(zaehlung.treffer.filter(t => t.customerId === customerId).map(t => t.monat), "Zählung findet Funke im Juni").toEqual([6]);

      const neu = await generiere(customerId);
      diag("F-3", startwert, "neu", neu.map(i => [i.netAmountCents, i.budgetType, i.billingType, i.vatAmountCents, i.grossAmountCents]));
      const kasse = neu.filter(i => i.budgetType === "entlastungsbetrag_45b");
      const privat = neu.filter(i => i.billingType === "selbstzahler");
      // Ledger = gebuchter Anspruch (auf den Cent).
      expect(await lebendJeTopf(db, customerId, offen), "Ledger nach dem Erstellen").toMatchObject({ kasse: erwKasse, privat: erwPrivat });
      expect(kasse.reduce((n, i) => n + i.netAmountCents, 0), "Rechnung Kasse").toBe(erwKasseRechnung);
      expect(privat.reduce((n, i) => n + i.netAmountCents, 0), "Rechnung privat").toBe(erwPrivatRechnung);
      expect(privat.reduce((n, i) => n + i.vatAmountCents, 0), "privat steuerfrei").toBe(0);
      expect(neu.reduce((n, i) => n + i.grossAmountCents, 0), "gesamt").toBe(SUMME);
      expect(await lebendJeTopf(db, customerId, [bezahltTermin]), "bezahlte Juni-Rechnung unberührt").toEqual(bezahltVorher);
    }, 300_000);

  it("F-4 – Kunde ohne Privatzahlung, Topf überzogen: Abbruch, Ledger unverändert (fachlich offen)", async () => {
    const { customerId, offen } = await prodLage(262_00, false);
    const vorher = await ledgerZeilen(customerId);
    const gen = await apiPost<any>("/api/billing/generate", { customerId, billingMonth: 6, billingYear: J });
    diag("F-4", gen.status, gen.data);
    expect(gen.status, JSON.stringify(gen.data)).toBe(400);
    expect(await ledgerZeilen(customerId), "nichts storniert, nichts gebucht").toBe(vorher);
    // Die Neubuchung selbst (die Vorschau bricht schon vorher ab): Storno und
    // Neubuchung sind EINE Transaktion — kein halb stornierter Stand.
    await expect(neubuchenFuerLauf(customerId, offen, auth.user.id)).rejects.toThrow(/Re-Abrechnung nicht möglich/);
    expect(await ledgerZeilen(customerId), "Neubuchung rollt vollständig zurück").toBe(vorher);
  }, 300_000);
});
