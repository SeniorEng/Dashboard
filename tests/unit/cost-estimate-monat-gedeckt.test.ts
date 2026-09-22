import { describe, expect, it } from "vitest";
import { classifyCostEstimate } from "@shared/domain/budget/cost-estimate-outcome";

/**
 * Replit #1916 — die Vorschau darf nicht strenger sein als der Server.
 *
 * ── Der Fall ────────────────────────────────────────────────────────────
 * Es gibt ZWEI Tore mit verschiedenen Stichtagen: `planHold` entscheidet beim
 * **Anlegen** und projiziert bis zum Monatsende, `createConsumptionTransaction`
 * entscheidet beim **Dokumentieren** und ist auf heute gedeckelt. Beide sind
 * für sich richtig — wer im Oktober dokumentiert, hat den Oktober-Anspruch
 * real.
 *
 * Falsch war, die Vorschau der ANLAGE gegen den Dokumentations-Stichtag zu
 * prüfen. Sie sperrte damit Termine, die `planHold` angenommen hätte: eine
 * Mitarbeiterin konnte für Oktober nichts buchen.
 *
 * ── Alriks Weiche ───────────────────────────────────────────────────────
 *   projiziert reicht nicht        → harter Stopp, wie bisher
 *   projiziert reicht, heute nicht → anlegbar, MIT Warnung
 *   beides reicht                  → unverändert
 */

const BASIS = {
  weightedVatRate: 19,
  acceptsPrivatePayment: false,
  isSelbstzahler: false,
};

describe("Kostenschätzung — projizieren, aber warnen statt sperren", () => {
  it("MG-1 – projiziert reicht, heute nicht: anlegbar mit Warnung", () => {
    const o = classifyCostEstimate({
      ...BASIS,
      totalCostCents: 100_00,
      availableCents: 47_00,        // Stand heute
      projectedAvailableCents: 178_00, // mit der Aufstockung des Termin-Monats
    });

    expect(o.kind).toBe("erst_im_monat_gedeckt");
    // Das Entscheidende: der Knopf bleibt offen. Der Client sperrt über
    // genau dieses Feld.
    expect(o.isHardBlock, "der Termin bleibt gesperrt — genau der gemeldete Fehler").toBe(false);
    // Die Warnung nennt ZAHLEN, keine Vermutung, und sagt, worauf sie sich
    // beziehen. „Reicht schon noch" wäre wertlos.
    expect(o.warning).toContain("178,00");
    expect(o.warning).toContain("100,00");
    expect(o.warning, "die Differenz zu heute fehlt").toContain("53,00");
    expect(o.warning, "der Monatsbezug fehlt").toContain("Monat des Termins");
    // Und: eine AUSSAGE, keine Zusage. Die Vorschau rechnet nicht mit
    // derselben Kostenbasis wie `planHold` (km fehlen, Zwei-Kräfte-Einsatz
    // reserviert doppelt) — sie kann den Erfolg des Speicherns nicht
    // versprechen, nur das Wegfallen der Sperre (Gate 2 zu #167, S1).
    expect(o.warning).toContain("Budget-Sperre entfällt");
    expect(o.warning, "die Vorschau verspricht etwas, das sie nicht weiß")
      .not.toContain("kann angelegt werden");
  });

  it("MG-2 – projiziert reicht NICHT: harter Stopp bleibt", () => {
    // Die Gegenprobe. Aus „warnt statt sperrt" darf kein „sperrt nie" werden.
    const o = classifyCostEstimate({
      ...BASIS,
      totalCostCents: 300_00,
      availableCents: 47_00,
      projectedAvailableCents: 178_00,
    });

    expect(o.kind).toBe("hard_block");
    expect(o.isHardBlock).toBe(true);
    // Gegen die MASSGEBLICHE Zahl gerechnet, nicht gegen die heutige: es
    // fehlen 122,00 (300 − 178), nicht 253,00 (300 − 47). Sonst nennte die
    // Meldung einen Betrag, den niemand aufbringen muss.
    expect(o.warning, "der Fehlbetrag ist gegen den heutigen Stand gerechnet").toContain("122,00");
  });

  it("MG-3 – beides reicht: unverändert ok", () => {
    const o = classifyCostEstimate({
      ...BASIS,
      totalCostCents: 30_00,
      availableCents: 47_00,
      projectedAvailableCents: 178_00,
    });
    expect(o.kind).toBe("ok");
    expect(o.warning).toBeNull();
    expect(o.isHardBlock).toBe(false);
  });

  it("MG-4 – ohne projizierte Zahl gilt das alte Verhalten", () => {
    // Aufrufer, die nicht projizieren können, bleiben unverändert — sonst
    // wäre aus einer Erweiterung eine stille Verhaltensänderung für alle
    // geworden.
    const ohne = classifyCostEstimate({ ...BASIS, totalCostCents: 100_00, availableCents: 47_00 });
    expect(ohne.kind).toBe("hard_block");
    expect(ohne.isHardBlock).toBe(true);
    expect(ohne.warning).toContain("53,00");
  });

  it("MG-5 – Privatzahler-Pfad rechnet ebenfalls gegen die projizierte Zahl", () => {
    // Wer privat zahlen darf, bekommt weiterhin `soft_private` — aber der
    // privat berechnete Anteil ist der gegen die MASSGEBLICHE Zahl, nicht der
    // gegen den heutigen Stand. Sonst stellte die Vorschau 253,00 € privat in
    // Aussicht, wo 122,00 € anfallen.
    const o = classifyCostEstimate({
      ...BASIS,
      acceptsPrivatePayment: true,
      totalCostCents: 300_00,
      availableCents: 47_00,
      projectedAvailableCents: 178_00,
    });
    expect(o.kind).toBe("soft_private");
    expect(o.isHardBlock).toBe(false);
    expect(o.privateCents, "privat berechnet wird gegen den heutigen Stand statt gegen den Monat").toBe(122_00);
  });

  it("MG-6 – ohne Ausweichtopf steht der Satz dabei, sonst nicht", () => {
    // Alriks Satz, wörtlich: "Kein Ausweichbudget verfügbar." Er ist KEINE
    // Fehlermeldung, sondern eine Aussage über Leistungsansprüche, die eine
    // Mitarbeiterin gegenüber dem Kunden vertritt. Deshalb steht er so, wie
    // er freigegeben wurde — und nur dort, wo er zutrifft.
    const ohneAusweich = classifyCostEstimate({
      ...BASIS,
      totalCostCents: 100_00,
      availableCents: 47_00,
      projectedAvailableCents: 178_00,
      pflegegrad1OhnePrivatzahlung: true,
    });
    expect(ohneAusweich.warning).toContain("Kein Ausweichbudget verfügbar.");

    // Gegenprobe: wer einen Ausweichtopf hat, bekommt den Satz NICHT — sonst
    // stünde eine falsche Auskunft über Leistungsansprüche im Formular.
    const mitAusweich = classifyCostEstimate({
      ...BASIS,
      totalCostCents: 100_00,
      availableCents: 47_00,
      projectedAvailableCents: 178_00,
      pflegegrad1OhnePrivatzahlung: false,
    });
    expect(mitAusweich.warning).not.toContain("Ausweichbudget");
  });

  it("MG-8 – der Satz steht auch im harten Stopp", () => {
    // Alriks Ergänzung: im Mittelzweig heißt der Satz „es wird knapp", im
    // harten Stopp heißt er „du musst nicht weitersuchen". Dort steht eine
    // Mitarbeiterin vor einem gesperrten Knopf und müsste sonst raten, ob
    // irgendein anderer Topf noch hilft.
    const gesperrt = classifyCostEstimate({
      ...BASIS,
      totalCostCents: 300_00,
      availableCents: 47_00,
      projectedAvailableCents: 178_00,
      pflegegrad1OhnePrivatzahlung: true,
    });
    expect(gesperrt.kind).toBe("hard_block");
    expect(gesperrt.warning).toContain("Kein Ausweichbudget verfügbar.");
    // Der Fehlbetrag bleibt daneben stehen — der Satz ersetzt ihn nicht.
    expect(gesperrt.warning).toContain("122,00");

    const mitAusweichGesperrt = classifyCostEstimate({
      ...BASIS,
      totalCostCents: 300_00,
      availableCents: 47_00,
      projectedAvailableCents: 178_00,
      pflegegrad1OhnePrivatzahlung: false,
    });
    expect(mitAusweichGesperrt.warning).not.toContain("Ausweichbudget");
  });

  it("MG-7 – ist die Projektion KLEINER, entscheidet trotzdem sie", () => {
    /**
     * Der Fall, den `Math.max` verschluckt hat (Gate 2 zu #167, S1).
     *
     * Die Projektion kann kleiner sein als der heutige Stand — strukturell,
     * nicht als Sonderfall: `expiry45bFloorDateFor` setzt den Boden aufs
     * Vorjahr, solange der Horizont ≤ 30.06. liegt, und aufs laufende Jahr
     * danach. Der Reader deckelt auf HEUTE, die Projektion aufs
     * Termin-MONATSENDE. Liegt heute im ersten Halbjahr und der Termin im
     * zweiten, nimmt die Projektion den zum 30.06. verfallenden Anspruch weg.
     *
     * Gemessen wurde `available = 2.358,00`, `projiziert = 917,00`.
     *
     * Mit `Math.max` hätte die Vorschau hier einen GRÜNEN Kasten gezeigt und
     * `planHold` beim Speichern mit 422 abgelehnt — **die Umkehrung des
     * Fehlers, gegen den dieser PR gebaut ist.**
     */
    const o = classifyCostEstimate({
      ...BASIS,
      totalCostCents: 1_500_00,
      availableCents: 2_358_00,        // Stand heute: reicht
      projectedAvailableCents: 917_00, // was `planHold` sieht: reicht NICHT
    });

    expect(o.kind, "die Vorschau zeigt grün, wo planHold mit 422 ablehnt").toBe("hard_block");
    expect(o.isHardBlock).toBe(true);
    // Und der Fehlbetrag gegen die maßgebliche Zahl: 1.500 − 917 = 583.
    expect(o.warning).toContain("583,00");
  });
});
