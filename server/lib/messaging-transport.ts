// ---------------------------------------------------------------------------
// Replit-Exit — zentrales Stub-Gate für ausgehende Nachrichten (Task #1840).
//
// Vor der Migration hatte nur E-Mail ein Stub-Gate — und das griff nur bei
// NODE_ENV=test. WhatsApp und Twilio hatten GAR KEINES: mit gültigen
// Credentials in der DB hätte eine Nicht-Prod-Umgebung echte Nachrichten/Anrufe
// ausgelöst. Für Hetzner ist das brisant, weil die Dev-Umgebung eine
// Prod-KOPIE-DB (mit echten Provider-Tokens) nutzt.
//
// Richtlinie: SAFE-BY-DEFAULT. Außerhalb der Produktion wird NIE real gesendet,
// es sei denn, der Kanal wird explizit auf "real" geschaltet. Umgekehrt kann in
// der Produktion einzeln auf "stub" geschaltet werden.
//
//   <CHANNEL>_TRANSPORT = real  → echter Versand (explizit erzwungen)
//   <CHANNEL>_TRANSPORT = stub  → kein Versand (explizit)
//   (nicht gesetzt)             → stub, außer NODE_ENV=production
//
// Kanäle: EMAIL_TRANSPORT, WHATSAPP_TRANSPORT, TWILIO_TRANSPORT.
// ---------------------------------------------------------------------------

export type OutboundChannel = "email" | "whatsapp" | "twilio";

/**
 * True, wenn der Kanal im Stub-Modus läuft (kein realer Versand). Siehe
 * Datei-Header für die Präzedenz. Safe-by-default: ohne explizite Übersteuerung
 * ist außerhalb der Produktion immer Stub.
 */
export function isStubTransport(channel: OutboundChannel): boolean {
  const raw = process.env[`${channel.toUpperCase()}_TRANSPORT`]?.trim().toLowerCase();
  if (raw === "real") return false;
  if (raw === "stub") return true;
  return process.env.NODE_ENV !== "production";
}
