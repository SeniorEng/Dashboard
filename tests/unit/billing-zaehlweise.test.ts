import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  ZAEHLWEISE,
  type ZaehlweiseSicht,
  type ZaehlweiseSatz,
} from "@shared/domain/billing-zaehlweise";
import { PIPELINE_STAGE_LABELS } from "@shared/domain/billing-pipeline";

/**
 * Ticket 6hWgVqw2C8442hcG, Weg 3 + S-1 — „sichtbar machen statt angleichen".
 *
 * Am 17.09.2026 zeigten Umsatz-Kachel und „Noch zu erstellen" vier Beträge für
 * zwei Fälle. Keine Zahl war falsch; sie beantworten verschiedene Fragen.
 * Alriks Entscheidung: beide Ansichten bleiben, dazu kommt die Auskunft, was
 * jede zählt. S-1 (18.09.) hat das auf VIER Sichten und auf eine zweite Frage
 * ausgeweitet: was macht der Monatsabschluss mit dieser Zahl?
 *
 * Alriks fünf Anforderungen an die Hinweise, und was hier davon prüfbar ist:
 *
 *  1. **fachlich, nicht technisch** — prüfbar: kein Schema-Vokabular (ZW-3).
 *  2. **ein Satz, keine Fußnotenliste** — prüfbar: Länge, keine Aufzählung (ZW-4).
 *  3. **sichtbar, nicht im Kleingedruckten** — NICHT hier prüfbar, das ist
 *     Platzierung im JSX. Prüfbar ist immerhin, DASS jede der vier Sichten ihn
 *     rendert (ZW-7).
 *  4. **in der SSoT, nicht doppelt gepflegt** — prüfbar: die Sätze stehen als
 *     Literal nur in ihrer Quelldatei (ZW-5).
 *  5. **bindet an die Sache, nicht an eine Stufen-Beschriftung** — prüfbar:
 *     kein Stufen-Label kommt in einem Satz vor (ZW-6).
 *
 * **Und eine sechste Prüfung, die keine Anforderung war, sondern die Lehre aus
 * dem ZW-6-Fehlschlag: ZW-9 misst, ob der Satz STIMMT.** Ein Hinweis, der
 * behauptet „hier zählt nach dem Abschluss nur noch Dokumentiertes", ist eine
 * Aussage über den Reader — und die lässt sich nachsehen, statt sie zu glauben.
 * Genau das hat beim „ab ‚gestellt'"-Satz gefehlt: er war grün, weil der Test
 * die Wörter prüfte statt der Aussage.
 */
const WURZEL = path.resolve(__dirname, "../..");
const SICHTEN = Object.keys(ZAEHLWEISE) as ZaehlweiseSicht[];

function lies(rel: string): string {
  return readFileSync(path.join(WURZEL, rel), "utf8");
}

/** Beide Sätze einer Sicht — fast jede Prüfung gilt für beide. */
function saetze(h: ZaehlweiseSatz): string[] {
  return [h.zaehlt, h.nachAbschluss];
}

describe("Zählweise-Hinweise (Weg 3 + S-1)", () => {
  it("ZW-0 – es sind genau die vier Ansichten, die dieselben Termine zeigen", () => {
    // Der Riegel gegen die stille fünfte Ansicht: wer eine Sicht ergänzt, ohne
    // sie zu beschriften, kommt an diesem Test nicht vorbei.
    expect(SICHTEN.sort()).toEqual(
      ["kostenTabelle", "rechnungenListe", "termineListe", "umsatzKaskade"],
    );
    expect(SICHTEN.filter((s) => ZAEHLWEISE[s].art === "geld").sort())
      .toEqual(["kostenTabelle", "umsatzKaskade"]);
    expect(SICHTEN.filter((s) => ZAEHLWEISE[s].art === "arbeitsliste").sort())
      .toEqual(["rechnungenListe", "termineListe"]);
  });

  it("ZW-1 – jeder Satz nennt seine EINHEIT und seine BASIS", () => {
    // Die Dimensionen, die die verglichenen Beträge auseinandertreiben. Fällt
    // eine weg, erklärt der Hinweis den Unterschied nicht mehr.
    expect(ZAEHLWEISE.umsatzKaskade.zaehlt).toMatch(/je Termin/);
    expect(ZAEHLWEISE.umsatzKaskade.zaehlt).toMatch(/netto/);

    expect(ZAEHLWEISE.rechnungenListe.zaehlt).toMatch(/je Kunde/);
    expect(ZAEHLWEISE.rechnungenListe.zaehlt).toMatch(/brutto/);

    // Die Kosten-Tabelle unterscheidet sich von der Kaskade in den SPALTEN,
    // nicht in der Einheit — deshalb nennt ihr Satz beide Spaltenpaare.
    expect(ZAEHLWEISE.kostenTabelle.zaehlt).toMatch(/Ist/);
    expect(ZAEHLWEISE.kostenTabelle.zaehlt).toMatch(/Potenzial/);

    // Und der Termine-Tab muss sagen, dass er ÜBERHAUPT kein Geld zählt — sonst
    // vergleicht jemand seine Anzahl mit einem Euro-Betrag.
    expect(ZAEHLWEISE.termineListe.zaehlt).toMatch(/kein Geld/);
  });

  it("ZW-2 – die vier Sätze unterscheiden sich, sie widersprechen sich nicht", () => {
    const alle = SICHTEN.map((s) => ZAEHLWEISE[s].zaehlt);
    expect(new Set(alle).size, "zwei Sichten behaupten dieselbe Zählweise").toBe(4);

    // Wären Kaskade und Liste beide „netto" oder beide „je Kunde", wäre der
    // Hinweis falsch statt erklärend — dann gäbe es keinen Unterschied zu erklären.
    expect(ZAEHLWEISE.rechnungenListe.zaehlt).not.toMatch(/\bnetto\b/);
    expect(ZAEHLWEISE.umsatzKaskade.zaehlt).not.toMatch(/je Kunde/);
  });

  it("ZW-3 – fachlich, nicht technisch (Anforderung 1)", () => {
    // Wer das liest, arbeitet mit Rechnungen, nicht mit dem Schema. Und nicht
    // mit unserer Architektur: „kalendarisch vs. zustandsbasiert" ist die
    // technische Seite des Cutoffs und gehört ausdrücklich NICHT in die UI.
    for (const sicht of SICHTEN) {
      for (const satz of saetze(ZAEHLWEISE[sicht])) {
        expect(satz, sicht).not.toMatch(/unit_type|grossAmountCents|Cents|SQL|status\s*=/);
        expect(satz, sicht).not.toMatch(/[a-z]+[A-Z][a-z]+/); // kein camelCase
        expect(satz, sicht).not.toMatch(/kalendarisch|zustandsbasiert|Reader|Cutoff/i);
      }
    }
  });

  it("ZW-4 – ein Satz, keine Fußnotenliste (Anforderung 2)", () => {
    for (const sicht of SICHTEN) {
      for (const satz of saetze(ZAEHLWEISE[sicht])) {
        expect(satz.length, `zu lang für eine Kopfzeile (${sicht}): "${satz}"`)
          .toBeLessThanOrEqual(70);
        expect(satz, `Aufzählung statt Satz (${sicht})`).not.toMatch(/\n|•|^\d\./);
      }
    }
  });

  it("ZW-5 – die Sätze stehen NUR in ihrer Quelldatei (Anforderung 4)", () => {
    // Der tragende Test — und die erste Fassung hat NICHT gemessen, was sie
    // zusagte: sie sah in genau zwei Dateien nach je einem Teilstück. Eine
    // Kopie in einer dritten Datei wäre unbemerkt geblieben, eine Kopie über
    // Kreuz ebenso, und eine Kopie nur der ersten Satzhälfte in beiden.
    //
    // Jetzt ein Lauf über den ganzen Quellbaum, mit markanten Teilstücken aus
    // ALLEN acht Sätzen gegen JEDE Datei ausser der Quelle und dieser hier.
    const teilstuecke = [
      "je Termin ohne km",
      "immer netto",
      "je Kunde, brutto",
      "nur noch nicht Abgerechnetes",
      "Potenzial = plus geplant",
      "Anzahl, kein Geld",
      "zählt nur noch, was dokumentiert ist",
      "bleibt auch nach dem Abschluss stehen",
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
  });

  it("ZW-6 – kein Satz nennt eine Stufen-Beschriftung (Anforderung 5)", () => {
    // Die erste Fassung schrieb „ab ‚gestellt‘" und lag eine Stufe daneben —
    // die Hybrid-Kante ist `isInvoiced`, und Entwurfs-Rechnungen zählen dort
    // mit. Der damalige Test war grün, weil er nur auf „Rechnung" prüfte.
    //
    // Die Regel: der Satz nennt KEINE Stufen-Beschriftung. Dann kann er nicht
    // auf die falsche zeigen, und eine Umbenennung macht ihn nicht falsch.
    for (const sicht of SICHTEN) {
      for (const satz of saetze(ZAEHLWEISE[sicht])) {
        for (const [stufe, label] of Object.entries(PIPELINE_STAGE_LABELS)) {
          expect(
            satz.includes(label),
            `${sicht} nennt die Stufen-Beschriftung „${label}" (${stufe}) — an die Sache binden, nicht an den Namen`,
          ).toBe(false);
        }
      }
    }

    // Die Kaskade muss die km-Grenze trotzdem mitnennen: „ohne km" gilt nur bis
    // zur Rechnung, danach trägt die Stufe den vollen Rechnungs-Netto inklusive
    // km. Ein Hinweis, der für die Hälfte der Zeilen nicht stimmt, ist schlimmer
    // als keiner.
    expect(ZAEHLWEISE.umsatzKaskade.zaehlt).toMatch(/ohne km/);
    expect(ZAEHLWEISE.umsatzKaskade.zaehlt, "die Grenze fehlt — der Satz gilt dann nur halb")
      .toMatch(/Rechnung/);
    expect(ZAEHLWEISE.umsatzKaskade.zaehlt).toMatch(/mit km/);
  });

  it("ZW-7 – jede der vier Sichten rendert ihren Hinweis (Anforderung 3, halb)", () => {
    // Ohne diese Hälfte wäre der Test auch dann grün, wenn der Hinweis nirgends
    // mehr stünde. Geprüft wird die Verdrahtung, nicht die Optik.
    const komponente: Record<ZaehlweiseSicht, string> = {
      umsatzKaskade: "client/src/features/billing/components/status-pipeline-card.tsx",
      kostenTabelle: "client/src/features/billing/components/economics-overview-card.tsx",
      termineListe: "client/src/features/billing/components/termine-tab.tsx",
      rechnungenListe: "client/src/features/billing/components/pending-invoices-card.tsx",
    };
    for (const sicht of SICHTEN) {
      const quelle = lies(komponente[sicht]);
      expect(quelle, `${sicht} rendert keinen Hinweis`).toContain(`sicht="${sicht}"`);
      expect(quelle, `${sicht} baut den Hinweis selbst statt ihn zu rendern`)
        .toContain("ZaehlweiseHinweis");
    }
  });

  it("ZW-8 – der Abschluss-Satz hängt an der ART, nicht an der einzelnen Sicht", () => {
    // Die zwei Geld-Sichten MÜSSEN hier wortgleich sein. Sagten sie
    // Verschiedenes, sagte EINE Karte zwei Dinge über dasselbe Geld — genau der
    // Fehler, den Weg A behoben hat, nur eine Ebene tiefer wieder eingebaut.
    expect(ZAEHLWEISE.umsatzKaskade.nachAbschluss)
      .toBe(ZAEHLWEISE.kostenTabelle.nachAbschluss);
    expect(ZAEHLWEISE.termineListe.nachAbschluss)
      .toBe(ZAEHLWEISE.rechnungenListe.nachAbschluss);

    // Und die beiden Arten müssen etwas VERSCHIEDENES sagen — sonst erklärt der
    // Hinweis den Unterschied nicht, um dessentwillen es ihn gibt.
    expect(ZAEHLWEISE.umsatzKaskade.nachAbschluss)
      .not.toBe(ZAEHLWEISE.termineListe.nachAbschluss);
  });

  it("ZW-9 – die Sätze STIMMEN: nur die Geld-Sichten fragen nach dem Monatsabschluss", () => {
    // Der eigentliche Anti-Lügen-Riegel. Die Hinweise behaupten etwas über das
    // Verhalten der Reader; hier wird nachgesehen, statt es zu glauben.
    //
    // Gemessen wird der AUFRUF (`istNachMonatsCutoff(`), nicht die Erwähnung —
    // ein Kommentar, der die Funktion nennt, darf den Test weder grün noch rot
    // machen.
    //
    // Fällt dieser Test, ist nicht der Test kaputt: dann ist eine Beschriftung
    // zur Falschaussage geworden. Wer einen Reader umstellt, muss hier
    // vorbeikommen.
    //
    // ZWEI GRENZEN, ausdrücklich benannt statt verschwiegen:
    //  - Es ist ein Textgrep über genannte Dateien, keine Aussage über den
    //    Aufrufgraph. Wer den Cutoff auf anderem Weg nachbaut (etwa
    //    `computeMonthCloseCutoff(...) < todayBerlinIso()`), kommt hier
    //    vorbei. Genau diese Mutation ist im Gate-2-Review gefahren worden —
    //    sie fällt seitdem über CB-6 in
    //    `tests/billing/kachel-cutoff-beide-bloecke.test.ts`, weil dessen
    //    Fixture-Fenster jetzt in der Vergangenheit liegt. Erst beide Hälften
    //    zusammen tragen die Beschriftung.
    //  - Die HTTP-Route-Schicht (`server/routes/billing.ts`) ist bewusst NICHT
    //    in der Liste: sie bedient alle vier Sichten aus einer Datei, ein
    //    Riegel darauf würde bei jeder unbeteiligten Änderung falsch
    //    anschlagen. Heute reicht sie keinen Stichtag durch (geprüft).
    // Eine Sicht wird von MEHREREN Dateien bestimmt. Die erste Fassung zeigte
    // für `rechnungenListe` nur auf die Betrags-Berechnung — was einen Kunden
    // überhaupt in die Liste bringt, entscheiden aber die Reifegrad-Prädikate
    // und die Termin-Mengen. Ein Cutoff, der dort einzöge, hätte die Karte
    // leerlaufen lassen, während der Hinweis „bleibt stehen" behauptet.
    // (Gate-2-Fund S2 zu #152.)
    const quellen: Record<ZaehlweiseSicht, string[]> = {
      umsatzKaskade: ["server/storage/billing/pipeline-reader.ts"],
      kostenTabelle: ["server/storage/billing/economics-reader.ts"],
      termineListe: ["server/storage/billing/termine-reader.ts"],
      rechnungenListe: [
        "server/services/billing-customer-amounts.ts", // die Beträge
        "server/services/invoice-data.ts",             // welche Termine hineinzählen
        "shared/domain/billing-eligibility.ts",        // wer überhaupt in der Liste steht
      ],
    };

    for (const sicht of SICHTEN) {
      const sollte = ZAEHLWEISE[sicht].art === "geld";
      for (const datei of quellen[sicht]) {
        const fragtNachAbschluss = /\bistNachMonatsCutoff\s*\(/.test(lies(datei));
        if (sollte) {
          // Bei den Geld-Sichten genügt EINE Datei, die fragt — sie haben je
          // nur eine. Wären es mehrere, müsste hier `some` stehen.
          expect(
            fragtNachAbschluss,
            `${sicht} ist als Geld-Sicht beschriftet, aber ${datei} folgt dem Monatsabschluss nicht`,
          ).toBe(true);
        } else {
          expect(
            fragtNachAbschluss,
            `${sicht} ist als Arbeitsliste beschriftet, aber ${datei} folgt dem Monatsabschluss — die Beschriftung wäre dann falsch`,
          ).toBe(false);
        }
      }
    }
  });
});
