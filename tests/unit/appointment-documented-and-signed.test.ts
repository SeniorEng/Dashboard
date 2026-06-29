/**
 * Task #1119 — Unit-Tests für das geteilte „dokumentiert & unterschrieben"-Prädikat
 * und die abgeleitete Anzeige-Status-Logik.
 *
 * `isAppointmentDocumentedAndSigned` ist die EINZIGE Quelle der Wahrheit; die
 * server-seitigen SQL-Spiegelungen in `server/lib/appointment-signed.ts` müssen
 * exakt diesem Verhalten folgen. `deriveAppointmentDisplayStatus` erzeugt
 * `expired_unsigned` („Nicht abgerechnet") ausschließlich zur Laufzeit — es wird
 * nie persistiert.
 */
import { describe, it, expect } from "vitest";
import {
  isAppointmentDocumentedAndSigned,
  deriveAppointmentDisplayStatus,
} from "@shared/domain/appointments";

describe("Task #1119: isAppointmentDocumentedAndSigned", () => {
  it("completed + direkte Unterschrift ⇒ true", () => {
    expect(
      isAppointmentDocumentedAndSigned({
        status: "completed",
        hasDirectSignature: true,
        hasSignedServiceRecord: false,
      }),
    ).toBe(true);
  });

  it("completed + unterschriebener Leistungsnachweis ⇒ true", () => {
    expect(
      isAppointmentDocumentedAndSigned({
        status: "completed",
        hasDirectSignature: false,
        hasSignedServiceRecord: true,
      }),
    ).toBe(true);
  });

  it("completed ohne jegliche Unterschrift ⇒ false", () => {
    expect(
      isAppointmentDocumentedAndSigned({
        status: "completed",
        hasDirectSignature: false,
        hasSignedServiceRecord: false,
      }),
    ).toBe(false);
  });

  it("nicht-completed Status ⇒ immer false, selbst mit Unterschrift", () => {
    for (const status of ["scheduled", "documenting", "expired_unsigned", "cancelled"]) {
      expect(
        isAppointmentDocumentedAndSigned({
          status,
          hasDirectSignature: true,
          hasSignedServiceRecord: true,
        }),
      ).toBe(false);
    }
  });
});

describe("Task #1496: deriveAppointmentDisplayStatus (von Unterschrift entkoppelt)", () => {
  it("offener Monat ⇒ persistierter Status bleibt unverändert", () => {
    expect(
      deriveAppointmentDisplayStatus("completed", { isMonthClosed: false }),
    ).toBe("completed");
    expect(
      deriveAppointmentDisplayStatus("scheduled", { isMonthClosed: false }),
    ).toBe("scheduled");
  });

  it("geschlossener Monat + NICHT dokumentiert (nicht completed) ⇒ expired_unsigned (abgeleitet)", () => {
    expect(
      deriveAppointmentDisplayStatus("scheduled", { isMonthClosed: true }),
    ).toBe("expired_unsigned");
    expect(
      deriveAppointmentDisplayStatus("documenting", { isMonthClosed: true }),
    ).toBe("expired_unsigned");
  });

  it("geschlossener Monat + dokumentiert (completed) ⇒ bleibt completed, UNABHÄNGIG von Unterschrift", () => {
    expect(
      deriveAppointmentDisplayStatus("completed", { isMonthClosed: true }),
    ).toBe("completed");
  });

  it("cancelled / customer_no_show sind dokumentierte Terminal-Status — nie expired_unsigned", () => {
    expect(
      deriveAppointmentDisplayStatus("cancelled", { isMonthClosed: true }),
    ).toBe("cancelled");
    expect(
      deriveAppointmentDisplayStatus("customer_no_show", { isMonthClosed: true }),
    ).toBe("customer_no_show");
  });
});
