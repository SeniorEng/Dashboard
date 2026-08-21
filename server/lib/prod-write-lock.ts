/**
 * **Laufzeit-Sperre: im Skript-Kontext kein Schreibzugriff ohne Ziel-Freigabe.**
 *
 * ── Warum es nicht beim statischen Wächter bleiben konnte ───────────────────
 * `tests/architecture/prod-write-gate-coverage.test.ts` liest Quelltext. Er
 * sieht `.update(`/`.insert(`/`.delete(` und rohes SQL — aber nicht, wenn ein
 * Skript über einen importierten Helfer schreibt. Gemessen am 20.08.2026:
 * 15 Skripte schreiben sichtbar, **12 unsichtbar** über Storage-/Service-Helfer.
 * Zwei davon erzeugen über `stornoInvoiceDocumentOnly` STORNORECHNUNGEN.
 *
 * Statische Textsuche kann das nicht auflösen, ohne den Importgraphen zu
 * verfolgen. Diese Sperre sitzt stattdessen dort, wo jeder Weg zusammenläuft:
 * am Treiber. Ortsunabhängig, indirektionsfest.
 *
 * ── Die beiden Kontexte ────────────────────────────────────────────────────
 *   App     → `server/index.ts` / `dist/index.cjs`. UNANGETASTET. Requests
 *             haben ihre eigene Authz; hier zu prüfen hieße, die laufende
 *             Anwendung zu brechen.
 *   Test    → Vitest. Ausgenommen — aber nur, weil der Wegwerf-DB-Guard in
 *             BEIDEN Projekten unbedingt läuft (siehe `tests/globalSetup.ts`).
 *             Ohne diese Zusage wäre die Ausnahme ein Loch.
 *   Skript  → alles unter `server/scripts/**` und `scripts/**`.
 *   sonst   → **Skript**. Fail-closed: ein unbekannter Entrypoint
 *             (`tsx -e`, umbenanntes Skript, fremder Wrapper) gilt als Skript
 *             und braucht die Freigabe. Ein Zweifelsfall darf nicht in den
 *             Freifahrtschein fallen.
 *
 * ── Freigabe ───────────────────────────────────────────────────────────────
 * `assertProdWriteAllowedOrThrow` ruft `freigabeErteilen()`, NACHDEM Ziel
 * (`--confirm-target=<host>/<datenbank>`, Datenbankname aus der offenen
 * Verbindung), Superadmin und Begründung geprüft sind. Ein Skript-Prozess ist
 * einzweckig — deshalb ein Modul-Flag und kein `AsyncLocalStorage`: letzteres
 * kaufte eine Scoping-Eigenschaft, die hier niemand braucht, und zwänge jedem
 * Skript ein `.run()` auf.
 */
import path from "node:path";
import { istSchreibendesSql } from "@shared/db-write-statements";
import { evaluateTestDbTarget } from "@shared/ephemeral-db-target";

export type Schreibkontext = "app" | "test" | "skript";

/**
 * Rein, damit sie testbar ist, ohne den Prozess umzubauen. `argv1` ist
 * `process.argv[1]` — was tatsächlich gestartet wurde.
 */
export function ermittleKontext(
  argv1: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Schreibkontext {
  // NUR Vitest. `NODE_ENV=test` galt hier zunaechst mit — das war ein Loch:
  // CLAUDE.md schreibt fuer den lokalen Testbetrieb
  // `set -a; . ./.env.test.local; set +a` vor, und diese Datei setzt
  // `NODE_ENV=test`. In genau der Shell, in der hier taeglich gearbeitet wird,
  // waere die Sperre tot gewesen — und ein Skript haette gegen die Prod-Kopie
  // schreiben koennen, ohne irgendein Ziel zu nennen.
  if (env.VITEST === "true" || env.VITEST_WORKER_ID) {
    return "test";
  }
  if (!argv1) return "skript"; // fail-closed

  const p = argv1.replace(/\\/g, "/");
  // Der gebündelte Server und sein Quelltext-Pendant.
  if (/(^|\/)dist\/index\.cjs$/.test(p) || /(^|\/)server\/index\.ts$/.test(p)) {
    return "app";
  }
  // Kein eigener Zweig fuer `scripts/`: er waere wirkungsgleich mit dem
  // Default, und eine Mutation, die ihn loescht, wuerde zwangslaeufig
  // ueberleben. Alles, was nicht nachweislich App oder Vitest ist, ist Skript.
  return "skript"; // fail-closed
}

/**
 * Der erbrachte Zielnachweis. `art` sagt, WELCHE der drei Formen ihn erbracht
 * hat — das steht in der Fehlermeldung eines spaeteren Abbruchs und im Log.
 */
let freigabe: { art: "prod-gate" | "dev-db"; ziel: string } | null = null;

/** Wird ausschliesslich vom Prod-Schreib-Gate gerufen, nach dessen Pruefungen. */
export function freigabeErteilen(ziel: string): void {
  freigabe = { art: "prod-gate", ziel };
  // Das Ziel gehoert ins Log, nicht nur ins Feld: bei einem spaeteren Vorfall
  // ist die erste Frage "wogegen lief das eigentlich?".
  console.log(`[write-lock] Ziel geprueft (Prod-Gate): ${ziel}`);
}

/**
 * Zweite Form: `assertDevDatabase()` hat bestaetigt, dass das Ziel die
 * Dev-Datenbank ist (kein Prod-Host, kein Prod-Name).
 *
 * Ohne sie waeren die dokumentierten Wartungsskripte (`npm run db:sweep-dev`,
 * `cleanup:test-data`, `purge:junk-master-data`, `budget:correct-km-drift`)
 * nicht mehr ausfuehrbar: das Prod-Gate verlangt `NODE_ENV=production` und
 * lehnt lokale Hosts ab, kann also fuer die Dev-DB per Konstruktion nie
 * greifen. Eine Sperre, die legitime Arbeit unmoeglich macht, wird umgangen —
 * und der Umgehungsweg waere ausgerechnet das gewesen, was oben gerade
 * geschlossen wurde.
 */
export function devZielGeprueft(ziel: string): void {
  freigabe = { art: "dev-db", ziel };
  console.log(`[write-lock] Ziel geprueft (Dev-DB): ${ziel}`);
}

/** Nur fuer Tests: den Prozess-Zustand zuruecksetzen. */
export function freigabeZuruecksetzen(): void {
  freigabe = null;
}

const HINWEIS = [
  "",
  "==============================================================================",
  "  ABBRUCH: Schreibzugriff aus einem Skript ohne Ziel-Freigabe.",
  "==============================================================================",
  "",
  "  Ein Skript darf erst schreiben, nachdem es sein ZIEL deklariert hat:",
  "",
  "    assertProdWriteAllowedOrThrow(args, \"<Zweck>\")",
  "      aus server/scripts/lib/prod-write-gate.ts",
  "",
  "  Aufruf dann mit --apply --user=<superadmin-id> --reason=\"…\"",
  "  und --confirm-target=<host>/<datenbank>.",
  "",
  "  Der Datenbankname wird an der OFFENEN Verbindung geprueft, nicht aus der",
  "  URL gelesen: am 18.08.2026 lief ein Dry-Run gegen `heliumdb` statt",
  "  `neondb`, weil `helium` in Dev wie Prod derselbe Hostname ist.",
  "",
  "  Diese Sperre sitzt am Treiber und gilt auch fuer Schreibzugriffe ueber",
  "  Storage-/Service-Helfer und innerhalb von Transaktionen.",
  "",
].join("\n");

/**
 * Der eigentliche Riegel. Wirft, wenn im Skript-Kontext ohne Freigabe
 * geschrieben wird.
 *
 * @param was Name der Operation, fuer die Fehlermeldung (`insert`, `execute`, …)
 */
export function assertSchreibenErlaubt(was: string): void {
  if (zielIstGeprueft()) return;
  throw new Error(`${HINWEIS}\n  Blockierte Operation: ${was}\n`);
}

/**
 * Es gibt ZWEI legitime Arten, ein Ziel zu deklarieren — und die Sperre
 * verlangt genau das, nicht mehr:
 *
 *   1. `assertProdWriteAllowedOrThrow` → bewusster Schreibzugriff auf eine
 *      echte Datenbank, mit Host + `current_database()` + Superadmin + Grund.
 *   2. eine verifizierte **Wegwerf-DB** → per Konstruktion unschaedlich.
 *   3. `assertDevWriteTargetOrThrow()` → bestaetigte Dev-Datenbank.
 *
 * Zu 3 stand hier `assertDevDatabase()`. Das ist FALSCH und war es immer:
 * `assertDevDatabase()` ruft `devZielGeprueft` nicht, erteilt der Sperre also
 * keine Freigabe. Nur die POSITIVE Pruefung tut das — was der ganze Punkt von
 * #118 war (ein negatives „nicht Prod" darf kein Schreibrecht erteilen).
 * Der Satz las sich wie „mit assertDevDatabase() ist ein Skript benutzbar",
 * und genau das stimmt nicht: es stirbt beim ersten Schreibzugriff am
 * HINWEIS-Block unten. Gefunden im Gate-2 zu #122.
 *
 * Form 2 fehlte im ersten Entwurf, und CI hat es sofort gezeigt:
 * `scripts/ci-seed-superadmin.ts` legt den Test-Superadmin an und wurde
 * blockiert. Dieselbe Klasse sind der Schema-Migrator und die Test-Cleanups —
 * sie haben kein Prod-Gate, weil sie nie auf Prod zeigen duerfen. Sie als
 * Ausnahme zu behandeln waere falsch: sie erfuellen die Regel „kein
 * Schreibzugriff ohne geprueftes Ziel" auf dem anderen Weg.
 */
function zielIstGeprueft(): boolean {
  if (ermittleKontext(process.argv[1]) !== "skript") return true;
  if (freigabe) return true; // Prod-Gate oder Dev-DB-Nachweis
  return evaluateTestDbTarget(process.env).ok; // Wegwerf-DB
}

/**
 * Wie `assertSchreibenErlaubt`, aber fuer `execute()`: nur DML/DDL sperren,
 * `SELECT` durchlassen. Die Erkennung teilt sich die SSoT mit dem statischen
 * Waechter (`@shared/db-write-statements`), damit beide nicht auseinanderlaufen.
 */
export function assertExecuteErlaubt(sql: unknown): void {
  if (zielIstGeprueft()) return;
  const text = sqlText(sql);
  // Unlesbare Form ⇒ wie Schreiben behandeln. Fail-closed auch hier: eine
  // Anweisung, die wir nicht lesen koennen, duerfen wir nicht freigeben.
  if (text !== null && !istSchreibendesSql(text)) return;
  throw new Error(`${HINWEIS}\n  Blockierte Operation: execute\n`);
}

/**
 * Drizzle reicht `SQL`-Objekte durch; wir brauchen nur den Text.
 *
 * REKURSIV, weil ein Chunk selbst wieder ein `SQL`-Objekt sein kann
 * (`sql\`${sql\`DELETE FROM invoices\`}\``). Die erste Fassung bildete solche
 * Chunks auf `""` ab — heraus kam Whitespace statt `null`, die Anweisung galt
 * als lesend und ging durch. Genau das Gegenteil der zugesagten Regel.
 *
 * Und: bleibt nach dem Zusammensetzen nur Leerraum, gilt das als UNLESBAR
 * (`null`) — nicht als "leer, also harmlos".
 */
function sqlText(sql: unknown, tiefe = 0): string | null {
  if (typeof sql === "string") return sql;
  if (tiefe > 8) return null; // Zyklenschutz; im Zweifel unlesbar
  if (sql && typeof sql === "object") {
    const q = sql as { queryChunks?: unknown[]; value?: unknown };
    if (Array.isArray(q.queryChunks)) {
      const teile = q.queryChunks.map((c) => sqlText(c, tiefe + 1) ?? "");
      const text = teile.join(" ").trim();
      return text.length > 0 ? text : null;
    }
    if (Array.isArray(q.value)) return q.value.join("");
    if (typeof q.value === "string") return q.value;
  }
  return null;
}

/** Namen der Methoden, die schreiben (vgl. `DbOrTx` in `server/lib/db.ts`). */
const SCHREIB_METHODEN = new Set([
  "insert",
  "update",
  "delete",
  // Gemessen an der realen drizzle-Instanz (Reflect.ownKeys ueber die
  // Prototypenkette): sie hat ausserdem `refreshMaterializedView`, und das
  // schreibt. Die Menge war als "die Methoden, die schreiben" deklariert und
  // war es nicht.
  "refreshMaterializedView",
]);

/**
 * Legt die Sperre um ein `db`- oder `tx`-Objekt.
 *
 * **`tx` muss mit umhuellt werden.** Genau ueber das Transaktions-Objekt
 * schreiben die Helfer (`rebookAppointmentConsumption`,
 * `stornoInvoiceDocumentOnly`). Wuerde nur `db` umhuellt, fielen exakt die
 * Indirektions-Faelle durch, fuer die diese Sperre gebaut wurde.
 */
export function mitSchreibsperre<T extends object>(ziel: T): T {
  return new Proxy(ziel, {
    get(target, prop, receiver) {
      const wert = Reflect.get(target, prop, receiver);
      if (typeof wert !== "function") return wert;
      const name = String(prop);

      if (SCHREIB_METHODEN.has(name)) {
        return (...args: unknown[]) => {
          assertSchreibenErlaubt(name);
          return (wert as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (name === "execute") {
        return (...args: unknown[]) => {
          assertExecuteErlaubt(args[0]);
          return (wert as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (name === "transaction") {
        return (cb: (tx: object) => unknown, ...rest: unknown[]) => {
          const gehuellt = (tx: object) => cb(mitSchreibsperre(tx));
          return (wert as (...a: unknown[]) => unknown).apply(target, [gehuellt, ...rest]);
        };
      }
      return (wert as (...a: unknown[]) => unknown).bind(target);
    },
  });
}
