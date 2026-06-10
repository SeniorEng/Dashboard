/**
 * Task #1108 — Standing-Test: frisch erzeugte E-Rechnungen bestehen die
 * In-Process-XSD-Strict-Validierung pro Topf-/USt-Szenario.
 *
 * Hintergrund: Task #1105 versiegelt NEUE Rechnungen im Strict-Modus und
 * verifiziert das eingebettete EN-16931-XML beim Seal mit einer
 * WebAssembly-XSD-Prüfung (`validateZugferdXsd`, kein Java nötig). Diese
 * Prüfung lief bisher AUSSCHLIESSLICH im Live-Render-Pfad — es gab keinen
 * stehenden Test, der garantiert, dass eine frisch generierte Rechnung
 * tatsächlich XSD-konform ist. Eine Regression in den node-zugferd-
 * Settlement-Schlüsseln (`paymentInstruction`/`vatBreakdown`) würde STILL auf
 * die Non-Strict-Versiegelung zurückfallen (nur ein `invoice_zugferd_nonstrict_seal`-
 * Audit-Eintrag), ohne dass irgendein Test rot wird.
 *
 * Dieser Test schließt die Lücke: für jedes abrechnungsrelevante Szenario
 *   - umsatzsteuerfreie Pflegekassen-Rechnung (0 %, § 4 Nr. 16 UStG)
 *   - Selbstzahler-Rechnung (19 %)
 *   - Storno (TypeCode 384)
 * wird über den ECHTEN Renderer (`generateZugferdXml`, strict-Settlement) das
 * XML erzeugt und gegen die gebündelten EN-16931-XSDs validiert
 * (`validateZugferdXsd`). Ist die Versiegelung kaputt, schlägt der Test fehl,
 * bevor eine fehlerhafte E-Rechnung an die Kasse rausgeht.
 *
 * Zusätzlich (Byte-Stabilität für Bestands-Rechnungen): der Legacy-Pfad OHNE
 * `strictSettlement` darf KEINE USt-Aufschlüsselung im Settlement-Header
 * (`ApplicableTradeTax` in `ApplicableHeaderTradeSettlement`, BG-23) emittieren —
 * das alte, von node-zugferd verworfene Format bleibt unverändert, damit das in
 * `invoices.zugferd_xml` versiegelte Original byte-genau reproduzierbar bleibt.
 *
 * Reiner Logik-Test: kein DB-/Server-Setup, rendert direkt über
 * `generateZugferdXml` und validiert in-process via xmllint-wasm.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { generateZugferdXml, validateZugferdXsd } from "../../server/lib/zugferd";
import type { InvoicePdfData } from "../../server/lib/pdf-generator";

interface LineItemSpec {
  serviceCode: string;
  serviceDescription: string;
  quantityRaw: number;
  quantityUnit: string;
  unitPriceCents: number;
  totalCents: number;
}

function lineItem(spec: LineItemSpec) {
  return {
    appointmentId: 101,
    appointmentDate: "2026-01-05",
    startTime: "09:00",
    endTime: "10:00",
    serviceCode: spec.serviceCode,
    serviceDescription: spec.serviceDescription,
    durationMinutes: 60,
    quantityRaw: spec.quantityRaw,
    quantityUnit: spec.quantityUnit,
    unitPriceCents: spec.unitPriceCents,
    totalCents: spec.totalCents,
    employeeName: "Anna Beispiel",
    appointmentNotes: null,
    serviceDetails: null,
  };
}

function buildPdfData(overrides: Partial<InvoicePdfData> = {}): InvoicePdfData {
  return {
    invoiceNumber: "RE-2026-0108",
    invoiceDate: "15.01.2026",
    invoiceDueDate: "29.01.2026",
    invoiceType: "rechnung",
    billingYear: 2026,
    billingMonth: 1,
    companyName: "Pflegedienst Test",
    companyAddress: "Musterstraße 1\n10115 Berlin",
    iban: "DE89370400440532013000",
    bic: "COBADEFFXXX",
    ikNummer: "123456789",
    ustId: "",
    steuernummer: "",
    insuranceIkNummer: "987654321",
    versichertennummer: "A123456789",
    recipientName: "AOK Nordost",
    recipientAddress: "Wilhelmstraße 1\n10963 Berlin",
    customerName: "Max Mustermann",
    customerGeburtsdatum: "1940-03-15",
    pflegegrad: 3,
    buyerReference: null,
    assignmentDeclarationDate: null,
    assignmentDeclarationRef: null,
    netAmountCents: 4500,
    vatAmountCents: 0,
    grossAmountCents: 4500,
    vatRate: 0,
    // Neue Rechnungen werden kumuliert gerendert und mit der korrekten
    // Settlement-Aufschlüsselung (BT-131 + Header-USt) versiegelt.
    lineAggregation: "cumulative",
    includeLineTotalAmount: true,
    strictSettlement: true,
    lineItems: [
      lineItem({
        serviceCode: "hauswirtschaft",
        serviceDescription: "Hauswirtschaft",
        quantityRaw: 1,
        quantityUnit: "hours",
        unitPriceCents: 4500,
        totalCents: 4500,
      }),
    ],
    appointments: [],
    signatures: [],
    ...overrides,
  } as unknown as InvoicePdfData;
}

// Szenarien, die die Versiegelung pro Topf/USt-Satz abdecken müssen.
// `expectedNote` (optional): erwartete BT-22-§-Note der Pot-Rechnung
// (Variant C, `server/lib/zugferd.ts` budgetType → IncludedNote). Selbstzahler-
// und Storno-Szenarien tragen keine topf-spezifische §-Note.
const SCENARIOS: { name: string; data: InvoicePdfData; expectedNote?: string }[] = [
  {
    name: "umsatzsteuerfreie Pflegekassen-Rechnung §45b (0 %, § 4 Nr. 16 UStG)",
    expectedNote: "§ 45b SGB XI — Entlastungsbetrag",
    data: buildPdfData({
      invoiceType: "pflegekasse_gesetzlich",
      budgetType: "entlastungsbetrag_45b",
      netAmountCents: 13100,
      vatAmountCents: 0,
      grossAmountCents: 13100,
      vatRate: 0,
      lineItems: [
        lineItem({
          serviceCode: "alltagsbegleitung",
          serviceDescription: "Alltagsbegleitung",
          quantityRaw: 2,
          quantityUnit: "hours",
          unitPriceCents: 6550,
          totalCents: 13100,
        }),
      ],
    } as Partial<InvoicePdfData>),
  },
  {
    name: "umsatzsteuerfreie Pflegekassen-Rechnung §45a Umwandlungsanspruch (0 %)",
    expectedNote: "§ 45a SGB XI — Umwandlungsanspruch",
    data: buildPdfData({
      invoiceType: "pflegekasse_gesetzlich",
      budgetType: "umwandlung_45a",
      invoiceNumber: "RE-2026-0108-45A",
      netAmountCents: 8000,
      vatAmountCents: 0,
      grossAmountCents: 8000,
      vatRate: 0,
      lineItems: [
        lineItem({
          serviceCode: "alltagsbegleitung",
          serviceDescription: "Alltagsbegleitung",
          quantityRaw: 2,
          quantityUnit: "hours",
          unitPriceCents: 4000,
          totalCents: 8000,
        }),
      ],
    } as Partial<InvoicePdfData>),
  },
  {
    name: "umsatzsteuerfreie Pflegekassen-Rechnung §§39/42a Verhinderungspflege (0 %)",
    expectedNote: "§§ 39 / 42a SGB XI — Verhinderungspflege",
    data: buildPdfData({
      invoiceType: "pflegekasse_gesetzlich",
      budgetType: "ersatzpflege_39_42a",
      invoiceNumber: "RE-2026-0108-39",
      netAmountCents: 12000,
      vatAmountCents: 0,
      grossAmountCents: 12000,
      vatRate: 0,
      lineItems: [
        lineItem({
          serviceCode: "verhinderungspflege",
          serviceDescription: "Verhinderungspflege",
          quantityRaw: 3,
          quantityUnit: "hours",
          unitPriceCents: 4000,
          totalCents: 12000,
        }),
      ],
    } as Partial<InvoicePdfData>),
  },
  {
    name: "Selbstzahler-Rechnung (19 %)",
    data: buildPdfData({
      invoiceType: "rechnung",
      recipientName: "Max Mustermann",
      recipientAddress: "Musterweg 5\n10115 Berlin",
      netAmountCents: 10000,
      vatAmountCents: 1900,
      grossAmountCents: 11900,
      vatRate: 19,
      lineItems: [
        lineItem({
          serviceCode: "hauswirtschaft",
          serviceDescription: "Hauswirtschaft",
          quantityRaw: 2,
          quantityUnit: "hours",
          unitPriceCents: 5000,
          totalCents: 10000,
        }),
      ],
    } as Partial<InvoicePdfData>),
  },
  {
    name: "Storno (TypeCode 384)",
    data: buildPdfData({
      invoiceType: "stornorechnung",
      invoiceNumber: "RE-2026-0108-S",
      netAmountCents: -4500,
      vatAmountCents: 0,
      grossAmountCents: -4500,
      vatRate: 0,
      lineItems: [
        lineItem({
          serviceCode: "hauswirtschaft",
          serviceDescription: "Hauswirtschaft",
          quantityRaw: 1,
          quantityUnit: "hours",
          unitPriceCents: -4500,
          totalCents: -4500,
        }),
      ],
    } as Partial<InvoicePdfData>),
  },
];

/**
 * Extrahiert den Settlement-Header-Block (`ApplicableHeaderTradeSettlement`),
 * in dem die USt-Aufschlüsselung (BG-23, `ApplicableTradeTax`) bei neuen
 * Rechnungen sitzt. Positions-USt (`SpecifiedLineTradeSettlement`) liegt
 * außerhalb dieses Blocks und stört die Header-Prüfung daher nicht.
 */
function settlementHeaderBlock(xml: string): string {
  const m = xml.match(
    /<ram:ApplicableHeaderTradeSettlement>([\s\S]*?)<\/ram:ApplicableHeaderTradeSettlement>/,
  );
  return m ? m[1] : "";
}

describe("Task #1108 — frische E-Rechnungen bestehen die XSD-Strict-Versiegelung", () => {
  let en16931Profile: unknown;

  beforeAll(async () => {
    // Dasselbe Profil-Objekt, das `buildZugferdInvoice` für die Seal-Zeit-
    // Validierung lädt (DEFAULT_ZUGFERD_PROFILE = en16931).
    const m: Record<string, unknown> = await import("node-zugferd/profile/en16931");
    en16931Profile = m.EN16931;
  });

  for (const scenario of SCENARIOS) {
    it(`erzeugt XSD-valides EN-16931-XML: ${scenario.name}`, async () => {
      const xml = await generateZugferdXml(scenario.data);
      expect(xml).not.toBeNull();

      const result = await validateZugferdXsd(xml as string, en16931Profile);
      // `validateZugferdXsd` liefert bei Fehlern die XSD-Meldungen mit; bei
      // Failure landen sie in der Assertion-Message statt nur „false".
      if (!result.ok) {
        throw new Error(
          `XSD-Strict-Validierung fehlgeschlagen für „${scenario.name}":\n` +
            result.errors.join("\n"),
        );
      }
      expect(result.ok).toBe(true);

      // Strict-Versiegelung MUSS die USt-Aufschlüsselung im Settlement-Header
      // (BG-23) emittieren — sonst hätte node-zugferd nur das alte, verworfene
      // Format erzeugt und die Validierung wäre trivial.
      expect(settlementHeaderBlock(xml as string)).toContain("<ram:ApplicableTradeTax>");

      // Variant C: Pot-Rechnungen tragen die topf-spezifische BT-22-§-Note
      // (IncludedNote/BG-1, subjectCode REG). Eine Regression im
      // budgetType → IncludedNote-Mapping (`server/lib/zugferd.ts`) würde die
      // §-Zuordnung der §45a-/§§39/42a-Folgerechnungen still verlieren.
      if (scenario.expectedNote) {
        const noteBlock = xml as string;
        expect(noteBlock).toContain(scenario.expectedNote);
        expect(noteBlock).toMatch(
          /<ram:IncludedNote>[\s\S]*?<ram:SubjectCode>REG<\/ram:SubjectCode>[\s\S]*?<\/ram:IncludedNote>/,
        );
      }
    });
  }

  it("Legacy-Pfad (ohne strictSettlement) emittiert KEINE Header-USt-Aufschlüsselung (Byte-Stabilität)", async () => {
    // Bestands-Rechnungen ohne `strictSettlement` müssen byte-genau das
    // FRÜHERE (unvollständige) XML reproduzieren — node-zugferd verwirft den
    // alten `paymentMeans`/`tradeTax`-Header still, es darf also KEINE
    // `ApplicableTradeTax` im Settlement-Header stehen. Würde hier die
    // Header-USt auftauchen, driftete das Re-Render gegen den versiegelten
    // GoBD-Integritätshash.
    const legacyXml = await generateZugferdXml(
      buildPdfData({
        strictSettlement: false,
        // Legacy-Bestände wurden pro Termin und ohne BT-131 versiegelt.
        lineAggregation: "per_appointment",
        includeLineTotalAmount: false,
      } as Partial<InvoicePdfData>),
    );
    expect(legacyXml).not.toBeNull();
    expect(settlementHeaderBlock(legacyXml as string)).not.toContain(
      "<ram:ApplicableTradeTax>",
    );

    // Negative Kontrolle: der Strict-Pfad mit denselben Beträgen MUSS die
    // Header-USt-Aufschlüsselung enthalten — beweist, dass der Marker oben
    // nicht generell fehlt, sondern gezielt am `strictSettlement`-Schalter hängt.
    const strictXml = await generateZugferdXml(buildPdfData({ strictSettlement: true }));
    expect(strictXml).not.toBeNull();
    expect(settlementHeaderBlock(strictXml as string)).toContain(
      "<ram:ApplicableTradeTax>",
    );
  });
});
