import { isNull, and, type SQL, type AnyColumn } from "drizzle-orm";

/**
 * Task #447 — Soft-Delete zentral durchsetzen.
 *
 * `activeOnly(table)` liefert das `isNull(table.deletedAt)`-Prädikat.
 * Wird von den Repos in `server/repos/*` automatisch bei jeder `find*`-Methode
 * angewendet. Routen, die das Repo-`selectFrom` als Escape-Hatch nutzen,
 * MÜSSEN `activeOnly()` in ihre `.where()`-Klausel aufnehmen — sonst tauchen
 * gelöschte Datensätze in operativen Listen auf (GoBD-Verstoß).
 *
 * `withActive(table, extra?)` kombiniert das Predicate mit zusätzlichen
 * Bedingungen — bevorzugt für komplexe Where-Klauseln in Repos.
 */
export function activeOnly(table: { deletedAt: AnyColumn }): SQL {
  return isNull(table.deletedAt);
}

export function withActive(
  table: { deletedAt: AnyColumn },
  extra?: SQL | undefined,
): SQL {
  return extra ? (and(activeOnly(table), extra) as SQL) : activeOnly(table);
}
