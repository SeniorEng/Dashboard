/**
 * BUG-19-Rest / T003 + Task #1226 — Bestands-Scan: persistierte §45b-Zeilen bei
 * Selbstzahler-Kunden deaktivieren.
 *
 * Selbstzahler haben keinen Anspruch auf §45b/§45a/§39. Betroffene Bestandskunden
 * tragen eine persistierte, offene §45b-`enabled=true`-Zeile. Dieses Skript
 * deaktiviert sie über den regulären PUT-/type-settings-Pfad (append-only via
 * `upsertBudgetTypeSettings`, GoBD-konforme Transition + Audit mit Superadmin-
 * Akteur + `syncCarryoverAndExpiry`). KEINE Roh-UPDATEs, KEIN Delete (#1169).
 *
 * Zwei getrennte Ziel-Listen, je nach BASE_URL automatisch gewählt:
 *  - `DEV_TARGETS` (localhost): die ursprüngliche Dev-Bereinigung
 *    (138911/145919/203042) — bereits erledigt, bleibt als No-Op-Referenz.
 *  - `PROD_TARGETS` (remote): Task #1226 — Kunde 41 ("Testkundin, Erika",
 *    Selbstzahler) mit genau EINER offenen §45b-Zeile (id 25, validFrom
 *    1970-01-01) ohne Buchungen/Rechnungen (read-only verifiziert, siehe
 *    `docs/research/prod-report-kunde-41-45b.md`).
 *
 * WICHTIG: Die FULL settings list pro Kunde wird aus den AKTUELL OFFENEN
 * persistierten Zeilen gebaut (nicht aus der GET-Antwort, die synthetische
 * Default-Zeilen mit `id:null` mischt) — so werden keine §45a/§39-Default-Zeilen
 * materialisiert. §45b wird auf `enabled=false` gekippt, die übrigen offenen
 * Töpfe werden unverändert mitgeschickt (No-Op via `settingsEqual`), damit der
 * Partial-Payload-Pfad sie nicht schließt. Kunde 41 hat NUR den §45b-Topf, daher
 * ist die eine Zeile bereits die vollständige Liste.
 *
 * Proof-Kunden 203052/203058 werden NICHT angefasst (haben ohnehin keine
 * persistierten Zeilen).
 *
 * Lauf (DRY-RUN, nur Anzeige): `npx tsx scripts/deactivate-selbstzahler-45b.ts`
 * Lauf (schreibend, Dev):       `... --apply`
 * Remote/Prod (NUR nach Freigabe): `TEST_BASE_URL=<url> ... --apply --remote-confirm`
 * (läuft gegen den laufenden Server; Default-Ziel ist Dev :5000).
 *
 * SICHERHEIT (Konvention: Datenpflege-Skripte brauchen `--apply` + Host-Guard,
 * nie versehentlich auf Prod): Ohne `--apply` ist der Lauf ein reiner DRY-RUN
 * (GET + Report, KEIN PUT). Ein Ziel ≠ localhost erfordert ZUSÄTZLICH
 * `--remote-confirm`, damit ein Prod-Lauf nur bewusst und freigegeben passiert.
 * Credentials kommen ausschließlich aus der Umgebung (keine Klartext-Fallbacks).
 */

import { dbHostOf, istLoopback } from "@shared/ephemeral-db-target";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const EMAIL = process.env.TEST_USER_EMAIL;
const PASSWORD = process.env.TEST_USER_PASSWORD || process.env.TEST_USER_PASSWORD_INTERNAL;

const APPLY = process.argv.includes("--apply");
const REMOTE_CONFIRM = process.argv.includes("--remote-confirm");

/**
 * ERSETZT die frueher hier stehende Eigen-Antwort
 * (`h === "localhost" || h === "127.0.0.1" || h === "::1"`) durch die SSoT.
 *
 * Die Eigenform war genau die Schreibweisen-Pruefung, die W3 im Prod-Gate
 * abgeloest hat: `0177.0.0.1`, `2130706433`, `[::ffff:127.0.0.1]` und jede
 * Form mit Trailing Dot loesen auf 127.0.0.1 auf, galten hier aber als
 * "remote" — und daran haengt das `--remote-confirm`-Gate.
 *
 * ACHTUNG zur Richtung: hier wirkt die SSoT GROSSZUEGIGER, nicht strenger.
 * Wer bisher gegen `http://0177.0.0.1:5000` lief, brauchte `--remote-confirm`;
 * jetzt nicht mehr. Das ist richtig so — die Adresse IST localhost, das
 * Confirm war ein Falsch-Positiv und keine Schutzwirkung. Die Richtung, auf
 * die es ankommt, bleibt unveraendert: ein echtes fernes Ziel gilt weiter als
 * remote, und Praefix-Fallen wie `127.0.0.1.evil.com` ebenfalls (geprueft).
 */
function isLocalHost(url: string): boolean {
  const host = dbHostOf(url);
  return host !== null && istLoopback(host);
}

type SettingPayload = {
  budgetType: "entlastungsbetrag_45b" | "umwandlung_45a" | "ersatzpflege_39_42a";
  enabled: boolean;
  priority: number;
  monthlyLimitCents: number | null;
  yearlyLimitCents: number | null;
  validFrom: string | null;
  validTo: string | null;
};

// FULL settings list pro Kunde = aktuell OFFENE persistierte Zeilen (valid_to IS
// NULL), §45b auf enabled=false. Werte exakt aus der DB übernommen.

// Dev-Bereinigung (bereits erledigt) — bleibt als No-Op-Referenz für localhost.
const DEV_TARGETS: Record<number, SettingPayload[]> = {
  138911: [
    { budgetType: "entlastungsbetrag_45b", enabled: false, priority: 1, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: "1970-01-01", validTo: null },
    { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: "1970-01-01", validTo: null },
    { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: "1970-01-01", validTo: null },
  ],
  145919: [
    { budgetType: "entlastungsbetrag_45b", enabled: false, priority: 1, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: "1970-01-01", validTo: null },
    { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: "1970-01-01", validTo: null },
    { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: "1970-01-01", validTo: null },
  ],
  203042: [
    { budgetType: "entlastungsbetrag_45b", enabled: false, priority: 1, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: "2024-06-15", validTo: null },
  ],
};

// Prod-Altlast (Task #1226) — Kunde 41 hat NUR den §45b-Topf (id 25, offen,
// validFrom 1970-01-01); die eine Zeile ist bereits die vollständige Liste.
const PROD_TARGETS: Record<number, SettingPayload[]> = {
  41: [
    { budgetType: "entlastungsbetrag_45b", enabled: false, priority: 1, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: "1970-01-01", validTo: null },
  ],
};

// Ziel-Liste automatisch nach BASE_URL: localhost → Dev, remote → Prod.
const TARGETS: Record<number, SettingPayload[]> = isLocalHost(BASE_URL) ? DEV_TARGETS : PROD_TARGETS;

const FORBIDDEN = new Set([203052, 203058]);

async function login(): Promise<{ cookie: string; csrf: string }> {
  if (!EMAIL) throw new Error("TEST_USER_EMAIL nicht gesetzt");
  if (!PASSWORD) throw new Error("TEST_USER_PASSWORD(_INTERNAL) nicht gesetzt");
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login fehlgeschlagen: ${res.status}`);
  const cookie = res.headers.get("set-cookie") || "";
  const csrf = (cookie.match(/careconnect_csrf=([^;]+)/) || [])[1] || "";
  if (!csrf) throw new Error("CSRF-Token nicht gefunden");
  const body = await res.json();
  console.log(`Eingeloggt als ${body?.user?.email ?? "?"} (admin=${body?.user?.isAdmin})`);
  return { cookie, csrf };
}

async function getTypeSettings(auth: { cookie: string; csrf: string }, customerId: number) {
  const res = await fetch(`${BASE_URL}/api/budget/${customerId}/type-settings`, {
    headers: { Cookie: auth.cookie },
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function putTypeSettings(auth: { cookie: string; csrf: string }, customerId: number, settings: SettingPayload[]) {
  const res = await fetch(`${BASE_URL}/api/budget/${customerId}/type-settings`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Cookie: `${auth.cookie}; careconnect_csrf=${auth.csrf}`,
      "x-csrf-token": auth.csrf,
    },
    body: JSON.stringify({ settings }),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

function summarize45b(rows: unknown): string {
  if (!Array.isArray(rows)) return "(keine Liste)";
  const r = rows.find((x: { budgetType?: string }) => x?.budgetType === "entlastungsbetrag_45b") as { enabled?: boolean; validFrom?: string | null } | undefined;
  if (!r) return "§45b: keine Zeile";
  return `§45b enabled=${r.enabled} (validFrom=${r.validFrom ?? "null"})`;
}

async function main() {
  for (const id of Object.keys(TARGETS).map(Number)) {
    if (FORBIDDEN.has(id)) throw new Error(`Kunde ${id} ist ein Proof-Kunde und darf NICHT angefasst werden`);
  }

  // Host-Guard: Remote-Ziel (≠ localhost) nur mit ausdrücklicher Bestätigung.
  if (!isLocalHost(BASE_URL) && !REMOTE_CONFIRM) {
    throw new Error(
      `Ziel ${BASE_URL} ist NICHT localhost. Ein Remote-/Prod-Lauf erfordert ` +
        `zusätzlich das Flag --remote-confirm (nur nach ausdrücklicher Freigabe).`,
    );
  }

  console.log(
    APPLY
      ? `MODUS: APPLY — schreibt PUT gegen ${BASE_URL}`
      : `MODUS: DRY-RUN — nur Anzeige, KEIN PUT (mit --apply ausführen). Ziel: ${BASE_URL}`,
  );

  const auth = await login();

  for (const [idStr, settings] of Object.entries(TARGETS)) {
    const id = Number(idStr);
    const before = await getTypeSettings(auth, id);
    console.log(`\n--- Kunde ${id} ---`);
    console.log(`  vorher: ${summarize45b(before.data)}`);

    if (!APPLY) {
      const intended = settings.find((s) => s.budgetType === "entlastungsbetrag_45b");
      console.log(`  DRY-RUN: würde §45b auf enabled=${intended?.enabled ?? false} setzen (kein PUT).`);
      continue;
    }

    const put = await putTypeSettings(auth, id, settings);
    if (put.status !== 200) {
      console.error(`  PUT FEHLER ${put.status}:`, JSON.stringify(put.data));
      process.exitCode = 1;
      continue;
    }

    const after = await getTypeSettings(auth, id);
    console.log(`  nachher: ${summarize45b(after.data)}`);
  }
}

main().then(() => {
  console.log("\nFertig.");
  process.exit(process.exitCode ?? 0);
}).catch((err) => {
  console.error("Abbruch:", err);
  process.exit(1);
});
