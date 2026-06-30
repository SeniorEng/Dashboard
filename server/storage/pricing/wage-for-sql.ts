/**
 * Task #1503 — SQL-Spiegel der `wageFor`-SSoT (`shared/domain/pricing/wage-for.ts`).
 *
 * Die reine Domänenfunktion `resolveWageFor` löst „Welcher Stundensatz gilt für
 * Rolle × Leistung × Datum?" für EINEN Datensatz auf. Die Wirtschaftlichkeits-
 * /Statistik-/Export-Aggregate rechnen aber über VIELE Termine + Mitarbeiter
 * gleichzeitig in einer SQL-Query. Damit Anzeige === Buchung gilt, MUSS die
 * SQL-Auflösung byte-für-byte derselben Logik folgen wie die TS-SSoT:
 *
 *   1. Rollen-Satz (`role_wage_rates`) — EXISTENZ einer aktiven Zeile gewinnt
 *      IMMER, auch bei `cents = 0` (kein 0/NULL-Kurzschluss auf den Katalog).
 *      `pickActive`: spätestes `valid_from`, höchste `id` als Tiebreaker;
 *      `valid_to` inklusiv (NULL = offenes Ende).
 *   2. Katalog-Default (`services.employee_rate_cents`) — unterster Fallback.
 *
 * Die Rolle ist die des LEISTENDEN Mitarbeiters (admin > teamLead > employee),
 * abgeleitet aus seinen Flags — deckungsgleich mit `wageRoleForUserFlags`
 * (`shared/domain/pricing/wage-for.ts`) UND `isTeamLead`/`actorRole`
 * (`server/lib/team-lead.ts`): teamLead nur, wenn aktiv UND nicht anonymisiert
 * UND kein Admin/SuperAdmin.
 *
 * Wichtig: Diese Datei enthält KEINE fachliche Berechnung (kein `calculate*`/
 * `compute*` außerhalb von `shared/domain/`), sondern nur die Lookup-Auflösung
 * als SQL-Fragment. Die eigentliche Kosten-Mathematik (Minuten→Euro) bleibt in
 * `shared/domain/statistics/economics.ts` (`costForMinutes`/`buildEconomics`).
 */
import { sql, type SQL } from "drizzle-orm";

/**
 * SQL-Ausdruck, der die Lohn-Rolle eines Mitarbeiters aus seinen Flags ableitet.
 * `u` ist der Tabellen-Alias des (users-)Joins des leistenden Mitarbeiters.
 *
 * Bei LEFT JOIN ohne Treffer (alle Flags NULL) fällt der Ausdruck auf
 * `'employee'` — derselbe konservative Default wie in der TS-Ableitung für einen
 * unbekannten Mitarbeiter.
 */
export function wageRoleSql(u: string): SQL {
  const a = sql.raw(u);
  return sql`CASE
    WHEN ${a}.is_admin OR ${a}.is_super_admin THEN 'admin'
    WHEN ${a}.is_team_lead AND ${a}.is_active AND NOT COALESCE(${a}.is_anonymized, false) THEN 'teamLead'
    ELSE 'employee'
  END`;
}

/**
 * SQL-Ausdruck, der den aufgelösten Stundensatz (Integer-Cents) für eine Rolle ×
 * Leistung × Datum liefert — exakter Spiegel von `resolveWageFor`.
 *
 * @param roleExpr  SQL, das die Rolle liefert (i. d. R. `wageRoleSql("u")`).
 * @param s         Tabellen-Alias des `services`-Joins (für `id` + Default).
 * @param dateExpr  SQL-Datum des Termins (z. B. ``sql`a.date::date` ``).
 *
 * EXISTENZ-gewinnt-bei-0: Die Subquery liefert `cents` (auch 0) wenn eine aktive
 * Rollen-Zeile existiert; nur bei KEINER Zeile (Subquery = NULL) greift
 * `COALESCE` den Katalog-Default. `COALESCE(0, default) = 0` bleibt also 0.
 */
export function resolvedWageCentsSql(roleExpr: SQL, s: string, dateExpr: SQL): SQL {
  const sa = sql.raw(s);
  return sql`COALESCE(
    (SELECT w.cents FROM role_wage_rates w
     WHERE w.role = ${roleExpr}
       AND w.service_id = ${sa}.id
       AND w.deleted_at IS NULL
       AND w.valid_from::date <= ${dateExpr}
       AND (w.valid_to IS NULL OR w.valid_to::date >= ${dateExpr})
     ORDER BY w.valid_from DESC, w.id DESC
     LIMIT 1),
    ${sa}.employee_rate_cents
  )`;
}
