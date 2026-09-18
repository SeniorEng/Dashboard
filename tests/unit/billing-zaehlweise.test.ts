import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { readdirSync, statSync } from "node:fs";
import {
  ZAEHLWEISE_UMSATZ_KACHEL,
  ZAEHLWEISE_RECHNUNGSLISTE,
} from "@shared/domain/billing-zaehlweise";
import { PIPELINE_STAGE_LABELS } from "@shared/domain/billing-pipeline";

/**
 * Ticket 6hWgVqw2C8442hcG, Weg 3 — „sichtbar machen statt angleichen".
 *
 * Am 17.09.2026 zeigten Umsatz-Kachel und „Noch zu erstellen" vier Beträge für
 * zwei Fälle. Keine Zahl war falsch; sie beantworten verschiedene Fragen.
 * Alriks Entscheidung: beide Ansichten bleiben, dazu kommt die Auskunft, was
 * jede zählt.
 *
 * Alriks vier Anforderungen an die Hinweise, und was hier davon prüfbar ist:
 *
 *  1. **fachlich, nicht technisch** — prüfbar: kein Schema-Vokabular.
 *  2. **ein Satz, keine Fußnotenliste** — prüfbar: Länge, keine Aufzählung.
 *  3. **sichtbar, nicht im Kleingedruckten** — NICHT hier prüfbar, das ist
 *     Platzierung im JSX. Beide stehen im Kopf der jeweiligen Karte.
 *  4. **in der SSoT, nicht doppelt gepflegt** — prüfbar: die Sätze stehen als
 *     Literal nur in ihrer Quelldatei.
 *
 * Anforderung 4 ist der eigentliche Grund für diese Datei. Ein Paar Hinweise,
 * das an zwei Orten gepflegt wird, driftet auseinander — und dann hätten wir
 * genau das Problem eine Ebene höher: zwei Erklärungen, die sich
 * widersprechen.
 */
const WURZEL = path.resolve(__dirname, "../..");

function lies(rel: string): string {
  return readFileSync(path.join(WURZEL, rel), "utf8");
}

describe("Zählweise-Hinweise (Weg 3)", () => {
  it("ZW-1 – beide Sätze nennen ihre EINHEIT und ihre BASIS", () => {
    // Die zwei Dimensionen, die die verglichenen Beträge auseinandertreiben.
    // Fällt eine weg, erklärt der Hinweis den Unterschied nicht mehr.
    expect(ZAEHLWEISE_UMSATZ_KACHEL).toMatch(/je Termin/);
    expect(ZAEHLWEISE_UMSATZ_KACHEL).toMatch(/netto/);

    expect(ZAEHLWEISE_RECHNUNGSLISTE).toMatch(/je Kunde/);
    expect(ZAEHLWEISE_RECHNUNGSLISTE).toMatch(/brutto/);
  });

  it("ZW-2 – sie widersprechen sich nicht, sie unterscheiden sich", () => {
    expect(ZAEHLWEISE_UMSATZ_KACHEL).not.toBe(ZAEHLWEISE_RECHNUNGSLISTE);
    // Wären beide „netto" oder beide „je Kunde", wäre der Hinweis falsch statt
    // erklärend — dann gäbe es keinen Unterschied zu erklären.
    expect(ZAEHLWEISE_RECHNUNGSLISTE).not.toMatch(/\bnetto\b/);
    expect(ZAEHLWEISE_UMSATZ_KACHEL).not.toMatch(/je Kunde/);
  });

  it("ZW-3 – fachlich, nicht technisch (Anforderung 1)", () => {
    // Wer das liest, arbeitet mit Rechnungen, nicht mit dem Schema.
    for (const satz of [ZAEHLWEISE_UMSATZ_KACHEL, ZAEHLWEISE_RECHNUNGSLISTE]) {
      expect(satz).not.toMatch(/unit_type|grossAmountCents|Cents|SQL|status\s*=/);
      expect(satz).not.toMatch(/[a-z]+[A-Z][a-z]+/); // kein camelCase
    }
  });

  it("ZW-4 – ein Satz, keine Fußnotenliste (Anforderung 2)", () => {
    for (const satz of [ZAEHLWEISE_UMSATZ_KACHEL, ZAEHLWEISE_RECHNUNGSLISTE]) {
      expect(satz.length, `zu lang für eine Kopfzeile: "${satz}"`).toBeLessThanOrEqual(70);
      expect(satz, "Aufzählung statt Satz").not.toMatch(/\n|•|^\d\./);
    }
  });

  it("ZW-5 – die Sätze stehen NUR in ihrer Quelldatei (Anforderung 4)", () => {
    // Der tragende Test — und die erste Fassung hat NICHT gemessen, was sie
    // zusagte: sie sah in genau zwei Dateien nach je einem Teilstück. Eine
    // Kopie in einer dritten Datei wäre unbemerkt geblieben, eine Kopie über
    // Kreuz ebenso, und eine Kopie nur der ersten Satzhälfte in beiden.
    //
    // Jetzt ein Lauf über den ganzen Quellbaum. Geprüft werden markante
    // Teilstücke BEIDER Sätze gegen JEDE Datei ausser der Quelle und dieser
    // Testdatei.
    const teilstuecke = [
      "je Termin ohne km",
      "immer netto",
      "je Kunde, brutto",
      "nur noch nicht Abgerechnetes",
    ];
    const erlaubt = [
      "shared/domain/billing-zaehlweise.ts",
      "tests/unit/billing-zaehlweise.test.ts",
    ];

    const treffer: string[] = [];
    const lauf = (rel: string) => {
      for (const eintrag of readdirSync(path.join(WURZEL, rel))) {
        if (eintrag === "node_modules" || eintrag.startsWith(".")) continue;
        const kind = path.join(rel, eintrag);
        if (statSync(path.join(WURZEL, kind)).isDirectory()) {
          lauf(kind);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(kind)) continue;
        if (erlaubt.includes(kind)) continue;
        const inhalt = lies(kind);
        for (const t of teilstuecke) {
          if (inhalt.includes(t)) treffer.push(`${kind}: „${t}“`);
        }
      }
    };
    for (const wurzel of ["client/src", "shared", "server", "tests", "e2e"]) lauf(wurzel);

    expect(
      treffer,
      "Zählweise-Satz abgeschrieben statt importiert — zwei Orte, einer driftet",
    ).toEqual([]);

    // Gegenrichtung: die zwei Karten MÜSSEN ihn importieren. Ohne diese Hälfte
    // wäre der Test auch dann grün, wenn der Hinweis nirgends mehr steht.
    expect(lies("client/src/features/billing/components/status-pipeline-card.tsx"))
      .toContain("ZAEHLWEISE_UMSATZ_KACHEL");
    expect(lies("client/src/features/billing/components/pending-invoices-card.tsx"))
      .toContain("ZAEHLWEISE_RECHNUNGSLISTE");
  });

  it("ZW-6 – die Kachel behauptet NICHT pauschal „ohne km“", () => {
    // Der naheliegende Satz wäre „je Termin, netto, ohne km" gewesen — und er
    // wäre für die Hälfte der Zeilen falsch: ab „gestellt" trägt die Stufe den
    // vollen Rechnungs-Netto INKLUSIVE km. Dieselbe Falle wie die frühere
    // Kopfzeile „(Leistungen)", die „ohne km" meinte und es nur für drei von
    // sechs Stufen war.
    //
    // Der Satz muss die Grenze also mitnennen: wo die Einheit wechselt,
    // wechselt auch, ob km drinstecken.
    expect(ZAEHLWEISE_UMSATZ_KACHEL).toMatch(/ohne km/);
    expect(ZAEHLWEISE_UMSATZ_KACHEL, "die Grenze fehlt — der Satz gilt dann nur halb")
      .toMatch(/Rechnung/);
    expect(ZAEHLWEISE_UMSATZ_KACHEL).toMatch(/mit km/);

    // UND die Grenze muss an der richtigen Stelle liegen. Die erste Fassung
    // schrieb „ab ‚gestellt‘" und lag eine Stufe daneben — die Hybrid-Kante
    // ist `isInvoiced`, und Entwurfs-Rechnungen zaehlen dort mit. Dieser Test
    // war damals gruen, weil er nur auf „Rechnung" prueste.
    //
    // Die Regel: der Satz nennt KEINE Stufen-Beschriftung. Dann kann er nicht
    // auf die falsche zeigen, und eine Umbenennung macht ihn nicht falsch.
    for (const [stufe, label] of Object.entries(PIPELINE_STAGE_LABELS)) {
      expect(
        ZAEHLWEISE_UMSATZ_KACHEL.includes(label),
        `nennt die Stufen-Beschriftung „${label}" (${stufe}) — an die Sache binden, nicht an den Namen`,
      ).toBe(false);
    }
  });
});
