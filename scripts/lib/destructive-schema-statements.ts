/**
 * Reiner Kern des Schema-Riegels: **Welche der Anweisungen, die `drizzle-kit
 * push` gleich ausführen würde, vernichten Daten?**
 *
 * ── Warum das gebraucht wird ────────────────────────────────────────────
 * `scripts/migrate.sh` läuft im Release-Hook mit `--force`. `--force` heißt bei
 * drizzle-kit ausdrücklich „alle Datenverlust-Anweisungen automatisch
 * genehmigen". Der vorhandene Build-Check (`script/check-pre-publish-backup.mjs`)
 * liest DATEIEN in `migrations/` — bei `push` gibt es die nicht, er ist auf
 * diesem Pfad blind. Der blockierende Preflight
 * (`script/preflight-publish.mjs`) ist ein Operator-Schritt und hängt an
 * `PROD_DATABASE_URL`; im automatischen Deploy ruft ihn niemand auf.
 *
 * Ohne diesen Riegel gäbe es im Deploy-Pfad also KEIN technisches Gate gegen
 * einen Spalten-Drop — nur die Review-Regel in CLAUDE.md.
 *
 * ── Warum nicht `hasDataLoss` von drizzle-kit ───────────────────────────
 * Empirisch geprüft (0.31.10): eine Spalte, die in der DB steht und im Schema
 * fehlt, erzeugt `ALTER TABLE … DROP COLUMN …` in `statementsToExecute`, aber
 * `hasDataLoss` bleibt **false**. Wer sich auf das Flag verlässt, hat kein Gate.
 * Deshalb werden die Anweisungen selbst gelesen.
 *
 * ── Warum nur DROP COLUMN / DROP TABLE ──────────────────────────────────
 * Ebenfalls gemessen: ein Push gegen ein deckungsgleiches Schema erzeugt
 * regelmäßig ~8 `DROP CONSTRAINT`-Anweisungen (drizzle legt Fremdschlüssel neu
 * an, weil die Namen in der DB abgeschnitten sind). Ein Riegel auf „DROP"
 * würde also JEDEN Deploy blockieren und wäre nach einer Woche abgeschaltet.
 * Gefiltert wird deshalb auf dasselbe Muster, das der bestehende Backup-Check
 * verwendet: `DROP COLUMN` und `DROP TABLE`.
 *
 * Rein: Anweisungen rein, Drops raus. Keine DB, kein drizzle-Import — damit
 * ohne Wegwerf-DB testbar.
 */

/** Interchange-Form von `script/schema-replica-diff.mjs` (dropKey/describeDrop). */
export interface Drop {
  table: string;
  column?: string;
}

/** Dasselbe Muster wie `script/check-pre-publish-backup.mjs`. */
const DESTRUKTIV = /\bDROP\s+(COLUMN|TABLE)\b/i;

const DROP_COLUMN =
  /\bALTER\s+TABLE\s+(?<tabelle>(?:"[^"]+"|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|[\w$]+))?)\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(?<spalte>"[^"]+"|[\w$]+)/i;
const DROP_TABLE =
  /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?<tabelle>(?:"[^"]+"|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|[\w$]+))?)/i;

/** `"public"."invoices"` → `invoices`; `"invoices"` → `invoices`. */
function bezeichner(roh: string): string {
  const letzterTeil = roh.split(".").pop() ?? roh;
  return letzterTeil.trim().replace(/^"(.*)"$/s, "$1");
}

/**
 * Filtert aus den Anweisungen eines `push`-Trockenlaufs die datenvernichtenden.
 *
 * Anweisungen, die auf `DESTRUKTIV` passen, aber von keinem der beiden
 * Detailmuster zerlegt werden können, kommen als `{ table: "(unbekannt)" }`
 * zurück statt still zu verschwinden — ein nicht geparster Drop muss den
 * Release aufhalten, nicht durchrutschen.
 */
export function findeDestruktiveAnweisungen(anweisungen: readonly string[]): Drop[] {
  const drops: Drop[] = [];
  for (const anweisung of anweisungen) {
    if (!DESTRUKTIV.test(anweisung)) continue;

    const spalte = DROP_COLUMN.exec(anweisung);
    if (spalte?.groups) {
      drops.push({
        table: bezeichner(spalte.groups.tabelle),
        column: bezeichner(spalte.groups.spalte),
      });
      continue;
    }

    const tabelle = DROP_TABLE.exec(anweisung);
    if (tabelle?.groups) {
      drops.push({ table: bezeichner(tabelle.groups.tabelle) });
      continue;
    }

    drops.push({ table: "(unbekannt)" });
  }
  return drops;
}
