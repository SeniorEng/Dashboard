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

describe("Task #1119: deriveAppointmentDisplayStatus", () => {
  it("offener Monat ⇒ persistierter Status bleibt unverändert", () => {
    expect(
      deriveAppointmentDisplayStatus("completed", {
        documentedAndSigned: false,
        isMonthClosed: false,
      }),
    ).toBe("completed");
    expect(
      deriveAppointmentDisplayStatus("scheduled", {
        documentedAndSigned: false,
        isMonthClosed: false,
      }),
    ).toBe("scheduled");
  });

  it("geschlossener Monat + nicht dokumentiert&unterschrieben ⇒ expired_unsigned (abgeleitet)", () => {
    expect(
      deriveAppointmentDisplayStatus("completed", {
        documentedAndSigned: false,
        isMonthClosed: true,
      }),
    ).toBe("expired_unsigned");
    expect(
      deriveAppointmentDisplayStatus("scheduled", {
        documentedAndSigned: false,
        isMonthClosed: true,
      }),
    ).toBe("expired_unsigned");
  });

  it("geschlossener Monat + dokumentiert&unterschrieben ⇒ completed bleibt", () => {
    expect(
      deriveAppointmentDisplayStatus("completed", {
        documentedAndSigned: true,
        isMonthClosed: true,
      }),
    ).toBe("completed");
  });

  it("cancelled / customer_no_show sind dokumentierte Terminal-Status — nie expired_unsigned", () => {
    expect(
      deriveAppointmentDisplayStatus("cancelled", {
        documentedAndSigned: false,
        isMonthClosed: true,
      }),
    ).toBe("cancelled");
    expect(
      deriveAppointmentDisplayStatus("customer_no_show", {
        documentedAndSigned: false,
        isMonthClosed: true,
      }),
    ).toBe("customer_no_show");
  });
});
