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
| **Constraints** | **215** | **217** | **2 startup-only** |

Alle `ADD COLUMN`-, `ALTER COLUMN`- und `CREATE INDEX`-Effekte des Startup-Pfads
landen in der Baseline — inklusive der Typ-Korrekturen aus
`migrate-km-geo-to-numeric`, `migrate-monthly-work-hours-to-numeric`,
`fix-invoice-line-item-types` und `reconcile-drifted-column-types`. Auch die
`DROP`-Effekte stimmen: keine gedroppte Spalte oder Tabelle taucht in der
Baseline wieder auf.

## Die zwei Lücken

### 1. `appointments_prospect_or_customer_check` (CHECK)

Aus `server/startup/migrate-erstberatung-customers.ts`.

`CHECK (prospect_id IS NOT NULL OR customer_id IS NOT NULL)` — sichert ab, dass
ein Termin entweder an einem Kunden oder an einem Interessenten hängt.

Vom Drift-Wächter **erfasst** (`CHECK_SOURCES`), aber gegen ein handgepflegtes
Erwartungs-Prädikat im Test, **nicht** gegen das Drizzle-Modell. Das Modell kennt
den Constraint gar nicht, deshalb fehlt er der Baseline.

### 2. `audit_log_parent_deletion_id_fkey` (FOREIGN KEY)

Aus `server/startup/ensure-audit-parent-deletion.ts`.

`FOREIGN KEY (parent_deletion_id) REFERENCES audit_log(id)` — Selbstreferenz für
die Kaskaden-Zuordnung im Audit-Log.

Von **keinem** Coverage-Scan erfasst. Der Drift-Wächter hat Scans für `INDEX`,
`CHECK`, `CREATE TABLE`, `ADD COLUMN` und `TRIGGER` — aber keinen für
`FOREIGN KEY`. Die Spalte `parent_deletion_id` selbst steht im Modell und ist in
der Baseline; nur die Fremdschlüssel-Beziehung fehlt.

**Beide sind in Drizzle ausdrückbar** (`check()` bzw. `references()`/
`foreignKey()`). Ob sie ins Modell gehoben oder in die handgeführte Migration
aufgenommen werden, ist eine offene Entscheidung — siehe FINDINGs im A2-PR.

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
kennt — genau die zwei oben.

**Über Prod sagt er nichts.** Prod ist über Jahre gewachsener `push` plus 22 von
Hand per `psql` gefahrene Migrationen. Unvermessen bleiben dort: Umbenennungen,
alte Constraint-Namen, verwaiste Indizes aus der Push-Historie, und alles, was
je manuell angefasst wurde.

Nicht verglichen werden ausserdem — heute ohne Befund, aber latent:
`column_default`, Array-Elementtypen, `ordinal_position`, Collation,
Identity/Generated, Sequenzen, Enums/Domains, Extensions, Views, Kommentare,
Policies/RLS, Storage-Parameter, `NOT VALID`/`DEFERRABLE`.

## Was A3 damit prüft

A3 baut von Null (Baseline + Trigger-Migration) und diffed gegen das echte
Prod-Schema. Der Diff MUSS 0 sein.

**A3 darf sich dafür NICHT auf diese Query-Liste stützen**, sondern muss einen
normalisierten `pg_dump --schema-only`-Vergleich fahren — aus dem Grund im
Abschnitt darüber.

Die zwei hier gefundenen Constraints sind das Minimum, das A3 melden wird. Ob es
dabei bleibt, ist eine **Erwartung, keine Messung**: dieses Inventar hat Prod nie
gesehen. Meldet A3 mehr, ist das ein neuer Befund und ein Grund anzuhalten —
nicht, die Migration passend zu biegen.
