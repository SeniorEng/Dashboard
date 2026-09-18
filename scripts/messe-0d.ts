/**
 * Warum kommt Schritt 0d gegen Prod nicht durch? — Messwerkzeug, kein Fix.
 *
 * Ticket `6hWvrJgff5xr9hfp`. NUR LESEND: `pushSchema` wird im Trockenlauf
 * benutzt (`apply()` wird nie aufgerufen), es werden ausschliesslich
 * Katalog-Abfragen gefahren.
 *
 * ── Was bisher gemessen ist, und was NICHT ───────────────────────────────
 * Gemessen (lokal, Latenz ~0): 0d feuert **420 Abfragen** — sechs
 * Katalog-Abfragen pro Tabelle x 69 Tabellen + 6 globale — mit einer
 * Spitzen-Nebenlaeufigkeit von **69**. Lokal in 1,2 s durch.
 *
 * NICHT gemessen: warum es gegen Prod abbricht. Vier Laeufe brachen an
 * derselben Stelle ab (31–35 s), aber **die Fehlermeldung hat niemand
 * festgehalten** — und das ist ausgerechnet die Angabe, die die Hypothesen
 * auseinanderhaelt. Dieses Skript holt sie.
 *
 * ── Die zwei Hypothesen, die es trennt ───────────────────────────────────
 *
 *  A) **Verbindungsaufbau, nicht Abfragedauer.** `server/lib/db` faehrt
 *     `max: 20` mit `connectionTimeoutMillis: 15_000`. Eine 69-fache
 *     Auffaecherung laesst den Pool bis zu 20 Verbindungen GLEICHZEITIG
 *     aufbauen; gegen einen ungepoolten Serverless-Endpunkt ist jede davon
 *     ein eigener TLS-Handshake auf einem womoeglich kalten Compute. Wer
 *     dabei ueber 15 s kommt, bekommt einen Acquire-Timeout. Die beobachteten
 *     31–35 s liegen verdaechtig nahe an zwei solchen Fenstern.
 *
 *  B) **Fehlendes Connection-Pooling** (Coworks Hypothese, 18.09.2026): Neon
 *     hat auf Produktions-Datenbanken standardmaessig kein Pooling; mit
 *     `-pooler` im Host haelt der Endpunkt warme Server-Verbindungen vor.
 *
 * **Die beiden widersprechen sich nicht — B ist die Reparatur fuer A.** Wenn
 * der Flaschenhals der Verbindungsaufbau ist, macht der Pooler ihn billig.
 * Faellt der Lauf dagegen mit einer Abfrage-Fehlermeldung oder nach einer
 * ganz anderen Zeit, sind beide tot, und das ist genauso ein Ergebnis.
 *
 * ── Aufruf ───────────────────────────────────────────────────────────────
 *
 *   npx tsx scripts/messe-0d.ts                      # wie der Release-Step
 *   npx tsx scripts/messe-0d.ts --gleichzeitig=4     # Auffaecherung gedeckelt
 *   npx tsx scripts/messe-0d.ts --pool-max=5
 *
 * Fuer den Pooler-Lauf wird die URL AUSGETAUSCHT, nicht vom Skript
 * umgeschrieben — Begruendung unten bei `poolerHostHinweis`. Das Skript nennt
 * den Host, den man dafuer braucht, und meldet hinterher, welchen es
 * tatsaechlich gemessen hat.
 *
 * Die Prod-URL kommt aus `.prod-url.txt` (gitignored) oder aus
 * `PROD_DATABASE_URL`. **Sie wird nie ausgegeben** — gemeldet werden Host und
 * `current_database()` aus der offenen Verbindung.
 *
 * Empfohlene Reihenfolge, je ein Lauf: ohne Flags (Grundlinie, holt die
 * Fehlermeldung), dann derselbe Lauf mit der Pooler-URL, dann
 * `--gleichzeitig=4`. Drei Laeufe trennen A, B und „keins von beiden".
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { dbHostOf } from "@shared/ephemeral-db-target";
import { drizzle } from "drizzle-orm/node-postgres";
import { pushSchema } from "drizzle-kit/api";
import * as schema from "@shared/schema";

const WURZEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fehler(text: string): never {
  console.error(`\nABBRUCH: ${text}\n`);
  process.exit(1);
}

// ── Argumente ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flagWert = (name: string): number | null => {
  const treffer = argv.find((a) => a.startsWith(`--${name}=`));
  if (!treffer) return null;
  const n = Number(treffer.split("=")[1]);
  if (!Number.isFinite(n) || n < 1) fehler(`--${name} braucht eine Zahl >= 1.`);
  return n;
};
const gleichzeitigMax = flagWert("gleichzeitig");
const poolMax = flagWert("pool-max") ?? 20;

// ── Ziel-URL ──────────────────────────────────────────────────────────────
function urlHolen(): string {
  if (process.env.PROD_DATABASE_URL) return process.env.PROD_DATABASE_URL;
  try {
    const roh = readFileSync(path.join(WURZEL, ".prod-url.txt"), "utf8").trim();
    if (roh) return roh;
  } catch {
    // faellt unten in die Anleitung
  }
  console.error("Die Prod-URL fehlt. Sie steht im Replit-Publishing-Tab unter „Environment“.");
  console.error("");
  console.error("So hinterlegen — eingefuegt, nicht getippt, damit sie weder in die");
  console.error("Shell-History noch in einen Commit geraet:");
  console.error("");
  console.error("    cat > .prod-url.txt");
  console.error("    <URL einfuegen, dann Enter, dann Strg-D>");
  console.error("");
  fehler("keine Prod-URL.");
}

const zielUrl = urlHolen();

/**
 * Welcher Host ist das? — ueber die SSoT, nicht selbst geparst.
 *
 * `dbHostOf` liefert `null`, wenn die beiden Parser dieses Repos sich ueber die
 * Host-Grenze uneinig sind (unkodiertes `@`, `#`, `?` in der userinfo). Das ist
 * hier ein ABBRUCH und keine Randnotiz: uneinige Parser heissen, dass unklar
 * ist, wogegen gemessen wird — und eine Messung gegen ein unklares Ziel ist
 * keine.
 *
 * Die erste Fassung zog den Host mit `new URL(...).hostname` selbst heraus.
 * `tests/architecture/dev-db-guard-parity.test.ts` hat das in CI gefangen: es
 * war eine zweite Antwort auf „welcher Host?", und genau dafuer gibt es den
 * Waechter. Der Gate-2-Reviewer hatte dieselbe Doppelung einen Commit vorher
 * in `script/schema-replica-diff.mjs` angemeldet — dort ist sie unvermeidbar
 * (`.mjs` unter blankem node), hier war sie es nicht.
 */
const anzeigeHost = dbHostOf(zielUrl);
if (!anzeigeHost) {
  fehler(
    "Der Host der Ziel-URL ist nicht eindeutig bestimmbar (uneinige Parser — "
      + "vermutlich ein unkodiertes @, # oder ? im Passwort). Ohne eindeutiges "
      + "Ziel ist die Messung wertlos.",
  );
}

/**
 * Wie hiesse derselbe Endpunkt als Pooler? — reine Zeichenkettenarbeit auf
 * einem bereits aufgeloesten Hostnamen, keine zweite URL-Zerlegung.
 *
 * ── Warum das Skript die URL NICHT selbst umschreibt ─────────────────────
 * Die erste Fassung tat es (`--pooler`), mit dem Argument: den Host von Hand
 * zu aendern heisst, die Zugangsdaten anzufassen. Das Argument stimmt — aber
 * der Preis war eine URL-Operation auf dem Host, also die Doppelung, die der
 * Waechter verbietet. Und die Gefahr ist hier kleiner als gedacht: ein Vertipper
 * im Host scheitert LAUT (`ENOTFOUND`), er misst nicht still das Falsche.
 *
 * Stattdessen: das Skript sagt den Host an, den der Pooler-Lauf braucht, und
 * meldet oben, welchen es tatsaechlich gemessen hat. Wer die falsche URL
 * hinterlegt, sieht es in der Kopfzeile.
 */
function poolerHostHinweis(host: string): string | null {
  const teile = host.split(".");
  if (teile.length < 2) return null;
  if (teile[0].endsWith("-pooler")) return null;
  teile[0] = `${teile[0]}-pooler`;
  return teile.join(".");
}

// ── Semaphor: deckelt, wie viele Abfragen gleichzeitig unterwegs sind ─────
function semaphor(max: number) {
  let offen = 0;
  const warteschlange: (() => void)[] = [];
  return async function <T>(fn: () => Promise<T>): Promise<T> {
    if (offen >= max) await new Promise<void>((r) => warteschlange.push(r));
    offen += 1;
    try {
      return await fn();
    } finally {
      offen -= 1;
      warteschlange.shift()?.();
    }
  };
}

// ── Lauf ──────────────────────────────────────────────────────────────────
const t0 = Date.now();
const seit = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5);

let gestartet = 0;
let fertig = 0;
let offen = 0;
let spitze = 0;
const dauern: number[] = [];

const pool = new pg.Pool({
  connectionString: zielUrl,
  max: poolMax,
  connectionTimeoutMillis: 15_000,
  keepAlive: true,
});
const db = drizzle(pool, { schema });

console.log("Messung Schritt 0d");
console.log("==================");
console.log(`Host          : ${anzeigeHost}${anzeigeHost.includes("-pooler") ? "   (Pooler-Variante)" : ""}`);
console.log(`Pool-Max      : ${poolMax}`);
console.log(`Gleichzeitig  : ${gleichzeitigMax ?? "unbegrenzt (wie im Release-Step)"}`);
const hinweis = poolerHostHinweis(anzeigeHost);
if (hinweis) {
  console.log("");
  console.log("Fuer den Pooler-Lauf dieselbe URL mit diesem Host hinterlegen:");
  console.log(`  ${hinweis}`);
}
console.log("");

const drossel = gleichzeitigMax ? semaphor(gleichzeitigMax) : null;

const proxy = new Proxy(db, {
  get(ziel, prop, recv) {
    const orig = Reflect.get(ziel, prop, recv);
    if (prop !== "execute" || typeof orig !== "function") return orig;
    return (...args: unknown[]) => {
      const lauf = async () => {
        const i = ++gestartet;
        offen += 1;
        spitze = Math.max(spitze, offen);
        const start = Date.now();
        try {
          const r = await (orig as (...a: unknown[]) => Promise<unknown>).apply(ziel, args);
          dauern.push(Date.now() - start);
          fertig += 1;
          return r;
        } catch (e) {
          // DIE Zeile, wegen der es dieses Skript gibt.
          console.error(
            `\n[${seit()}s] ABFRAGE #${i} SCHEITERT nach ${Date.now() - start}ms`
              + `\n            ${e instanceof Error ? e.message : String(e)}`
              + `\n            (gestartet: ${gestartet}, fertig: ${fertig}, offen: ${offen})`,
          );
          throw e;
        } finally {
          offen -= 1;
        }
      };
      return drossel ? drossel(lauf) : lauf();
    };
  },
});

const puls = setInterval(() => {
  console.log(
    `[${seit()}s] laeuft — ${gestartet} gestartet, ${fertig} fertig, ${offen} offen, Spitze ${spitze}`,
  );
}, 5_000);

try {
  // Identitaet zuerst: eine einzelne Abfrage. Kommt schon SIE nicht durch, ist
  // es kein Auffaecherungs-Problem — dann steht die Antwort hier und der Rest
  // des Laufs ist ueberfluessig.
  const ident = await pool.query("SELECT current_database() AS db");
  console.log(`[${seit()}s] Identitaet steht: ${anzeigeHost}/${ident.rows[0].db}`);
  console.log(`[${seit()}s] Trockenlauf beginnt …\n`);

  const ergebnis = await pushSchema(
    schema as Parameters<typeof pushSchema>[0],
    proxy as unknown as Parameters<typeof pushSchema>[1],
  );

  dauern.sort((a, b) => b - a);
  console.log("");
  console.log(`FERTIG nach ${seit()}s`);
  console.log(`  Abfragen        : ${gestartet}`);
  console.log(`  Spitzen-Gleichz.: ${spitze}`);
  console.log(`  langsamste 3    : ${dauern.slice(0, 3).join(" ms, ")} ms`);
  console.log(`  anstehende DDL  : ${ergebnis.statementsToExecute.length}`);
} catch (e) {
  console.error("");
  console.error(`ABGEBROCHEN nach ${seit()}s bei ${gestartet} gestarteten Abfragen.`);
  console.error(`  ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  console.error("");
  console.error("Bitte diese Ausgabe vollstaendig ins Ticket 6hWvrJgff5xr9hfp kopieren —");
  console.error("die Fehlermeldung ist die Angabe, die bisher fehlte.");
  process.exitCode = 2;
} finally {
  clearInterval(puls);
  await pool.end().catch(() => {});
}
