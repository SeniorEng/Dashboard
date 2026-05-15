import { describe, it, expect } from "vitest";
import {
  diagnoseDocumentation,
  type DocumentationDiagnosisInput,
} from "../shared/domain/documentation-diagnostics";

const baseInput: DocumentationDiagnosisInput = {
  status: "documenting",
  date: "2026-04-02",
  today: "2026-05-15",
  actualStart: "13:00:00",
  actualEnd: "14:00:00",
  hasSignatureData: false,
  documentedServicesCount: 0,
  lastActivityAt: null,
};

describe("diagnoseDocumentation", () => {
  it("status=completed → INFO/COMPLETED", () => {
    const d = diagnoseDocumentation({ ...baseInput, status: "completed" });
    expect(d.code).toBe("COMPLETED");
    expect(d.severity).toBe("info");
  });

  it("status=expired_unsigned → ERROR/EXPIRED_UNSIGNED", () => {
    const d = diagnoseDocumentation({ ...baseInput, status: "expired_unsigned" });
    expect(d.code).toBe("EXPIRED_UNSIGNED");
    expect(d.severity).toBe("error");
  });

  it("status=scheduled in der Vergangenheit → WARNING/NOT_STARTED", () => {
    const d = diagnoseDocumentation({
      ...baseInput,
      status: "scheduled",
      date: "2026-04-02",
      today: "2026-05-15",
      actualStart: null,
      actualEnd: null,
    });
    expect(d.code).toBe("NOT_STARTED");
    expect(d.severity).toBe("warning");
  });

  it("status=scheduled in der Zukunft → INFO/NOT_STARTED", () => {
    const d = diagnoseDocumentation({
      ...baseInput,
      status: "scheduled",
      date: "2026-06-01",
      today: "2026-05-15",
      actualStart: null,
      actualEnd: null,
    });
    expect(d.code).toBe("NOT_STARTED");
    expect(d.severity).toBe("info");
  });

  it("status=documenting ohne Services → WARNING/NO_SERVICES", () => {
    const d = diagnoseDocumentation({ ...baseInput, documentedServicesCount: 0 });
    expect(d.code).toBe("NO_SERVICES");
    expect(d.severity).toBe("warning");
  });

  it("status=documenting mit Services aber ohne Endzeit → WARNING/MISSING_END_TIME", () => {
    const d = diagnoseDocumentation({
      ...baseInput,
      documentedServicesCount: 2,
      actualEnd: null,
    });
    expect(d.code).toBe("MISSING_END_TIME");
  });

  it("status=documenting mit Services + Endzeit, ohne Unterschrift → WARNING/MISSING_SIGNATURE", () => {
    const d = diagnoseDocumentation({
      ...baseInput,
      documentedServicesCount: 2,
      hasSignatureData: false,
    });
    expect(d.code).toBe("MISSING_SIGNATURE");
    expect(d.severity).toBe("warning");
  });

  it("status=documenting mit allem → WARNING/READY_BUT_NOT_FINALIZED", () => {
    const d = diagnoseDocumentation({
      ...baseInput,
      documentedServicesCount: 2,
      hasSignatureData: true,
    });
    expect(d.code).toBe("READY_BUT_NOT_FINALIZED");
    expect(d.severity).toBe("warning");
  });

  it("status=in-progress → WARNING/IN_PROGRESS", () => {
    const d = diagnoseDocumentation({ ...baseInput, status: "in-progress", actualEnd: null });
    expect(d.code).toBe("IN_PROGRESS");
  });

  it("status=customer_no_show → INFO/NO_SHOW", () => {
    const d = diagnoseDocumentation({ ...baseInput, status: "customer_no_show" });
    expect(d.code).toBe("NO_SHOW");
    expect(d.severity).toBe("info");
  });

  it("status=cancelled → INFO/CANCELLED", () => {
    const d = diagnoseDocumentation({ ...baseInput, status: "cancelled" });
    expect(d.code).toBe("CANCELLED");
  });
});
