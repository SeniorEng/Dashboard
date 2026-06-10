#!/usr/bin/env node
//
// normalize-lockfile.mjs — Lockfile-Registry-Normalisierung (Task #1156)
//
// In Replit löst npm Pakete über den internen Mirror
// `http://package-firewall.replit.local/npm/…` auf — und dieser Host steht
// AUCH in den `resolved`-/Tarball-URLs des Packuments, also schreibt npm ihn
// bei jeder Lockfile-Regenerierung in `package-lock.json`. Auf GitHub-Runnern
// ist der Host nicht erreichbar, `npm ci` bricht dort mit `EAI_AGAIN` ab.
//
// Weder ein `.npmrc registry`-Override noch `replace-registry-host` können das
// verhindern: die `npm_config_registry`-Env-Var (Firewall) übersteuert die
// `.npmrc`, und der Firewall-Mirror liefert die Tarball-URLs bereits mit
// Firewall-Host aus. Deshalb normalisieren wir das Lockfile NACH jeder
// Installation an der Quelle (postinstall) zurück auf
// `https://registry.npmjs.org/` (identische Tarballs, Integrity-Hashes bleiben
// gültig). So bleibt das committete Lockfile dauerhaft sauber und CI braucht
// kein per-Step-`sed` mehr. Siehe docs/ci-pipeline.md.
//
// Idempotent + defensiv: fehlt das Lockfile oder gibt es nichts zu ändern,
// passiert nichts; Fehler beenden die Installation NICHT (Exit 0).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const FIREWALL_PREFIX = "http://package-firewall.replit.local/npm/";
const PUBLIC_REGISTRY = "https://registry.npmjs.org/";

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const lockfilePath = join(here, "..", "package-lock.json");

  if (!existsSync(lockfilePath)) {
    return;
  }

  const original = readFileSync(lockfilePath, "utf8");
  if (!original.includes(FIREWALL_PREFIX)) {
    return;
  }

  const normalized = original.split(FIREWALL_PREFIX).join(PUBLIC_REGISTRY);
  writeFileSync(lockfilePath, normalized);
  process.stdout.write(
    "[normalize-lockfile] package-firewall URLs auf registry.npmjs.org normalisiert.\n",
  );
}

try {
  main();
} catch (err) {
  process.stderr.write(
    `[normalize-lockfile] Warnung: Normalisierung übersprungen (${err?.message ?? err}).\n`,
  );
}
