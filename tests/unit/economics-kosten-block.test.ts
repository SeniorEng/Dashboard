import { describe, it, expect } from "vitest";
import { splitEconomicsRows } from "../../client/src/features/billing/utils";
import type { BillingEconomicsRow } from "@shared/api";

/**
 * Der untere Block der Umsatz-Kachel — die Aussagen der DARSTELLUNG.
 *
 * ── Warum es diese Datei gibt ────────────────────────────────────────────
 * Der obere Block (Kaskade) hat mit `summarizePipelineCents` eine reine
 * Funktion, die seine Zusage trägt, und die ist getestet. Der untere Block
 * hatte seine Logik nur im `.tsx` — Block-Aufteilung, „zusammen"-Summe und
 * die Frage, ob der Block überhaupt gezeigt werden darf. Ein Vertauschen von
 * zwei Beträgen wäre niemandem aufgefallen.
 *
 * Die tragende Aussage hier ist `zeigeOhneUmsatz`: bei gesetztem Kassen-Filter
 * wird Overhead GAR NICHT GEMESSEN (nicht zurechenbar), der Reader liefert die
 * Zeilen aber trotzdem — mit 0. Ungeprüft stünde dort eine Rubrik „Kosten ohne
 * Umsatz" mit sieben Nullzeilen und einer Summe, also eine behauptete Messung.
 * Das ist dasselbe Argument, mit dem die Umsatz-Spalte dieser Zeilen einen
 * Gedankenstrich bekommt — nur auf die Kosten-Spalte angewandt.
 */
const zeile = (
  key: string,
  group: BillingEconomicsRow["group"],
  costCents: number,
  quantity = 0,
  revenueCents = 0,
): BillingEconomicsRow => ({
  key,
  group,
  label: key,
  unit: "none",
  quantity,
  revenueCents,
  costCents,
  marginCents: revenueCents - costCents,
  marginPercent: 0,
  revenueRateCents: 0,
  costRateCents: 0,
});

describe("Kosten-Block der Umsatz-Kachel", () => {
  it("KB-1 – trennt die zwei Blöcke und summiert jeden richtig", () => {
    const r = splitEconomicsRows([
      zeile("hauswirtschaft", "leistung", 2_646_75, 3_600, 6_127_50),
      zeile("kilometer", "leistung", 360_93, 1_213, 424_55),
      zeile("overhead_urlaub", "kosten_ohne_umsatz", 200_00, 600),
      zeile("overhead_vertrieb", "kosten_ohne_umsatz", 101_63, 300),
    ]);

    expect(r.leistung.map((x) => x.key)).toEqual(["hauswirtschaft", "kilometer"]);
    expect(r.ohneUmsatz.map((x) => x.key)).toEqual(["overhead_urlaub", "overhead_vertrieb"]);
    expect(r.ohneUmsatzCents, "nur der untere Block").toBe(301_63);
    expect(r.summeCents, "alle Zeilen — Grundlage des Selbsttests").toBe(
      2_646_75 + 360_93 + 301_63,
    );
  });

  it("KB-2 – blendet den Block aus, wenn nichts gemessen wurde (Kassen-Filter)", () => {
    // Genau der Fall: sieben Zeilen, alle 0 in Geld UND Menge. Der Reader
    // liefert sie, weil der Vertrag sie vorsieht; gemessen hat er sie nicht.
    const r = splitEconomicsRows([
      zeile("hauswirtschaft", "leistung", 2_646_75, 3_600, 6_127_50),
      zeile("kilometer_zeiterfassung", "kosten_ohne_umsatz", 0, 0),
      zeile("overhead_bueroarbeit", "kosten_ohne_umsatz", 0, 0),
      zeile("overhead_urlaub", "kosten_ohne_umsatz", 0, 0),
    ]);
    expect(
      r.zeigeOhneUmsatz,
      "eine Rubrik mit lauter Nullen behauptet eine Messung, die nicht stattfand",
    ).toBe(false);
  });

  it("KB-3 – zeigt den Block, sobald IRGENDEINE Kategorie Geld trägt", () => {
    const r = splitEconomicsRows([
      zeile("overhead_bueroarbeit", "kosten_ohne_umsatz", 0, 0),
      zeile("overhead_urlaub", "kosten_ohne_umsatz", 200_00, 600),
    ]);
    expect(r.zeigeOhneUmsatz).toBe(true);
  });

  it("KB-4 – zeigt den Block auch bei 0 Cent, aber gefahrenen KILOMETERN", () => {
    // Die Gegenrichtung zu KB-2: eine Menge ohne Geld ist eine echte Messung
    // (km-Lohnsatz 0). Sie zu verstecken hieße, eine Null als Nicht-Messung
    // auszugeben — der Fehler in die andere Richtung.
    //
    // BEWUSST `kilometer_zeiterfassung` und NICHT eine Overhead-Zeile: die
    // erste Fassung nahm `overhead_urlaub` mit quantity 2400 — eine Form, die
    // der Reader gar nicht erzeugen kann (`quantity` ist dort hart 0, siehe
    // KO-9 und `economics-effective-rate-drift`). Der Test beschrieb also eine
    // andere Welt als die Integrationstests daneben und belegte einen Riegel,
    // den es für Overhead nicht gibt. Jetzt der erreichbare Fall.
    const r = splitEconomicsRows([
      zeile("kilometer_zeiterfassung", "kosten_ohne_umsatz", 0, 12.5),
    ]);
    expect(r.zeigeOhneUmsatz).toBe(true);
  });

  it("KB-5 – ohne Zeilen im unteren Block gibt es keinen Block", () => {
    const r = splitEconomicsRows([zeile("hauswirtschaft", "leistung", 100, 60, 200)]);
    expect(r.zeigeOhneUmsatz).toBe(false);
    expect(r.ohneUmsatzCents).toBe(0);
  });

  it("KB-6 – ein leeres Ergebnis kippt nicht", () => {
    const r = splitEconomicsRows([]);
    expect(r.summeCents).toBe(0);
    expect(r.zeigeOhneUmsatz).toBe(false);
  });
});
