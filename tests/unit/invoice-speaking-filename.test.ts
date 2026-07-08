import { describe, it, expect } from "vitest";
import {
  buildSpeakingInvoiceFilename,
  sanitizeSpeakingSegment,
  buildContentDisposition,
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
    // Umlaute im ASCII-Fallback durch `_` ersetzt:
    expect(cd).toContain('filename="RE-2026-0034 - M_ller, J_rg - Rechnung.pdf"');
    // filename* percent-encoded (UTF-8):
    expect(cd).toContain("filename*=UTF-8''");
    expect(cd).toContain(encodeURIComponent("RE-2026-0034 - Müller, Jörg - Rechnung.pdf"));
  });

  it("unterstützt den attachment-Modus", () => {
    expect(buildContentDisposition("a.pdf", "attachment")).toMatch(/^attachment; /);
  });
});
