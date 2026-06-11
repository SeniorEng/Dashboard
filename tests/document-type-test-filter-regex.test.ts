import { describe, it, expect } from "vitest";
import { DOCUMENT_TYPE_TEST_NAME_PATTERN } from "../server/services/test-data-cleanup";

// BUG-18 — Der broadened Purge-Filter (`^DOC[0-9]+_[0-9]+_`) MUSS jeden
// generierten Test-Müll-Dokumenttyp treffen, aber KEINEN der echten deutschen
// Dokumenttyp-Namen. Beide Seiten werden hier gepinnt, damit eine spätere
// Filter-Verengung/-Verbreiterung nicht versehentlich echte Stammdaten erfasst
// oder Müll durchrutschen lässt. Importiert das EXAKTE Muster aus dem
// Purge-Service (SSoT) und prüft es gegen JS-`RegExp` (zeichengleich zu POSIX
// `~`).

const REAL_DOC_TYPE_NAMES = [
  "Abtretungserklärung",
  "Arbeitsunterweisung",
  "Arbeitsvertrag",
  "Auskunftsvollmacht zur Budgetabfrage (SGB XI)",
  "Betreuungsvertrag (Pflegekasse)",
  "Datenschutzerklärung",
  "Datenschutzvereinbarung",
  "Dienstleistungsvertrag (Selbstzahler)",
  "Einwilligungserklärung",
  "Erste Hilfe Zertifikat",
  "Forderungsabtretung",
  "Führerschein",
  "Führungszeugnis - einfach",
  "Führungszeugnis - erweitert",
  "Kundenvertrag",
  "Personenbeförderungsschein",
  "Pflegegradbescheid",
  "SEPA-Lastschriftmandat",
  "Schlüsselübergabeprotokoll",
  "Sonstiges Dokument",
  "Vollmacht",
  "Ärztliche Verordnung",
];

const GENERATED_JUNK_NAMES = [
  "DOC6_1777740879740_o27v3",
  "DOC1_1700000000000_abcde",
  "DOC42_1234567890_zz",
  "DOC0_0_x",
  "DOC2030_1699999999999_carecon",
];

describe("BUG-18 — DOCUMENT_TYPE_TEST_NAME_PATTERN", () => {
  const re = new RegExp(DOCUMENT_TYPE_TEST_NAME_PATTERN);

  it("trifft ALLE generierten Test-Müll-Dokumenttypen", () => {
    for (const name of GENERATED_JUNK_NAMES) {
      expect(re.test(name), `sollte matchen: ${name}`).toBe(true);
    }
  });

  it("trifft KEINEN der 22 echten deutschen Dokumenttyp-Namen", () => {
    for (const name of REAL_DOC_TYPE_NAMES) {
      expect(re.test(name), `darf NICHT matchen: ${name}`).toBe(false);
    }
  });
});
