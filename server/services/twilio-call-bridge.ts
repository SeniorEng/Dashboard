import twilio from "twilio";
import { storage } from "../storage";
import { prospectStorage } from "../storage/prospects";
import { validateGermanPhone } from "@shared/utils/phone";

interface CallBridgeParams {
  prospectId: number;
  leadName: string;
  leadPhone: string;
  quelle: string;
}

async function getTwilioConfig() {
  const settings = await storage.getCompanySettings();
  if (
    !settings?.leadCallBridgeEnabled ||
    !settings?.twilioAccountSid ||
    !settings?.twilioAuthToken ||
    !settings?.twilioPhoneNumber ||
    !settings?.leadCallBridgePhone
  ) {
    return null;
  }
  return {
    accountSid: settings.twilioAccountSid,
    authToken: settings.twilioAuthToken,
    twilioPhone: settings.twilioPhoneNumber,
    bridgePhone: settings.leadCallBridgePhone,
  };
}

function buildCallbackBaseUrl(): string {
  const domain = process.env.REPLIT_DOMAINS?.split(",")[0];
  if (domain) return `https://${domain}`;
  const replSlug = process.env.REPL_SLUG;
  const replOwner = process.env.REPL_OWNER;
  if (replSlug && replOwner) return `https://${replSlug}.${replOwner}.repl.co`;
  return "https://localhost:5000";
}

export async function initiateLeadCallBridge(params: CallBridgeParams): Promise<void> {
  const { prospectId, leadName, leadPhone, quelle } = params;

  const config = await getTwilioConfig();
  if (!config) {
    console.log("[twilio-bridge] Bridge not configured or disabled, skipping call");
    return;
  }

  const phoneResult = validateGermanPhone(leadPhone);
  if (!phoneResult.valid) {
    console.log(`[twilio-bridge] Invalid lead phone for prospect ${prospectId}: ${phoneResult.error}`);
    await prospectStorage.addNote({
      prospectId,
      noteText: `Automatischer Anruf nicht möglich: Telefonnummer ungültig (${leadPhone})`,
      noteType: "notiz",
    });
    return;
  }

  const normalizedLeadPhone = phoneResult.normalized;
  const client = twilio(config.accountSid, config.authToken);
  const baseUrl = buildCallbackBaseUrl();

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="${baseUrl}/api/webhook/twilio/gather?prospectId=${prospectId}&amp;leadPhone=${encodeURIComponent(normalizedLeadPhone)}&amp;twilioPhone=${encodeURIComponent(config.twilioPhone)}" method="POST" timeout="15">
    <Say language="de-DE">Neuer Lead: ${escapeXml(leadName)}. Quelle: ${escapeXml(quelle || "unbekannt")}. Drücken Sie 1 zum Verbinden.</Say>
  </Gather>
  <Say language="de-DE">Keine Eingabe erkannt. Auf Wiedersehen.</Say>
</Response>`;

  try {
    const call = await client.calls.create({
      to: config.bridgePhone,
      from: config.twilioPhone,
      twiml,
      statusCallback: `${baseUrl}/api/webhook/twilio/status?prospectId=${prospectId}`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      statusCallbackMethod: "POST",
    });

    console.log(`[twilio-bridge] Call initiated for prospect ${prospectId}: SID=${call.sid}`);

    await prospectStorage.addNote({
      prospectId,
      noteText: `Automatischer Anruf gestartet (${leadName}, Tel: ${phoneResult.formatted})`,
      noteType: "anruf",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[twilio-bridge] Failed to initiate call for prospect ${prospectId}: ${msg}`);

    await prospectStorage.addNote({
      prospectId,
      noteText: `Automatischer Anruf fehlgeschlagen: ${msg}`,
      noteType: "notiz",
    });
  }
}

export async function initiateTestCall(): Promise<{ success: boolean; message: string; callSid?: string }> {
  const config = await getTwilioConfig();
  if (!config) {
    return { success: false, message: "Twilio-Konfiguration unvollständig oder Brücke deaktiviert" };
  }

  const client = twilio(config.accountSid, config.authToken);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="de-DE">Dies ist ein Testanruf der Lead-Anruf-Brücke von Seniorenengel. Die Verbindung funktioniert korrekt. Auf Wiedersehen.</Say>
</Response>`;

  try {
    const call = await client.calls.create({
      to: config.bridgePhone,
      from: config.twilioPhone,
      twiml,
    });

    return { success: true, message: "Testanruf gestartet", callSid: call.sid };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Twilio-Fehler: ${msg}` };
  }
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
