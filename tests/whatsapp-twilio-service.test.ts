import { describe, it, expect } from "vitest";
import {
  buildTwilioRequest,
  resolveTwilioConfigFromSettings,
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
