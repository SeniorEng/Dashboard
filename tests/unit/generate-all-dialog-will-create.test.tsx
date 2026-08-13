// @vitest-environment jsdom
import React, { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import type { BillingCustomerItem } from "@shared/api";
import { GenerateAllDialog } from "@/features/billing/components/generate-all-dialog";

/**
 * Task #1780 — Regressionstest: Der (N)-Zähler „werden erstellt" im
 * GenerateAllDialog darf niemals mehr versprechen als tatsächlich abgerechnet
 * wird.
 *
 * Task #1905 (absorbiert #1895) — der Zähler leitet sich jetzt aus DER EINEN
 * Reife-SSoT `classifyBillingMaturity` ab statt aus einer eigenen Kombination
 * von `hasOpenAppointments` + `eligibility.status`. Die alte Formel zählte einen
 * MISCHKUNDEN (ein Teil kundensigniert, der Rest nur mitarbeiter-signiert) als
 * „wird erstellt": er hat keine offenen Termine und ist `eligible`. Der Server
 * rechnet ihn aber nur mit gesetztem `confirmPartial` ab — sonst meldet er ihn
 * als „übersprungen mit Ausweis" (#1883). Der Zähler versprach also eine
 * Rechnung, die nicht entsteht, und zwar UNABHÄNGIG vom Häkchen.
 *
 * Gespiegeltes Server-Verhalten (`POST /billing/generate-all`):
 *   • `readyOnly` überspringt nur Kunden mit OFFENEN Terminen.
 *   • kein abrechenbarer Anteil (`unbilledAppointmentCount === 0`) → übersprungen.
 *   • dokumentierte Termine ohne gültigen Nachweis → `confirmPartial` entscheidet.
 */

const BASE_CUSTOMER: Omit<BillingCustomerItem, "id"> = {
  name: "Kunde",
  vorname: "Max",
  nachname: "Muster",
  billingType: "selbstzahler",
  status: "aktiv",
  completedAppointments: 0,
  coveredAppointments: 0,
  openAppointments: 0,
  eligibility: { status: "eligible", reason: null },
  signedAppointmentCount: 0,
  unbilledAppointmentCount: 0,
  actualAmountCents: 0,
  plannedAmountCents: 0,
};

/** Vollständig dokumentiert, vollständig signiert, ein offener Rechnungsposten. */
function readyCustomer(id: number, extra: Partial<BillingCustomerItem> = {}) {
  return makeCustomer({
    id,
    completedAppointments: 1,
    coveredAppointments: 1,
    signedAppointmentCount: 1,
    unbilledAppointmentCount: 1,
    ...extra,
  });
}

function makeCustomer(
  overrides: Partial<BillingCustomerItem> & { id: number },
): BillingCustomerItem {
  return { ...BASE_CUSTOMER, ...overrides };
}

function Harness({ customers }: { customers: BillingCustomerItem[] }) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const generateAllMutation = {
    mutate: vi.fn(),
    isPending: false,
  } as never;
  return (
    <GenerateAllDialog
      open
      setOpen={vi.fn()}
      generateAllProgress={null}
      setGenerateAllProgress={vi.fn()}
      generateAllMutation={generateAllMutation}
      customers={customers}
      selectedMonth={5}
      selectedYear={2026}
      closeButtonRef={closeButtonRef}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("GenerateAllDialog — „werden erstellt“-Zähler (Task #1780/#1905)", () => {
  // 2 bereit, 1 ohne gültigen Nachweis (nichts abrechenbar), 1 mit offenen Terminen.
  const MIXED: BillingCustomerItem[] = [
    readyCustomer(1),
    readyCustomer(2),
    makeCustomer({
      id: 3, // kein signierter LN ⇒ nichts abrechenbar, KEINE offenen Termine
      billingType: "pflegekasse_gesetzlich",
      completedAppointments: 1,
      coveredAppointments: 1,
      eligibility: { status: "blocked", reason: "customer_signature_required" },
    }),
    readyCustomer(4, { openAppointments: 2 }), // abrechenbar, aber offene Termine
  ];

  it("readyOnly=true: zählt nur bereite Kunden ohne offene Termine", () => {
    render(<Harness customers={MIXED} />);

    // Default ist readyOnly=true.
    expect(
      screen.getByTestId("checkbox-ready-only").getAttribute("data-state"),
    ).toBe("checked");

    // Von 4 berechtigten Kunden werden nur die 2 „ready" erstellt.
    expect(
      screen.getByTestId("text-generate-all-will-create").textContent,
    ).toBe("2");
    expect(
      screen.getByTestId("text-generate-all-will-skip").textContent,
    ).toBe("2");
    expect(screen.getByTestId("text-generate-all-count").textContent).toBe("4");
  });

  // Task #1783 hat das Verhalten bewusst geändert (Komponente: `a48bb91a`,
  // nach dem #1780-Test `0f3171dd`): signatur-blockierte Kunden werden
  // SERVERSEITIG auch dann übersprungen, wenn `readyOnly` aus ist. Der
  // Vorab-Zähler wurde daran angeglichen, damit Schätzung und Ergebnis
  // übereinstimmen — vorher versprach der Dialog mehr, als er lieferte.
  //
  // Der frühere Titel „überspringt keine" und die Erwartung 4/0 stammen aus der
  // Zeit davor. `readyOnly` steuert nur noch die OFFENEN TERMINE, nicht mehr
  // das Unterschrifts-Gate.
  it("readyOnly=false: nimmt Kunden mit offenen Terminen dazu, blockierte NICHT", () => {
    render(<Harness customers={MIXED} />);

    fireEvent.click(screen.getByTestId("checkbox-ready-only"));

    // 3 = die zwei „ready" + der eligible mit offenen Terminen (id 4).
    // Der signatur-blockierte (id 3) bleibt aussen vor.
    expect(
      screen.getByTestId("text-generate-all-will-create").textContent,
    ).toBe("3");
    expect(
      screen.getByTestId("text-generate-all-will-skip").textContent,
    ).toBe("1");
  });

  it("blockierte Kunden ohne offene Termine blähen den Zähler nicht auf", () => {
    // Nur ein signatur-blockierter Kunde: „ready"-Zähler MUSS 0 sein,
    // obwohl er keine offenen Termine mehr hat.
    const blockedOnly = [
      makeCustomer({
        id: 10,
        billingType: "pflegekasse_gesetzlich",
        completedAppointments: 1,
        coveredAppointments: 1,
        eligibility: { status: "blocked", reason: "customer_signature_required" },
      }),
    ];
    render(<Harness customers={blockedOnly} />);

    expect(
      screen.getByTestId("text-generate-all-will-create").textContent,
    ).toBe("0");
    expect(
      screen.getByTestId("text-generate-all-will-skip").textContent,
    ).toBe("1");
  });

  // ── Task #1905 (absorbiert #1895) — die Vorschau-Lüge ─────────────────────
  // Der Mischkunde aus den echten Juli-2026-Daten: 5 dokumentiert, 5 abgedeckt,
  // 4 kundensigniert. Er ist `eligible` (der signierte Teil ist abrechenbar) und
  // hat KEINE offenen Termine — die alte Formel zählte ihn deshalb als „wird
  // erstellt", obwohl der Server ihn ohne `confirmPartial` überspringt.
  const MISCHKUNDE = makeCustomer({
    id: 96,
    billingType: "pflegekasse_gesetzlich",
    completedAppointments: 5,
    coveredAppointments: 5,
    signedAppointmentCount: 4,
    unbilledAppointmentCount: 4,
    eligibility: { status: "eligible", reason: null },
  });

  it("Mischkunde zählt OHNE confirmPartial NICHT als „wird erstellt“", () => {
    render(<Harness customers={[MISCHKUNDE]} />);

    expect(
      screen.getByTestId("checkbox-confirm-partial-bulk").getAttribute("data-state"),
    ).toBe("unchecked");
    expect(
      screen.getByTestId("text-generate-all-will-create").textContent,
    ).toBe("0");
    expect(
      screen.getByTestId("text-generate-all-will-skip").textContent,
    ).toBe("1");
    // Bewusst: ein Lauf, der 0 Rechnungen erzeugen würde, ist nicht startbar.
    // Wer den signierten Teil dieser Kunden abrechnen will, setzt das Häkchen —
    // also genau die Option mit Abrechnungsfolge. Die Information, WELCHE Termine
    // fehlen, steht unabhängig davon in der Liste (Cluster „Leistungsnachweis
    // fehlt") und im Einzel-Dialog (`excludedAppointments`).
    expect(
      screen.getByTestId("button-confirm-generate-all").getAttribute("disabled"),
    ).not.toBeNull();
  });

  it("Mischkunde zählt MIT confirmPartial als „wird erstellt“", () => {
    render(<Harness customers={[MISCHKUNDE]} />);

    fireEvent.click(screen.getByTestId("checkbox-confirm-partial-bulk"));

    expect(
      screen.getByTestId("text-generate-all-will-create").textContent,
    ).toBe("1");
    expect(
      screen.getByTestId("text-generate-all-will-skip").textContent,
    ).toBe("0");
  });

  it("confirmPartial macht einen Kunden OHNE abrechenbaren Anteil nicht erstellbar", () => {
    // Ohne signierten LN gibt es nichts zu berechnen — auch die bewusste
    // Teil-Abrechnung erzeugt hier keine Rechnung (der Server überspringt).
    const nothingBillable = [
      makeCustomer({
        id: 20,
        billingType: "pflegekasse_gesetzlich",
        completedAppointments: 2,
        coveredAppointments: 2,
        eligibility: { status: "blocked", reason: "customer_signature_required" },
      }),
    ];
    render(<Harness customers={nothingBillable} />);

    fireEvent.click(screen.getByTestId("checkbox-confirm-partial-bulk"));

    expect(
      screen.getByTestId("text-generate-all-will-create").textContent,
    ).toBe("0");
  });
});
