/**
 * Task #1109 — Java-freies Strict-Konformitäts-Gate für E-Rechnungen.
 *
 * Aufruf:  npm run validate:erechnung:strict
 *
 * Hintergrund:
 *   Das offizielle Gate (`scripts/validate-erechnung.ts`) prüft EINE
 *   Beispielrechnung mit den Java-Tools Mustang/veraPDF. Task #1105 hat einen
 *   Java-freien WASM-XSD-Validator (`validateZugferdXsd`) eingeführt, der am
 *   Seal-Punkt entscheidet, ob eine neue Rechnung als „strict" versiegelt wird
 *   (sonst → `invoice_zugferd_nonstrict_seal`-Audit). Damit dieser Strict-Pfad
 *   nicht still für neue Rechnungen regressiert (egal ob Java auf dem Runner
 *   installiert ist), prüft DIESES Gate die WASM-XSD-Strict-Validierung gegen
 *   REALE Pot-/USt-Szenarien und failt den Build bei jeder Nicht-Konformität.
 *
 * Was es macht:
 *   1. Baut für die wichtigsten Pot-/USt-Kombinationen je eine vollständige
 *      Rechnung als `InvoicePdfData` (mit `strictSettlement: true`, wie neue
 *      Rechnungen) und erzeugt die ZUGFeRD/Factur-X-XML über den Produktivpfad
 *      (`buildZugferdInvoice` → node-zugferd).
 *   2. Validiert jede XML mit `validateZugferdXsd` (xmllint-wasm, reines
 *      WebAssembly) gegen die gebündelten EN-16931-Profil-XSDs.
 *   3. Verlangt, dass JEDE Szenario-Rechnung XSD-konform ist UND der Seal-Pfad
 *      sie als strict markieren würde (`usedStrictMode === true`).
 *
 * Exit-Codes:
 *   0 = Alle Szenarien XSD-konform + strict.
 *   1 = Mindestens ein Szenario ist NICHT XSD-konform bzw. würde nur Non-Strict
 *       versiegelt (Regression).
 *   2 = Unerwarteter Fehler (Pipeline-Defekt).
 */
import { validateInvoiceXsd, DEFAULT_ZUGFERD_PROFILE } from "../server/lib/zugferd";
import type { InvoicePdfData } from "../server/lib/pdf-generator";

const LOG = "[validate-erechnung-strict]";

type Scenario = {
  name: string;
  data: InvoicePdfData;
};

/**
 * Pflegekassen-Basis-Rechnung (USt-befreit gem. § 4 Nr. 16 UStG). Einzelne
 * Felder werden pro Szenario überschrieben.
 */
function buildBaseInvoiceData(overrides: Partial<InvoicePdfData>): InvoicePdfData {
  return {
    invoiceNumber: "MUSTER-STRICT-0001",
    invoiceDate: "15.01.2026",
    invoiceDueDate: "29.01.2026",
    invoiceType: "pflegekasse_gesetzlich",
    billingYear: 2026,
    billingMonth: 1,
    companyName: "Pflegedienst Muster GmbH",
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
    netAmountCents: 12045,
    vatAmountCents: 0,
    grossAmountCents: 12045,
    vatRate: 0,
    // Neue Rechnungen werden mit korrekter Settlement-Aufschlüsselung +
    // BT-131 versiegelt; das spiegeln wir hier exakt.
    strictSettlement: true,
    includeLineTotalAmount: true,
    lineAggregation: "cumulative",
    lineItems: [
      {
        appointmentId: 101,
        appointmentDate: "2026-01-05",
        startTime: "09:00",
        endTime: "10:00",
        serviceCode: "hauswirtschaft",
        serviceDescription: "Hauswirtschaft",
        durationMinutes: 60,
        quantityRaw: 1,
        quantityUnit: "hours",
        unitPriceCents: 4500,
        totalCents: 4500,
        employeeName: "Anna Beispiel",
        appointmentNotes: null,
        serviceDetails: null,
      },
      {
        appointmentId: 102,
        appointmentDate: "2026-01-12",
        startTime: "11:00",
        endTime: "12:30",
        serviceCode: "alltagsbegleitung",
        serviceDescription: "Alltagsbegleitung",
        durationMinutes: 90,
        quantityRaw: 1.5,
        quantityUnit: "hours",
        unitPriceCents: 5030,
        totalCents: 7545,
        employeeName: "Bernd Beispiel",
        appointmentNotes: null,
        serviceDetails: null,
      },
    ],
    appointments: [],
    signatures: [],
    ...overrides,
  } as unknown as InvoicePdfData;
}

/**
 * Selbstzahler-Rechnung mit 19 % USt. Netto 100,00 € + 19,00 € USt = 119,00 €.
 */
function buildSelbstzahlerData(): InvoicePdfData {
  return buildBaseInvoiceData({
    invoiceNumber: "MUSTER-STRICT-SZ-0001",
    invoiceType: "selbstzahler",
    recipientName: "Max Mustermann",
    recipientAddress: "Musterweg 7\n10115 Berlin",
    insuranceIkNummer: "",
    versichertennummer: "",
    budgetType: undefined,
    netAmountCents: 10000,
    vatAmountCents: 1900,
    grossAmountCents: 11900,
    vatRate: 19,
    lineItems: [
      {
        appointmentId: 201,
        appointmentDate: "2026-01-08",
        startTime: "10:00",
        endTime: "12:00",
        serviceCode: "hauswirtschaft",
        serviceDescription: "Hauswirtschaft",
        durationMinutes: 120,
        quantityRaw: 2,
        quantityUnit: "hours",
        unitPriceCents: 5000,
        totalCents: 10000,
        employeeName: "Anna Beispiel",
        appointmentNotes: null,
        serviceDetails: null,
      },
    ],
  } as unknown as Partial<InvoicePdfData>);
}

function buildScenarios(): Scenario[] {
  return [
    {
      name: "§45b Entlastungsbetrag (Pflegekasse, USt-befreit)",
      data: buildBaseInvoiceData({
        invoiceNumber: "MUSTER-STRICT-45B-0001",
        budgetType: "entlastungsbetrag_45b",
      } as unknown as Partial<InvoicePdfData>),
    },
    {
      name: "§45a Umwandlungsanspruch (Pflegekasse, USt-befreit)",
      data: buildBaseInvoiceData({
        invoiceNumber: "MUSTER-STRICT-45A-0001",
        budgetType: "umwandlung_45a",
      } as unknown as Partial<InvoicePdfData>),
    },
    {
      name: "§§39/42a Verhinderungspflege (Pflegekasse, USt-befreit)",
      data: buildBaseInvoiceData({
        invoiceNumber: "MUSTER-STRICT-39-0001",
        budgetType: "ersatzpflege_39_42a",
      } as unknown as Partial<InvoicePdfData>),
    },
    {
      name: "Selbstzahler (19 % USt)",
      data: buildSelbstzahlerData(),
    },
    {
      name: "Stornorechnung (§45b, USt-befreit)",
      data: buildBaseInvoiceData({
        invoiceNumber: "MUSTER-STRICT-STORNO-0001",
        invoiceType: "stornorechnung",
        budgetType: "entlastungsbetrag_45b",
      } as unknown as Partial<InvoicePdfData>),
    },
  ];
}

async function main(): Promise<void> {
  const scenarios = buildScenarios();
  console.log(
    `${LOG} Validiere ${scenarios.length} Pot-/USt-Szenarien (Profil=${DEFAULT_ZUGFERD_PROFILE}) per WASM-XSD ...`,
  );

  const failures: string[] = [];
  for (const scenario of scenarios) {
    const result = await validateInvoiceXsd(scenario.data);
    if (!result.ok) {
      failures.push(`${scenario.name}: XSD-NICHT-konform — ${result.errors.join("; ")}`);
      console.error(`${LOG} ✗ ${scenario.name}: ${result.errors.join("; ")}`);
      continue;
    }
    if (!result.usedStrictMode) {
      failures.push(`${scenario.name}: XSD-konform, aber NICHT als strict markiert (würde Non-Strict versiegeln).`);
      console.error(`${LOG} ✗ ${scenario.name}: nicht strict (würde Non-Strict-Audit auslösen).`);
      continue;
    }
    console.log(`${LOG} ✓ ${scenario.name} (XSD-konform + strict, XML ${result.xml?.length ?? 0} Zeichen).`);
  }

  if (failures.length > 0) {
    console.error(`${LOG} FAIL: ${failures.length} Szenario(en) nicht konform:`);
    for (const f of failures) console.error(`${LOG}   - ${f}`);
    process.exit(1);
  }

  console.log(`${LOG} OK: Alle ${scenarios.length} Szenarien sind XSD-konform und strict-versiegelbar.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`${LOG} Unerwarteter Fehler:`, err);
  process.exit(2);
});
