import { describe, it, expect } from "vitest";
import { isDocumentationOverdue } from "@shared/domain/appointments";

const NOW = new Date("2026-05-15T14:30:00");

describe("isDocumentationOverdue", () => {
  it("markiert Status 'documenting' immer als überfällig (auch heute)", () => {
    expect(
      isDocumentationOverdue(
        { status: "documenting", date: "2026-05-15", scheduledStart: "10:00", scheduledEnd: "11:00", durationPromised: 60 },
        NOW,
      ),
    ).toBe(true);
    expect(
      isDocumentationOverdue(
        { status: "documenting", date: "2026-04-02", scheduledStart: "10:00", scheduledEnd: "11:00", durationPromised: 60 },
        NOW,
      ),
    ).toBe(true);
  });

  it("markiert 'scheduled' an einem vergangenen Tag als überfällig", () => {
    expect(
      isDocumentationOverdue(
        { status: "scheduled", date: "2026-05-14", scheduledStart: "10:00", scheduledEnd: "11:00", durationPromised: 60 },
        NOW,
      ),
    ).toBe(true);
  });

  it("markiert 'scheduled' am heutigen Tag nur überfällig, wenn das Ende in der Vergangenheit liegt", () => {
    expect(
      isDocumentationOverdue(
        { status: "scheduled", date: "2026-05-15", scheduledStart: "10:00", scheduledEnd: "11:00", durationPromised: 60 },
        NOW,
      ),
    ).toBe(true);
    expect(
      isDocumentationOverdue(
        { status: "scheduled", date: "2026-05-15", scheduledStart: "16:00", scheduledEnd: "17:00", durationPromised: 60 },
        NOW,
      ),
    ).toBe(false);
  });

  it("nutzt durationPromised, wenn kein scheduledEnd vorhanden ist", () => {
    expect(
      isDocumentationOverdue(
        { status: "scheduled", date: "2026-05-15", scheduledStart: "09:00", scheduledEnd: null, durationPromised: 60 },
        NOW,
      ),
    ).toBe(true);
    expect(
      isDocumentationOverdue(
        { status: "scheduled", date: "2026-05-15", scheduledStart: "14:00", scheduledEnd: null, durationPromised: 60 },
        NOW,
      ),
    ).toBe(false);
  });

  it("markiert 'scheduled' in der Zukunft NICHT als überfällig", () => {
    expect(
      isDocumentationOverdue(
        { status: "scheduled", date: "2026-05-20", scheduledStart: "10:00", scheduledEnd: "11:00", durationPromised: 60 },
        NOW,
      ),
    ).toBe(false);
  });

  it.each([
    "completed",
    "cancelled",
    "expired_unsigned",
    "customer_no_show",
    "in-progress",
  ] as const)("markiert Status '%s' nicht als überfällig (auch nicht in der Vergangenheit)", (status) => {
    expect(
      isDocumentationOverdue(
        { status, date: "2026-04-02", scheduledStart: "10:00", scheduledEnd: "11:00", durationPromised: 60 },
        NOW,
      ),
    ).toBe(false);
  });
});
