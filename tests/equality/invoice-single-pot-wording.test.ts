/**
 * Task #1094 — Pot-spezifische Rechnungstexte bei Single-Pot-Kassenrechnungen.
 *
 * Hintergrund: Ein Termin, der vollständig aus EINEM Nicht-§45b-Kassentopf
 * gedeckt ist (z.B. §45a allein, weil §45b erschöpft/deaktiviert ist, oder
 * §39/42a allein), erzeugte bisher eine Rechnung mit `budget_type = null`. Der
 * Renderer fiel dann STILL auf die §45b-Formulierung zurück — rechtlich falscher
 * Text auf einer versiegelten Rechnung, ohne Fehler oder Feedback.
 *
 * Diese Suite sichert ab:
 *   1. Stamping-Logik (`resolveSinglePotBudgetType`): Single-Pot-Kassentopf →
 *      echter Topf, Selbstzahler/Privat → null, Multi-/Leer-Pot → null.
 *   2. Renderer (HTML + ZUGFeRD-XML): jeder Topf rendert seine eigene
 *      Überschrift/§-Notiz/BT-22-Note; §45a bzw. §39/42a NICHT mehr §45b.
 *   3. Legacy-Fallback: eine Bestands-Rechnung mit `budgetType = null` rendert
 *      unverändert die §45b-Formulierung (GoBD-Byte-Stabilität).
 */
import { describe, expect, it } from "vitest";
import { generateInvoiceHtml, generateLeistungsnachweisHtml, type InvoicePdfData } from "../../server/lib/pdf-generator";
import { generateZugferdXml } from "../../server/lib/zugferd";
import { resolveSinglePotBudgetType } from "../../server/services/invoice-calc";
import type { BuildLineItem } from "../../server/services/invoice-data";
import type { InvoicePotKey } from "@shared/domain/budget-invoice-split";

function makeLineItem(over: Partial<InvoicePdfData["lineItems"][0]> = {}): InvoicePdfData["lineItems"][0] {
  return {
    appointmentId: 1,
    appointmentDate: "2026-01-05",
    startTime: "10:00",
    endTime: "11:00",
    serviceDescription: "Betreuung",
    serviceCode: "alltagsbegleitung",
    durationMinutes: 60,
    quantityRaw: 1,
    quantityUnit: "hours",
    unitPriceCents: 100,
    totalCents: 100,
    employeeName: "Mitarbeiter A",
    appointmentNotes: null,
    serviceDetails: null,
    ...over,
  };
}

function makeData(over: Partial<InvoicePdfData> = {}): InvoicePdfData {
  return {
    companyName: "CarePflege GmbH",
    companyAddress: "Musterstraße 1\n10115 Berlin",
    companyPhone: "030123456",
    companyEmail: "info@example.com",
    companyWebsite: null,
    steuernummer: "",
    ustId: "",
    iban: "DE89370400440532013000",
    bic: "COBADEFFXXX",
    bankName: "Testbank",
    bankAccountHolder: null,
    ikNummer: "123456789",
    geschaeftsfuehrer: null,
    invoiceNumber: "RE-2026-0001",
    invoiceDate: "06.01.2026",
    invoiceDueDate: "06.01.2026",
    buyerReference: "REF-1",
    invoiceType: "rechnung",
    billingType: "pflegekasse_gesetzlich",
    budgetType: "entlastungsbetrag_45b",
    billingMonth: 1,
    billingYear: 2026,
    recipientName: "AOK Nord",
    recipientAddress: "Wilhelmstraße 1\n10963 Berlin",
    insuranceProviderName: "AOK",
    insuranceIkNummer: "987654321",
    versichertennummer: "",
    pflegegrad: 3,
    customerName: "Max Mustermann",
    customerAddress: "Kundenweg 2\n10115 Berlin",
    customerGeburtsdatum: null,
    assignmentDeclarationDate: null,
    assignmentDeclarationRef: null,
    lineItems: [makeLineItem()],
    netAmountCents: 100,
    vatAmountCents: 0,
    grossAmountCents: 100,
    vatRate: 0,
    notes: null,
    ...over,
  };
}

// Erwartete topf-spezifische Render-Artefakte (HTML-Label/-Notiz + XML-BT-22).
const LABEL_45B = "§ 45b SGB XI – Entlastungsbetrag";
const NOTE_45B = "Abrechnung gemäß Abtretungserklärung über den Entlastungsbetrag nach § 45b SGB XI.";
const LABEL_45A = "§ 45a SGB XI – Umwandlungsanspruch";
const NOTE_45A = "Abrechnung des Umwandlungsanspruchs nach § 45a SGB XI";
const LABEL_39_42A = "§§ 39 / 42a SGB XI – Verhinderungspflege";
const NOTE_39_42A = "Abrechnung der Verhinderungs-/Ersatzpflege nach §§ 39 i.V.m. 42a SGB XI.";
// ZUGFeRD-BT-22-Notizen verwenden Geviertstrich (—) statt Halbgeviertstrich.
const XML_NOTE_45B = "§ 45b SGB XI — Entlastungsbetrag";
const XML_NOTE_45A = "§ 45a SGB XI — Umwandlungsanspruch";
const XML_NOTE_39_42A = "§§ 39 / 42a SGB XI — Verhinderungspflege";

function buildLineItem(appointmentId: number, totalCents: number): BuildLineItem {
  return { appointmentId, totalCents } as unknown as BuildLineItem;
}

function potMap(entries: Array<[InvoicePotKey, number]>): Map<InvoicePotKey, BuildLineItem[]> {
  const m = new Map<InvoicePotKey, BuildLineItem[]>();
  for (const [pot, count] of entries) {
    m.set(pot, Array.from({ length: count }, (_, i) => buildLineItem(i + 1, 100)));
  }
  return m;
}

describe("Task #1094 — resolveSinglePotBudgetType (Stamping-Logik)", () => {
  it("Single §45a-Pot → umwandlung_45a", () => {
    expect(resolveSinglePotBudgetType(potMap([["umwandlung_45a", 2]]))).toBe("umwandlung_45a");
  });

  it("Single §39/42a-Pot → ersatzpflege_39_42a", () => {
    expect(resolveSinglePotBudgetType(potMap([["ersatzpflege_39_42a", 1]]))).toBe("ersatzpflege_39_42a");
  });

  it("Single §45b-Pot → entlastungsbetrag_45b", () => {
    expect(resolveSinglePotBudgetType(potMap([["entlastungsbetrag_45b", 1]]))).toBe("entlastungsbetrag_45b");
  });

  it("Single Privat-Pot → null (Selbstzahler, kein Stamping)", () => {
    expect(resolveSinglePotBudgetType(potMap([["private", 1]]))).toBeNull();
  });

  it("Mehrere Pots → null (Multi-Pot-Pfad stempelt selbst pro Rechnung)", () => {
    expect(
      resolveSinglePotBudgetType(potMap([["umwandlung_45a", 1], ["private", 1]])),
    ).toBeNull();
  });

  it("Kein belegter Pot → null", () => {
    expect(resolveSinglePotBudgetType(potMap([]))).toBeNull();
  });
});

describe("Task #1094 — Single-Pot §45a-Rechnung rendert §45a-Wording", () => {
  // Der §-Hinweis lebt im Rechnungs-Renderer (getPotNote), das Topf-Label im
  // Leistungsnachweis-Renderer (getBudgettopfLabel) — beide leitet `budgetType`.
  const data = makeData({ budgetType: "umwandlung_45a" });

  it("Rechnung-HTML: §45a-Notiz, NICHT §45b", () => {
    const html = generateInvoiceHtml(data);
    expect(html).toContain(NOTE_45A);
    expect(html).not.toContain(NOTE_45B);
  });

  it("Leistungsnachweis-HTML: §45a-Topf-Label, NICHT §45b", () => {
    const html = generateLeistungsnachweisHtml(data);
    expect(html).toContain(LABEL_45A);
    expect(html).not.toContain(LABEL_45B);
  });

  it("ZUGFeRD-XML: §45a-BT-22-Note, NICHT §45b", async () => {
    const xml = await generateZugferdXml(data);
    expect(xml).not.toBeNull();
    expect(xml!).toContain(XML_NOTE_45A);
    expect(xml!).not.toContain(XML_NOTE_45B);
  });
});

describe("Task #1094 — Single-Pot §39/42a-Rechnung rendert §39/42a-Wording", () => {
  const data = makeData({ budgetType: "ersatzpflege_39_42a" });

  it("Rechnung-HTML: §39/42a-Notiz, NICHT §45b", () => {
    const html = generateInvoiceHtml(data);
    expect(html).toContain(NOTE_39_42A);
    expect(html).not.toContain(NOTE_45B);
  });

  it("Leistungsnachweis-HTML: §39/42a-Topf-Label, NICHT §45b", () => {
    const html = generateLeistungsnachweisHtml(data);
    expect(html).toContain(LABEL_39_42A);
    expect(html).not.toContain(LABEL_45B);
  });

  it("ZUGFeRD-XML: §39/42a-BT-22-Note, NICHT §45b", async () => {
    const xml = await generateZugferdXml(data);
    expect(xml).not.toBeNull();
    expect(xml!).toContain(XML_NOTE_39_42A);
    expect(xml!).not.toContain(XML_NOTE_45B);
  });
});

describe("Task #1094 — Single-Pot §45b-Rechnung rendert weiterhin §45b", () => {
  const data = makeData({ budgetType: "entlastungsbetrag_45b" });

  it("Rechnung-HTML: §45b-Notiz, NICHT §45a", () => {
    const html = generateInvoiceHtml(data);
    expect(html).toContain(NOTE_45B);
    expect(html).not.toContain(NOTE_45A);
  });

  it("Leistungsnachweis-HTML: §45b-Topf-Label, NICHT §45a", () => {
    const html = generateLeistungsnachweisHtml(data);
    expect(html).toContain(LABEL_45B);
    expect(html).not.toContain(LABEL_45A);
  });

  it("ZUGFeRD-XML: §45b-BT-22-Note", async () => {
    const xml = await generateZugferdXml(data);
    expect(xml).not.toBeNull();
    expect(xml!).toContain(XML_NOTE_45B);
    expect(xml!).not.toContain(XML_NOTE_45A);
  });
});

describe("Task #1094 — Legacy null-budgetType rendert §45b-Fallback unverändert", () => {
  // Bestands-Rechnung vor #1094: budgetType=null. Der Render-Zeit-Fallback
  // (§45b) bleibt für diese Datensätze erhalten (GoBD-Byte-Stabilität). Nach dem
  // Stamping erreicht dieser Pfad nur noch echte Legacy-§45b-Rechnungen.
  const legacy = makeData({ budgetType: null });
  const stamped = makeData({ budgetType: "entlastungsbetrag_45b" });

  it("Rechnung-HTML: fällt auf §45b-Notiz zurück", () => {
    expect(generateInvoiceHtml(legacy)).toContain(NOTE_45B);
  });

  it("Leistungsnachweis-HTML: fällt auf §45b-Topf-Label zurück", () => {
    expect(generateLeistungsnachweisHtml(legacy)).toContain(LABEL_45B);
  });

  it("HTML: byte-identisch zur explizit gesetzten §45b-Rechnung (GoBD)", () => {
    expect(generateInvoiceHtml(legacy)).toBe(generateInvoiceHtml(stamped));
    expect(generateLeistungsnachweisHtml(legacy)).toBe(generateLeistungsnachweisHtml(stamped));
  });
});
