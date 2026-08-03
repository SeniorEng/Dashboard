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
| **Constraints** | **216** | **216** | **—** |

Die Constraint-Zeile stand bei der Ersterhebung auf 216 vs. 217. Das eine
Duplikat ist inzwischen behoben (unten); erneut gemessen am 03.08.2026 gegen eine
frisch gepushte und gebootete Wegwerf-DB.

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
`server/startup/ensure-audit-parent-deletion.ts` legt daneben einen **zweiten**,
funktional identischen FK unter dem Postgres-Default-Namen `..._fkey` an.

In der laufenden DB liegen deshalb beide:

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

### Es ist ein Deploy-Ping-Pong, kein Altbestand

Gemessen: `drizzle-kit push --force` **droppt** den `_fkey` — er steht ja nicht
im Modell. `ensure-audit-parent-deletion.ts` prüft seine Existenz aber über den
**Namen** (`WHERE conname = 'audit_log_parent_deletion_id_fkey'`) und legt ihn
beim nächsten Boot sofort wieder an.

In Prod heißt das bei jedem Deploy: Pre-Deploy droppt einen Constraint auf
`audit_log`, der Boot fügt ihn wieder ein. Das erklärt auch, warum die
Laufzeit-DB beide trägt — die Reihenfolge push→boot ist der Grund, nicht ein
historischer Zufall.

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

**Prod trägt das Duplikat weiterhin.** Der Schema-Dump vom 03.08.2026 zeigt beide
FKs nebeneinander. Der einmalige Drop dort ist eine Prod-Schreiboperation
(Gate 4) und NICHT Teil dieser Änderung — er wird aber ab jetzt halten, weil kein
Boot ihn mehr nachlegt.

### Annahmen, auf denen die Messung beruht

Der Vergleich setzt voraus, dass der **Boot nach dem Push** lief — sonst fehlen
der „Laufzeit"-Seite alle Startup-Effekte. Im Orchestrator und in CI ist die
Reihenfolge garantiert (der Server bootet vor den Tests).

Zweitens: die Laufzeit-DB muss mit dem **aktuellen** Code gebootet worden sein.
Eine langlebige lokale Test-DB, die noch einen Boot der namensbasierten Fassung
gesehen hat, trägt den `..._fkey` weiterhin — dort meldet der Inventar-Test zu
Recht eine veraltete Ausnahme-Liste. Einmal neu pushen genügt.

### Erledigt: `appointments_prospect_or_customer_check`

Der CHECK stand tatsächlich nur im Startup-Pfad. Er ist jetzt im Drizzle-Modell
(`shared/schema/appointments.ts`), wortgleich zum gemessenen
`pg_get_constraintdef`, unter unverändertem Namen — ein abweichender Name hätte
beim nächsten `push` einen zweiten, gleichbedeutenden Constraint erzeugt statt
den vorhandenen zu erkennen. Die neu erzeugte Baseline enthält ihn.

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
kennt — genau die zwei oben, beide inzwischen aufgelöst.

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

Bekanntes Restdelta, das A3 melden wird: das `..._fkey`-Duplikat in Prod (Drop =
Gate 4, hält seit dieser Änderung). Ob es dabei bleibt, ist eine **Erwartung,
keine Messung** — dieses Inventar vergleicht Testumgebung gegen Testumgebung.
Meldet A3 mehr, ist das ein neuer Befund und ein Grund anzuhalten, nicht, die
Migration passend zu biegen.
