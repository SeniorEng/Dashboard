/**
 * Task #1797 — Prominenter Kostenträger-Topf-Label im Rechnungskopf.
 *
 * Auf jeder neu versiegelten Rechnung steht der Budget-Topf/Kostenträger
 * prominent direkt unter der Überschrift "RECHNUNG"/"STORNORECHNUNG" (gespeist
 * ausschließlich aus `getBudgettopfLabel`, derselben SSoT wie im
 * Leistungsnachweis-Kopf). Die bisher redundante Topf-Nennung im
 * Einleitungssatz (§-Klausel) und in der Notiz-Box (reine §-Benennung) entfällt
 * dabei (Konsolidierung); die Notiz-Box behält nur die Erstattungs-/Abtretungs-/
 * Beihilfe-Hinweise.
 *
 * Byte-Stabilität: Das neue Verhalten ist über das Render-Snapshot-Flag
 * `prominentPotLabel` gegatet. Ohne Flag (Bestand) rendert das alte Layout
 * byte-identisch weiter (`pdf_hash`-Stabilität).
 */
import { describe, expect, it } from "vitest";
import { generateInvoiceHtml, type InvoicePdfData } from "../../server/lib/pdf-generator";

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
    lineItems: [
      {
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
      },
    ],
    netAmountCents: 100,
    vatAmountCents: 0,
    grossAmountCents: 100,
    vatRate: 0,
    notes: null,
    ...over,
  };
}

const HEADER_LABEL_CLASS = 'class="invoice-pot-label"';
const INTRO_CLAUSE = "gemäß § 45b Abs. 1 Satz 3 Nr. 4 SGB XI";

const LABEL_45B = "§ 45b SGB XI – Entlastungsbetrag";
const LABEL_45A = "§ 45a SGB XI – Umwandlungsanspruch";
const LABEL_39_42A = "§§ 39 / 42a SGB XI – Verhinderungspflege";
const LABEL_SELBSTZAHLER = "Selbstzahler";

describe("Task #1797 — prominenter Topf-Label im Kopf (pro Topf/Abrechnungsart)", () => {
  it("§45b (gesetzlich, kassen-adressiert): Kopf-Label sichtbar", () => {
    const html = generateInvoiceHtml(makeData({ prominentPotLabel: true }));
    expect(html).toContain(HEADER_LABEL_CLASS);
    expect(html).toContain(LABEL_45B);
  });

  it("§45a: Kopf-Label §45a", () => {
    const html = generateInvoiceHtml(makeData({ budgetType: "umwandlung_45a", prominentPotLabel: true }));
    expect(html).toContain(HEADER_LABEL_CLASS);
    expect(html).toContain(LABEL_45A);
  });

  it("§§39/42a: Kopf-Label §§39/42a", () => {
    const html = generateInvoiceHtml(makeData({ budgetType: "ersatzpflege_39_42a", prominentPotLabel: true }));
    expect(html).toContain(HEADER_LABEL_CLASS);
    expect(html).toContain(LABEL_39_42A);
  });

  it("Kostenerstattung (gesetzlich + rechnungAnKunde): Kopf-Label §45b", () => {
    const html = generateInvoiceHtml(makeData({ rechnungAnKunde: true, prominentPotLabel: true }));
    expect(html).toContain(HEADER_LABEL_CLASS);
    expect(html).toContain(LABEL_45B);
  });

  it("pflegekasse_privat: Kopf-Label §45b (privat)", () => {
    const html = generateInvoiceHtml(makeData({ billingType: "pflegekasse_privat", prominentPotLabel: true }));
    expect(html).toContain(HEADER_LABEL_CLASS);
    expect(html).toContain("§ 45b SGB XI – Entlastungsbetrag (privat)");
  });

  it("Selbstzahler: Kopf-Label Selbstzahler", () => {
    const html = generateInvoiceHtml(
      makeData({ billingType: "selbstzahler", budgetType: null, prominentPotLabel: true }),
    );
    expect(html).toContain(HEADER_LABEL_CLASS);
    expect(html).toContain(LABEL_SELBSTZAHLER);
  });

  it("Storno: Kopf-Label sichtbar unter STORNORECHNUNG", () => {
    const html = generateInvoiceHtml(makeData({ invoiceType: "stornorechnung", prominentPotLabel: true }));
    expect(html).toContain("STORNORECHNUNG");
    expect(html).toContain(HEADER_LABEL_CLASS);
    expect(html).toContain(LABEL_45B);
  });
});

describe("Task #1797 — Konsolidierung (keine doppelte §-Nennung)", () => {
  it("Einleitungssatz enthält keine §-Klausel mehr", () => {
    const html = generateInvoiceHtml(makeData({ prominentPotLabel: true }));
    expect(html).toContain("berechnen wir:");
    expect(html).not.toContain(INTRO_CLAUSE);
  });

  it("Notiz-Box behält Abtretungs-Hinweis, ohne reine §-Topf-Benennung", () => {
    const html = generateInvoiceHtml(makeData({ prominentPotLabel: true }));
    expect(html).toContain("Abrechnung gemäß Abtretungserklärung.");
    expect(html).not.toContain("über den Entlastungsbetrag nach § 45b SGB XI");
  });

  it("Kostenerstattung: Notiz-Box behält Erstattungshinweis, ohne §-Topf-Satz", () => {
    const html = generateInvoiceHtml(makeData({ rechnungAnKunde: true, prominentPotLabel: true }));
    expect(html).toContain("Zur Erstattung bei Ihrer Pflegekasse");
    expect(html).not.toContain("Abrechnung des Entlastungsbetrags nach § 45b SGB XI.");
  });

  it("§45a: keine §45a-§-Benennung mehr in der Notiz-Box", () => {
    const html = generateInvoiceHtml(makeData({ budgetType: "umwandlung_45a", prominentPotLabel: true }));
    expect(html).not.toContain("Abrechnung des Umwandlungsanspruchs nach § 45a SGB XI");
  });
});

describe("Task #1797 — Byte-Stabilität (Bestand ohne Flag = altes Layout)", () => {
  it("Ohne Flag: kein Kopf-Label, alte Einleitung/Notiz", () => {
    const html = generateInvoiceHtml(makeData());
    expect(html).not.toContain(HEADER_LABEL_CLASS);
    expect(html).toContain(INTRO_CLAUSE);
    expect(html).toContain("Abrechnung gemäß Abtretungserklärung über den Entlastungsbetrag nach § 45b SGB XI.");
  });

  it("prominentPotLabel:false rendert byte-identisch zu undefined (Bestand)", () => {
    expect(generateInvoiceHtml(makeData({ prominentPotLabel: false }))).toBe(generateInvoiceHtml(makeData()));
  });

  it("prominentPotLabel:true ist deterministisch/stabil (identischer Re-Render)", () => {
    const a = generateInvoiceHtml(makeData({ prominentPotLabel: true }));
    const b = generateInvoiceHtml(makeData({ prominentPotLabel: true }));
    expect(a).toBe(b);
  });
});
