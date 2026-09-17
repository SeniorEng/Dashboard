/**
 * SSoT der Frage „ist die Referenz-DB aktuell genug für diese Messung?"
 *
 * ── Warum es das gibt ────────────────────────────────────────────────────
 * `engeldesk_ref` ist eine pseudonymisierte Prod-Kopie. Sie ist nur so viel
 * wert wie ihr Alter: misst jemand eine Monatsfrage gegen einen zwei Wochen
 * alten Stand, bekommt er eine Zahl, die plausibel aussieht und falsch ist.
 *
 * Genau das ist am 02.09.2026 passiert — ein Analyse-Skript meldete
 * 64.837,30 € „verfallenen Anspruch", weil die Ref-DB für das Quelljahr gar
 * keine Bewegungsdaten hatte. Die Lehre war nicht „besser hinsehen", sondern:
 * ein Skript, dessen Prämissen nicht erfüllt sind, muss ABBRECHEN statt eine
 * Zahl zu drucken. Dieses Modul ist dieselbe Regel für die Dimension ALTER.
 *
 * ── Das Muster ───────────────────────────────────────────────────────────
 * Aufrufer rufen `assertRefDbFresh()` als ERSTES, vor jeder Abfrage. Ist der
 * Stand zu alt oder unbekannt, bricht der Prozess mit Exit-Code 2 ab — nicht
 * mit 1, damit „Prämisse nicht erfüllt" von „Skript kaputt" unterscheidbar
 * bleibt (dieselbe Konvention wie `analyse-45b-anker-floor-verfall.ts`).
 *
 * ── Warum ein eigenes Modul und kein Copy-Paste ──────────────────────────
 * Weil die Toleranz EINE Zahl sein muss. Stünde sie in jedem Analyse-Skript,
 * wäre sie nach drei Skripten dreimal verschieden — und das Skript mit der
 * großzügigsten Kopie bestimmt, wie alt eine Zahl sein darf.
 */
import { sql } from "drizzle-orm";
import { db } from "../../server/lib/db";

/**
 * Toleranz in Tagen.
 *
 * Bemessen an der Refresh-Kadenz (täglich, nachts) plus einem Tag Luft:
 * ein einzelner ausgefallener Lauf soll nicht die Arbeit blockieren, zwei
 * schon. Wer die Kadenz ändert, ändert diese Zahl mit — sie ist kein
 * Komfortwert, sondern die Aussage „so alt darf eine Messung höchstens sein".
 */
export const REF_DB_MAX_AGE_DAYS = 2;

export interface RefDbFreshness {
  lastRefreshAt: Date;
  ageDays: number;
  sourceDumpName: string | null;
}

/** Ist die verbundene DB überhaupt die Referenz-DB? */
async function currentDatabaseName(): Promise<string> {
  const r = await db.execute(sql`SELECT current_database() AS name`);
  return String((r.rows[0] as Record<string, unknown>).name);
}

async function readMeta(): Promise<RefDbFreshness | null> {
  const exists = await db.execute(sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'ref_db_meta'
  `);
  if (exists.rows.length === 0) return null;

  const r = await db.execute(sql`
    SELECT last_refresh_at, source_dump_name FROM ref_db_meta LIMIT 1
  `);
  if (r.rows.length === 0) return null;

  const row = r.rows[0] as Record<string, unknown>;
  const lastRefreshAt = new Date(String(row.last_refresh_at));
  if (Number.isNaN(lastRefreshAt.getTime())) return null;

  return {
    lastRefreshAt,
    ageDays: (Date.now() - lastRefreshAt.getTime()) / 86_400_000,
    sourceDumpName: row.source_dump_name == null ? null : String(row.source_dump_name),
  };
}

/**
 * Bricht ab, wenn die Referenz-DB zu alt oder ihr Stand unbekannt ist.
 *
 * Gibt bei Erfolg den Stand zurück, damit das aufrufende Skript ihn in seinen
 * Kopf drucken kann — eine Zahl ohne Stichtag ist im Nachhinein wertlos.
 *
 * @param maxAgeDays Toleranz überschreiben. Nur für Fragen, die nachweislich
 *   unempfindlich gegen Alter sind (z.B. Schema-Fragen). Wer sie hochsetzt,
 *   begründet das am Aufrufort.
 */
export async function assertRefDbFresh(
  opts: { maxAgeDays?: number } = {},
): Promise<RefDbFreshness> {
  const maxAgeDays = opts.maxAgeDays ?? REF_DB_MAX_AGE_DAYS;
  const dbName = await currentDatabaseName();
  const meta = await readMeta();

  if (!meta) {
    console.error(
      `\nABBRUCH: kein Refresh-Zeitstempel in \`${dbName}\`.\n\n` +
      "  Die Tabelle `ref_db_meta` fehlt oder ist leer. Damit ist UNBEKANNT,\n" +
      "  wie alt dieser Datenstand ist — und eine Messung gegen einen\n" +
      "  unbekannt alten Stand ist keine Messung.\n\n" +
      "  Wenn das die Referenz-DB ist: einmal `scripts/ref-db/refresh-box.sh`\n" +
      "  laufen lassen, der setzt den Stempel beim Einspielen.\n" +
      "  Wenn das NICHT die Referenz-DB ist: DATABASE_URL prüfen.\n",
    );
    process.exit(2);
  }

  if (meta.ageDays > maxAgeDays) {
    const tage = meta.ageDays.toFixed(1);
    console.error(
      `\nABBRUCH: \`${dbName}\` ist ${tage} Tage alt (Toleranz ${maxAgeDays}).\n\n` +
      `  Letzter Refresh: ${meta.lastRefreshAt.toISOString()}\n` +
      (meta.sourceDumpName ? `  Quell-Dump:      ${meta.sourceDumpName}\n` : "") +
      "\n  Eine Monatsfrage gegen diesen Stand liefert eine Zahl, die\n" +
      "  plausibel aussieht und falsch ist. Genau so entstand am 02.09.2026\n" +
      "  das 64.837,30-€-Artefakt.\n\n" +
      "  Entweder den Refresh nachziehen, oder die Frage bewusst gegen Prod\n" +
      "  stellen (Alrik, read-only) — nicht die Toleranz hochsetzen.\n",
    );
    process.exit(2);
  }

  return meta;
}

/** Kopfzeile für Analyse-Ausgaben: jede Zahl braucht ihren Stichtag. */
export function refDbStandLine(f: RefDbFreshness): string {
  return `Datenstand: ${f.lastRefreshAt.toISOString().slice(0, 16).replace("T", " ")} UTC `
    + `(${f.ageDays.toFixed(1)} Tage alt)`;
}
