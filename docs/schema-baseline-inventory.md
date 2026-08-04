# Schema-Baseline — Struktur-Inventar (A2)

Stand: 03.08.2026. Erhoben gegen die gebootete Test-DB, nicht aus Quelltext
abgeleitet. Der Befund ist als Test festgenagelt:
`tests/startup/baseline-structure-inventory.test.ts`.

## Was der Bauplan heute ist

| Teil | Datei | Herkunft |
|---|---|---|
| Struktur (Tabellen, Spalten, Indizes, die meisten Constraints) | `migrations/0000_*.sql` | generiert per `drizzle-kit generate` aus `shared/schema.ts` (Barrel über `shared/schema/**`) |
| Trigger + Trigger-Funktionen | `migrations/manual/0001_gobd_triggers.sql` | generiert aus `server/startup/trigger-registry.ts` (A1) |

Die alte, kaputte Historie liegt inaktiv unter `migrations_legacy/`
(siehe `migrations_legacy/ARCHIV.md`).

**Kein Runner wendet das heute an.** `scripts/migrate.sh` fährt weiterhin
`drizzle-kit push`; der programmatische Migrator kommt in A3.

## Methode

Eine zweite Wegwerf-DB wird **nur** aus Baseline + Trigger-Migration gebaut und
ihr Katalog gegen die laufende Test-DB gestellt (= Drizzle-Modell **plus** alle
Startup-DDL-Effekte). Verglichen werden Tabellen, Spalten (Typ inkl.
Precision/Scale und Nullability), Indizes (normalisierte `indexdef`),
Constraints (`pg_get_constraintdef`), Trigger (`pg_get_triggerdef`) und
Trigger-Funktionen.

Textvergleiche gegen die 34 Startup-Dateien wären schwächer: sie zeigen die
Absicht, nicht das Ergebnis.

## Ergebnis

| Objektart | Baseline | Laufzeit | Delta |
|---|---|---|---|
| Tabellen | 68 | 68 | — |
| Spalten | 944 | 944 | — |
| Indizes | 260 | 260 | — |
| Trigger | 16 | 16 | — |
| Trigger-Funktionen | 11 | 11 | — |
| **Constraints** | **215** | **216** | **1 startup-only** |

Die Constraint-Zeile stand bei der Ersterhebung auf 216 vs. 217. Von den beiden
damaligen Abweichungen ist eine behoben (das FK-Duplikat) und eine als
**bewusste Ausnahme** eingetragen (`appointments_prospect_or_customer_check`,
unten). Erneut gemessen am 03.08.2026 gegen eine frisch gepushte und gebootete
Wegwerf-DB.

**„Laufzeit" heißt hier: frische Orchestrator-DB, nicht die Dev-Kopie.** Der
Unterschied ist für die Ausnahme-Zeile real. `drizzle-kit push` droppt den
startup-only CHECK, sobald er nicht mehr im Modell steht (gemessen), und
`scripts/post-merge.sh` fährt `npm run db:push` unbeaufsichtigt gegen die
Dev-DB. Zurück kommt er dort **nicht**: die Anlage ist ledger-gegated und in der
Dev-DB längst als gelaufen vermerkt. Auf einer langlebigen Dev-/Test-DB steht
also über kurz oder lang 215 vs. 215 — der Inventar-Test meldet dann „Liste ist
veraltet". Abhilfe ist **nicht** erneutes Pushen (das ist die Ursache), sondern
eine frische DB oder das Löschen des Ledger-Eintrags
`migrate-erstberatung-customers`.

Alle `ADD COLUMN`-, `ALTER COLUMN`- und `CREATE INDEX`-Effekte des Startup-Pfads
landen in der Baseline — inklusive der Typ-Korrekturen aus
`migrate-km-geo-to-numeric`, `migrate-monthly-work-hours-to-numeric`,
`fix-invoice-line-item-types` und `reconcile-drifted-column-types`. Auch die
`DROP`-Effekte stimmen: keine gedroppte Spalte oder Tabelle taucht in der
Baseline wieder auf.

## Erledigt: `audit_log_parent_deletion_id_fkey` — ein DUPLIKAT, kein fehlender Constraint

Das war ursprünglich als „FK fehlt im Modell" notiert. Die Messung sagt etwas
anderes: das Drizzle-Modell **hat** die Selbstreferenz längst —

```ts
parentDeletionId: integer("parent_deletion_id").references((): AnyPgColumn => auditLog.id)
```

— nur unter dem von Drizzle vergebenen Namen
`audit_log_parent_deletion_id_audit_log_id_fk`. Der steht in der Baseline.
`server/startup/ensure-audit-parent-deletion.ts` legte daneben einen **zweiten**,
funktional identischen FK unter dem Postgres-Default-Namen `..._fkey` an.

Der folgende Abschnitt beschreibt den Befund im **Präsens des Zeitpunkts der
Erhebung**; die Korrektur steht darunter.

In der DB lagen deshalb beide:

```
audit_log_parent_deletion_id_audit_log_id_fk | FOREIGN KEY (parent_deletion_id) REFERENCES audit_log(id)
audit_log_parent_deletion_id_fkey            | FOREIGN KEY (parent_deletion_id) REFERENCES audit_log(id)
```

Identisch in **jedem** Attribut — Spalten (`conkey`/`confkey`), Zieltabelle,
`ON UPDATE`/`ON DELETE` (beide `NO ACTION`), `MATCH SIMPLE`, nicht deferrable,
validiert. Der Preis ist nicht nur eine doppelte Prüfung: Postgres hält je FK
einen vollständigen Satz interner RI-Trigger, also einen zweiten auf der
schreibintensivsten Tabelle der App.

**Ihn dem Modell hinzuzufügen wäre falsch**: dann stünden zwei FKs in der
Baseline, und die Redundanz wäre auf Dauer gestellt.

### Es ist ein Ping-Pong — gemessen auf dem `--force`-Pfad

Gemessen: `drizzle-kit push --force` **droppt** den `_fkey` — er steht ja nicht
im Modell. `ensure-audit-parent-deletion.ts` prüfte seine Existenz aber über den
**Namen** (`WHERE conname = 'audit_log_parent_deletion_id_fkey'`) und legte ihn
beim nächsten Boot sofort wieder an. Die Reihenfolge push→boot erklärt, warum die
Laufzeit-DB beide trug — kein historischer Zufall.

**Für Prod ist das eine Vermutung, keine Messung.** Der Coolify-Pre-Deploy fährt
`bash scripts/migrate.sh` **ohne** `--force` (`scripts/migrate.sh:43` reicht
Argumente nur durch), und ohne `--force` ist `push` interaktiv — ob ein
destruktives `DROP CONSTRAINT` dort überhaupt angewendet wird, ist hier nicht
belegt. Gemessen ist nur: Prod trägt beide FKs (Schema-Dump 03.08.2026).
**Wie** das Duplikat dort entstanden ist, weiß dieses Dokument nicht.

Das entscheidet, was an Gate 4 zu tun ist:

- Droppt der Pre-Deploy den `_fkey` tatsächlich, erledigt der nächste reguläre
  Deploy dieser Änderung ihn von selbst — dann ist Gate 4 nur eine Nachkontrolle.
- Droppt er ihn nicht, bleibt der Constraint bis zu einem ausdrücklichen
  manuellen Drop liegen.

Klären lässt sich das ohne Prod-Schreibzugriff: über den tatsächlich in Coolify
konfigurierten Pre-Deploy-Command, über das Pre-Deploy-Log des letzten Deploys
(steht dort ein `DROP CONSTRAINT ..._fkey`?), oder über einen erneuten
`pg_dump --schema-only` **nach** dem nächsten Deploy.

### Behoben: spaltenbasierte Prüfung statt namensbasierter

Ein Drop in Prod allein hätte genau bis zum nächsten Boot gehalten — deshalb
musste der FK-Block im Startup-Skript weichen, nicht der Constraint in der DB.
`ensure-audit-parent-deletion.ts` prüft die Existenz jetzt **spaltenbasiert**
(`conrelid='audit_log'::regclass AND contype='f' AND attname='parent_deletion_id'`)
und legt unter dem **Drizzle-Namen** an, falls wirklich keiner da ist. Das Muster
gab es im Repo bereits: `ensure-reservation-captured-transaction-link.ts`
begründet es mit „unabhängig von einer eventuell von `drizzle-kit` abweichenden
Constraint-Namens-Trunkierung".

Nebenbefund derselben Zeile: die alte Prüfung schränkte nicht auf `conrelid` ein.
`conname` ist in PostgreSQL nur pro Tabelle eindeutig — ein gleichnamiger
Constraint auf einer fremden Tabelle hätte die Anlage hier stillgelegt.

Gepinnt in `tests/startup/startup-schema-drift.test.ts` → „Startup FK-Drift":
genau ein FK auf der Spalte, unter dem Drizzle-Namen; ein zweiter Boot ist ein
No-Op; plus eine Negativ-Kontrolle auf einer TEMP-Tabelle, die das alte
namensbasierte Verhalten reproduziert (dort entsteht der Zweitling wirklich).

**Prod trägt das Duplikat weiterhin** (Schema-Dump 03.08.2026). Sicher ist nur:
ab jetzt **hält** ein Drop dort, weil kein Boot ihn mehr nachlegt. Ob er von
selbst durch den nächsten Pre-Deploy passiert oder ausdrücklich gefahren werden
muss, ist die offene Frage aus dem Abschnitt oben — beides ist Gate 4 (Kontrolle
bzw. Schreiboperation), nichts davon Teil dieser Änderung.

Wird er manuell gefahren: **genau `audit_log_parent_deletion_id_fkey` droppen**
und den Drizzle-Namen stehen lassen. Fielen beide, legt der nächste Boot den FK
neu an — inklusive Validierungs-Scan unter `ACCESS EXCLUSIVE` auf der
schreibintensivsten Tabelle, mitten im Start.

### Annahmen, auf denen die Messung beruht

Der Vergleich setzt voraus, dass der **Boot nach dem Push** lief — sonst fehlen
der „Laufzeit"-Seite alle Startup-Effekte. Im Orchestrator und in CI ist die
Reihenfolge garantiert (der Server bootet vor den Tests).

Zweitens: die Laufzeit-DB muss mit dem **aktuellen** Code gebootet worden sein.
Eine langlebige lokale Test-DB, die noch einen Boot der namensbasierten Fassung
gesehen hat, trägt den `..._fkey` weiterhin — dort meldet der Inventar-Test zu
Recht eine veraltete Ausnahme-Liste. Einmal neu pushen genügt.

## Die eine verbleibende Abweichung

### `appointments_prospect_or_customer_check` — startup-only, und das bleibt so

A2 hatte den CHECK ins Drizzle-Modell gehoben, weil die Dev-Kopie ihn trägt und
er der Baseline fehlte. Das war ein Fehlschluss aus der falschen Referenz: der
Prod-Schema-Dump vom 03.08.2026 zeigt, dass Prod ihn **nicht** hat. Der einzige
CHECK im gesamten Prod-Schema ist `qonto_transactions_match_xor`.

**Gemessen ist genau das — dass er fehlt. WARUM er fehlt, ist offen.**

#### Die Anlage läuft einmal pro DB, nicht bei jedem Boot

`ensureCheckConstraint` sitzt in `migrateErstberatungCustomers`, und die ist als
`migrate-erstberatung-customers` über `runGuardedBudgetMigration` registriert
(`server/startup/data-migration-runner.ts:222`). Der Runner prüft vorher das
Ledger `budget_migrations` und steigt aus, wenn ein Eintrag da ist
(`server/startup/budget-migration-runner.ts:137`).

Der Constraint-Versuch läuft also **genau einmal pro Datenbank**. In Prod steht
der Ledger-Eintrag seit dem ersten Boot nach #1428; seither wird der Block nie
wieder ausgeführt — auch nicht nach einer Datenbereinigung.

Beim damaligen einmaligen Lauf hat er übersprungen:

```ts
if (violatingCount > 0) {
  log(`CHECK-Constraint übersprungen: ${violatingCount} Termine ohne prospect_id und customer_id gefunden`, "startup");
  return;
}
```

Kein stiller Fehlschlag — ein bewusstes Überspringen mit Log-Zeile.

#### Zwei konkurrierende Erklärungen, beide unbelegt

1. **Verletzende Bestandsdaten beim einmaligen Lauf.** Naheliegend, aber nirgends
   mit einer Zeilenzahl aus Prod belegt.
2. **Der Constraint war da und wurde gedroppt.**
   `.agents/memory/additive-publish-diff-strategy.md:63-66` hält fest, dass der
   Replit-Publish-Diff genau diesen Constraint aus Prod **droppen** wollte — was
   voraussetzt, dass Prod ihn einmal hatte. Zusammen mit dem Ledger-Gate ergäbe
   das: Constraint war da → ein Publish hat ihn gedroppt → das Ledger verhindert
   seither jede Wiederherstellung, unabhängig von den Daten.

Trifft (2) zu, verfestigt „aus dem Modell nehmen" einen Deploy-Unfall, statt die
Realität abzubilden. Für die **Baseline** ändert das nichts (sie muss abbilden,
was in Prod steht), wohl aber für den Folge-Task.

#### Verdacht zur Datenlage: Grabsteine, nicht lebende Termine

`migrate-erstberatung-customers.ts:32-35` zählt **ohne** `deleted_at`-Filter —
für einen Tabellen-CHECK korrekt, er gilt auch für soft-gelöschte Zeilen. Das
Aufräum-Skript zu genau diesen Waisen (`server/scripts/cleanup-orphan-appointments.ts`)
filtert dagegen auf `deleted_at IS NULL` und **soft-deletet** die Funde
(`.set({ deletedAt: now })`), ohne `prospect_id`/`customer_id` zu setzen. Das
Aufräumen erzeugt also selbst Zeilen, die den CHECK weiter verletzen und ihn
dauerhaft blockieren.

Wenn es so gelaufen ist, hält Prod die Invariante für alle **lebenden** Termine
längst ein, und die Maßnahme ist viel kleiner als „fachliche Entscheidung +
Datenbereinigung": entweder Hard-Delete der Grabsteine oder ein Teilprädikat
`CHECK (deleted_at IS NOT NULL OR prospect_id IS NOT NULL OR customer_id IS NOT NULL)`.

**Das ist eine Vermutung.** Zwei read-only Queries auf Prod entscheiden sie:

```sql
SELECT count(*) FILTER (WHERE deleted_at IS NULL)     AS lebend,
       count(*) FILTER (WHERE deleted_at IS NOT NULL) AS grabsteine
FROM appointments WHERE prospect_id IS NULL AND customer_id IS NULL;

SELECT name, applied_at, summary FROM budget_migrations
WHERE name = 'migrate-erstberatung-customers';
```

#### Warum er trotzdem aus dem Modell muss

Im Modell wäre er ein Constraint, den **jede frisch gebaute DB hätte und Prod
nicht** — genau die Asymmetrie, an der die A3-Gegenprobe („von Null gebaut ==
Prod, Diff 0") scheitern müsste. Er ist deshalb aus dem Modell entfernt und in
`KNOWN_STARTUP_ONLY_CONSTRAINTS` eingetragen; die regenerierte Baseline ist zur
vorigen byte-gleich bis auf genau diese Zeile.

**Das ist keine Entscheidung gegen die Invariante.** Ob sie in Prod erzwungen
werden soll, ist eine fachliche Frage und ausdrücklich kein Migrations-Thema.

**Wichtig für den Folge-Task:** „Constraint einfach in beide Wege legen" reicht
NICHT. Der vorhandene Startup-Pfad ist ledger-gegated und liefe in Prod als
No-op — es bräuchte eine **neue** Migration unter neuem Namen (oder einen
ungegateten `ensure`-Hook) plus den Eintrag in der Baseline. Wer das übersieht,
bereinigt die Daten und wundert sich, dass der Constraint nicht kommt.

## Kein Befund, aber wissenswert

`budget_transactions_appointment_required_check` existiert **weder** in der
Baseline **noch** in der laufenden DB. Das ist korrekt und dokumentiert:
`ensureBudgetTxAppointmentConstraint` ist laut eigenem Docblock (Task #1841)
bewusst **nicht** im Startup verdrahtet, weil noch Legacy-Waisen ohne
`appointment_id` existieren und ein `km-rebook` das Feld kurzzeitig auf `NULL`
setzt. Die SSoT-DDL und der Drift-Wächter-Eintrag bleiben stehen, bis das
Follow-up sie wieder scharf schaltet.

**Wenn das passiert, muss der Constraint in beide Wege** — Startup-Pfad und
Baseline/Migration. Sonst entsteht genau die Asymmetrie, die dieses Inventar
aufdeckt.

## Was dieses Inventar NICHT abdeckt

Die „Laufzeit"-Seite des Vergleichs ist `drizzle-kit push` (= Modell) **plus**
Startup-DDL. Jede Startup-Anweisung ist `IF NOT EXISTS`- bzw.
`pg_constraint`-geguardet und damit auf einer frisch gepushten DB ein No-op. Der
Vergleich kann strukturell also nur Startup-Objekte finden, die das Modell nicht
kennt — genau die zwei oben: eine behoben, eine als bewusste Ausnahme geführt.

**Über Prod sagt er nichts.** Prod ist über Jahre gewachsener `push` plus 22 von
Hand per `psql` gefahrene Migrationen. Unvermessen bleiben dort: Umbenennungen,
alte Constraint-Namen, verwaiste Indizes aus der Push-Historie, und alles, was
je manuell angefasst wurde.

Ein `pg_dump --schema-only` von Prod liegt seit dem 03.08.2026 vor und bestätigt
punktuell: 68 Tabellen, 130 FKs (die 129 der Baseline **plus** das
`..._fkey`-Duplikat), 16 Trigger, 14 Trigger-Funktionen (die 11 der Migration
plus die 3 verwaisten `budget_ledger_*`, die `0001_gobd_triggers.sql` droppt),
und genau **einen** CHECK: `qonto_transactions_match_xor`. Der systematische
Abgleich bleibt A3 vorbehalten — das hier sind Stichproben, keine Gegenprobe.

Nicht verglichen werden ausserdem — heute ohne Befund, aber latent:
`column_default`, Array-Elementtypen, `ordinal_position`, Collation,
Identity/Generated, Sequenzen, Enums/Domains, Extensions, Views, Kommentare,
Policies/RLS, Storage-Parameter, `NOT VALID`/`DEFERRABLE`.

## Was A3 damit prüft

A3 baut von Null (Baseline + Trigger-Migration) und diffed gegen das echte
Prod-Schema. Der Diff MUSS 0 sein.

**A3 darf sich dafür NICHT auf diese Query-Liste stützen**, sondern muss einen
normalisierten `pg_dump --schema-only`-Vergleich fahren — aus dem Grund im
Abschnitt darüber. Und er muss auf `--schema=public` einschränken: Prod trägt
zusätzlich das Replit-Schema `_system` (`replit_database_migrations_v1` samt
Sequenz und Index), das die Baseline zu Recht nicht baut.

**Die Von-Null-DB darf für diesen Vergleich NICHT gebootet werden.** Sonst ist
sie leer, das Ledger ist leer, `violatingCount` ist 0 — und der Startup-Pfad legt
den CHECK an. Dann steht er auf der Von-Null-Seite und nicht auf der Prod-Seite:
dasselbe Falsch-Delta wie vorher, nur mit umgekehrtem Vorzeichen. Diese Änderung
beseitigt die Asymmetrie also nicht, sie verschiebt sie von „Baseline vs. Prod"
nach „frisch gebootet vs. Prod" — für A3 handhabbar, aber nur mit dieser
Vorbedingung.

Bekanntes Restdelta, das A3 melden wird: das `..._fkey`-Duplikat in Prod (Drop =
Gate 4, hält seit der FK-Korrektur). Der CHECK dagegen ist KEIN Restdelta mehr —
er steht weder in der Baseline noch in Prod; A3 darf ihn auf beiden Seiten nicht
sehen. Taucht er wieder auf, ist das Modell zurückgefallen.

Ob es dabei bleibt, ist eine **Erwartung, keine Messung** — dieses Inventar
vergleicht Testumgebung gegen Testumgebung.
Meldet A3 mehr, ist das ein neuer Befund und ein Grund anzuhalten, nicht, die
Migration passend zu biegen.
