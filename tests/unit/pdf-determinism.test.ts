/**
 * Task #1047 — Unit-Tests für `normalizePdfDeterminism`.
 *
 * Reine Logik (kein DB/Server/Chromium): prüft, dass die Metadaten-
 * Normalisierung
 *   - alle nicht-deterministischen Zeitstempel (Info-Dict + XMP) auf den
 *     eingefrorenen Erzeugungszeitpunkt setzt,
 *   - die Datei-`/ID` deterministisch aus dem Seed ableitet,
 *   - LÄNGENERHALTEND arbeitet (Byte-Offsets bleiben stabil),
 *   - bei gleichem Input + gleichen Optionen byte-identische Bytes liefert,
 *   - bei unterschiedlichem Seed unterschiedliche `/ID` erzeugt,
 *   - Inhalts-Bytes (alles außerhalb der Metadaten) unangetastet lässt.
 */
import { describe, expect, it } from "vitest";
import { normalizePdfDeterminism } from "../../server/lib/pdf-determinism";

const CREATION = "2026-03-04T08:09:10.000Z";

function sampleBytes(): Buffer {
  // Synthetisches PDF-Fragment mit allen drei Token-Familien + Inhalt.
  const parts = [
    "%PDF-1.7\n",
    "1 0 obj<</Title(Rechnung)>>endobj\n",
    "/CreationDate (D:20240101120000+01'00')\n",
    "/ModDate (D:20240101120000+01'00')\n",
    "<x:xmpmeta>",
    "<xmp:CreateDate>2024-01-01T12:00:00.123Z</xmp:CreateDate>",
    "<xmp:ModifyDate>2024-01-01T12:00:00.123Z</xmp:ModifyDate>",
    "<xmp:MetadataDate>2024-01-01T12:00:00.123Z</xmp:MetadataDate>",
    "<rdf:li>2024-01-01T12:00:00.123Z</rdf:li>",
    "</x:xmpmeta>",
    "trailer\n/ID [<0123456789abcdef0123456789abcdef> <fedcba9876543210fedcba9876543210>]\n",
    "stream\nBINARY-CONTENT-\u00ff\u0000\u00fe\nendstream\n",
    "%%EOF",
  ];
  return Buffer.from(parts.join(""), "latin1");
}

describe("normalizePdfDeterminism", () => {
  it("ersetzt Info-Dict-Zeitstempel längenerhaltend", () => {
    const out = normalizePdfDeterminism(sampleBytes(), { creationDate: CREATION, idSeed: "RE-1" });
    const s = out.toString("latin1");
    expect(s).toContain("/CreationDate (D:20260304080910+01'00')");
    expect(s).toContain("/ModDate (D:20260304080910+01'00')");
    expect(s).not.toContain("20240101120000");
  });

  it("ersetzt alle XMP-Zeitstempel (24-Zeichen-Millis-ISO)", () => {
    const out = normalizePdfDeterminism(sampleBytes(), { creationDate: CREATION, idSeed: "RE-1" });
    const s = out.toString("latin1");
    expect(s).toContain("<xmp:CreateDate>2026-03-04T08:09:10.000Z</xmp:CreateDate>");
    expect(s).toContain("<xmp:ModifyDate>2026-03-04T08:09:10.000Z</xmp:ModifyDate>");
    expect(s).toContain("<xmp:MetadataDate>2026-03-04T08:09:10.000Z</xmp:MetadataDate>");
    expect(s).toContain("<rdf:li>2026-03-04T08:09:10.000Z</rdf:li>");
    expect(s).not.toContain("2024-01-01T12:00:00.123Z");
  });

  it("leitet die Datei-/ID deterministisch aus dem Seed ab (gleiche Länge)", () => {
    const out = normalizePdfDeterminism(sampleBytes(), { creationDate: CREATION, idSeed: "RE-1" });
    const s = out.toString("latin1");
    const m = s.match(/\/ID \[<([0-9a-f]+)> <([0-9a-f]+)>\]/);
    expect(m).not.toBeNull();
    expect(m![1]).toHaveLength(32);
    expect(m![2]).toHaveLength(32);
    expect(m![1]).not.toBe("0123456789abcdef0123456789abcdef");
    // Beide Slots unterscheiden sich (unterschiedlicher Slot-Suffix).
    expect(m![1]).not.toBe(m![2]);
  });

  it("ist längenerhaltend (Byte-Länge unverändert)", () => {
    const input = sampleBytes();
    const out = normalizePdfDeterminism(input, { creationDate: CREATION, idSeed: "RE-1" });
    expect(out.length).toBe(input.length);
  });

  it("ist deterministisch: gleicher Input + Optionen ⇒ byte-identisch", () => {
    const a = normalizePdfDeterminism(sampleBytes(), { creationDate: CREATION, idSeed: "RE-1" });
    const b = normalizePdfDeterminism(sampleBytes(), { creationDate: CREATION, idSeed: "RE-1" });
    expect(a.equals(b)).toBe(true);
  });

  it("unterschiedlicher Seed ⇒ unterschiedliche /ID", () => {
    const a = normalizePdfDeterminism(sampleBytes(), { creationDate: CREATION, idSeed: "RE-1" });
    const b = normalizePdfDeterminism(sampleBytes(), { creationDate: CREATION, idSeed: "RE-2" });
    expect(a.equals(b)).toBe(false);
  });

  it("lässt Inhalts-Bytes (Stream/Titel) unangetastet", () => {
    const out = normalizePdfDeterminism(sampleBytes(), { creationDate: CREATION, idSeed: "RE-1" });
    const s = out.toString("latin1");
    expect(s).toContain("<</Title(Rechnung)>>");
    expect(s).toContain("stream\nBINARY-CONTENT-\u00ff\u0000\u00fe\nendstream");
  });

  it("gibt bei ungültigem Datum die Bytes unverändert zurück", () => {
    const input = sampleBytes();
    const out = normalizePdfDeterminism(input, { creationDate: "not-a-date", idSeed: "RE-1" });
    expect(out.equals(input)).toBe(true);
  });
});
