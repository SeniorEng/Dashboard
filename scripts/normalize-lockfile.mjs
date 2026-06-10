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
//
// --check-Modus (Task #1163): schreibt NICHT, sondern failed hart (Exit 1),
// falls eine Firewall-URL im committeten Lockfile steckt. Dieser Modus läuft im
// CI-Static-Gate VOR `npm ci` — denn ein Lockfile mit unerreichbarem
// `package-firewall.replit.local`-Host bricht `npm ci` auf GitHub-Runnern mit
// `EAI_AGAIN` ab, BEVOR irgendein nachgelagerter (Vitest-)Test laufen könnte.
// Nutzt ausschließlich Node-Bordmittel, braucht also keine installierten
// Dependencies.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const FIREWALL_HOST = "package-firewall.replit.local";
const FIREWALL_PREFIX = "http://package-firewall.replit.local/npm/";
const PUBLIC_REGISTRY = "https://registry.npmjs.org/";

const CHECK_ONLY = process.argv.includes("--check");

function resolveLockfilePath() {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "package-lock.json");
}

/**
 * --check: niemals schreiben, sondern hart failen, wenn der Firewall-Host im
 * Lockfile steht. Gedacht als always-on CI-Static-Gate VOR `npm ci`.
 */
function check() {
  const lockfilePath = resolveLockfilePath();

  if (!existsSync(lockfilePath)) {
    process.stderr.write(
      "[normalize-lockfile] --check: package-lock.json nicht gefunden.\n",
    );
    process.exit(1);
  }

  const lockfile = readFileSync(lockfilePath, "utf8");
  const offenders = lockfile
    .split("\n")
    .map((line, idx) => ({ line: line.trim(), no: idx + 1 }))
    .filter(({ line }) => line.includes(FIREWALL_HOST));

  if (offenders.length === 0) {
    process.stdout.write(
      "[normalize-lockfile] --check OK: keine Firewall-URLs im package-lock.json.\n",
    );
    return;
  }

  process.stderr.write(
    `[normalize-lockfile] --check FEHLGESCHLAGEN: ${offenders.length} ` +
      `Verweis(e) auf den Replit-internen Host '${FIREWALL_HOST}' im ` +
      "package-lock.json gefunden:\n",
  );
  for (const { no, line } of offenders.slice(0, 10)) {
    process.stderr.write(`  Zeile ${no}: ${line}\n`);
  }
  if (offenders.length > 10) {
    process.stderr.write(`  … und ${offenders.length - 10} weitere.\n`);
  }
  process.stderr.write(
    "\nDieser Host ist außerhalb von Replit nicht erreichbar und bricht jeden " +
      "GitHub-CI-Job mit EAI_AGAIN ab. Das Lockfile darf NUR auf " +
      "registry.npmjs.org verweisen.\n" +
      "Fix: `node scripts/normalize-lockfile.mjs` ausführen (läuft normalerweise " +
      "automatisch als postinstall-Hook) und das normalisierte package-lock.json " +
      "committen. Vermutliche Ursache: Lockfile mit `npm ci --ignore-scripts` " +
      "erzeugt, was den postinstall-Normalizer überspringt.\n",
  );
  process.exit(1);
}

function main() {
  const lockfilePath = resolveLockfilePath();

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

if (CHECK_ONLY) {
  // Im --check-Modus sind Fehler bewusst FATAL (kein Graceful-Skip), damit das
  // CI-Gate nicht versehentlich grün durchläuft.
  check();
} else {
  try {
    main();
  } catch (err) {
    process.stderr.write(
      `[normalize-lockfile] Warnung: Normalisierung übersprungen (${err?.message ?? err}).\n`,
    );
  }
}
