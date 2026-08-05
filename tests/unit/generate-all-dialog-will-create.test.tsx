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
 * Task #1775 hat den Zähler an `eligibility.status === "eligible"` UND
 * „keine offenen Termine" gekoppelt (= Karten-Gruppe „Bereit zum Abrechnen").
 * Dieser Test zementiert die Kopplung mit gemischten Kunden:
 *   • eligible & keine offenen Termine  → zählt mit
 *   • blocked (customer_signature_required), keine offenen Termine → zählt NICHT
 *   • eligible, aber offene Termine → zählt NICHT (bei readyOnly=true)
 * Abgedeckt für readyOnly=true (Default) und readyOnly=false.
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
};

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

describe("GenerateAllDialog — „werden erstellt“-Zähler (Task #1780)", () => {
  // 2 eligible ohne offene Termine, 1 signatur-blockiert, 1 mit offenen Terminen.
  const MIXED: BillingCustomerItem[] = [
    makeCustomer({ id: 1 }), // eligible, ready
    makeCustomer({ id: 2 }), // eligible, ready
    makeCustomer({
      id: 3, // blocked: Kundenunterschrift fehlt, KEINE offenen Termine
      billingType: "pflegekasse_gesetzlich",
      eligibility: { status: "blocked", reason: "customer_signature_required" },
    }),
    makeCustomer({ id: 4, openAppointments: 2 }), // eligible, aber offene Termine
  ];

  it("readyOnly=true: zählt nur eligible-und-nicht-offene Kunden", () => {
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
});
