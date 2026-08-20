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

export type Schreibkontext = "app" | "test" | "skript";

/**
 * Rein, damit sie testbar ist, ohne den Prozess umzubauen. `argv1` ist
 * `process.argv[1]` — was tatsächlich gestartet wurde.
 */
export function ermittleKontext(
  argv1: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Schreibkontext {
  // Vitest setzt `VITEST`; `NODE_ENV=test` deckt Nebenwege ab.
  if (env.VITEST === "true" || env.VITEST_WORKER_ID || env.NODE_ENV === "test") {
    return "test";
  }
  if (!argv1) return "skript"; // fail-closed

  const p = argv1.replace(/\\/g, "/");
  // Der gebündelte Server und sein Quelltext-Pendant.
  if (/(^|\/)dist\/index\.cjs$/.test(p) || /(^|\/)server\/index\.ts$/.test(p)) {
    return "app";
  }
  if (/(^|\/)(server\/)?scripts\//.test(p)) return "skript";
  return "skript"; // fail-closed
}

let freigabe: { erteilt: true; ziel: string } | null = null;

/** Wird ausschliesslich vom Prod-Schreib-Gate gerufen, nach dessen Pruefungen. */
export function freigabeErteilen(ziel: string): void {
  freigabe = { erteilt: true, ziel };
}

/** Nur fuer Tests: den Prozess-Zustand zuruecksetzen. */
export function freigabeZuruecksetzen(): void {
  freigabe = null;
}

export function freigabeErteilt(): boolean {
  return freigabe !== null;
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
  if (ermittleKontext(process.argv[1]) !== "skript") return;
  if (freigabe) return;
  throw new Error(`${HINWEIS}\n  Blockierte Operation: ${was}\n`);
}

/**
 * Wie `assertSchreibenErlaubt`, aber fuer `execute()`: nur DML/DDL sperren,
 * `SELECT` durchlassen. Die Erkennung teilt sich die SSoT mit dem statischen
 * Waechter (`@shared/db-write-statements`), damit beide nicht auseinanderlaufen.
 */
export function assertExecuteErlaubt(sql: unknown): void {
  if (ermittleKontext(process.argv[1]) !== "skript") return;
  if (freigabe) return;
  const text = sqlText(sql);
  // Unlesbare Form ⇒ wie Schreiben behandeln. Fail-closed auch hier: eine
  // Anweisung, die wir nicht lesen koennen, duerfen wir nicht freigeben.
  if (text !== null && !istSchreibendesSql(text)) return;
  throw new Error(`${HINWEIS}\n  Blockierte Operation: execute\n`);
}

/** Drizzle reicht `SQL`-Objekte durch; wir brauchen nur den Text. */
function sqlText(sql: unknown): string | null {
  if (typeof sql === "string") return sql;
  if (sql && typeof sql === "object") {
    const q = sql as { queryChunks?: unknown[] };
    if (Array.isArray(q.queryChunks)) {
      // Die statischen Teile genuegen: `UPDATE foo SET x = $1` steht dort,
      // die Parameter sind irrelevant fuer die Frage "schreibt das?".
      return q.queryChunks
        .map((c) => {
          if (typeof c === "string") return c;
          const v = (c as { value?: unknown }).value;
          return Array.isArray(v) ? v.join("") : "";
        })
        .join(" ");
    }
  }
  return null;
}

/** Namen der Methoden, die schreiben (vgl. `DbOrTx` in `server/lib/db.ts`). */
const SCHREIB_METHODEN = new Set(["insert", "update", "delete"]);

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
