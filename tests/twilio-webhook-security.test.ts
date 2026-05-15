/**
 * Task #450 — Twilio-Webhook-Härtung.
 *
 * Prüft:
 *  - HMAC-Callback-Token: Sign/Verify-Roundtrip, Tampering, Expiry, Replay
 *  - `escapeXml` ist zentralisiert und es gibt KEINE lokalen Duplikate mehr
 *    in den Twilio-Pfaden (außer dem zentralen `server/lib/xml.ts`).
 *  - `verifyTwilioSignature`-Middleware: lehnt unsigned/tampered ab, lässt
 *    signed durch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import twilio from "twilio";
import { signCallbackToken, verifyCallbackToken } from "../server/lib/twilio-callback-token";
import { escapeXml } from "../server/lib/xml";

const KEY = "a".repeat(64);

beforeEach(() => {
  process.env.ENCRYPTION_KEY = KEY;
});

describe("Twilio-Callback-Token (HMAC)", () => {
  it("signiert und verifiziert einen gültigen Token", () => {
    const token = signCallbackToken({ prospectId: 4711 });
    const res = verifyCallbackToken(token);
    expect(res.ok).toBe(true);
    expect(res.prospectId).toBe(4711);
  });

  it("lehnt einen fehlenden Token ab", () => {
    expect(verifyCallbackToken(undefined).ok).toBe(false);
    expect(verifyCallbackToken("").ok).toBe(false);
    expect(verifyCallbackToken(null).ok).toBe(false);
  });

  it("lehnt einen Token mit manipuliertem Body ab (Signatur passt nicht)", () => {
    const token = signCallbackToken({ prospectId: 1 });
    const [, sig] = token.split(".");
    // Versuch, prospectId von 1 auf 99999 umzubiegen — Signatur wurde aber
    // über den Original-Body berechnet.
    const tamperedBody = Buffer.from(JSON.stringify({ prospectId: 99999, exp: Date.now() + 60000 }), "utf8")
      .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const tampered = `${tamperedBody}.${sig}`;
    const res = verifyCallbackToken(tampered);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("bad_signature");
  });

  it("lehnt einen Token mit manipulierter Signatur ab", () => {
    const token = signCallbackToken({ prospectId: 1 });
    const [body] = token.split(".");
    const res = verifyCallbackToken(`${body}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("bad_signature");
  });

  it("lehnt einen abgelaufenen Token ab", () => {
    const past = Date.now() - 10_000;
    const token = signCallbackToken({ prospectId: 7 }, 1, past); // exp = past + 1ms
    const res = verifyCallbackToken(token);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("expired");
  });

  it("lehnt einen Token mit anderem Server-Secret ab (Replay über Provider-Wechsel)", () => {
    const token = signCallbackToken({ prospectId: 1 });
    process.env.ENCRYPTION_KEY = "b".repeat(64);
    // Module cached den Key nicht — verify nutzt aktuelle env.
    const res = verifyCallbackToken(token);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("bad_signature");
  });

  it("lehnt malformierte Tokens ab", () => {
    expect(verifyCallbackToken("nodot").ok).toBe(false);
    expect(verifyCallbackToken(".").ok).toBe(false);
    expect(verifyCallbackToken("a.").ok).toBe(false);
    expect(verifyCallbackToken(".b").ok).toBe(false);
  });
});

describe("escapeXml ist zentralisiert (Task #450)", () => {
  it("escaped die fünf XML-Entities", () => {
    expect(escapeXml(`<a href="x" foo='y'>&amp;</a>`)).toBe(
      "&lt;a href=&quot;x&quot; foo=&apos;y&apos;&gt;&amp;amp;&lt;/a&gt;",
    );
  });

  it("keine lokalen escapeXml-Kopien in webhook-twilio.ts / twilio-call-bridge.ts", () => {
    const route = readFileSync(join(process.cwd(), "server/routes/webhook-twilio.ts"), "utf8");
    const service = readFileSync(join(process.cwd(), "server/services/twilio-call-bridge.ts"), "utf8");
    expect(route).not.toMatch(/function escapeXml\b/);
    expect(service).not.toMatch(/function escapeXml\b/);
    expect(route).toMatch(/from "\.\.\/lib\/xml"/);
    expect(service).toMatch(/from "\.\.\/lib\/xml"/);
  });
});

// getCachedCompanySettings global mocken, damit kein DB-Zugriff nötig ist.
// Hinweis: `vi.mock` wird gehoistet — der Token muss als Literal im Factory
// stehen, nicht über eine äußere Variable.
vi.mock("../server/services/cache", () => ({
  getCachedCompanySettings: async () => ({ twilioAuthToken: "test-auth-token-12345" }),
}));

describe("verifyTwilioSignature middleware (Fuzz: signed/unsigned/tampered)", () => {
  const AUTH_TOKEN = "test-auth-token-12345";

  // Import nach dem Mock laden.
  let verifyTwilioSignature: typeof import("../server/middleware/twilio-auth").verifyTwilioSignature;
  beforeEach(async () => {
    verifyTwilioSignature = (await import("../server/middleware/twilio-auth")).verifyTwilioSignature;
  });

  function makeReqRes(opts: { signature?: string; body: Record<string, string>; url?: string }) {
    const fullUrl = opts.url ?? "https://example.com/api/webhook/twilio/gather";
    const u = new URL(fullUrl);
    const req: any = {
      headers: {
        "x-twilio-signature": opts.signature,
        "x-forwarded-proto": u.protocol.replace(":", ""),
        host: u.host,
      },
      protocol: u.protocol.replace(":", ""),
      originalUrl: u.pathname + u.search,
      body: opts.body,
      get(name: string) {
        return this.headers[name.toLowerCase()];
      },
    };
    const res: any = {
      statusCode: 200,
      sent: undefined,
      status(code: number) { this.statusCode = code; return this; },
      send(payload: any) { this.sent = payload; return this; },
    };
    const next = vi.fn();
    return { req, res, next, fullUrl };
  }

  function sign(url: string, params: Record<string, string>): string {
    // Twilio-Signatur-Algorithmus: base64(HMAC-SHA1(authToken, url + sortedParams))
    return (twilio as any).getExpectedTwilioSignature(AUTH_TOKEN, url, params);
  }

  it("lehnt Request ohne X-Twilio-Signature ab (403)", async () => {
    const { req, res, next } = makeReqRes({ body: { Digits: "1" } });
    await verifyTwilioSignature(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("lehnt Request mit falscher Signatur ab (403)", async () => {
    const { req, res, next } = makeReqRes({ body: { Digits: "1" }, signature: "garbage-not-base64-valid-hmac" });
    await verifyTwilioSignature(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("lehnt Request mit manipuliertem Body ab (Signatur passt nicht mehr)", async () => {
    const { req, res, next, fullUrl } = makeReqRes({ body: { Digits: "1" } });
    const validSig = sign(fullUrl, { Digits: "1" });
    // Manipulation: Body wird nach Signierung verändert.
    req.headers["x-twilio-signature"] = validSig;
    req.body = { Digits: "9" };
    await verifyTwilioSignature(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("lässt korrekt signierten Request durch (next aufgerufen)", async () => {
    const { req, res, next, fullUrl } = makeReqRes({ body: { Digits: "1", CallStatus: "completed" } });
    req.headers["x-twilio-signature"] = sign(fullUrl, { Digits: "1", CallStatus: "completed" });
    await verifyTwilioSignature(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
