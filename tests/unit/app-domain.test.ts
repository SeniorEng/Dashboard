/**
 * Task #1840 — Unit-Tests für den `APP_DOMAIN`-Override
 * (`server/lib/app-domain.ts`), eingeführt für den Replit-Exit.
 *
 * Sichert ab: (1) `APP_DOMAIN` wird als bloßer Host aufgelöst und zu einer
 * `https://`-Basis-URL geformt, inkl. Normalisierung (Schema/Slash strippen);
 * (2) der Override betrachtet AUSSCHLIESSLICH `APP_DOMAIN` — die Replit-Vars
 * bleiben Sache der jeweiligen Aufrufer (strikt verhaltensneutral auf Replit).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveAppDomainOverride, appDomainBaseUrl } from "../../server/lib/app-domain";

const VARS = ["APP_DOMAIN", "REPLIT_DOMAINS", "REPLIT_DEV_DOMAIN"] as const;

describe("APP_DOMAIN-Override (Task #1840)", () => {
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

  it("gibt null zurück, wenn APP_DOMAIN nicht gesetzt ist", () => {
    expect(resolveAppDomainOverride()).toBeNull();
    expect(appDomainBaseUrl()).toBeNull();
  });

  it("löst einen bloßen Host zu einer https-Basis-URL auf", () => {
    process.env.APP_DOMAIN = "app.example.com";
    expect(resolveAppDomainOverride()).toBe("app.example.com");
    expect(appDomainBaseUrl()).toBe("https://app.example.com");
  });

  it("normalisiert vorangestelltes Schema und abschließende Slashes", () => {
    process.env.APP_DOMAIN = "https://app.example.com/";
    expect(resolveAppDomainOverride()).toBe("app.example.com");
    expect(appDomainBaseUrl()).toBe("https://app.example.com");
  });

  it("ignoriert die Replit-Vars vollständig (Override ist APP_DOMAIN-only)", () => {
    process.env.REPLIT_DOMAINS = "repl-a.example.dev,repl-b.example.dev";
    process.env.REPLIT_DEV_DOMAIN = "dev.example.repl";
    // Kein APP_DOMAIN gesetzt → Override liefert null, der Aufrufer fällt selbst
    // auf seine (hier bewusst nicht getestete) Replit-Logik zurück.
    expect(resolveAppDomainOverride()).toBeNull();
    expect(appDomainBaseUrl()).toBeNull();
  });

  it("behandelt leere/whitespace-Werte wie nicht gesetzt", () => {
    process.env.APP_DOMAIN = "   ";
    expect(resolveAppDomainOverride()).toBeNull();
    expect(appDomainBaseUrl()).toBeNull();
  });
});
