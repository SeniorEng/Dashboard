import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildTwilioRequest,
  resolveTwilioConfigFromSettings,
  normalizeWhatsAppRecipient,
  whatsAppService,
} from "../server/services/whatsapp-service";

const ENV_SID = "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const ENV_TOKEN = "env-auth-token-123";

describe("WhatsApp Twilio Service – Konfigurations-Auflösung", () => {
  const baseSettings = {
    whatsappEnabled: true,
    whatsappFromOrService: "+4915112345678",
    whatsappAccessToken: null as string | null,
  };

  it("liefert null, wenn whatsappEnabled = false", () => {
    process.env.TWILIO_ACCOUNT_SID = ENV_SID;
    process.env.TWILIO_AUTH_TOKEN = ENV_TOKEN;
    expect(
      resolveTwilioConfigFromSettings({ ...baseSettings, whatsappEnabled: false }),
    ).toBeNull();
  });

  it("liefert null, wenn kein Sender konfiguriert ist", () => {
    process.env.TWILIO_ACCOUNT_SID = ENV_SID;
    process.env.TWILIO_AUTH_TOKEN = ENV_TOKEN;
    expect(
      resolveTwilioConfigFromSettings({ ...baseSettings, whatsappFromOrService: null }),
    ).toBeNull();
  });

  it("liefert null, wenn TWILIO_ACCOUNT_SID fehlt", () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    process.env.TWILIO_AUTH_TOKEN = ENV_TOKEN;
    expect(resolveTwilioConfigFromSettings(baseSettings)).toBeNull();
  });

  it("nutzt process.env-Auth-Token, wenn kein Override gesetzt ist", () => {
    process.env.TWILIO_ACCOUNT_SID = ENV_SID;
    process.env.TWILIO_AUTH_TOKEN = ENV_TOKEN;
    const cfg = resolveTwilioConfigFromSettings(baseSettings);
    expect(cfg?.authToken).toBe(ENV_TOKEN);
    expect(cfg?.from).toBe("+4915112345678");
    expect(cfg?.messagingServiceSid).toBeUndefined();
  });

  it("nutzt den DB-Override-Token, wenn vorhanden", () => {
    process.env.TWILIO_ACCOUNT_SID = ENV_SID;
    process.env.TWILIO_AUTH_TOKEN = ENV_TOKEN;
    const cfg = resolveTwilioConfigFromSettings({
      ...baseSettings,
      whatsappAccessToken: "override-token-xyz",
    });
    expect(cfg?.authToken).toBe("override-token-xyz");
  });

  it("erkennt Messaging-Service-SID (MG…) als messagingServiceSid statt from", () => {
    process.env.TWILIO_ACCOUNT_SID = ENV_SID;
    process.env.TWILIO_AUTH_TOKEN = ENV_TOKEN;
    const cfg = resolveTwilioConfigFromSettings({
      ...baseSettings,
      whatsappFromOrService: "MGabcdefabcdefabcdefabcdefabcdef00",
    });
    expect(cfg?.messagingServiceSid).toBe("MGabcdefabcdefabcdefabcdefabcdef00");
    expect(cfg?.from).toBeUndefined();
  });
});

describe("WhatsApp Twilio Service – Request-Payload", () => {
  const fromConfig = {
    accountSid: ENV_SID,
    authToken: ENV_TOKEN,
    from: "+4915112345678",
  };

  it("baut korrektes Twilio-Payload mit Content-Variablen", () => {
    const payload = buildTwilioRequest(
      {
        phoneNumber: "+491701234567",
        templateName: "HX0123456789abcdef0123456789abcdef",
        templateParams: ["Anna", "10:00 Uhr"],
      },
      fromConfig,
    );

    expect(payload.to).toBe("whatsapp:+491701234567");
    expect(payload.from).toBe("whatsapp:+4915112345678");
    expect(payload.contentSid).toBe("HX0123456789abcdef0123456789abcdef");
    expect(payload.contentVariables).toBe(JSON.stringify({ "1": "Anna", "2": "10:00 Uhr" }));
    expect(payload.messagingServiceSid).toBeUndefined();
  });

  it("präfixiert die Empfängernummer nicht doppelt mit whatsapp:", () => {
    const payload = buildTwilioRequest(
      {
        phoneNumber: "whatsapp:+491701234567",
        templateName: "HX0123456789abcdef0123456789abcdef",
      },
      fromConfig,
    );
    expect(payload.to).toBe("whatsapp:+491701234567");
  });

  it("hängt buttonUrl als nächste Variable an", () => {
    const payload = buildTwilioRequest(
      {
        phoneNumber: "+491701234567",
        templateName: "HX0123456789abcdef0123456789abcdef",
        templateParams: ["Anna"],
        buttonUrl: "https://app.example.com/appointment/42",
      },
      fromConfig,
    );
    expect(payload.contentVariables).toBe(
      JSON.stringify({ "1": "Anna", "2": "https://app.example.com/appointment/42" }),
    );
  });

  it("nutzt messagingServiceSid statt from, wenn gesetzt", () => {
    const payload = buildTwilioRequest(
      {
        phoneNumber: "+491701234567",
        templateName: "HX0123456789abcdef0123456789abcdef",
      },
      {
        accountSid: ENV_SID,
        authToken: ENV_TOKEN,
        messagingServiceSid: "MGabcdefabcdefabcdefabcdefabcdef00",
      },
    );
    expect(payload.messagingServiceSid).toBe("MGabcdefabcdefabcdefabcdefabcdef00");
    expect(payload.from).toBeUndefined();
  });

  it("normalisiert lokale DE-Eingaben (z. B. 0170…) zu whatsapp:+E164", () => {
    expect(normalizeWhatsAppRecipient("0170 1234567")).toBe("whatsapp:+491701234567");
    expect(normalizeWhatsAppRecipient("+491701234567")).toBe("whatsapp:+491701234567");
    expect(normalizeWhatsAppRecipient("whatsapp:+491701234567")).toBe(
      "whatsapp:+491701234567",
    );
  });

  it("liefert null bei nicht-DACH oder ungültigen Nummern", () => {
    expect(normalizeWhatsAppRecipient("not-a-number")).toBeNull();
    expect(normalizeWhatsAppRecipient("")).toBeNull();
    expect(normalizeWhatsAppRecipient("+15551234567")).toBeNull();
  });

  it("lässt contentVariables weg, wenn keine Parameter übergeben werden", () => {
    const payload = buildTwilioRequest(
      {
        phoneNumber: "+491701234567",
        templateName: "HX0123456789abcdef0123456789abcdef",
      },
      fromConfig,
    );
    expect(payload.contentVariables).toBeUndefined();
  });
});

describe("WhatsApp Deep-Link-Basis (buildAppUrl) – Präzedenz (Task #1840)", () => {
  const VARS = ["APP_DOMAIN", "REPLIT_DOMAINS", "REPLIT_DEV_DOMAIN", "APP_URL"] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of VARS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("nutzt APP_DOMAIN vorrangig (Hetzner/Coolify)", () => {
    process.env.APP_DOMAIN = "app.example.com";
    process.env.REPLIT_DOMAINS = "prod.repl.example,other.repl.example";
    process.env.REPLIT_DEV_DOMAIN = "dev.repl.example";
    expect(whatsAppService.buildAppUrl("/tasks")).toBe("https://app.example.com/tasks");
  });

  it("Fix: nutzt in Replit-PROD die PROD-Domain (REPLIT_DOMAINS[0]) statt der DEV-Domain", () => {
    // Beide Replit-Vars gesetzt (typisch für Prod) — vor dem Fix hätte
    // buildAppUrl die DEV-Domain verwendet.
    process.env.REPLIT_DOMAINS = "prod.repl.example,other.repl.example";
    process.env.REPLIT_DEV_DOMAIN = "dev.repl.example";
    expect(whatsAppService.buildAppUrl("/appointment/42")).toBe(
      "https://prod.repl.example/appointment/42",
    );
  });

  it("fällt auf REPLIT_DEV_DOMAIN zurück, wenn nur diese gesetzt ist", () => {
    process.env.REPLIT_DEV_DOMAIN = "dev.repl.example";
    expect(whatsAppService.buildAppUrl("/")).toBe("https://dev.repl.example/");
  });

  it("nutzt APP_URL als letzte Stufe, wenn keine Domain-Var gesetzt ist", () => {
    process.env.APP_URL = "https://legacy.example.com";
    expect(whatsAppService.buildAppUrl("/customers/7")).toBe(
      "https://legacy.example.com/customers/7",
    );
  });
});
