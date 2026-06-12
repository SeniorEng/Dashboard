import { describe, it, expect } from "vitest";
import {
  isDocumentTypeTestJunk,
  DOCUMENT_TYPE_WHITELIST,
} from "../server/services/test-data-cleanup";

// BUG-18 (Task #1230) — Der Purge-/Guard-Filter folgt jetzt einem WHITELIST-
// Ansatz statt einer Namens-Pattern-Blacklist: Test-Müll ist JEDER Dokumenttyp
// mit DOC-Prefix, der NICHT in der zentralen `DOCUMENT_TYPE_WHITELIST` steht.
// Dieser Test pinnt beide Seiten — die 22 echten Stammdaten-Typen dürfen NIE
// als Müll klassifiziert werden, jeder generierte/abweichende `DOC*`-Typ MUSS.
// Importiert die EXAKTE Klassifikation (`isDocumentTypeTestJunk`) aus dem
// Purge-Service (SSoT, zeichengleich zum SQL-Filter `LIKE 'DOC%' AND NOT IN …`).

const GENERATED_JUNK_NAMES = [
  "DOC6_1777740879740_o27v3",
  "DOC1_1700000000000_abcde",
  "DOC42_1234567890_zz",
  "DOC0_0_x",
  "DOC2030_1699999999999_carecon",
  // Bewusst abweichende DOC*-Varianten, die eine reine Epoch-Pattern-Blacklist
  // hätte durchrutschen lassen — die Whitelist fängt sie ab:
  "DOCabc",
  "DOC_freihand",
  "DOCXYZ_violation",
];

describe("BUG-18 — isDocumentTypeTestJunk (Whitelist)", () => {
  it("klassifiziert ALLE generierten/abweichenden DOC*-Typen als Müll", () => {
    for (const name of GENERATED_JUNK_NAMES) {
      expect(isDocumentTypeTestJunk(name), `sollte Müll sein: ${name}`).toBe(true);
    }
  });

  it("klassifiziert KEINEN der 22 echten Whitelist-Dokumenttypen als Müll", () => {
    for (const name of DOCUMENT_TYPE_WHITELIST) {
      expect(isDocumentTypeTestJunk(name), `darf NICHT Müll sein: ${name}`).toBe(false);
    }
  });

  it("schont Nicht-DOC-Namen (z.B. admin-angelegte Sonder-Typen ohne DOC-Prefix)", () => {
    for (const name of ["Sonstiges", "Mein eigener Typ", "Datenschutz-Sonderfall", "Dokument X"]) {
      expect(isDocumentTypeTestJunk(name), `darf NICHT Müll sein: ${name}`).toBe(false);
    }
  });

  it("enthält genau 22 echte Dokumenttypen ohne DOC-Prefix", () => {
    expect(DOCUMENT_TYPE_WHITELIST).toHaveLength(22);
    expect(new Set(DOCUMENT_TYPE_WHITELIST).size).toBe(22);
    for (const name of DOCUMENT_TYPE_WHITELIST) {
      expect(name.startsWith("DOC"), `Whitelist-Eintrag sollte nicht mit DOC beginnen: ${name}`).toBe(false);
    }
  });
});
