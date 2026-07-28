// ---------------------------------------------------------------------------
// Replit-Exit — `APP_DOMAIN`-Override für externe Links (Task #1840).
//
// Vor der Migration bauten mehrere Services ihre externen Links (E-Mail-Assets,
// Twilio-Callbacks, WhatsApp-Deep-Links) jeweils EIGENSTÄNDIG aus den Replit-
// Umgebungsvariablen. Für den Betrieb außerhalb von Replit (Hetzner/Coolify)
// führen wir `APP_DOMAIN` als vorrangige Quelle ein.
//
// Bewusst NICHT als vereinheitlichte Fallback-Kette umgesetzt: `APP_DOMAIN`
// wird lediglich VORANGESTELLT; ist es nicht gesetzt, behält jeder Aufrufer
// seine bisherige Replit-Fallback-Logik unverändert bei (strikt verhaltens-
// neutral auf Replit bis zum Cutover, Strangler-Prinzip).
// ---------------------------------------------------------------------------

/** Entfernt ein evtl. vorangestelltes Schema und abschließende Slashes. */
function normalizeHost(raw: string | undefined | null): string | null {
  const v = raw?.trim();
  if (!v) return null;
  return v.replace(/^https?:\/\//i, "").replace(/\/+$/, "") || null;
}

/**
 * Liefert den bloßen Host aus `APP_DOMAIN` (z.B. `app.example.com`) oder `null`,
 * wenn die Variable nicht (sinnvoll) gesetzt ist. NUR die Override-Quelle —
 * keine Replit-Fallbacks (die bleiben beim jeweiligen Aufrufer).
 */
export function resolveAppDomainOverride(): string | null {
  return normalizeHost(process.env.APP_DOMAIN);
}

/**
 * Liefert die Basis-URL (`https://<host>`, ohne abschließenden Slash) aus
 * `APP_DOMAIN` oder `null`. Aufrufer nutzen sie als vorrangigen Wert und fallen
 * bei `null` auf ihre bestehende Logik zurück.
 */
export function appDomainBaseUrl(): string | null {
  const host = resolveAppDomainOverride();
  return host ? `https://${host}` : null;
}
