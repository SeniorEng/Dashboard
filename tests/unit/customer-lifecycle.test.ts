import { describe, it, expect } from "vitest";
import {
  classifyActiveCustomerLifecycle,
  isGekuendigterAktiverKunde,
  isLaufenderAktiverKunde,
  ACTIVE_CUSTOMER_LIFECYCLE_LABELS,
  TERMINATED_CONTRACT_STATUS,
} from "@shared/domain/customers";

describe("classifyActiveCustomerLifecycle (Task #1194)", () => {
  it("klassifiziert einen aktiven Kunden ohne Vertragsende/Kündigung als 'laufend'", () => {
    expect(
      classifyActiveCustomerLifecycle({ status: "aktiv", contractEnd: null, contractStatus: null }),
    ).toBe("laufend");
  });

  it("klassifiziert einen aktiven Kunden mit gesetztem Vertragsende als 'gekuendigt'", () => {
    expect(
      classifyActiveCustomerLifecycle({ status: "aktiv", contractEnd: "2026-01-31", contractStatus: null }),
    ).toBe("gekuendigt");
  });

  it("klassifiziert einen aktiven Kunden mit Vertragsstatus 'terminated' als 'gekuendigt'", () => {
    expect(
      classifyActiveCustomerLifecycle({ status: "aktiv", contractEnd: null, contractStatus: TERMINATED_CONTRACT_STATUS }),
    ).toBe("gekuendigt");
  });

  it("behandelt einen leeren contractEnd-String wie 'kein Vertragsende' (laufend)", () => {
    expect(
      classifyActiveCustomerLifecycle({ status: "aktiv", contractEnd: "   ", contractStatus: null }),
    ).toBe("laufend");
  });

  it("ignoriert andere Vertragsstatus (z.B. 'paused') und bleibt 'laufend'", () => {
    expect(
      classifyActiveCustomerLifecycle({ status: "aktiv", contractEnd: null, contractStatus: "paused" }),
    ).toBe("laufend");
  });

  it("gibt null zurück, wenn der Kunde nicht aktiv ist", () => {
    expect(
      classifyActiveCustomerLifecycle({ status: "inaktiv", contractEnd: "2026-01-31", contractStatus: TERMINATED_CONTRACT_STATUS }),
    ).toBeNull();
    expect(
      classifyActiveCustomerLifecycle({ status: "gekuendigt", contractEnd: null, contractStatus: null }),
    ).toBeNull();
    expect(
      classifyActiveCustomerLifecycle({ status: null, contractEnd: null, contractStatus: null }),
    ).toBeNull();
    expect(
      classifyActiveCustomerLifecycle({ status: undefined, contractEnd: null, contractStatus: null }),
    ).toBeNull();
  });
});

describe("isGekuendigterAktiverKunde / isLaufenderAktiverKunde", () => {
  it("isGekuendigterAktiverKunde ist nur für aktiv + beendet/gekündigt true", () => {
    expect(isGekuendigterAktiverKunde({ status: "aktiv", contractEnd: "2026-01-31" })).toBe(true);
    expect(isGekuendigterAktiverKunde({ status: "aktiv", contractStatus: TERMINATED_CONTRACT_STATUS })).toBe(true);
    expect(isGekuendigterAktiverKunde({ status: "aktiv", contractEnd: null })).toBe(false);
    expect(isGekuendigterAktiverKunde({ status: "inaktiv", contractEnd: "2026-01-31" })).toBe(false);
  });

  it("isLaufenderAktiverKunde ist nur für aktiv + nicht beendet/gekündigt true", () => {
    expect(isLaufenderAktiverKunde({ status: "aktiv", contractEnd: null })).toBe(true);
    expect(isLaufenderAktiverKunde({ status: "aktiv", contractEnd: "2026-01-31" })).toBe(false);
    expect(isLaufenderAktiverKunde({ status: "inaktiv", contractEnd: null })).toBe(false);
  });

  it("die beiden Prädikate sind innerhalb der aktiven Kohorte komplementär", () => {
    const inputs = [
      { status: "aktiv", contractEnd: null, contractStatus: null },
      { status: "aktiv", contractEnd: "2026-01-31", contractStatus: null },
      { status: "aktiv", contractEnd: null, contractStatus: TERMINATED_CONTRACT_STATUS },
    ];
    for (const input of inputs) {
      expect(isLaufenderAktiverKunde(input)).toBe(!isGekuendigterAktiverKunde(input));
    }
  });
});

describe("ACTIVE_CUSTOMER_LIFECYCLE_LABELS", () => {
  it("liefert die deutschen UI-Labels", () => {
    expect(ACTIVE_CUSTOMER_LIFECYCLE_LABELS.laufend).toBe("Laufend");
    expect(ACTIVE_CUSTOMER_LIFECYCLE_LABELS.gekuendigt).toBe("Gekündigt");
  });
});
