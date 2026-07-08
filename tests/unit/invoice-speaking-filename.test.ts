import { describe, it, expect } from "vitest";
import {
  buildSpeakingInvoiceFilename,
  buildSpeakingKassenBundleFilename,
  sanitizeSpeakingSegment,
  sanitizeExportSegment,
  buildContentDisposition,
  transliterateGermanUmlauts,
} from "@shared/domain/invoice-export-filename";

describe("buildSpeakingInvoiceFilename", () => {
  it("baut den Rechnungs-Namen im Muster `Nr - Nachname, Vorname - Rechnung`", () => {
    expect(
      buildSpeakingInvoiceFilename({
        invoiceNumber: "RE-2026-0034",
        vorname: "Erika",
        nachname: "Mustermann",
        kind: "invoice",
      }),
    ).toBe("RE-2026-0034 - Mustermann, Erika - Rechnung.pdf");
  });

  it("baut den Bündel-Namen (Rechnung+Leistungsnachweis)", () => {
    expect(
      buildSpeakingInvoiceFilename({
        invoiceNumber: "RE-2026-0034",
        vorname: "Erika",
        nachname: "Mustermann",
        kind: "bundle",
      }),
    ).toBe("RE-2026-0034 - Mustermann, Erika - Rechnung+Leistungsnachweis.pdf");
  });

  it("baut den Leistungsnachweis-Namen", () => {
    expect(
      buildSpeakingInvoiceFilename({
        invoiceNumber: "RE-2026-0034",
        vorname: "Erika",
        nachname: "Mustermann",
        kind: "leistungsnachweis",
      }),
    ).toBe("RE-2026-0034 - Mustermann, Erika - Leistungsnachweis.pdf");
  });

  it("bewahrt deutsche Umlaute im Kundennamen", () => {
    expect(
      buildSpeakingInvoiceFilename({
        invoiceNumber: "RE-2026-0100",
        vorname: "Jörg",
        nachname: "Müller-Schäfer",
        kind: "invoice",
      }),
    ).toBe("RE-2026-0100 - Müller-Schäfer, Jörg - Rechnung.pdf");
  });

  it("entfernt filesystem-unsichere Zeichen aus den Segmenten", () => {
    expect(
      buildSpeakingInvoiceFilename({
        invoiceNumber: "RE/2026:0034",
        vorname: 'Er"ika',
        nachname: "Muster*mann",
        kind: "invoice",
      }),
    ).toBe("RE 2026 0034 - Muster mann, Er ika - Rechnung.pdf");
  });

  it("fällt auf einen einzelnen Namensteil zurück, wenn der andere fehlt", () => {
    expect(
      buildSpeakingInvoiceFilename({
        invoiceNumber: "RE-2026-0034",
        nachname: "Mustermann",
        kind: "invoice",
      }),
    ).toBe("RE-2026-0034 - Mustermann - Rechnung.pdf");
  });

  it("nutzt den kombinierten Kundennamen, wenn Vor-/Nachname fehlen", () => {
    expect(
      buildSpeakingInvoiceFilename({
        invoiceNumber: "RE-2026-0034",
        customerName: "Seniorenheim Sonnenhof GmbH",
        kind: "invoice",
      }),
    ).toBe("RE-2026-0034 - Seniorenheim Sonnenhof GmbH - Rechnung.pdf");
  });

  it("fällt auf den neutralen Default `Kunde` zurück, wenn alle Namen fehlen", () => {
    expect(
      buildSpeakingInvoiceFilename({
        invoiceNumber: "RE-2026-0034",
        kind: "invoice",
      }),
    ).toBe("RE-2026-0034 - Kunde - Rechnung.pdf");
  });
});

describe("buildSpeakingKassenBundleFilename", () => {
  it("baut den Bündel-Namen im Muster `Pflegekasse - YYYY-MM - Sammelbündel` (pdf)", () => {
    expect(
      buildSpeakingKassenBundleFilename({
        providerName: "AOK Bayern",
        year: 2026,
        month: 3,
        extension: "pdf",
      }),
    ).toBe("AOK Bayern - 2026-03 - Sammelbündel.pdf");
  });

  it("nutzt die zip-Endung im ZIP-Modus", () => {
    expect(
      buildSpeakingKassenBundleFilename({
        providerName: "AOK Bayern",
        year: 2026,
        month: 12,
        extension: "zip",
      }),
    ).toBe("AOK Bayern - 2026-12 - Sammelbündel.zip");
  });

  it("bewahrt Umlaute im Kassennamen", () => {
    expect(
      buildSpeakingKassenBundleFilename({
        providerName: "Techniker Krankenkasse Süd",
        year: 2026,
        month: 1,
        extension: "pdf",
      }),
    ).toBe("Techniker Krankenkasse Süd - 2026-01 - Sammelbündel.pdf");
  });

  it("entfernt filesystem-unsichere Zeichen aus dem Kassennamen", () => {
    expect(
      buildSpeakingKassenBundleFilename({
        providerName: "AOK/Bayern:Süd",
        year: 2026,
        month: 6,
        extension: "zip",
      }),
    ).toBe("AOK Bayern Süd - 2026-06 - Sammelbündel.zip");
  });

  it("fällt auf `Pflegekasse` zurück, wenn der Name fehlt", () => {
    expect(
      buildSpeakingKassenBundleFilename({
        providerName: null,
        year: 2026,
        month: 7,
        extension: "pdf",
      }),
    ).toBe("Pflegekasse - 2026-07 - Sammelbündel.pdf");
  });
});

describe("transliterateGermanUmlauts", () => {
  it("mappt alle deutschen Umlaute korrekt", () => {
    expect(transliterateGermanUmlauts("äöüÄÖÜ")).toBe("aeoeueAeOeUe");
    expect(transliterateGermanUmlauts("ß")).toBe("ss");
    expect(transliterateGermanUmlauts("ẞ")).toBe("SS");
  });

  it("transliteriert echte Kundennamen (Task #1706)", () => {
    expect(transliterateGermanUmlauts("Unterschütz")).toBe("Unterschuetz");
    expect(transliterateGermanUmlauts("Schröder")).toBe("Schroeder");
    expect(transliterateGermanUmlauts("Müller")).toBe("Mueller");
    expect(transliterateGermanUmlauts("Straße")).toBe("Strasse");
  });

  it("lässt Nicht-Umlaut-Zeichen unangetastet und toleriert null/undefined", () => {
    expect(transliterateGermanUmlauts("Meyer")).toBe("Meyer");
    expect(transliterateGermanUmlauts(null)).toBe("");
    expect(transliterateGermanUmlauts(undefined)).toBe("");
  });
});

describe("sanitizeExportSegment (ZIP-Eintrag)", () => {
  it("schreibt Umlaute aus, statt sie zu `_` zu strippen (Task #1706)", () => {
    expect(sanitizeExportSegment("Unterschütz", "Kunde")).toBe("Unterschuetz");
    expect(sanitizeExportSegment("Schröder", "Kunde")).toBe("Schroeder");
    expect(sanitizeExportSegment("Müller", "Kunde")).toBe("Mueller");
    expect(sanitizeExportSegment("Straße", "Kunde")).toBe("Strasse");
  });

  it("ersetzt verbleibende Nicht-ASCII/Sonderzeichen weiterhin durch `_`", () => {
    expect(sanitizeExportSegment("Öztürk-Émile", "Kunde")).toBe("Oeztuerk-E_mile");
  });

  it("liefert den Fallback bei leerer Eingabe", () => {
    expect(sanitizeExportSegment("", "Kunde")).toBe("Kunde");
    expect(sanitizeExportSegment(null, "Datum")).toBe("Datum");
  });
});

describe("sanitizeSpeakingSegment", () => {
  it("erhält Umlaute, Komma, Bindestrich und Plus", () => {
    expect(sanitizeSpeakingSegment("Müller-Schäfer, Jörg+", "x")).toBe("Müller-Schäfer, Jörg+");
  });

  it("kollabiert Whitespace und trimmt", () => {
    expect(sanitizeSpeakingSegment("  a   b  ", "x")).toBe("a b");
  });

  it("liefert den Fallback für leere/nur-unsichere Eingabe", () => {
    expect(sanitizeSpeakingSegment("", "Kunde")).toBe("Kunde");
    expect(sanitizeSpeakingSegment(null, "Kunde")).toBe("Kunde");
  });
});

describe("buildContentDisposition", () => {
  it("liefert ASCII-Fallback und RFC-5987 filename* mit UTF-8-Encoding", () => {
    const cd = buildContentDisposition("RE-2026-0034 - Müller, Jörg - Rechnung.pdf");
    expect(cd).toContain('inline; filename="');
    // Umlaute im ASCII-Fallback ausgeschrieben (`ü→ue`, `ö→oe`), nicht `_` (Task #1706):
    expect(cd).toContain('filename="RE-2026-0034 - Mueller, Joerg - Rechnung.pdf"');
    // filename* percent-encoded (UTF-8) — echte Umlaute bleiben erhalten:
    expect(cd).toContain("filename*=UTF-8''");
    expect(cd).toContain(encodeURIComponent("RE-2026-0034 - Müller, Jörg - Rechnung.pdf"));
  });

  it("schreibt alle deutschen Umlaute im ASCII-Fallback aus (Task #1706)", () => {
    const cd = buildContentDisposition("RE-2026-0066 - Unterschütz, Karla - Rechnung.pdf");
    expect(cd).toContain('filename="RE-2026-0066 - Unterschuetz, Karla - Rechnung.pdf"');
    const cd2 = buildContentDisposition("RE-2026-0071 - Schröder, Marvin - Rechnung.pdf");
    expect(cd2).toContain('filename="RE-2026-0071 - Schroeder, Marvin - Rechnung.pdf"');
  });

  it("unterstützt den attachment-Modus", () => {
    expect(buildContentDisposition("a.pdf", "attachment")).toMatch(/^attachment; /);
  });
});
