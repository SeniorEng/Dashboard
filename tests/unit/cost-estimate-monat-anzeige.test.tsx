// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CostEstimatePreview, type CostEstimate } from "@/features/appointments/components/cost-estimate-preview";
import { classifyCostEstimate } from "@shared/domain/budget/cost-estimate-outcome";

/**
 * Replit #1916 — der neue Ausgang muss auf den SCHIRM kommen, und zwar mit der
 * RICHTIGEN Zahl im Kopf.
 *
 * ── Warum dieser Test neben dem SSoT-Test steht ────────────────────────
 * Im §45b-Vorgang ist genau das zweimal schiefgegangen: der Server lieferte
 * korrekt, und der Client zeigte es nicht (bzw. zeigte eine falsche
 * Begründung). Beide Male war der Test eine Schicht zu tief angesetzt.
 *
 * Prüffrage aus der Nachbereitung: *auf welcher Schicht steht die Behauptung,
 * die der Test belegen soll — und misst er dort oder eine darunter?* Die
 * Behauptung „der Bediener sieht, dass er den Termin anlegen kann" steht auf
 * der Anzeige. Also wird hier gerendert.
 */

/**
 * Die Props kommen aus der SSoT, nicht aus der Hand (Gate 2 zu #167, B1).
 *
 * ── Warum das der Kern dieses Tests ist ────────────────────────────────
 * Die erste Fassung tippte `warning` als String ab — und zwar mit der ALTEN
 * Mathematik (`100 − 47`). Nach der S1-Korrektur rechnet die SSoT gegen die
 * projizierte Zahl; die Fixture kodierte damit einen Zustand, **den der Server
 * nicht mehr produzieren kann**. Der Anzeige-Test konnte den Widerspruch
 * zwischen Kopf und Text deshalb per Konstruktion nie sehen.
 *
 * `MG-*` misst die SSoT und sieht die Anzeige nicht, `MA-*` maß die Anzeige
 * gegen eine erfundene Eingabe — **zwischen beiden fiel der Fall durch**.
 *
 * Jetzt baut der Helfer die Props aus demselben Aufruf, den die Route macht.
 * Eine Änderung an der Klassifikation schlägt damit bis in die Anzeige durch.
 */
function ausSsot(input: {
  totalCostCents: number;
  availableCents: number;
  projectedAvailableCents?: number;
  acceptsPrivatePayment?: boolean;
  pflegegrad1OhnePrivatzahlung?: boolean;
}): CostEstimate {
  const o = classifyCostEstimate({
    weightedVatRate: 19,
    isSelbstzahler: false,
    acceptsPrivatePayment: input.acceptsPrivatePayment ?? false,
    totalCostCents: input.totalCostCents,
    availableCents: input.availableCents,
    projectedAvailableCents: input.projectedAvailableCents,
    pflegegrad1OhnePrivatzahlung: input.pflegegrad1OhnePrivatzahlung,
  });
  return {
    totalCents: input.totalCostCents,
    availableCents: input.availableCents,
    projectedAvailableCents: input.projectedAvailableCents,
    warning: o.warning,
    isHardBlock: o.isHardBlock,
    kind: o.kind,
  };
}

afterEach(() => cleanup());

describe("Kostenschätzung-Anzeige — Kopf und Text aus derselben Zahl", () => {
  it("MA-1 – der Kopf nennt die MONATS-Zahl, nicht die heutige", () => {
    render(
      <CostEstimatePreview
        billingType="pflegekasse_gesetzlich"
        costEstimate={ausSsot({ totalCostCents: 100_00, availableCents: 47_00, projectedAvailableCents: 178_00 })}
      />,
    );
    const kasten = screen.getByTestId("budget-warning-monat");
    expect(kasten.textContent).toContain("im Termin-Monat verfügbar: 178,00");
    expect(kasten.textContent).not.toContain("— verfügbar: 47,00");
  });

  it("MA-2 – kein harter Block: der Kasten ist die Warnung, nicht die Sperre", () => {
    render(
      <CostEstimatePreview
        billingType="pflegekasse_gesetzlich"
        costEstimate={ausSsot({ totalCostCents: 100_00, availableCents: 47_00, projectedAvailableCents: 178_00 })}
      />,
    );
    expect(screen.queryByTestId("budget-hard-block"), "der Termin wird weiterhin gesperrt").toBeNull();
    expect(screen.getByTestId("budget-warning-monat")).toBeTruthy();
  });

  it("MA-3 – Privatzahler: Kopf und Text nennen DIESELBE Zahl", () => {
    /**
     * Der Fall, den die erste Fassung nicht sehen konnte (Gate 2 zu #167, B1):
     * sie tippte den Warntext mit der alten Mathematik ab. Hier kommt er aus
     * der SSoT — 300 − 178 = 122 privat, und der Kopf muss dieselben 178
     * nennen, nicht die heutigen 47.
     */
    render(
      <CostEstimatePreview
        billingType="pflegekasse_gesetzlich"
        costEstimate={ausSsot({
          totalCostCents: 300_00, availableCents: 47_00,
          projectedAvailableCents: 178_00, acceptsPrivatePayment: true,
        })}
      />,
    );
    const kasten = screen.getByTestId("budget-warning");
    expect(kasten.textContent).toContain("122,00");
    expect(kasten.textContent, "Kopf und Text rechnen gegen verschiedene Zahlen")
      .toContain("im Termin-Monat verfügbar: 178,00");
    expect(kasten.textContent).not.toContain("verfügbar: 47,00");
  });

  it("MA-4 – harter Block: Kopf und Fehlbetrag passen zusammen", () => {
    // Die Zeile, die vorher offen unsinnig war: „verfügbar: 2.358,00" über
    // „es fehlen 583,00". Beide kommen jetzt aus derselben Zahl.
    render(
      <CostEstimatePreview
        billingType="pflegekasse_gesetzlich"
        costEstimate={ausSsot({
          totalCostCents: 1_500_00, availableCents: 2_358_00, projectedAvailableCents: 917_00,
        })}
      />,
    );
    const kasten = screen.getByTestId("budget-hard-block");
    expect(kasten.textContent).toContain("im Termin-Monat verfügbar: 917,00");
    expect(kasten.textContent).toContain("583,00");
    expect(kasten.textContent, "der Kopf nennt den heutigen Stand, der Text die Projektion")
      .not.toContain("2.358,00");
  });

  it("MA-5 – ohne projizierte Zahl kein irreführender Kopf", () => {
    // Vertragsguard der Komponente: der Typ erlaubt die Kombination, der
    // Produktivpfad erzeugt sie nicht (`kind === "erst_im_monat_gedeckt"`
    // setzt voraus, dass die Projektion da war). Deshalb hier von Hand
    // gebaut — und ausdrücklich als Vertrag, nicht als Produktivfall.
    render(
      <CostEstimatePreview
        billingType="pflegekasse_gesetzlich"
        costEstimate={{
          totalCents: 100_00,
          availableCents: 47_00,
          isHardBlock: false,
          kind: "erst_im_monat_gedeckt",
          warning: "Im Termin-Monat reicht das Budget.",
        }}
      />,
    );
    expect(screen.queryByTestId("budget-warning-monat"),
      "der Kopf nennt eine Monatszahl, die es nicht gibt").toBeNull();
    expect(screen.getByTestId("budget-warning")).toBeTruthy();
  });
});
