/**
 * Task #1163 — Architektur-Test: KEINE Replit-internen Firewall-URLs im
 * committeten `package-lock.json`.
 *
 * Hintergrund: In Replit löst npm Pakete über den internen Mirror
 * `http://package-firewall.replit.local/npm/…` auf und schreibt diesen Host in
 * die `resolved`-Tarball-URLs des Lockfiles. Auf GitHub-Runnern ist der Host
 * nicht erreichbar — `npm ci` bricht dort mit `EAI_AGAIN` ab und legt JEDEN
 * CI-Job lahm.
 *
 * Der `postinstall`-Hook (`scripts/normalize-lockfile.mjs`) normalisiert das
 * Lockfile lokal still zurück auf `https://registry.npmjs.org/`. Wer aber ein
 * mit `npm ci --ignore-scripts` erzeugtes (also nicht normalisiertes) Lockfile
 * committet, umgeht den Hook — und nichts schlägt heute fest darauf an.
 *
 * Dieser Fitness-Test läuft in den always-on Static-Gates (Project `unit`,
 * kein Server/DB) und failed schnell mit klarer Meldung, sobald auch nur eine
 * Firewall-URL im Lockfile steckt.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const LOCKFILE_PATH = join(process.cwd(), "package-lock.json");
const FIREWALL_HOST = "package-firewall.replit.local";

describe("Architektur: keine Firewall-URLs im package-lock.json (Task #1163)", () => {
  it("enthält keine `package-firewall.replit.local`-URLs", () => {
    const lockfile = readFileSync(LOCKFILE_PATH, "utf8");
    const lines = lockfile.split("\n");
    const offenders: string[] = [];
    lines.forEach((line, idx) => {
      if (line.includes(FIREWALL_HOST)) {
        offenders.push(`Zeile ${idx + 1}: ${line.trim()}`);
      }
    });

    expect(
      offenders,
      `Replit-internen Firewall-Host (${FIREWALL_HOST}) im package-lock.json gefunden. ` +
        "Dieser Host ist außerhalb von Replit nicht erreichbar und bricht jeden " +
        "GitHub-CI-Job mit EAI_AGAIN ab. Das Lockfile muss ausschließlich auf " +
        "registry.npmjs.org verweisen. Fix: `node scripts/normalize-lockfile.mjs` " +
        "ausführen (läuft normalerweise automatisch als postinstall-Hook) und das " +
        "normalisierte Lockfile committen. Vermutliche Ursache: Lockfile wurde mit " +
        "`npm ci --ignore-scripts` erzeugt, was den postinstall-Normalizer überspringt.",
    ).toEqual([]);
  });
});
