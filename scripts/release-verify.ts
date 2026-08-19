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

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    abbruch("[release-verify] FEHLER: DATABASE_URL ist nicht gesetzt.");
  }

  const host = dbHostOf(process.env.DATABASE_URL) ?? "(Host unbekannt)";
  const datenbank = await currentDatabaseName();
  console.log(`[release-verify] Ziel: ${host}/${datenbank}`);

  // Existiert die Tabelle noch nicht (allererster Deploy, Schema-Push davor
  // hat sie gerade erst angelegt), gibt es nichts zu prüfen.
  const vorhanden = await db.execute(
    sql`SELECT to_regclass('public.invoices') IS NOT NULL AS da`,
  ) as unknown;
  const vorhandenRows = Array.isArray(vorhanden)
    ? vorhanden
    : ((vorhanden as { rows?: unknown[] }).rows ?? []);
  if (!(vorhandenRows[0] as { da?: boolean } | undefined)?.da) {
    console.log("[release-verify] Tabelle `invoices` existiert nicht — nichts zu prüfen.");
    return;
  }

  const ergebnis = await db.execute(
    sql`SELECT status, count(*)::int AS anzahl FROM invoices GROUP BY status ORDER BY count(*) DESC`,
  ) as unknown;
  const zeilen = (Array.isArray(ergebnis)
    ? ergebnis
    : ((ergebnis as { rows?: unknown[] }).rows ?? [])) as StatusZeile[];

  const befund = bewerteStatuszeilen(zeilen);
  if (befund.befunde.length > 0) {
    abbruch(releaseAbbruchMeldung(befund));
  }

  console.log(
    `[release-verify] ${zeilen.length} Statuswert(e) geprüft, alle lesbar.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    // Auch ein unerwarteter Fehler bricht den Release ab. Eine Prüfung, die bei
    // eigenem Versagen durchwinkt, ist keine.
    abbruch(`[release-verify] FEHLER: ${err instanceof Error ? err.message : String(err)}`);
  });
