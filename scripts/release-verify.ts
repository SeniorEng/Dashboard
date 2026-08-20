/**
 * Release-Step: prüft, ob der auszuliefernde Code den vorhandenen Datenstand
 * lesen kann. Teil von `scripts/migrate.sh`, nicht einzeln aufzurufen.
 *
 * ── Warum hier und nicht beim Boot ──────────────────────────────────────
 * Ein Boot-Gate hätte denselben Fehler gefunden, aber bei JEDEM Start — auch
 * beim Restart einer laufenden Version (OOM, Healthcheck, Host-Reboot). Aus
 * „die Abrechnung antwortet mit 500" wäre „nichts läuft mehr, auch /health
 * nicht" geworden, und der Ausweg wäre ein Prod-Schreibzugriff gewesen, der
 * selbst ein Gate ist.
 *
 * Als Release-Step bricht ein Fehlschlag den Deploy ab und lässt die laufende
 * Version unberührt.
 *
 * ── Plattform-agnostisch ────────────────────────────────────────────────
 * Braucht ausschließlich `DATABASE_URL`. Die Verbindung läuft über
 * `server/lib/db`, das `DB_DRIVER` auswertet — `neon` (Replit/Prod, WebSocket)
 * und `pg` (Coolify, TCP) funktionieren beide, ohne dass dieses Skript den
 * Unterschied kennen muss.
 *
 * ── Die URL wird NIE ausgegeben ─────────────────────────────────────────
 * Sie trägt das Passwort. Gemeldet werden Host (aus der URL) und
 * Datenbankname (aus der OFFENEN Verbindung, per `current_database()`) —
 * dieselbe Quelle, gegen die das Prod-Schreib-Gate vergleicht. Beim Testen ist
 * uns genau dieser Leak einmal passiert.
 */
import { sql } from "drizzle-orm";
import { db } from "../server/lib/db";
import { dbHostOf, currentDatabaseName } from "../server/scripts/lib/prod-write-gate";
import {
  bewerteStatuszeilen,
  releaseAbbruchMeldung,
  type StatusZeile,
} from "@shared/domain/invoice-status-domain";

function abbruch(nachricht: string): never {
  console.error(`\n${nachricht}\n`);
  process.exit(1);
}

/** Postgres: `undefined_table`. */
const TABELLE_FEHLT = "42P01";

/**
 * Drizzle verpackt Treiberfehler in `DrizzleQueryError`; der SQLSTATE-Code
 * steckt dann in `cause`, nicht oben. Ohne diese Kette hielt die Prüfung eine
 * fehlende Tabelle für einen unbekannten Fehler — fail-closed zwar, aber mit
 * falscher Meldung, und der legitime allererste Deploy wäre gebrochen.
 */
function sqlstate(err: unknown): string | undefined {
  let aktuell: unknown = err;
  for (let tiefe = 0; aktuell && tiefe < 5; tiefe++) {
    const code = (aktuell as { code?: unknown }).code;
    if (typeof code === "string") return code;
    aktuell = (aktuell as { cause?: unknown }).cause;
  }
  return undefined;
}

const FEHLT = Symbol("tabelle-fehlt");

/**
 * Liest die Statusverteilung. Fehlt die Tabelle, kommt `FEHLT` zurück statt
 * einer Ausnahme — ob das in Ordnung ist, entscheidet der Modus, nicht diese
 * Funktion. Jeder ANDERE Fehler fliegt weiter und bricht den Release ab.
 */
async function statuszeilenLesen(): Promise<StatusZeile[] | typeof FEHLT> {
  try {
    const ergebnis = (await db.execute(
      sql`SELECT status, count(*)::int AS anzahl FROM invoices GROUP BY status ORDER BY count(*) DESC`,
    )) as unknown;
    // `pg` und `neon-serverless` liefern beide `{ rows }`. Ein Treiber, der
    // etwas anderes liefert, darf NICHT als „leerer Bestand" durchgehen —
    // deshalb Abbruch statt `?? []`.
    const rows = Array.isArray(ergebnis)
      ? ergebnis
      : (ergebnis as { rows?: unknown[] }).rows;
    if (!Array.isArray(rows)) {
      abbruch(
        "[release-verify] FEHLER: Ergebnisform des DB-Treibers nicht lesbar.\n" +
          "Eine Pruefung, die ihr eigenes Ergebnis nicht versteht, darf nicht durchwinken.",
      );
    }
    return rows as StatusZeile[];
  } catch (err) {
    if (sqlstate(err) === TABELLE_FEHLT) return FEHLT;
    throw err;
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    abbruch("[release-verify] FEHLER: DATABASE_URL ist nicht gesetzt.");
  }

  const host = dbHostOf(process.env.DATABASE_URL) ?? "(Host unbekannt)";
  const datenbank = await currentDatabaseName();
  console.log(`[release-verify] Ziel: ${host}/${datenbank}`);

  // Kein Frühausstieg mehr. Die frühere Fassung sprang bei fehlender Tabelle
  // mit exit 0 heraus („allererster Deploy") — und färbte damit genau den Fall
  // grün, der im Betrieb viel häufiger ist: ein fehlgeschlagener Schema-Push.
  // `drizzle-kit push` meldet einen DDL-Fehler mit exit 0 (gemessen, 0.31.10),
  // danach fehlt die Tabelle, und diese Zeile sagte „nichts zu prüfen".
  //
  // Zweitens war die Existenzprüfung schema-qualifiziert (`public.invoices`),
  // die Lese-Abfrage aber nicht (`FROM invoices`, also über `search_path`) —
  // zwei Prädikate für eine Frage. Jetzt gibt es nur noch die Abfrage selbst;
  // schlägt sie fehl, bricht der Release ab, statt zu urteilen.
  const zeilen = await statuszeilenLesen();

  // Zwei Modi, weil „Tabelle fehlt" je nach Zeitpunkt etwas anderes bedeutet.
  // VOR dem Push (Schritt 0e) ist es der allererste Deploy — legitim.
  // NACH dem Push (Schritt 2) heisst dasselbe: der Push hat nicht gewirkt.
  const vorDemPush = process.argv[2] === "--vor-dem-push";

  if (zeilen === FEHLT) {
    if (vorDemPush) {
      console.log(
        "[release-verify] Tabelle `invoices` existiert noch nicht — vor dem Push nichts zu pruefen.",
      );
      return;
    }
    abbruch(
      "RELEASE ABGEBROCHEN — Tabelle `invoices` fehlt NACH dem Schema-Push.\n\n" +
        "Das heisst nicht 'allererster Deploy', sondern: Schritt 1 hat nicht\n" +
        "gewirkt. `drizzle-kit push` meldet einen DDL-Fehlschlag mit exit 0 —\n" +
        "der eigentliche Fehler steht im Log von Schritt 1.\n\n" +
        "Der Deploy bricht ab; die laufende Version bleibt unberuehrt.",
    );
  }

  const befund = bewerteStatuszeilen(zeilen);
  if (befund.befunde.length > 0) {
    abbruch(releaseAbbruchMeldung(befund));
  }

  console.log(
    `[release-verify] ${zeilen.length} Statuswert(e) geprüft, alle lesbar` +
      `${vorDemPush ? " (vor dem Push)" : ""}.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    // Auch ein unerwarteter Fehler bricht den Release ab. Eine Prüfung, die bei
    // eigenem Versagen durchwinkt, ist keine.
    abbruch(`[release-verify] FEHLER: ${err instanceof Error ? err.message : String(err)}`);
  });
