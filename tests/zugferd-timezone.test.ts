import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateZugferdXml } from "../server/lib/zugferd";
import type { InvoicePdfData } from "../server/lib/pdf-generator";

const ORIGINAL_TZ = process.env.TZ;

beforeAll(() => {
  // Server simuliert eine TZ westlich von UTC. Ohne den K5-Fix würde
  // `new Date("2025-01-31")` als 2025-01-30 19:00 EST interpretiert,
  // wodurch das Rechnungsdatum in der ZUGFeRD-XML auf den 30. Januar
  // verrutscht.
  process.env.TZ = "America/New_York";
});

afterAll(() => {
  if (ORIGINAL_TZ === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = ORIGINAL_TZ;
  }
});

function buildPdfData(invoiceDate: string): InvoicePdfData {
  return {
    invoiceNumber: "RE-TZ-2025-0001",
    invoiceDate,
    invoiceType: "selbstzahler",
    billingYear: 2025,
    billingMonth: 1,
    companyName: "Pflegedienst TZ",
    companyAddress: "Musterstraße 1\n10115 Berlin",
    iban: "DE89370400440532013000",
    bic: "COBADEFFXXX",
    ikNummer: "",
    ustId: "",
    steuernummer: "",
    insuranceIkNummer: "",
    versichertennummer: "",
    recipientName: "Max Mustermann",
    recipientAddress: "Hauptstraße 5\n10117 Berlin",
    customerName: "Max Mustermann",
    netAmountCents: 5000,
    vatAmountCents: 950,
    grossAmountCents: 5950,
    vatRate: 19,
    lineItems: [
      {
        serviceCode: "HW",
        serviceDescription: "Hauswirtschaft",
        durationMinutes: 60,
        unitPriceCents: 5000,
        totalCents: 5000,
      },
    ],
    appointments: [],
    signatures: [],
  } as unknown as InvoicePdfData;
}

describe("K5 — ZUGFeRD bleibt bei abweichender Server-TZ deterministisch", () => {
  it("TZ-1 — TZ-Override wirkt im Test (Sanity-Check)", () => {
    // Ohne diesen Sanity-Check wäre der eigentliche Test wertlos: in
    // Node bleibt eine zur Laufzeit gesetzte TZ nicht immer aktiv.
    // Wenn dieser Check fehlschlägt, ist der gesamte TZ-Test ungültig
    // und muss in einem separaten Prozess mit TZ=… ausgeführt werden.
    const offsetMinutes = new Date("2025-01-31T12:00:00Z").getTimezoneOffset();
    expect(offsetMinutes).toBe(300); // EST = UTC-5
  });

  it("TZ-2 — Rechnungsdatum „2025-01-31\" bleibt der 31. Januar in der XML", async () => {
    const xml = await generateZugferdXml(buildPdfData("2025-01-31"));
    expect(xml).not.toBeNull();
    // ZUGFeRD-XML enthält das Datum als YYYYMMDD im Format-102-Element.
    expect(xml).toContain("20250131");
    expect(xml).not.toContain("20250130");
  });

  it("TZ-3 — Deutsches Datumsformat „31.01.2025\" wird identisch behandelt", async () => {
    const xml = await generateZugferdXml(buildPdfData("31.01.2025"));
    expect(xml).not.toBeNull();
    expect(xml).toContain("20250131");
    expect(xml).not.toContain("20250130");
  });

  it("TZ-4 — Monatsanfang „2025-02-01\" verrutscht nicht in den Vormonat", async () => {
    const data = buildPdfData("2025-02-01");
    data.billingMonth = 2;
    const xml = await generateZugferdXml(data);
    expect(xml).not.toBeNull();
    expect(xml).toContain("20250201");
    expect(xml).not.toContain("20250131");
  });
});
