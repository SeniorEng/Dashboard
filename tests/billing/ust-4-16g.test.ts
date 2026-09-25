/**
 * ABNAHME — § 4 Nr. 16 Buchst. g UStG (Ticket 6hcgffPJWm57p72p).
 * Tabelle D und E bestätigt von Alrik am 25.09.2026.
 *
 * ERSETZT die Charakterisierung aus Schritt B (`ust-ist-verhalten.test.ts`,
 * Commit fccdd51e): dieselben Fälle, jetzt mit dem Soll nach Tabelle D. Was
 * sich gegenüber dem Ist geändert hat, steht je Fall dabei.
 *
 * Geprüft wird je Fall, was der Empfänger bekommt (CLAUDE.md: „Die Zusage auf
 * das stellen, was der Nutzer bekommt"):
 *   · die gespeicherte Rechnung (netto / USt / brutto / Stempel),
 *   · das gerenderte Rechnungs-HTML (`generateInvoiceHtml` — der PDF-Inhalt
 *     vor der Chromium-Umwandlung; Chromium fehlt lokal),
 *   · das ZUGFeRD-XML (Kategorie je Position, Aufschlüsselung, BT-120).
 *
 * Regel (Tabelle D): steuerfrei genau dann, wenn die Leistung auf der
 * Anerkennungsliste steht UND am Leistungsdatum ein Pflegegrad in der
 * HISTORIE nachgewiesen ist. Sonst 19 %. Kassen-Töpfe immer steuerfrei (RK-1).
 */
import { validSignatureDataUrl } from "../helpers/valid-signature";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetAllocations, customerCareLevelHistory, customers, invoiceLineItems, invoices } from "@shared/schema";
import {
  apiGet, apiPost, apiPut, apiPatch, apiDelete, apiPostAs, loginAs, createTestEmployee,
  getAuthCookie, uniqueId, cleanupCustomer, runCleanup,
} from "../test-utils";
import { assertTestClockActive, clearTestClock, useTestClock } from "../helpers/test-clock";
import { storage } from "../../server/storage";
import { buildInvoicePdfData } from "../../server/services/invoice-pdf-orchestrator";
import { generateInvoiceHtml, generateLeistungsnachweisHtml } from "../../server/lib/pdf-generator";
import { generateZugferdXml } from "../../server/lib/zugferd";
import { getCareLevelAt } from "../../server/storage/customer-mgmt/care-level";
import { USTFREI_HINWEIS } from "@shared/domain/ust-texte";

const J = 2026;
const HEUTE = `${J}-09-25`;
const MONAT = 8;
/** 60 min Hauswirtschaft zu 38,00 €/h (Katalog). */
const HW_60 = 38_00;
const UST_19 = (netto: number) => Math.round(netto * 0.19);

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let hwId: number;
const kunden: number[] = [];
const cleanup = { appts: [] as number[], srs: [] as number[], invoices: [] as number[] };

interface Ausgabe {
  invoice: any;
  html: string;
  /** Leistungsnachweis zur Rechnung (Gate 2 zu #194, B-1). */
  ln: string;
  xml: string;
}

async function neuerKunde(felder: Record<string, unknown>): Promise<{ id: number; name: string }> {
  const nachname = `Fall-${uniqueId()}`;
  const k = await apiPost<{ id: number }>("/api/admin/customers", {
    vorname: "UStAbnahme", nachname, geburtsdatum: "1939-05-04",
    email: `ust-abnahme-${uniqueId()}@test.local`, strasse: "Musterweg", nr: "2",
    plz: "09111", stadt: "Chemnitz", telefon: "+4917600000093",
    contacts: [{ contactType: "familie", isPrimary: true, vorname: "K", nachname: "U", mobilnummer: "+4917600000094" }],
    ...felder,
  });
  expect(k.status, JSON.stringify(k.data)).toBe(201);
  kunden.push(k.data.id);
  expect((await apiPatch(`/api/admin/customers/${k.data.id}/assign`, {
    primaryEmployeeId: auth.user.id, backupEmployeeId: null, backupEmployeeId2: null,
  })).status).toBe(200);
  const [c] = await db.select({ name: customers.name }).from(customers).where(eq(customers.id, k.data.id));
  return { id: k.data.id, name: c.name };
}

/**
 * Eigene Uhrzeit je Termin UND Datum: derselbe Mitarbeiter, sonst
 * Terminüberschneidung. Je Datum gezählt, damit der Tag nicht über
 * Mitternacht hinausläuft (07:00, 08:30, … bis 20:30).
 */
const slotsJeDatum = new Map<string, number>();
function naechsteUhrzeit(datum: string): string {
  const n = slotsJeDatum.get(datum) ?? 0;
  slotsJeDatum.set(datum, n + 1);
  if (n > 9) throw new Error(`Zu viele Test-Termine am ${datum}`);
  const minuten = 7 * 60 + 90 * n;
  return `${String(Math.floor(minuten / 60)).padStart(2, "0")}:${String(minuten % 60).padStart(2, "0")}`;
}

async function termin(customerId: number, datum: string, minuten = 60, km = 0): Promise<number> {
  const start = naechsteUhrzeit(datum);
  const r = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
    customerId, date: datum, scheduledStart: start, notes: `UStAbnahme-${datum}`,
    assignedEmployeeId: auth.user.id, services: [{ serviceId: hwId, durationMinutes: minuten }],
  });
  expect(r.status, `Termin ${datum}: ${JSON.stringify(r.data)}`).toBe(201);
  cleanup.appts.push(r.data.id);
  const d = await apiPost<unknown>(`/api/appointments/${r.data.id}/document`, {
    actualStart: start, travelOriginType: "home", travelKilometers: km, customerKilometers: 0,
    services: [{ serviceId: hwId, actualDurationMinutes: minuten, details: "UStAbnahme" }],
  });
  expect(d.status, `dokumentieren ${datum}: ${JSON.stringify(d.data)}`).toBe(200);
  return r.data.id;
}

async function rendern(invoiceId: number): Promise<Ausgabe> {
  const settings = await storage.getCompanySettings();
  const invoice = await storage.getInvoice(invoiceId);
  expect(invoice, `Rechnung ${invoiceId} nicht lesbar`).toBeTruthy();
  const { pdfData } = await buildInvoicePdfData(invoice!, settings);
  const xml = await generateZugferdXml(pdfData);
  expect(xml, "ZUGFeRD-XML wurde nicht erzeugt (Validierungsfehler)").toBeTruthy();
  return { invoice, html: generateInvoiceHtml(pdfData), ln: generateLeistungsnachweisHtml(pdfData), xml: xml! };
}

/** Leistungsnachweis unterschreiben, abrechnen, je Rechnung rendern. */
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
  const out: Ausgabe[] = [];
  for (const i of erzeugt) {
    cleanup.invoices.push(i.id);
    out.push(await rendern(i.id));
  }
  return out;
}

/** Kategorien der Positionen (ohne die Aufschlüsselung im Kopf). */
function positionsKategorien(xml: string): string[] {
  const zeilen = xml.split("<ram:IncludedSupplyChainTradeLineItem>").slice(1);
  return zeilen.map(z => z.match(/<ram:CategoryCode>([A-Z]+)<\/ram:CategoryCode>/)?.[1] ?? "?");
}

/** Aufschlüsselung im Kopf (BG-23): Kategorie, Basis, Steuer, Befreiungsgrund. */
function aufschluesselung(xml: string): Array<{ kategorie: string; basis: string; steuer: string; grund: string | null }> {
  const kopf = xml.split("<ram:ApplicableHeaderTradeSettlement>")[1] ?? "";
  return [...kopf.matchAll(/<ram:ApplicableTradeTax>([\s\S]*?)<\/ram:ApplicableTradeTax>/g)].map(m => ({
    kategorie: m[1].match(/<ram:CategoryCode>([A-Z]+)</)?.[1] ?? "?",
    basis: m[1].match(/<ram:BasisAmount>([^<]+)</)?.[1] ?? "?",
    steuer: m[1].match(/<ram:CalculatedAmount>([^<]+)</)?.[1] ?? "?",
    grund: m[1].match(/<ram:ExemptionReason>([^<]+)</)?.[1] ?? null,
  }));
}

function nurText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

/** Pflichtfall 1/6 — die 19-%-Ausgabe auf allen drei Ebenen. */
function erwarte19(a: Ausgabe, netto: number, name: string, label: string) {
  expect(a.invoice.netAmountCents, `${label}: netto`).toBe(netto);
  expect(a.invoice.vatAmountCents, `${label}: USt 19 %`).toBe(UST_19(netto));
  expect(a.invoice.grossAmountCents, `${label}: brutto`).toBe(netto + UST_19(netto));
  const text = nurText(a.html);
  expect(text, `${label}: das PDF weist 19 % aus`).toMatch(/USt\. 19 %/);
  expect(text, `${label}: das PDF nennt KEINE Befreiung`).not.toMatch(/§\s*4\s*Nr\.\s*16/);
  expect(text, `${label}: Leistungsempfänger OHNE Pflegegrad`).toContain(`Leistungsempfänger: ${name}`);
  expect(text, `${label}: kein Pflegegrad im Leistungsempfänger`).not.toMatch(new RegExp(`Leistungsempfänger: ${name}[^.]*Pflegegrad`));
  expect(positionsKategorien(a.xml), `${label}: XML-Kategorie je Position`).toEqual(["S"]);
  expect(aufschluesselung(a.xml).map(g => g.kategorie), `${label}: XML-Aufschlüsselung`).toEqual(["S"]);
  expect(nurText(a.ln), `${label}: LN weist brutto aus`).toMatch(/Summe \(inkl\. MwSt\.\)/);
}

/** Pflichtfall 2/3 — die steuerfreie Ausgabe auf allen drei Ebenen. */
function erwarteFrei(a: Ausgabe, netto: number, label: string) {
  expect(a.invoice.netAmountCents, `${label}: netto bleibt`).toBe(netto);
  expect(a.invoice.vatAmountCents, `${label}: keine USt`).toBe(0);
  expect(a.invoice.grossAmountCents, `${label}: brutto = netto`).toBe(netto);
  const text = nurText(a.html);
  expect(text, `${label}: Befreiungshinweis im PDF`).toContain(USTFREI_HINWEIS);
  expect(text, `${label}: keine 19 % im PDF`).not.toMatch(/USt\. 19 %/);
  expect(new Set(positionsKategorien(a.xml)), `${label}: XML-Kategorie je Position`).toEqual(new Set(["E"]));
  const g = aufschluesselung(a.xml);
  expect(g.map(x => x.kategorie), `${label}: XML-Aufschlüsselung`).toEqual(["E"]);
  expect(g[0].grund, `${label}: BT-120 = derselbe Text wie im PDF`).toBe(USTFREI_HINWEIS);
  // Leistungsnachweis (B-1): netto = brutto, kein Brutto-Satz neben Netto-Betrag.
  const ln = nurText(a.ln);
  expect(ln, `${label}: LN ohne „(brutto)“`).not.toMatch(/\(brutto\)|inkl\. MwSt/);
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

describe("§ 4 Nr. 16 g UStG — Abnahme (Tabelle D, Pflichtfälle 1–6, E3–E6)", () => {
  it("Pflichtfall 1 – Selbstzahler OHNE Pflegegrad: 19 % (Leitplanke, unverändert)", async () => {
    const k = await neuerKunde({ billingType: "selbstzahler", acceptsPrivatePayment: true });
    await termin(k.id, `${J}-08-10`);
    const [a, ...rest] = await abrechnen(k.id);
    expect(rest).toHaveLength(0);
    erwarte19(a, HW_60, k.name, "Fall 1");
    expect(a.invoice.pflegegrad, "Fall 1: kein Pflegegrad-Stempel").toBeNull();
  }, 300_000);

  it("Pflichtfall 2 / E6 – Selbstzahler MIT Pflegegrad: steuerfrei, Netto bleibt (vorher 19 %)", async () => {
    const k = await neuerKunde({
      billingType: "selbstzahler", acceptsPrivatePayment: true, pflegegrad: 2, pflegegradSeit: "2024-01-01",
    });
    await termin(k.id, `${J}-08-10`, 60, 4);
    const [a, ...rest] = await abrechnen(k.id);
    expect(rest).toHaveLength(0);
    // 38,00 Hauswirtschaft + 4 km × 0,35 = 1,40 → 39,40 netto; die km folgen der Hauptleistung (D6).
    erwarteFrei(a, HW_60 + 1_40, "Fall 2");
    expect(nurText(a.html), "Fall 2: Leistungsempfänger mit Pflegegrad").toContain(`Leistungsempfänger: ${k.name} (Pflegegrad 2)`);
    expect(a.invoice.pflegegrad, "Fall 2: Stempel = Grad am Leistungstag (Historie)").toBe(2);
    // B-1: der Nachweis zeigt den NETTO-Satz — vorher „45,22 €/Std." neben „38,00 €".
    expect(nurText(a.ln), "Fall 2: LN Stundensatz netto").toMatch(/38,00\s*€\/Std\./);
    expect(nurText(a.ln), "Fall 2: LN ohne hochgerechneten Satz").not.toMatch(/45,22/);
  }, 300_000);

  it("Pflichtfall 3 / E5 – Überlauf-Privatanteil eines Kassenkunden: Kasse UND privat steuerfrei (vorher privat 19 %)", async () => {
    const k = await neuerKunde({
      billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: true, pflegegrad: 3, pflegegradSeit: "2024-01-01",
    });
    expect((await apiPut(`/api/budget/${k.id}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
      ],
    })).status).toBe(200);
    await db.insert(budgetAllocations).values({
      customerId: k.id, budgetType: "entlastungsbetrag_45b", year: J, month: MONAT,
      amountCents: 20_00, source: "initial_balance",
      validFrom: `${J}-08-01`, expiresAt: null, notes: "UStAbnahme-Startwert",
    });
    await termin(k.id, `${J}-08-10`);
    const ausgaben = await abrechnen(k.id);
    const kasse = ausgaben.filter(a => a.invoice.budgetType === "entlastungsbetrag_45b");
    const privat = ausgaben.filter(a => a.invoice.billingType === "selbstzahler");
    expect(kasse, "eine Kassen-Rechnung").toHaveLength(1);
    expect(privat, "eine Privat-Rechnung").toHaveLength(1);
    erwarteFrei(kasse[0], 20_00, "Fall 3 Kasse");
    erwarteFrei(privat[0], HW_60 - 20_00, "Fall 3 privat");
  }, 300_000);

  it("Pflichtfall 4 – Leistung AUSSERHALB der Liste an eine Person mit Pflegegrad: 19 %, gemischte Rechnung mit Positionsbezug", async () => {
    // Der Katalog kennt keine Leistung außerhalb der Liste (Schritt A: nur
    // Hauswirtschaft + Alltagsbegleitung). Die REGEL für diesen Fall steht im
    // Unit-Test (D3); hier wird die DARSTELLUNG einer gemischten Rechnung
    // abgenommen: eine gespeicherte steuerfreie + eine 19-%-Position.
    const k = await neuerKunde({
      billingType: "selbstzahler", acceptsPrivatePayment: true, pflegegrad: 3, pflegegradSeit: "2024-01-01",
    });
    await termin(k.id, `${J}-08-10`);
    await termin(k.id, `${J}-08-17`);
    const [a] = await abrechnen(k.id);
    const zeilen = await db.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, a.invoice.id));
    const zweite = zeilen.find(z => z.appointmentDate === `${J}-08-17`)!;
    await db.update(invoiceLineItems)
      .set({ serviceCode: "gartenpflege", serviceDescription: "Gartenpflege", vatRateBp: 1900 })
      .where(eq(invoiceLineItems.id, zweite.id));
    await db.update(invoices)
      .set({ vatAmountCents: UST_19(HW_60), grossAmountCents: 2 * HW_60 + UST_19(HW_60), vatRate: 1900 })
      .where(eq(invoices.id, a.invoice.id));

    const g = await rendern(a.invoice.id);
    const text = nurText(g.html);
    // Die Reihenfolge der Positionen ist beim Anlegen nicht festgelegt (Termine
    // ohne ORDER BY geladen, FINDING im PR) — der Test liest die Nummer aus der
    // gerenderten Tabelle und prüft, dass der Hinweis GENAU auf die steuerfreie
    // Zeile zeigt (RK-5: die Nummer steht in der Spalte „Pos.“).
    expect(g.html, "Spalte „Pos.“").toContain("<th>Pos.</th>");
    const tbody = g.html.split("<tbody>")[1].split("</tbody>")[0];
    const reihen = [...tbody.matchAll(/<tr>\s*<td[^>]*>(\d+)<\/td>[\s\S]*?<td class="col-service"[^>]*>([^<]+)/g)]
      .map(m => ({ pos: m[1], leistung: m[2].trim() }));
    expect(reihen.map(z => z.pos), "Positionsnummern").toEqual(["1", "2"]);
    const frei = reihen.find(z => z.leistung === "Hauswirtschaft")!;
    expect(text, "Positionsbezug zeigt auf die steuerfreie Zeile").toContain(`Pos. ${frei.pos} ist umsatzsteuerfrei nach § 4 Nr. 16 UStG.`);
    expect(text, "USt je Satz mit Basis").toMatch(/USt\. 19 % auf 38,00\s*€/);
    // XML: Kategorie je Position in derselben Reihenfolge wie die PDF-Tabelle.
    expect(positionsKategorien(g.xml), "XML: Kategorie je Position")
      .toEqual(reihen.map(z => (z.leistung === "Hauswirtschaft" ? "E" : "S")));
    expect(aufschluesselung(g.xml), "XML: Aufschlüsselung je Satz").toEqual([
      { kategorie: "E", basis: "38.00", steuer: "0.00", grund: USTFREI_HINWEIS },
      { kategorie: "S", basis: "38.00", steuer: "7.22", grund: null },
    ]);
  }, 300_000);

  it("Pflichtfall 5 – Pflegegrad endet im Monat: davor steuerfrei, danach 19 % (vorher beides 19 %)", async () => {
    const k = await neuerKunde({
      billingType: "selbstzahler", acceptsPrivatePayment: true, pflegegrad: 2, pflegegradSeit: "2024-01-01",
    });
    expect((await apiPost(`/api/admin/customers/${k.id}/care-level/beenden`, { abDatum: `${J}-08-16` })).status).toBe(200);
    await termin(k.id, `${J}-08-10`);
    await termin(k.id, `${J}-08-20`);
    const [a, ...rest] = await abrechnen(k.id);
    expect(rest).toHaveLength(0);
    expect(a.invoice.netAmountCents).toBe(2 * HW_60);
    expect(a.invoice.vatAmountCents, "nur der Termin nach dem Ende trägt USt").toBe(UST_19(HW_60));
    const text = nurText(a.html);
    // Reihenfolge der Positionen beim Anlegen nicht festgelegt (FINDING im PR):
    // die steuerfreie Zeile ist die mit dem Netto-Satz 38,00 €/Std.
    const tbody = a.html.split("<tbody>")[1].split("</tbody>")[0];
    const reihen = [...tbody.matchAll(/<tr>\s*<td[^>]*>(\d+)<\/td>[\s\S]*?(\d+,\d{2})\s*€\/Std\./g)]
      .map(m => ({ pos: m[1], satz: m[2] }));
    expect(reihen.map(r => r.satz).sort(), "eine steuerfreie, eine 19-%-Zeile").toEqual(["38,00", "45,22"]);
    const frei = reihen.find(r => r.satz === "38,00")!;
    expect(text).toContain(`Pos. ${frei.pos} ist umsatzsteuerfrei nach § 4 Nr. 16 UStG.`);
    expect(text, "Leistungsempfänger mit Zeitraum").toContain(`Leistungsempfänger: ${k.name}, Pflegegrad 2 (bis 10.08.)`);
    expect(positionsKategorien(a.xml)).toEqual(reihen.map(r => (r.satz === "38,00" ? "E" : "S")));
    expect(a.invoice.pflegegrad, "Stempel = Grad am LETZTEN Leistungstag (keiner)").toBeNull();
    // B-1, gemischt: steuerfreie Zeile netto, 19-%-Zeile brutto, Summe = Rechnung.
    const ln = nurText(a.ln);
    expect(ln, "LN: steuerfreie Zeile 38,00").toMatch(/38,00\s*€\/Std\. 38,00\s*€/);
    expect(ln, "LN: 19-%-Zeile 45,22").toMatch(/45,22\s*€\/Std\. 45,22\s*€/);
    expect(ln, "LN: Summe = Rechnungsbetrag").toMatch(/Summe \(inkl\. MwSt\.\) 83,22\s*€/);
  }, 300_000);

  it("Pflichtfall 6 – Pflegegrad nur in den Stammdaten, NICHT in der Historie: 19 %", async () => {
    const k = await neuerKunde({ billingType: "selbstzahler", acceptsPrivatePayment: true });
    await db.update(customers).set({ pflegegrad: 3 }).where(eq(customers.id, k.id));
    await termin(k.id, `${J}-08-10`);
    const [a] = await abrechnen(k.id);
    erwarte19(a, HW_60, k.name, "Fall 6");
  }, 300_000);

  it("E4 → E3 – 177-Muster: Freigabe-Check meldet den Fehleintrag, nach „entfernen“ ist er leer und die Rechnung bleibt 19 %", async () => {
    const k = await neuerKunde({
      billingType: "selbstzahler", acceptsPrivatePayment: true, pflegegrad: 3, pflegegradSeit: "2024-08-01",
    });
    const befunde = async () => {
      const zeile = readFileSync(resolve(__dirname, "../../scripts/sql/ust-freigabe-check.sql"), "utf8");
      const r = await db.execute(sql.raw(zeile));
      const rows = ((r as any).rows ?? r) as Array<{ befund: string; customer_id: number }>;
      return rows.filter(x => Number(x.customer_id) === k.id).map(x => x.befund.slice(0, 1)).sort();
    };
    // E4: vor dem Austragen darf der Check NICHT leer sein.
    expect(await befunde(), "E4: Selbstzahler mit Pflegegrad in beiden Quellen").toEqual(["A", "B"]);

    const [eintrag] = await db.select().from(customerCareLevelHistory).where(eq(customerCareLevelHistory.customerId, k.id));
    const ent = await apiPost(`/api/admin/customers/${k.id}/care-level/${eintrag.id}/entfernen`, { grund: "Pflegegrad nie bewilligt (Test)" });
    expect(ent.status, JSON.stringify(ent.data)).toBe(200);

    // Beide Stellen bereinigt (Alrik): Stammdaten auf „kein PG", Historie markiert.
    const [c] = await db.select({ pg: customers.pflegegrad }).from(customers).where(eq(customers.id, k.id));
    expect(c.pg, "Stammdaten auf „kein Pflegegrad“").toBeNull();
    // I5: der Eintrag zählt für KEIN Datum mehr — auch rückwirkend.
    for (const tag of ["2024-08-01", "2025-06-30", `${J}-08-10`, HEUTE]) {
      expect(await getCareLevelAt(k.id, tag), `I5: ${tag}`).toBeNull();
    }
    expect(await befunde(), "nach dem Austragen: Freigabe-Check leer").toEqual([]);

    await termin(k.id, `${J}-08-10`);
    const [a] = await abrechnen(k.id);
    erwarte19(a, HW_60, k.name, "E3");
  }, 300_000);

  it("Freigabe-Check meldet auch Abweichungen zwischen den Quellen (Stammdaten ≠ Historie)", async () => {
    const k = await neuerKunde({
      billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: false, pflegegrad: 2, pflegegradSeit: "2024-01-01",
    });
    await db.update(customers).set({ pflegegrad: 4 }).where(eq(customers.id, k.id));
    const zeile = readFileSync(resolve(__dirname, "../../scripts/sql/ust-freigabe-check.sql"), "utf8");
    const r = await db.execute(sql.raw(zeile));
    const rows = ((r as any).rows ?? r) as Array<{ befund: string; customer_id: number; detail: string }>;
    const meine = rows.filter(x => Number(x.customer_id) === k.id);
    expect(meine.map(x => x.befund.slice(0, 1)), "Befund C").toEqual(["C"]);
    expect(meine[0].detail).toBe("Stammdaten 4, Historie 2");
  }, 120_000);

  it("Storno (D9) spiegelt die Behandlung jeder Position", async () => {
    const k = await neuerKunde({
      billingType: "selbstzahler", acceptsPrivatePayment: true, pflegegrad: 2, pflegegradSeit: "2024-01-01",
    });
    await termin(k.id, `${J}-08-12`);
    const [a] = await abrechnen(k.id);
    const st = await apiPatch<any>(`/api/billing/${a.invoice.id}/status`, { status: "storniert" });
    expect(st.status, JSON.stringify(st.data)).toBe(200);
    const [storno] = await db.select().from(invoices).where(and(
      eq(invoices.stornierteRechnungId, a.invoice.id), eq(invoices.invoiceType, "stornorechnung"),
    ));
    cleanup.invoices.push(storno.id);
    const zeilen = await db.select().from(invoiceLineItems).where(inArray(invoiceLineItems.invoiceId, [a.invoice.id, storno.id]));
    const original = zeilen.filter(z => z.invoiceId === a.invoice.id).map(z => [z.vatRateBp, z.pflegegradAmLeistungstag]);
    const gespiegelt = zeilen.filter(z => z.invoiceId === storno.id).map(z => [z.vatRateBp, z.pflegegradAmLeistungstag]);
    expect(gespiegelt, "Storno-Positionen tragen Satz und Grad des Originals").toEqual(original);
    const g = await rendern(storno.id);
    expect(positionsKategorien(g.xml), "Storno-XML: dieselbe Kategorie").toEqual(["E"]);
  }, 300_000);

  it("Befund H (RK-9) – Entwurf mit Pflegegrad, danach ausgetragen: der Check meldet ihn", async () => {
    const k = await neuerKunde({
      billingType: "selbstzahler", acceptsPrivatePayment: true, pflegegrad: 3, pflegegradSeit: "2024-08-01",
    });
    await termin(k.id, `${J}-08-11`);
    const [a] = await abrechnen(k.id);
    expect(a.invoice.vatAmountCents, "Vorbedingung: der Entwurf ist steuerfrei").toBe(0);
    const [eintrag] = await db.select().from(customerCareLevelHistory).where(eq(customerCareLevelHistory.customerId, k.id));
    expect((await apiPost(`/api/admin/customers/${k.id}/care-level/${eintrag.id}/entfernen`, { grund: "nie bewilligt (Test H)" })).status).toBe(200);
    const zeile = readFileSync(resolve(__dirname, "../../scripts/sql/ust-freigabe-check.sql"), "utf8");
    const rows = (((await db.execute(sql.raw(zeile))) as any).rows ?? []) as Array<{ befund: string; customer_id: number; detail: string }>;
    const meine = rows.filter(x => Number(x.customer_id) === k.id);
    expect(meine.map(x => x.befund.slice(0, 1)), "nur Befund H").toEqual(["H"]);
    expect(meine[0].detail).toContain("PG 3, Historie kein");
  }, 300_000);

  it("RK-10 – Fehleintrag entfernen: voriger Grad lebt NUR nach Bestätigung wieder auf", async () => {
    const setup = async () => {
      const k = await neuerKunde({
        billingType: "selbstzahler", acceptsPrivatePayment: true, pflegegrad: 2, pflegegradSeit: "2024-01-01",
      });
      // Irrtümlich PG 3 ab 01.08. — addCareLevelHistory beendet PG 2 am 31.07.
      expect((await apiPost(`/api/admin/customers/${k.id}/care-level`, { pflegegrad: 3, validFrom: `${J}-08-01` })).status).toBe(201);
      const hist = await db.select().from(customerCareLevelHistory).where(eq(customerCareLevelHistory.customerId, k.id));
      const falsch = hist.find(h => h.pflegegrad === 3)!;
      expect(hist.find(h => h.pflegegrad === 2)!.validTo, "Vorbedingung").toBe(`${J}-07-31`);
      return { k, falsch };
    };

    // Ohne Bestätigung: Lücke ab 01.08. (wie bisher entschieden: nicht automatisch).
    const ohne = await setup();
    expect((await apiPost(`/api/admin/customers/${ohne.k.id}/care-level/${ohne.falsch.id}/entfernen`, { grund: "Irrtum (Test)" })).status).toBe(200);
    expect(await getCareLevelAt(ohne.k.id, `${J}-08-10`), "ohne Bestätigung: kein PG ab 01.08.").toBeNull();

    // S-12: der Dialog hat einen ANDEREN Eintrag angekündigt → 409, nichts geändert.
    const veraltet = await setup();
    const falscheId = await apiPost<any>(`/api/admin/customers/${veraltet.k.id}/care-level/${veraltet.falsch.id}/entfernen`, {
      grund: "Irrtum (Test)", vorigenWiederOeffnen: true, erwarteterVorgaengerId: veraltet.falsch.id,
    });
    expect(falscheId.status, JSON.stringify(falscheId.data)).toBe(409);
    expect(await getCareLevelAt(veraltet.k.id, `${J}-08-10`), "409: der Fehleintrag gilt weiter (zurückgerollt)").toBe(3);

    // Mit Bestätigung: PG 2 gilt wieder ab 01.08., offen wie der entfernte Eintrag.
    const mit = await setup();
    const vorgaenger = (await db.select().from(customerCareLevelHistory).where(eq(customerCareLevelHistory.customerId, mit.k.id))).find(h => h.pflegegrad === 2)!;
    const r = await apiPost<any>(`/api/admin/customers/${mit.k.id}/care-level/${mit.falsch.id}/entfernen`, {
      grund: "Irrtum (Test)", vorigenWiederOeffnen: true, erwarteterVorgaengerId: vorgaenger.id,
    });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(await getCareLevelAt(mit.k.id, `${J}-08-10`), "mit Bestätigung: PG 2 wieder ab 01.08.").toBe(2);
    expect(await getCareLevelAt(mit.k.id, HEUTE)).toBe(2);
    const [c] = await db.select({ pg: customers.pflegegrad }).from(customers).where(eq(customers.id, mit.k.id));
    expect(c.pg, "Stammdaten folgen").toBe(2);
  }, 300_000);

  it("RK-11 – Mitarbeiter ohne Admin-Rechte: Pflegegrad nur ab heute, nicht rückwirkend", async () => {
    const k = await neuerKunde({ billingType: "selbstzahler", acceptsPrivatePayment: true });
    const ma = await createTestEmployee({ isAdmin: false, nachnamePrefix: "UStRK11" });
    expect((await apiPatch(`/api/admin/customers/${k.id}/assign`, {
      primaryEmployeeId: ma.id, backupEmployeeId: null, backupEmployeeId2: null,
    })).status).toBe(200);
    const maAuth = await loginAs(ma.email, ma.password);
    const rueck = await apiPostAs<any>(maAuth, `/api/customers/${k.id}/care-level`, { pflegegrad: 2, seitDatum: `${J}-08-01` });
    expect(rueck.status, "rückwirkend abgelehnt").toBe(400);
    expect(await getCareLevelAt(k.id, `${J}-08-10`), "kein Nachweis entstanden").toBeNull();
    const abHeute = await apiPostAs<any>(maAuth, `/api/customers/${k.id}/care-level`, { pflegegrad: 2, seitDatum: HEUTE });
    expect(abHeute.status, JSON.stringify(abHeute.data)).toBe(200);
  }, 300_000);

  it("Kostenvoranschlag – Selbstzahler mit Pflegegrad: Satz 0, brutto = netto", async () => {
    const k = await neuerKunde({
      billingType: "selbstzahler", acceptsPrivatePayment: true, pflegegrad: 2, pflegegradSeit: "2024-01-01",
    });
    const kv = await apiGet<any>(`/api/budget/${k.id}/cost-estimate?date=${J}-08-12&hauswirtschaftMinutes=60&alltagsbegleitungMinutes=0&travelKilometers=0&customerKilometers=0`);
    expect(kv.status, JSON.stringify(kv.data)).toBe(200);
    expect(kv.data.isSelbstzahler).toBe(true);
    expect(kv.data.vatRate, "Kostenvoranschlag: Satz 0").toBe(0);
    expect(kv.data.bruttoCents, "Kostenvoranschlag: brutto = netto").toBe(HW_60);
  }, 300_000);

  it("Liste „Bereit zum Abrechnen“ – Selbstzahler mit Pflegegrad: Betrag ohne USt", async () => {
    const k = await neuerKunde({
      billingType: "selbstzahler", acceptsPrivatePayment: true, pflegegrad: 2, pflegegradSeit: "2024-01-01",
    });
    await termin(k.id, `${J}-08-12`);
    const sr = await apiPost<{ id: number }>("/api/service-records", { customerId: k.id, employeeId: auth.user.id, year: J, month: MONAT });
    cleanup.srs.push(sr.data.id);
    for (const signerType of ["employee", "customer"] as const) {
      await apiPost(`/api/service-records/${sr.data.id}/sign`, { signerType, signatureData: validSignatureDataUrl() });
    }
    const liste = await apiGet<Record<string, { actualAmountCents: number | null }>>(
      `/api/billing/customer-amounts?year=${J}&month=${MONAT}&customerIds=${k.id}`,
    );
    expect(liste.status, JSON.stringify(liste.data)).toBe(200);
    expect(liste.data[String(k.id)]?.actualAmountCents, "Liste: ohne USt").toBe(HW_60);
  }, 300_000);

  it("E1/E2 auf PDF und XML – Rundung je Satz auf die Summe", async () => {
    const k = await neuerKunde({ billingType: "selbstzahler", acceptsPrivatePayment: true });
    await termin(k.id, `${J}-08-04`);
    await termin(k.id, `${J}-08-05`);
    await termin(k.id, `${J}-08-06`);
    const [a] = await abrechnen(k.id);
    const zeilen = await db.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, a.invoice.id));
    const setze = async (betraege: number[]) => {
      for (const [i, z] of [...zeilen].sort((x, y) => x.id - y.id).entries()) {
        await db.update(invoiceLineItems).set({ totalCents: betraege[i] }).where(eq(invoiceLineItems.id, z.id));
      }
    };
    // E2: RE-2026-0378, netto 291,01 € — drei Positionen, deren Einzelrundung 55,30 € ergäbe.
    await setze([10050, 10050, 9001]);
    await db.update(invoices).set({ netAmountCents: 29101, vatAmountCents: 5529, grossAmountCents: 34630 }).where(eq(invoices.id, a.invoice.id));
    const e2 = await rendern(a.invoice.id);
    expect(nurText(e2.html), "E2 PDF").toMatch(/USt\. 19 % auf 291,01\s*€: 55,29\s*€/);
    expect(aufschluesselung(e2.xml), "E2 XML").toEqual([{ kategorie: "S", basis: "291.01", steuer: "55.29", grund: null }]);
    // E1: RE-2026-0595, netto 299,85 € → 56,97 €.
    await setze([10000, 10000, 9985]);
    await db.update(invoices).set({ netAmountCents: 29985, vatAmountCents: 5697, grossAmountCents: 35682 }).where(eq(invoices.id, a.invoice.id));
    const e1 = await rendern(a.invoice.id);
    expect(nurText(e1.html), "E1 PDF").toMatch(/USt\. 19 % auf 299,85\s*€: 56,97\s*€/);
    expect(aufschluesselung(e1.xml), "E1 XML").toEqual([{ kategorie: "S", basis: "299.85", steuer: "56.97", grund: null }]);
  }, 300_000);
});
