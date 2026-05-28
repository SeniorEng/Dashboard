/**
 * Task #749 — Drift-Guard "Leistungsnachweis-Unterschrift nicht leer".
 *
 * RE-2026-0010 (Unterschütz, Karla — April 2026) zeigte den klassischen
 * Drift-Pfad: die DB-Spalte `customerSignatureData` war zwar gesetzt und
 * passierte den `isValidDataUrl`-Regex-Filter, lieferte aber im PDF ein
 * leeres `<img>` (transparenter Canvas). Der Renderer kombinierte das
 * dann mit dem signed-Label „<Datum>, <Name>" — Ergebnis: ein
 * leistungsnachweis-PDF mit Signatur-Text aber unsichtbarer Unterschrift.
 *
 * Diese Suite sichert drei unabhängige Guards ab:
 *   1. `analyzeSignatureImage` lehnt leere PNG-Canvas ab und akzeptiert
 *      Signaturen mit Tinte.
 *   2. Der LN-Renderer `generateLeistungsnachweisHtml` fällt bei einer
 *      leeren Signatur auf den "noch nicht unterschrieben"-Branch zurück
 *      (Text statt `<img>`) und gibt NIE die „signed text + empty img"-
 *      Kombination aus.
 *   3. Eine gültige Signatur wird als `<img src="data:image/png;...">`
 *      gerendert, zusammen mit dem signed-Label.
 */

import { describe, it, expect } from "vitest";
import zlib from "node:zlib";
import {
  analyzeSignatureImage,
  isSignatureImageMeaningful,
} from "../../server/lib/signature-validation";
import {
  generateLeistungsnachweisHtml,
  type InvoicePdfData,
} from "../../server/lib/pdf-generator";

function buildPng(width: number, height: number, fillAlpha: boolean): string {
  const bpp = 4;
  const rowSize = 1 + width * bpp;
  const raw = Buffer.alloc(rowSize * height);
  if (fillAlpha) {
    for (let y = 0; y < height; y++) {
      const off = y * rowSize;
      raw[off] = 0;
      for (let x = 0; x < width; x++) {
        const p = off + 1 + x * bpp;
        raw[p + 3] = 255;
      }
    }
  }
  const idat = zlib.deflateSync(raw);
  function chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(0, 0);
    return Buffer.concat([len, Buffer.from(type, "ascii"), data, crc]);
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

const EMPTY_SIG = buildPng(600, 200, false);
const REAL_SIG = buildPng(600, 200, true);
const TINY_SIG = buildPng(20, 10, true);

function baseLnData(): InvoicePdfData {
  return {
    companyName: "Pflegedienst Test",
    companyAddress: "Teststr. 1, 12345 Berlin",
    companyPhone: "030/000",
    companyEmail: "info@test.de",
    companyWebsite: null,
    steuernummer: null,
    ustIdNr: null,
    iban: null,
    bic: null,
    bankName: null,
    invoiceNumber: "RE-2026-TEST",
    invoiceDate: "2026-05-08",
    billingMonth: 4,
    billingYear: 2026,
    recipientName: "Unterschütz, Karla",
    recipientAddress: null,
    customerName: "Unterschütz, Karla",
    insuranceProviderName: null,
    insuranceIkNummer: null,
    versichertennummer: null,
    pflegegrad: null,
    lineItems: [{
      appointmentId: 1,
      appointmentDate: "2026-04-15",
      serviceDescription: "Pflegerische Tätigkeit",
      serviceCode: "care",
      startTime: "10:00:00",
      endTime: "11:00:00",
      durationMinutes: 60,
      quantityRaw: null,
      quantityUnit: null,
      unitPriceCents: 4000,
      totalCents: 4000,
      employeeName: "Erna Helfer",
      appointmentNotes: null,
      serviceDetails: null,
    }],
    subtotalCents: 4000,
    vatRate: 0,
    vatCents: 0,
    totalCents: 4000,
    billingType: "pflegekasse_privat",
    notes: null,
    dueDate: null,
  } as unknown as InvoicePdfData;
}

describe("signature meaningful-pixel validator", () => {
  it("rejects fully transparent canvas (RE-2026-0010 repro)", () => {
    const result = analyzeSignatureImage(EMPTY_SIG);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("empty_canvas");
  });

  it("accepts a PNG with actual ink (alpha > 0)", () => {
    const result = analyzeSignatureImage(REAL_SIG);
    expect(result.ok).toBe(true);
  });

  it("rejects PNGs smaller than the minimum signature pad", () => {
    const result = analyzeSignatureImage(TINY_SIG);
    expect(result.ok).toBe(false);
  });

  it("rejects malformed data URLs", () => {
    expect(analyzeSignatureImage("not-a-data-url").ok).toBe(false);
    expect(analyzeSignatureImage("").ok).toBe(false);
    expect(analyzeSignatureImage("data:image/png;base64,").ok).toBe(false);
  });

  it("rejects PNG with valid chunks but corrupted (un-inflatable) IDAT", () => {
    // Take a valid PNG, then surgically corrupt the IDAT payload so
    // zlib.inflateSync wirft — early-return-Pfad in analyzeSignatureImage.
    // Vor dem Hardening hätte dieser Pfad fälschlich ok:true geliefert
    // (RE-2026-0010-Klasse: nicht-renderbares PNG → "signed text + empty img").
    const goodB64 = REAL_SIG.replace(/^data:image\/png;base64,/, "");
    const buf = Buffer.from(goodB64, "base64");
    // Finde IDAT-Chunk und überschreibe die ersten 8 Bytes seines Datenbereichs
    // mit Müll, der kein gültiger zlib-Stream ist.
    const idatTagOff = buf.indexOf(Buffer.from("IDAT", "ascii"));
    expect(idatTagOff).toBeGreaterThan(0);
    const dataStart = idatTagOff + 4;
    for (let i = 0; i < 8; i++) buf[dataStart + i] = 0xff;
    const corrupted = `data:image/png;base64,${buf.toString("base64")}`;
    const r = analyzeSignatureImage(corrupted);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("decode_failed");
    expect(isSignatureImageMeaningful(corrupted)).toBe(false);
  });

  it("isSignatureImageMeaningful matches analyzeSignatureImage.ok", () => {
    expect(isSignatureImageMeaningful(EMPTY_SIG)).toBe(false);
    expect(isSignatureImageMeaningful(REAL_SIG)).toBe(true);
    expect(isSignatureImageMeaningful(null)).toBe(false);
  });
});

describe("Leistungsnachweis renderer hardening", () => {
  it("falls back to unsigned-text branch when stored signature is empty", () => {
    const data = baseLnData();
    data.signatures = [{
      appointmentIds: [1],
      customerName: "Unterschütz, Karla",
      employeeName: "Erna Helfer",
      customerSignatureData: EMPTY_SIG,
      employeeSignatureData: EMPTY_SIG,
      customerSignedAt: "08.05.2026",
      employeeSignedAt: "08.05.2026",
    } as unknown as NonNullable<InvoicePdfData["signatures"]>[0]];

    const html = generateLeistungsnachweisHtml(data);

    // Hartes Verbot des RE-2026-0010-Drift-Pfads: weder ein <img>-Tag
    // mit data:image-Source noch der signed-Label-Branch dürfen
    // gerendert werden, wenn die Signatur leer ist.
    expect(html).not.toMatch(/<img[^>]*class="signature-img"/);
    expect(html).not.toContain(EMPTY_SIG);
    // Der signed-Customer-Label ("(Leistungsempfänger/in)" ohne "oder
    // gesetzl. Vertreter/in") darf nicht auftauchen — das war genau die
    // Drift-Zeile aus RE-2026-0010.
    expect(html).not.toMatch(/\(Leistungsempfänger\/in\)\s*<\/span>/);
    // Stattdessen muss der "noch nicht unterschrieben"-Platzhalter da sein.
    expect(html).toContain("(Leistungsempfänger/in oder gesetzl. Vertreter/in)");
  });

  it("renders <img> + signed-label when signature has ink", () => {
    const data = baseLnData();
    data.signatures = [{
      appointmentIds: [1],
      customerName: "Unterschütz, Karla",
      employeeName: "Erna Helfer",
      customerSignatureData: REAL_SIG,
      employeeSignatureData: REAL_SIG,
      customerSignedAt: "08.05.2026",
      employeeSignedAt: "08.05.2026",
    } as unknown as NonNullable<InvoicePdfData["signatures"]>[0]];

    const html = generateLeistungsnachweisHtml(data);
    expect(html).toMatch(/<img[^>]*class="signature-img"/);
    expect(html).toContain(REAL_SIG.slice(0, 40));
  });
});
