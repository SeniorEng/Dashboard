/**
 * SCHRITT B (Standard Geldpfad) — Charakterisierung: was die USt-Entscheidung
 * HEUTE tut. Ticket `6hcgffPJWm57p72p` (§ 4 Nr. 16 g UStG).
 *
 * Diese Tests halten das Ist-Verhalten fest, BEVOR die Regel geändert wird
 * (Feathers). Sie behaupten nicht, dass das Verhalten richtig ist. Der USt-PR
 * stellt die Fälle, deren Verhalten sich laut Tabelle D ändert, ausdrücklich
 * um — jede Umstellung ist dann im Diff sichtbar.
 *
 * Heutige Regel (am Code gemessen, Ticket-Kommentar `6hcggFF3jGrFhJMG`):
 * 19 % genau dann, wenn die RECHNUNG den Zahlertyp `selbstzahler` trägt.
 * Pflegegrad und Leistungsart spielen keine Rolle.
 *
 * Geprüft wird je Fall auf drei Ebenen, jeweils das, was der Empfänger bekommt:
 *   · die gespeicherte Rechnung (netto / USt / brutto),
 *   · das gerenderte Rechnungs-HTML (`generateInvoiceHtml` — der Inhalt des
 *     PDFs vor der Chromium-Umwandlung; Chromium fehlt lokal),
 *   · das ZUGFeRD-XML (`generateZugferdXml`, Steuerkategorie).
 *
 * Pflichtfall 4 (Leistung außerhalb der Anerkennungsliste) ist HEUTE nicht
 * erreichbar: der Katalog kennt keine abrechenbare Leistung außerhalb der
 * Liste (`shared/config/services.ts`; Alrik, Schritt A: nur `hauswirtschaft`
 * und `alltagsbegleitung`). Er entsteht erst mit einer Test-Leistung im USt-PR.
 */
import { validSignatureDataUrl } from "../helpers/valid-signature";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetAllocations, customerCareLevelHistory, customers } from "@shared/schema";
import {
  apiGet, apiPost, apiPut, apiPatch, apiDelete,
  getAuthCookie, uniqueId, cleanupCustomer, runCleanup,
} from "../test-utils";
import { assertTestClockActive, clearTestClock, useTestClock } from "../helpers/test-clock";
import { storage } from "../../server/storage";
import { buildInvoicePdfData } from "../../server/services/invoice-pdf-orchestrator";
import { generateInvoiceHtml } from "../../server/lib/pdf-generator";
import { generateZugferdXml } from "../../server/lib/zugferd";

const J = 2026;
const HEUTE = `${J}-09-25`;
const MONAT = 8;
/** 60 min Hauswirtschaft zu 38,00 €/h (Katalog). */
const HW_60 = 38_00;
const BEFREIUNGSHINWEIS = /§\s*4\s*Nr\.\s*16/;

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let hwId: number;
const kunden: number[] = [];
const cleanup = { appts: [] as number[], srs: [] as number[], invoices: [] as number[] };

interface Ausgabe {
  invoice: any;
  html: string;
  xml: string | null;
}

async function neuerKunde(felder: Record<string, unknown>): Promise<number> {
  const k = await apiPost<{ id: number }>("/api/admin/customers", {
    vorname: "UStIst", nachname: `Fall-${uniqueId()}`, geburtsdatum: "1939-05-04",
    email: `ust-ist-${uniqueId()}@test.local`, strasse: "Musterweg", nr: "2",
    plz: "09111", stadt: "Chemnitz", telefon: "+4917600000093",
    contacts: [{ contactType: "familie", isPrimary: true, vorname: "K", nachname: "U", mobilnummer: "+4917600000094" }],
    ...felder,
  });
  expect(k.status, JSON.stringify(k.data)).toBe(201);
  kunden.push(k.data.id);
  expect((await apiPatch(`/api/admin/customers/${k.data.id}/assign`, {
    primaryEmployeeId: auth.user.id, backupEmployeeId: null, backupEmployeeId2: null,
  })).status).toBe(200);
  return k.data.id;
}

/** Eigene Uhrzeit je Termin: derselbe Mitarbeiter, sonst Terminüberschneidung. */
let slot = 0;
function naechsteUhrzeit(): string {
  const minuten = 7 * 60 + 90 * slot++;
  return `${String(Math.floor(minuten / 60)).padStart(2, "0")}:${String(minuten % 60).padStart(2, "0")}`;
}

async function termin(customerId: number, datum: string, minuten = 60): Promise<number> {
  const start = naechsteUhrzeit();
  const r = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
    customerId, date: datum, scheduledStart: start, notes: `UStIst-${datum}`,
    assignedEmployeeId: auth.user.id, services: [{ serviceId: hwId, durationMinutes: minuten }],
  });
  expect(r.status, `Termin ${datum}: ${JSON.stringify(r.data)}`).toBe(201);
  cleanup.appts.push(r.data.id);
  const d = await apiPost<unknown>(`/api/appointments/${r.data.id}/document`, {
    actualStart: start, travelOriginType: "home", travelKilometers: 0, customerKilometers: 0,
    services: [{ serviceId: hwId, actualDurationMinutes: minuten, details: "UStIst" }],
  });
  expect(d.status, `dokumentieren ${datum}: ${JSON.stringify(d.data)}`).toBe(200);
  return r.data.id;
}

/** Leistungsnachweis unterschreiben, abrechnen, je Rechnung HTML + XML rendern. */
async function abrechnen(customerId: number): Promise<Ausgabe[]> {
  const sr = await apiPost<{ id: number }>("/api/service-records", {
    customerId, employeeId: auth.user.id, year: J, month: MONAT,
  });
  expect(sr.status, JSON.stringify(sr.data)).toBe(201);
  cleanup.srs.push(sr.data.id);
  for (const signerType of ["employee", "customer"] as const) {
    expect((await apiPost(`/api/service-records/${sr.data.id}/sign`, {
      signerType, signatureData: validSignatureDataUrl(),
    })).status).toBe(200);
  }
  const gen = await apiPost<any>("/api/billing/generate", { customerId, billingMonth: MONAT, billingYear: J });
  expect(gen.status, `generate: ${JSON.stringify(gen.data)}`).toBe(200);
  const erzeugt: any[] = gen.data?.splitInvoices ? gen.data.invoices : [gen.data];
  const settings = await storage.getCompanySettings();
  const out: Ausgabe[] = [];
  for (const i of erzeugt) {
    cleanup.invoices.push(i.id);
    const invoice = await storage.getInvoice(i.id);
    expect(invoice, `Rechnung ${i.id} nicht lesbar`).toBeTruthy();
    const { pdfData } = await buildInvoicePdfData(invoice!, settings);
    out.push({ invoice, html: generateInvoiceHtml(pdfData), xml: await generateZugferdXml(pdfData) });
  }
  return out;
}

function steuerkategorien(xml: string | null): string[] {
  expect(xml, "ZUGFeRD-XML wurde nicht erzeugt").toBeTruthy();
  return [...new Set([...xml!.matchAll(/<ram:CategoryCode>([A-Z]+)<\/ram:CategoryCode>/g)].map(m => m[1]))];
}

/** Die heutige 19-%-Ausgabe: Betrag, Text, Kategorie. */
function erwarte19(a: Ausgabe, netto: number, label: string) {
  expect(a.invoice.netAmountCents, `${label}: netto`).toBe(netto);
  expect(a.invoice.vatAmountCents, `${label}: USt 19 %`).toBe(Math.round(netto * 0.19));
  expect(a.invoice.grossAmountCents, `${label}: brutto`).toBe(netto + Math.round(netto * 0.19));
  expect(a.html, `${label}: das PDF weist 19 % aus`).toMatch(/19\s*%/);
  expect(a.html, `${label}: das PDF nennt KEINE Befreiung`).not.toMatch(BEFREIUNGSHINWEIS);
  expect(steuerkategorien(a.xml), `${label}: XML-Kategorie`).toEqual(["S"]);
}

beforeAll(async () => {
  useTestClock(HEUTE);
  assertTestClockActive();
  auth = await getAuthCookie();
  const services = await apiGet<Array<{ id: number; code: string | null }>>("/api/services/all");
  hwId = services.data.find(s => s.code === "hauswirtschaft")!.id;
});

afterAll(async () => {
  for (const id of cleanup.invoices) { try { await apiDelete(`/api/billing/${id}`); } catch { /* best-effort */ } }
  for (const id of cleanup.srs) { try { await apiDelete(`/api/service-records/${id}`); } catch { /* best-effort */ } }
  for (const id of cleanup.appts) { try { await apiDelete(`/api/appointments/${id}`); } catch { /* best-effort */ } }
  for (const id of kunden) await cleanupCustomer(id);
  await runCleanup();
  clearTestClock();
});

describe("USt HEUTE — Charakterisierung vor § 4 Nr. 16 g (Schritt B)", () => {
  it("IST-1 – Selbstzahler OHNE Pflegegrad: 19 % (Leitplanke — bleibt so)", async () => {
    const id = await neuerKunde({ billingType: "selbstzahler", acceptsPrivatePayment: true });
    await termin(id, `${J}-08-10`);
    const [a, ...rest] = await abrechnen(id);
    expect(rest, "genau eine Rechnung").toHaveLength(0);
    erwarte19(a, HW_60, "IST-1");
  }, 300_000);

  it("IST-2 – Selbstzahler MIT Pflegegrad: heute 19 % (ändert sich mit der Regel)", async () => {
    const id = await neuerKunde({
      billingType: "selbstzahler", acceptsPrivatePayment: true, pflegegrad: 2, pflegegradSeit: "2024-01-01",
    });
    const historie = await db.select().from(customerCareLevelHistory).where(eq(customerCareLevelHistory.customerId, id));
    expect(historie.map(h => h.pflegegrad), "Vorbedingung: der Pflegegrad steht in der Historie").toEqual([2]);
    await termin(id, `${J}-08-10`);
    const [a, ...rest] = await abrechnen(id);
    expect(rest).toHaveLength(0);
    erwarte19(a, HW_60, "IST-2");
  }, 300_000);

  it("IST-3 – Überlauf-Privatanteil eines Kassenkunden: Kasse befreit, privat heute 19 %", async () => {
    const id = await neuerKunde({
      billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: true, pflegegrad: 3, pflegegradSeit: "2024-01-01",
    });
    expect((await apiPut(`/api/budget/${id}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
      ],
    })).status).toBe(200);
    await db.insert(budgetAllocations).values({
      customerId: id, budgetType: "entlastungsbetrag_45b", year: J, month: MONAT,
      amountCents: 20_00, source: "initial_balance",
      validFrom: `${J}-08-01`, expiresAt: null, notes: "UStIst-Startwert",
    });
    await termin(id, `${J}-08-10`);
    const ausgaben = await abrechnen(id);
    const kasse = ausgaben.filter(a => a.invoice.budgetType === "entlastungsbetrag_45b");
    const privat = ausgaben.filter(a => a.invoice.billingType === "selbstzahler");
    expect(kasse, "eine Kassen-Rechnung").toHaveLength(1);
    expect(privat, "eine Privat-Rechnung").toHaveLength(1);

    expect(kasse[0].invoice.netAmountCents, "Kasse netto").toBe(20_00);
    expect(kasse[0].invoice.vatAmountCents, "Kasse: keine USt").toBe(0);
    expect(kasse[0].html, "Kasse: Befreiungshinweis im PDF").toMatch(BEFREIUNGSHINWEIS);
    expect(steuerkategorien(kasse[0].xml), "Kasse: XML-Kategorie").toEqual(["E"]);

    erwarte19(privat[0], HW_60 - 20_00, "IST-3 privat");
  }, 300_000);

  it("IST-5 – Selbstzahler, Pflegegrad endet mitten im Monat: heute 19 % vor UND nach dem Ende", async () => {
    const id = await neuerKunde({
      billingType: "selbstzahler", acceptsPrivatePayment: true, pflegegrad: 2, pflegegradSeit: "2024-01-01",
    });
    await db.update(customerCareLevelHistory).set({ validTo: `${J}-08-15` })
      .where(eq(customerCareLevelHistory.customerId, id));
    await termin(id, `${J}-08-10`);
    await termin(id, `${J}-08-20`);
    const [a, ...rest] = await abrechnen(id);
    expect(rest).toHaveLength(0);
    erwarte19(a, 2 * HW_60, "IST-5");
  }, 300_000);

  it("IST-6 – Pflegegrad nur in den Stammdaten, NICHT in der Historie: heute 19 %", async () => {
    // Die zwei Quellen laufen auseinander: `customers.pflegegrad` gesetzt,
    // `customer_care_level_history` leer. Genau der Zustand, den der
    // Freigabe-Check melden soll (Alrik, 25.09.2026).
    const id = await neuerKunde({ billingType: "selbstzahler", acceptsPrivatePayment: true });
    await db.update(customers).set({ pflegegrad: 3 }).where(eq(customers.id, id));
    const historie = await db.select().from(customerCareLevelHistory)
      .where(and(eq(customerCareLevelHistory.customerId, id)));
    expect(historie, "Vorbedingung: keine Historie").toHaveLength(0);
    await termin(id, `${J}-08-10`);
    const [a, ...rest] = await abrechnen(id);
    expect(rest).toHaveLength(0);
    erwarte19(a, HW_60, "IST-6");
  }, 300_000);
});
