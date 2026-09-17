import { describe, it, expect } from "vitest";
import {
  PIPELINE_CASCADE_ORDER,
  PIPELINE_STAGES,
  PIPELINE_STAGE_LABELS,
  EXPECTED_REVENUE_SIDE_STATES,
  summarizePipelineCents,
  assignAppointmentStage,
  type PipelineAtomicUnit,
} from "@shared/domain/billing-pipeline";

/**
 * Die Kaskade der Umsatz-Kachel (Ticket 6hWgVqw2C8442hcG).
 *
 * ── Die eine Zusage, die diese Darstellung macht ─────────────────────
 * Die Schlagzeile heißt „Erwarteter Kontoeingang", und darunter stehen
 * die Stufen mit dem Vermerk „Summe = <Schlagzeile>". Geht das nicht
 * auf, ist die Kachel falsch — und zwar auf eine Art, die niemandem
 * auffällt, weil beide Zahlen einzeln plausibel aussehen.
 *
 * Genau diese Klasse hat den Entwurf zweimal erwischt: die erste
 * Skizze zog die Verluste von einer Summe ab, in der sie nie enthalten
 * waren. Deshalb prüfen diese Tests die IDENTITÄT, nicht das Layout.
 *
 * ── Warum ohne DB ────────────────────────────────────────────────────
 * `summarizePipelineCents` ist eine reine Funktion über
 * `PipelineAtomicUnit[]`. Die Aussage ist arithmetisch, nicht
 * datenabhängig — ein Integrationstest würde hier die Fixture messen.
 */

const unit = (a: PipelineAtomicUnit["assignment"], cents: number): PipelineAtomicUnit =>
  ({ assignment: a, cents });

describe("Umsatz-Kachel — die Kaskade geht auf", () => {
  it("KA-1 – die sichtbaren Stufen summieren sich auf die Schlagzeile", () => {
    // Genau das steht in der Kachel als „Summe = …". Der erwartete
    // Kontoeingang MUSS Σ(Stufen) + „wartet auf Kundenunterschrift" sein
    // — nicht mehr und nicht weniger.
    const units = [
      unit({ kind: "stage", stage: "offen" }, 7_376_50),
      unit({ kind: "stage", stage: "dokumentiert" }, 1_289_00),
      unit({ kind: "stage", stage: "unterschrieben" }, 5_124_50),
      unit({ kind: "stage", stage: "versendet" }, 1_810_21),
      unit({ kind: "side", state: "wartet_auf_kundenunterschrift" }, 76_00),
    ];
    const s = summarizePipelineCents(units);

    const sichtbar =
      PIPELINE_CASCADE_ORDER.reduce((n, st) => n + s.stageCents[st], 0)
      + s.sideCents.wartet_auf_kundenunterschrift;

    expect(sichtbar, "Σ sichtbare Zeilen === Schlagzeile")
      .toBe(s.expectedRevenueTotalCents);
  });

  it("KA-2 – die Verluste sind NICHT in der Schlagzeile (kein Abzug!)", () => {
    // Der Fehler, den beide Entwurfs-Skizzen hatten. Storniert, nicht
    // angetroffen und Fristablauf waren nie Teil der erwarteten Summe —
    // sie davon abzuziehen entfernte sie ein zweites Mal.
    const ohneVerluste = summarizePipelineCents([
      unit({ kind: "stage", stage: "unterschrieben" }, 5_000_00),
    ]);
    const mitVerlusten = summarizePipelineCents([
      unit({ kind: "stage", stage: "unterschrieben" }, 5_000_00),
      unit({ kind: "excluded", reason: "cancelled" }, 1_881_00),
      unit({ kind: "side", state: "kunde_nicht_angetroffen" }, 9_50),
      unit({ kind: "side", state: "nicht_abgerechnet" }, 76_00),
    ]);

    expect(
      mitVerlusten.expectedRevenueTotalCents,
      "Verluste dürfen die Schlagzeile nicht verändern",
    ).toBe(ohneVerluste.expectedRevenueTotalCents);
  });

  it("KA-3 – abgesagte Termine tragen ihren Betrag, damit die Zeile sie zeigen kann", () => {
    // Vorher verwarf `summarizePipelineCents` den € jeder `excluded`-
    // Einheit. Ohne ihn bliebe die Zeile „abgesagt" leer.
    const s = summarizePipelineCents([
      unit({ kind: "excluded", reason: "cancelled" }, 1_881_00),
    ]);
    expect(s.cancelledCents).toBe(1_881_00);
  });

  it("KA-4 – ABGERECHNETE Termine zählen NICHT als abgesagt", () => {
    // Die Falle an der Hybrid-Kante: `excluded` hat zwei Gründe. Zählte
    // `invoiced` mit, stünde jeder abgerechnete Termin doppelt — einmal
    // hier, einmal auf der Rechnungs-Stufe.
    const s = summarizePipelineCents([
      unit({ kind: "excluded", reason: "invoiced" }, 9_999_00),
      unit({ kind: "stage", stage: "versendet" }, 9_999_00),
    ]);
    expect(s.cancelledCents, "`invoiced` gehört nicht in die Verlust-Zeile").toBe(0);
    expect(s.expectedRevenueTotalCents, "sein € lebt auf der Rechnung").toBe(9_999_00);
  });

  it("KA-5 – die Kaskade zeigt JEDE Stufe, keine fällt unter den Tisch", () => {
    // Der erste Entwurf listete fünf Zeilen und vergaß „Rechnung im
    // Entwurf", weil sie im Messmonat 0 war. Eine Stufe, die heute leer
    // ist, ist nächsten Monat nicht leer — und dann fehlte ihr Betrag in
    // einer Summe, die sich trotzdem als vollständig ausgibt.
    expect([...PIPELINE_CASCADE_ORDER].sort()).toEqual([...PIPELINE_STAGES].sort());
  });

  it("KA-6 – die Leserichtung ist links unsicher, rechts das Geld", () => {
    // GEDREHT gegenüber der ersten Fassung (Alrik, 17.09.2026): die Kaskade ist
    // waagerecht, und dann soll die Bewegung im Monatsverlauf — Beträge wandern
    // von „noch geplant" nach „bezahlt" — die natürliche Leserichtung sein
    // statt eine Aufwärtsbewegung, die man erklären muss.
    expect(PIPELINE_CASCADE_ORDER[0], "links das Unsicherste").toBe("offen");
    expect(
      PIPELINE_CASCADE_ORDER[PIPELINE_CASCADE_ORDER.length - 1],
      "rechts das, was auf dem Konto ist",
    ).toBe("bezahlt");

    // Sie ist damit wieder deckungsgleich mit der fachlichen Durchlauf-Folge —
    // aber BEWUSST eine eigene Konstante. Fielen sie zusammen, wäre die
    // nächste Layout-Entscheidung eine Änderung an der Domäne.
    expect(
      PIPELINE_CASCADE_ORDER,
      "Anzeige-Reihenfolge und Durchlauf-Folge sind zwei Fragen",
    ).not.toBe(PIPELINE_STAGES);
  });

  it("KA-7 – `wartet auf Kundenunterschrift` ist erwarteter Umsatz und gehört in die Kaskade", () => {
    // Die Kopplung, an der KA-1 hängt: wäre der Zustand kein erwarteter
    // Umsatz, dürfte die Zeile nicht in der Kaskade stehen — und wäre er
    // einer, dürfte sie nicht fehlen. Beides bricht den Selbsttest.
    expect(EXPECTED_REVENUE_SIDE_STATES).toContain("wartet_auf_kundenunterschrift");
    expect(EXPECTED_REVENUE_SIDE_STATES).not.toContain("kunde_nicht_angetroffen");
    expect(EXPECTED_REVENUE_SIDE_STATES).not.toContain("nicht_abgerechnet");
    expect(EXPECTED_REVENUE_SIDE_STATES).not.toContain("storniert");
  });

  it("KA-9 – „Nachweis zu erstellen“ und „Leistungsnachweis fehlt“ sind DISJUNKT", () => {
    // Alriks Verdacht vom 17.09.2026 (August-Zahlen): beide Zeilen zeigten
    // 57,00 €, die eine mit 1 Termin, die andere mit 2. Liegt derselbe Termin
    // in beiden, zaehlt die Schlagzeile ihn doppelt — und der sichtbare
    // Selbsttest merkt es NICHT, weil er die gezeigten Zeilen addiert: eine
    // doppelt gezaehlte Zeile geht genauso auf wie eine echte.
    //
    // Hier wird die Frage als MENGEN-Aussage entschieden, nicht an einer
    // Fixture: ueber alle Eingabe-Kombinationen darf keine einzige in beiden
    // Ausgaengen landen. `assignAppointmentStage` gibt genau einen Ausgang
    // zurueck (frueher Return), die Partition ist also strukturell — dieser
    // Test haelt sie fest, falls jemand den Rueckgabewert je zu einer Liste
    // macht oder die Reihenfolge der Zweige aendert.
    const stati = ["scheduled", "documenting", "completed",
      "cancelled", "expired_unsigned", "customer_no_show"] as const;
    // Die ECHTEN Werte — "pflegekasse" gibt es nicht, der Seitenzustand haengt
    // an `isPflegekasseBillingType` (gesetzlich ODER privat). Die
    // Erreichbarkeits-Pruefung unten hat genau diesen Tippfehler gefangen.
    const zahler = [null, "selbstzahler", "privat",
      "pflegekasse_gesetzlich", "pflegekasse_privat"] as const;
    const boolsch = [false, true] as const;

    const inDokumentiert: string[] = [];
    const inWartet: string[] = [];

    for (const status of stati) {
      for (const billingType of zahler) {
        for (const hasDirectSignature of boolsch) {
          for (const hasCompletedServiceRecord of boolsch) {
            for (const hasEmployeeSignedServiceRecord of boolsch) {
              for (const isInvoiced of boolsch) {
                const key = [status, billingType, hasDirectSignature,
                  hasCompletedServiceRecord, hasEmployeeSignedServiceRecord,
                  isInvoiced].join("|");
                const a = assignAppointmentStage({
                  status: status as never,
                  billingType,
                  hasDirectSignature,
                  hasCompletedServiceRecord,
                  hasEmployeeSignedServiceRecord,
                  isInvoiced,
                });
                if (a.kind === "stage" && a.stage === "dokumentiert") inDokumentiert.push(key);
                if (a.kind === "side" && a.state === "wartet_auf_kundenunterschrift") {
                  inWartet.push(key);
                }
              }
            }
          }
        }
      }
    }

    // Beide Ausgaenge muessen ueberhaupt erreichbar sein — sonst prueft der
    // Schnittmengen-Test nichts.
    expect(inDokumentiert.length, "Stufe `dokumentiert` unerreichbar").toBeGreaterThan(0);
    expect(inWartet.length, "Seitenzustand `wartet…` unerreichbar").toBeGreaterThan(0);

    const schnitt = inDokumentiert.filter((k) => inWartet.includes(k));
    expect(
      schnitt,
      "dieselbe Eingabe landet in BEIDEN Zeilen — die Schlagzeile zaehlt doppelt",
    ).toEqual([]);
  });

  it("KA-8 – `dokumentiert` heißt nicht „Doku fehlt“", () => {
    // Die Stufe ist `status = 'completed'` OHNE gültige Unterschrift: der
    // Termin IST dokumentiert, es fehlt der NACHWEIS. Die ursprünglich
    // vorgeschlagene Beschriftung hätte zur falschen Handlung geschickt.
    expect(PIPELINE_STAGE_LABELS.dokumentiert).not.toMatch(/Doku fehlt/i);
    expect(PIPELINE_STAGE_LABELS.dokumentiert).toMatch(/Nachweis/i);
  });
});
