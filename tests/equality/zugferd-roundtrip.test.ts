/**
 * Task #773 — Property-Based Drift-Detektor: ZUGFeRD-XML Round-Trip.
 *
 * Ergänzt die beispielbasierten ZUGFeRD-Tests
 * (`tests/equality/zugferd-xml-rerender.test.ts`) um einen Property-Test:
 * für ZUFÄLLIGE Rechnungs-Eingaben gilt nach
 *   Render (`generateZugferdXml`) → Parse (XML) → Vergleich
 * dass alle abrechnungsrelevanten Felder bit-genau wieder im XML auftauchen:
 *   - Rechnungsnummer, TypeCode (380 Rechnung / 384 Storno), Ausstellungsdatum
 *   - Empfänger (BuyerTradeParty.Name) und Absender (SellerTradeParty.Name)
 *   - pro Position: Stückpreis (ChargeAmount), Menge + Einheit
 *     (BilledQuantity/unitCode KMT|HUR), Steuerkategorie + -satz
 *   - Summen (LineTotal/TaxBasis/TaxTotal/GrandTotal/DuePayable)
 *   - BT-22-Note (§-Paragraf) bei Multi-Pot-Rechnungen (Task #759)
 *
 * Der Test mockt nichts — er rendert über den echten Renderer und parst das
 * tatsächlich erzeugte XML zurück. So fängt er Drift zwischen „was reingeht"
 * und „was die Pflegekasse maschinell ausliest" ab.
 *
 * Nutzt den globalen fast-check-Setup (seed: 42, numRuns: 100 aus
 * `tests/setup.ts`).
 */
import { describe, expect, it, beforeAll } from "vitest";
import fc from "fast-check";
import { generateZugferdXml } from "../../server/lib/zugferd";
import { centsToEuroNumber } from "@shared/utils/money";
import type { InvoicePdfData } from "../../server/lib/pdf-generator";

// ---------------------------------------------------------------------------
// Minimaler, abhängigkeitsfreier Parser für das node-zugferd BASIC-Profil.
// Wir extrahieren gezielt die abrechnungsrelevanten Felder; die Generatoren
// erzeugen ausschließlich XML-sichere Strings (keine Entities), damit der
// Vergleich byte-genau bleibt.
// ---------------------------------------------------------------------------

function block(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<(?:rsm|ram):${tag}>([\\s\\S]*?)</(?:rsm|ram):${tag}>`));
  return m ? m[1] : null;
}

function firstText(scope: string, tag: string): string | null {
  const m = scope.match(new RegExp(`<ram:${tag}>([^<]*)</ram:${tag}>`));
  return m ? m[1] : null;
}

interface ParsedLine {
  name: string | null;
  chargeAmount: string | null;
  quantity: string | null;
  unitCode: string | null;
  categoryCode: string | null;
  ratePercent: string | null;
}

interface ParsedXml {
  invoiceNumber: string | null;
  typeCode: string | null;
  issueDate: string | null;
  sellerName: string | null;
  buyerName: string | null;
  lines: ParsedLine[];
  monetary: {
    lineTotal: string | null;
    taxBasis: string | null;
    taxTotal: string | null;
    grandTotal: string | null;
    duePayable: string | null;
  };
  notes: string[];
}

function parseZugferd(xml: string): ParsedXml {
  const exchangedDoc = block(xml, "ExchangedDocument") ?? "";
  const issueMatch = exchangedDoc.match(/format="102">(\d{8})</);

  const lineBlocks = xml
    .split("<ram:IncludedSupplyChainTradeLineItem>")
    .slice(1)
    .map((part) => part.split("</ram:IncludedSupplyChainTradeLineItem>")[0]);

  const lines: ParsedLine[] = lineBlocks.map((lb) => {
    const product = block(lb, "SpecifiedTradeProduct") ?? "";
    const qtyMatch = lb.match(/<ram:BilledQuantity unitCode="([^"]*)">([^<]*)<\/ram:BilledQuantity>/);
    return {
      name: firstText(product, "Name"),
      chargeAmount: firstText(lb, "ChargeAmount"),
      quantity: qtyMatch ? qtyMatch[2] : null,
      unitCode: qtyMatch ? qtyMatch[1] : null,
      categoryCode: firstText(lb, "CategoryCode"),
      ratePercent: firstText(lb, "RateApplicablePercent"),
    };
  });

  const seller = block(xml, "SellerTradeParty") ?? "";
  const buyer = block(xml, "BuyerTradeParty") ?? "";
  const monetary = block(xml, "SpecifiedTradeSettlementHeaderMonetarySummation") ?? "";
  const taxTotalMatch = monetary.match(/<ram:TaxTotalAmount[^>]*>([^<]*)<\/ram:TaxTotalAmount>/);

  const notes = Array.from(
    exchangedDoc.matchAll(/<ram:Content>([^<]*)<\/ram:Content>/g),
  ).map((m) => m[1]);

  return {
    invoiceNumber: firstText(exchangedDoc, "ID"),
    typeCode: firstText(exchangedDoc, "TypeCode"),
    issueDate: issueMatch ? issueMatch[1] : null,
    sellerName: firstText(seller, "Name"),
    buyerName: firstText(buyer, "Name"),
    lines,
    monetary: {
      lineTotal: firstText(monetary, "LineTotalAmount"),
      taxBasis: firstText(monetary, "TaxBasisTotalAmount"),
      taxTotal: taxTotalMatch ? taxTotalMatch[1] : null,
      grandTotal: firstText(monetary, "GrandTotalAmount"),
      duePayable: firstText(monetary, "DuePayableAmount"),
    },
    notes,
  };
}

function decimal(cents: number): string {
  return centsToEuroNumber(cents).toFixed(2);
}

const BT22_NOTE: Record<string, string> = {
  entlastungsbetrag_45b: "§ 45b SGB XI — Entlastungsbetrag",
  umwandlung_45a: "§ 45a SGB XI — Umwandlungsanspruch",
  ersatzpflege_39_42a: "§§ 39 / 42a SGB XI — Verhinderungspflege",
};

// XML-sichere Tokens (keine Entities, kein führendes/abschließendes Whitespace).
const TOKENS = [
  "Alpha", "Beta", "Gamma", "Pflege", "Dienst", "AOK", "Nord", "Haus",
  "GmbH", "Service", "Mobil", "123", "Care", "Connect",
];
const safeName = fc
  .array(fc.constantFrom(...TOKENS), { minLength: 1, maxLength: 3 })
  .map((a) => a.join(" "));

const KM_CODES = ["travel_km", "customer_km"];
const lineItemArb = fc.record({
  serviceCode: fc.constantFrom(
    "hauswirtschaft",
    "alltagsbegleitung",
    "travel_km",
    "customer_km",
    "erstberatung",
  ),
  serviceDescription: safeName,
  quantityRaw: fc.integer({ min: 1, max: 5000 }).map((n) => n / 100), // 0.01–50.00
  unitPriceCents: fc.integer({ min: 1, max: 20_000 }),
  totalCents: fc.integer({ min: 1, max: 100_000 }),
});

const invoiceArb = fc.record({
  invoiceNumber: fc
    .integer({ min: 1, max: 9999 })
    .map((n) => `RE-2026-${String(n).padStart(4, "0")}`),
  date: fc.record({
    y: fc.integer({ min: 2024, max: 2027 }),
    m: fc.integer({ min: 1, max: 12 }),
    d: fc.integer({ min: 1, max: 28 }),
  }),
  invoiceType: fc.constantFrom("rechnung", "stornorechnung"),
  budgetType: fc.constantFrom(
    undefined,
    "entlastungsbetrag_45b",
    "umwandlung_45a",
    "ersatzpflege_39_42a",
  ),
  vatBasisPoints: fc.constantFrom(0, 700, 1900),
  companyName: safeName,
  recipientName: safeName,
  lineItems: fc.array(lineItemArb, { minLength: 1, maxLength: 6 }),
});

type InvoiceArb = typeof invoiceArb extends fc.Arbitrary<infer T> ? T : never;

function buildPdfData(spec: InvoiceArb): InvoicePdfData {
  const dd = String(spec.date.d).padStart(2, "0");
  const mm = String(spec.date.m).padStart(2, "0");
  const yyyy = String(spec.date.y);
  const invoiceDate = `${dd}.${mm}.${yyyy}`;

  const netAmountCents = spec.lineItems.reduce((s, li) => s + li.totalCents, 0);
  const vatAmountCents =
    spec.vatBasisPoints === 0
      ? 0
      : Math.round((netAmountCents * spec.vatBasisPoints) / 10_000);
  const grossAmountCents = netAmountCents + vatAmountCents;

  return {
    invoiceNumber: spec.invoiceNumber,
    invoiceDate,
    invoiceDueDate: invoiceDate,
    invoiceType: spec.invoiceType,
    budgetType: spec.budgetType,
    billingYear: spec.date.y,
    billingMonth: spec.date.m,
    companyName: spec.companyName,
    companyAddress: "Musterstraße 1\n10115 Berlin",
    iban: "DE89370400440532013000",
    bic: "COBADEFFXXX",
    ikNummer: "123456789",
    ustId: "",
    steuernummer: "",
    insuranceIkNummer: "987654321",
    versichertennummer: "",
    recipientName: spec.recipientName,
    recipientAddress: "Wilhelmstraße 1\n10963 Berlin",
    customerName: "",
    customerGeburtsdatum: null,
    pflegegrad: null,
    buyerReference: "REF-1",
    assignmentDeclarationDate: null,
    assignmentDeclarationRef: null,
    netAmountCents,
    vatAmountCents,
    grossAmountCents,
    vatRate: spec.vatBasisPoints,
    // Task #1083: dieser Property-Roundtrip prüft die pro-Termin-XML-Form
    // (eine Zeile je Spec-Item). Aggregation wird separat unit-getestet.
    lineAggregation: "per_appointment",
    lineItems: spec.lineItems.map((li, idx) => ({
      appointmentId: idx + 1,
      appointmentDate: "2026-01-05",
      startTime: "09:00",
      endTime: "10:00",
      serviceCode: li.serviceCode,
      serviceDescription: li.serviceDescription,
      durationMinutes: 60,
      quantityRaw: li.quantityRaw,
      quantityUnit: KM_CODES.includes(li.serviceCode) ? "km" : "hours",
      unitPriceCents: li.unitPriceCents,
      totalCents: li.totalCents,
      employeeName: "Mitarbeiter",
      appointmentNotes: null,
      serviceDetails: null,
    })),
    appointments: [],
    signatures: [],
  } as unknown as InvoicePdfData;
}

describe("Task #773 — ZUGFeRD-XML Round-Trip (Property-Based)", () => {
  beforeAll(async () => {
    // node-zugferd Lazy-Load einmal vorwärmen, damit der erste Property-Lauf
    // nicht die Modul-Ladezeit mitzählt.
    await generateZugferdXml(buildPdfData({
      invoiceNumber: "RE-2026-0001",
      date: { y: 2026, m: 1, d: 1 },
      invoiceType: "rechnung",
      budgetType: undefined,
      vatBasisPoints: 0,
      companyName: "Pflege",
      recipientName: "AOK",
      lineItems: [{ serviceCode: "hauswirtschaft", serviceDescription: "Haus", quantityRaw: 1, unitPriceCents: 4500, totalCents: 4500 }],
    }));
  });

  it("property: alle Eingabe-Felder finden sich bit-genau im geparsten XML wieder", async () => {
    await fc.assert(
      fc.asyncProperty(invoiceArb, async (spec) => {
        const data = buildPdfData(spec);
        const xml = await generateZugferdXml(data);
        expect(xml).not.toBeNull();
        const parsed = parseZugferd(xml as string);

        // Kopf
        expect(parsed.invoiceNumber).toBe(data.invoiceNumber);
        expect(parsed.typeCode).toBe(
          spec.invoiceType === "stornorechnung" ? "384" : "380",
        );
        const dd = String(spec.date.d).padStart(2, "0");
        const mm = String(spec.date.m).padStart(2, "0");
        expect(parsed.issueDate).toBe(`${spec.date.y}${mm}${dd}`);

        // Empfänger / Absender
        expect(parsed.sellerName).toBe(spec.companyName);
        expect(parsed.buyerName).toBe(spec.recipientName);

        // Positionen
        expect(parsed.lines).toHaveLength(spec.lineItems.length);
        const expectedCategory = data.vatAmountCents === 0 ? "E" : "S";
        const expectedRate = data.vatAmountCents === 0 ? 0 : spec.vatBasisPoints / 100;
        spec.lineItems.forEach((li, idx) => {
          const pl = parsed.lines[idx];
          expect(pl.name).toBe(li.serviceDescription);
          expect(pl.chargeAmount).toBe(decimal(li.unitPriceCents));
          expect(Number(pl.quantity)).toBe(li.quantityRaw);
          expect(pl.unitCode).toBe(
            KM_CODES.includes(li.serviceCode) ? "KMT" : "HUR",
          );
          expect(pl.categoryCode).toBe(expectedCategory);
          expect(Number(pl.ratePercent)).toBe(expectedRate);
        });

        // Summen (Beträge bit-genau)
        expect(parsed.monetary.lineTotal).toBe(decimal(data.netAmountCents));
        expect(parsed.monetary.taxBasis).toBe(decimal(data.netAmountCents));
        expect(parsed.monetary.taxTotal).toBe(decimal(data.vatAmountCents));
        expect(parsed.monetary.grandTotal).toBe(decimal(data.grossAmountCents));
        expect(parsed.monetary.duePayable).toBe(decimal(data.grossAmountCents));

        // BT-22-Note bei Multi-Pot-Rechnungen
        if (spec.budgetType) {
          expect(parsed.notes).toContain(BT22_NOTE[spec.budgetType]);
        } else {
          for (const note of Object.values(BT22_NOTE)) {
            expect(parsed.notes).not.toContain(note);
          }
        }
      }),
    );
  });
});
