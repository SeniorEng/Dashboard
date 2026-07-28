/**
 * Task #1840 — Safe-by-default Stub-Gate für ausgehende Nachrichten
 * (server/lib/messaging-transport.ts).
 *
 * Kern-Garantie: Außerhalb der Produktion wird NIE real gesendet, es sei denn,
 * der Kanal wird explizit auf "real" geschaltet. Das schützt die Hetzner-Dev-
 * Umgebung (Prod-Kopie-DB mit echten Provider-Tokens) vor echten Mails/
 * WhatsApp-Nachrichten/Anrufen.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isStubTransport } from "../../server/lib/messaging-transport";

const KEYS = ["NODE_ENV", "EMAIL_TRANSPORT", "WHATSAPP_TRANSPORT", "TWILIO_TRANSPORT"] as const;

describe("safe-by-default Stub-Gate (Task #1840)", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("Produktion ohne Override: real (kein Stub)", () => {
    process.env.NODE_ENV = "production";
    expect(isStubTransport("email")).toBe(false);
    expect(isStubTransport("whatsapp")).toBe(false);
    expect(isStubTransport("twilio")).toBe(false);
  });

  it("Nicht-Produktion ohne Override: STUB (development/test/unset)", () => {
    for (const env of ["development", "test", undefined]) {
      if (env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = env;
      expect(isStubTransport("email")).toBe(true);
      expect(isStubTransport("whatsapp")).toBe(true);
      expect(isStubTransport("twilio")).toBe(true);
    }
  });

  it("<CHANNEL>_TRANSPORT=real erzwingt real auch außerhalb der Produktion", () => {
    process.env.NODE_ENV = "development";
    process.env.WHATSAPP_TRANSPORT = "real";
    expect(isStubTransport("whatsapp")).toBe(false);
    // andere Kanäle bleiben Stub (Kanal-Unabhängigkeit)
    expect(isStubTransport("email")).toBe(true);
    expect(isStubTransport("twilio")).toBe(true);
  });

  it("<CHANNEL>_TRANSPORT=stub erzwingt Stub auch in Produktion", () => {
    process.env.NODE_ENV = "production";
    process.env.TWILIO_TRANSPORT = "stub";
    expect(isStubTransport("twilio")).toBe(true);
    expect(isStubTransport("email")).toBe(false);
  });

  it("ist unabhängig von Groß-/Kleinschreibung und Whitespace", () => {
    process.env.NODE_ENV = "development";
    process.env.EMAIL_TRANSPORT = "  REAL  ";
    expect(isStubTransport("email")).toBe(false);
  });
});
