// @vitest-environment jsdom
import React from "react";
import { describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { BetragMitVerdraengung } from "@/components/budget/BudgetTypeSettings";

/**
 * P1 `6hXp9qMrXH2WGVVG`, E4 — die Kennzeichnung muss auf den SCHIRM kommen,
 * nicht nur in die Antwort.
 *
 * ── Warum es diesen Test gibt (Gate 2 zu #166, B2) ─────────────────────
 * Die erste Fassung rief die Kennzeichnung nur im Übertrags-Abschnitt. Der
 * Server lieferte den ersetzten **Startwert** korrekt als ersetzt — und der
 * Client zeigte ihn weiter als gleichberechtigten Betrag. Genau der Fall, mit
 * dem der PR begründet war („wirkt sofort, auch ohne scharfes Flag"), kam
 * nicht auf den Schirm.
 *
 * **Aufgefallen ist es nicht am Test:** `EK-1` prüft die API-Antwort. Eine
 * Zusage über das UI, die eine Ebene tiefer geprüft wird, hält genau so
 * lange, bis jemand die obere Ebene vergisst.
 */

function allocation(over: Partial<React.ComponentProps<typeof BetragMitVerdraengung>["allocation"]> = {}) {
  return {
    id: 1,
    amountCents: 117_900,
    validFrom: "2026-01-01",
    source: "carryover",
    expiresAt: null,
    year: 2026,
    ...over,
  } as React.ComponentProps<typeof BetragMitVerdraengung>["allocation"];
}

describe("§45b-Anzeige — ersetzte Zuweisung ist als ersetzt zu sehen", () => {
  it("VA-1 – eine ersetzte Zeile zeigt den Grund und streicht den Betrag durch", () => {
    render(
      <BetragMitVerdraengung
        allocation={allocation({ ersetztDurchStartwertMonat: "06/2026" })}
        testId="probe"
        klasse="font-semibold"
      />,
    );
    const zeile = screen.getByTestId("probe");
    expect(zeile.textContent).toContain("ersetzt durch Startwert 06/2026");
    // Der Betrag bleibt lesbar — verdrängen, nicht löschen. Wer nachsieht,
    // soll erkennen, DASS es die Zeile gab und WARUM sie nicht mehr zählt.
    expect(zeile.textContent).toContain("1.179,00");
    expect(zeile.querySelector(".line-through"), "der Betrag ist nicht durchgestrichen").toBeTruthy();
    cleanup();
  });

  it("VA-2 – eine zählende Zeile bleibt unverändert", () => {
    // Die Gegenprobe: aus „zeigt zu selten" darf kein „zeigt immer" werden.
    render(
      <BetragMitVerdraengung
        allocation={allocation({ ersetztDurchStartwertMonat: null })}
        testId="probe"
        klasse="font-semibold"
      />,
    );
    expect(screen.queryByTestId("probe"), "eine gültige Zeile wird als ersetzt gezeigt").toBeNull();
    expect(document.body.textContent).toContain("1.179,00");
    expect(document.body.querySelector(".line-through")).toBeNull();
    cleanup();
  });

  it("VA-3 – die Kennzeichnung gilt auch für einen STARTWERT, nicht nur für Überträge", () => {
    // B2 in einem Satz: der ersetzte Startwert war der Fall, mit dem der PR
    // begründet war, und genau er wurde nicht gerendert.
    render(
      <BetragMitVerdraengung
        allocation={allocation({ source: "initial_balance", amountCents: 50_000, ersetztDurchStartwertMonat: "06/2026" })}
        testId="probe"
        klasse="font-medium"
      />,
    );
    const zeile = screen.getByTestId("probe");
    expect(zeile.textContent).toContain("ersetzt durch Startwert 06/2026");
    expect(zeile.textContent).toContain("500,00");
    cleanup();
  });
});
