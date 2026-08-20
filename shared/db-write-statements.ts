/**
 * **Schreibt diese Anweisung?** — EINE Antwort für zwei Prüfer.
 *
 * Zwei Stellen stellen dieselbe Frage und dürfen nicht auseinanderlaufen:
 *
 *   1. `tests/architecture/prod-write-gate-coverage.test.ts` — statisch: welche
 *      Skript-Datei schreibt überhaupt und braucht deshalb das Ziel-Gate?
 *   2. `server/lib/prod-write-lock.ts` — zur Laufzeit: darf dieses konkrete
 *      `execute()` durch, oder ist es ein Schreibzugriff ohne Freigabe?
 *
 * Liefen die beiden auseinander, entstünde genau der Zustand, den beide
 * verhindern sollen: der statische Wächter meldet ein Skript als harmlos, die
 * Laufzeit lässt es schreiben — oder umgekehrt blockiert die Laufzeit ein
 * Report-Skript, das der Wächter nie beanstandet hat, und jemand schaltet sie
 * ab. Deshalb steht die Erkennung hier und nirgends sonst.
 *
 * Bewusst in `shared/`: `server/lib/**` darf nicht aus `scripts/**` oder
 * `tests/**` importieren, und das Prod-Image kopiert `shared/` ohnehin.
 */

/** Query-Builder-Schreibaufrufe: `.insert(`, `.update(`, `.delete(`. */
export const SCHREIB_BUILDER_MUSTER = /\.\s*(?:update|insert|delete)\s*\(/;

/** `db.execute(`, `tx.execute(`, `trx.execute(` — der Träger für rohes SQL. */
export const ROH_EXEC_MUSTER = /\b(?:db|tx|trx)\s*\.\s*execute\s*\(/;

/**
 * DML/DDL in rohem SQL.
 *
 * `SELECT` fehlt hier bewusst: `execute()` trägt lesende und schreibende
 * Anweisungen gleichermaßen, und ein Riegel, der Reports blockiert, wird
 * abgeschaltet. Was hier steht, verändert Daten oder Struktur.
 */
// Kein abschliessendes `\b`: es verlangte eine Wortgrenze direkt hinter dem
// ersten Zeichen des Tabellennamens, weshalb `UPDATE invoices …` NICHT traf
// (`UPDATE i` traf, `UPDATE in` nicht). Der Mutationstest 4 hat das gefunden —
// ohne ihn waere die Laufzeit-Sperre fuer rohes `UPDATE` blind geblieben.
export const ROH_SQL_MUSTER =
  /\b(?:UPDATE\s+\w|INSERT\s+INTO\b|DELETE\s+FROM\b|TRUNCATE\b|ALTER\s+TABLE\b|DROP\s+(?:TABLE|COLUMN|INDEX|TYPE|SCHEMA)\b|CREATE\s+(?:TABLE|INDEX|UNIQUE|TYPE|SCHEMA)\b)/i;

/**
 * Verändert dieses rohe SQL etwas? Für den **Laufzeit**-Prüfer: er sieht die
 * fertige Anweisung, nicht den Quelltext, der sie erzeugt hat.
 *
 * Kommentare werden vorher entfernt — sonst genügte ein `-- DELETE FROM …`
 * in einer harmlosen Abfrage, um sie fälschlich zu sperren.
 */
export function istSchreibendesSql(sql: string): boolean {
  const ohneKommentare = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  return ROH_SQL_MUSTER.test(ohneKommentare);
}

/**
 * Schreibt dieser QUELLTEXT? Für den **statischen** Prüfer.
 *
 * Grobkörniger als `istSchreibendesSql`, und das ist Absicht: hier zählt „diese
 * Datei kann schreiben", nicht „diese Zeile schreibt". Fehlalarme sind hier
 * billiger als Auslassungen — ein zu Unrecht gelistetes Skript kostet einen
 * Blick, ein übersehenes kostet eine Datenbank.
 */
export function quelltextSchreibt(text: string): boolean {
  // Kommentare raus: ein `// … DELETE FROM …` in einer Erklaerung ist kein
  // Schreibzugriff. Strings bleiben drin — ein Skript, das seinen SQL-Befehl
  // als Literal traegt, schreibt tatsaechlich.
  const ohneKommentare = text
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  if (SCHREIB_BUILDER_MUSTER.test(ohneKommentare)) return true;
  return ROH_EXEC_MUSTER.test(ohneKommentare) && ROH_SQL_MUSTER.test(ohneKommentare);
}
