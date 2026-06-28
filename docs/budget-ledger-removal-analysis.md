# Budget-Ledger Referenz-Analyse (Paket 1.1 — Vorprüfung)

> **Status (abgeschlossen 28.06.2026 — Task #1486):**
> - **`budget_ledger` = ENTFERNT** — der frühere Spiegel UND der Zweit-Link
>   `budget_reservations.captured_ledger_id` sind über die freigabe-gegatete
>   Guarded-Migration `drop-budget-ledger-1443` in Prod gedroppt; nach dem
>   bestätigten Prod-Drop wurde in Task #1486 das gesamte Drop-Gerüst
>   (Migrationsdatei, Flag `APPROVED_DROP_BUDGET_LEDGER`, Preflight-Deskriptor,
>   Schema-Deklaration) abgebaut. SoT der Buchungen ist allein
>   `budget_transactions` mit `captured_transaction_id` als einzigem Capture-Link.
>   Der Drift-Wächter `tests/startup/startup-schema-drift.test.ts` prüft seither
>   den Endzustand (weder Tabelle noch FK-Spalte dürfen wiederkehren).
> - **`budget_reservations` = NO-GO** (produktive Live-Holds, jeder Verfügbar-
>   keits-Read) und **`budget_migrations` = NO-GO** (Migrations-Bookkeeping) —
>   unverändert.
>
> Ursprüngliche Read-only-Analyse vom 12.06.2026, `budget_ledger`-GO-Urteil vom
> 26.06.2026 auf Basis der Drop-Verifikation
> (`.local/tasks/budget-ledger-drop-verification-report.md`): kein
> Live-Reader/Writer mehr, alle 62 Prod-Zeilen 1:1 in `budget_transactions`
> gespiegelt (struktureller + deterministischer ID-Match, null Info-Verlust),
> Drop-Reihenfolge FK-sicher. Der Drop ist seit 28.06.2026 vollzogen.

## Frage

Paket 1.1 wollte `budget_ledger`, `budget_reservations` und `budget_migrations`
entfernen und die GoBD-Unveränderbarkeit direkt auf `budget_transactions`
erzwingen — unter der Annahme, dies seien tote/giftige Schatten-Tabellen neben
`budget_transactions`. Diese Analyse prüft je Referenz, ob das stimmt.

## Wichtigste Erkenntnis (Stolperfalle bestätigt)

Die **Fassade** `budgetLedgerStorage` (`server/storage/budget-ledger.ts`,
Interface `BudgetLedgerStorage`) ist die zentrale Budget-Fassade und wird an
**~90 Stellen** importiert (Routes, Services, Startup, Skripte). Sie ist
**NICHT** die `budget_ledger`-TABELLE. Naive Greps nach „budgetLedger"
vermischen beides. Diese Analyse zählt ausschließlich **echten
Tabellen-Zugriff** (Drizzle `.from/.insert/.update/.delete` auf den
Schema-Objekten `budgetLedger` / `budgetReservations` / `budgetMigrations` bzw.
rohes SQL auf den Tabellennamen).

Der echte Tabellen-Fußabdruck ist klein — aber **produktiv und nicht durch
`budget_transactions` ersetzbar**: alle drei Tabellen tragen eine andere
Funktion als der Consumption-Ledger `budget_transactions`.

---

## Tabelle: `budget_reservations` — **PRODUKTIV (Lesen bei jeder Verfügbarkeit) → NO-GO**

Operative Holds (Phase 5, „BUDGET_HARD_HOLDS"). Bewusst **nicht** GoBD,
mutierbar (State `hold | captured | released | expired`), aus Finanz-Exporten
ausgeschlossen — also kein Duplikat des Consumption-Ledgers.

| Datei → Pfad/Funktion | Urteil | Beweis |
|---|---|---|
| `shared/schema/budget.ts:217` | Definition | Tabellendeklaration + Insert-Schema/Typen (`:260,268`). |
| `server/storage/budget/unified-reader.ts:52-71,216,270,305` `activeHoldsCents()` | **produktiv-lesend (ungated!)** | Der **eine** Verfügbarkeits-Reader (`readUnifiedBudgetAvailability`) liest `budget_reservations WHERE state='hold'` bei **jeder** Verfügbarkeitsberechnung für **alle drei** statutarischen Töpfe (§45b/§45a/§39+§42a). Läuft unabhängig vom Feature-Flag — ohne Holds liefert die Aggregation 0, das SELECT läuft trotzdem. Tabelle weg ⇒ jeder Budget-Read bricht. |
| `server/storage/budget/reservation-storage.ts` (gesamtes Modul) | produktiv-schreibend (flag-gated) | `planHold/captureHolds/releaseHolds/rescheduleHold/sweepOrphanHolds` schreiben/mutieren Holds. Aktiv bei `BUDGET_HARD_HOLDS` (siehe unten). |
| `server/lib/budget-conservation.ts:118-119` | produktiv-lesend | `leftJoin(budgetLedger …)` für den Orphan-`captured`-Kreuzcheck (Invariante I13). |
| `tests/budget/hard-holds-engine.test.ts`, `tests/budget-ledger-immutability.test.ts` | Test | Direkter Engine-/Trigger-Test. |

**Go/No-Go:** **NO-GO.** Nicht durch `budget_transactions` ersetzbar — Holds sind
ein eigenes operatives Konzept (geplant/noch nicht verbraucht) und werden auf
dem **Lesepfad jeder Budget-Verfügbarkeit** abgefragt.

---

## Tabelle: `budget_ledger` — **GO (redundanter Spiegel, #1443 verifiziert)**

> **Update 26.06.2026 (#1443/#1446):** Diese Tabelle wurde von **NO-GO auf GO**
> revidiert. Die Stufen A→C (Tasks #1272–#1274) haben `budget_ledger`
> schrittweise zu einem reinen Spiegel von `budget_transactions` reduziert: die
> GoBD-Immutability liegt seit Stufe B auf `budget_transactions`, jede captured
> Reservierung trägt seit Stufe A den EINEN Capture-Link
> `budget_reservations.captured_transaction_id`, und `checkBudgetConservation`
> liest `budget_ledger`/`capturedLedgerId` nicht mehr (Kreuzcheck über
> `captured_transaction_id → budget_transactions`). Die #1443-Verifikation
> (`.local/tasks/budget-ledger-drop-verification-report.md`) bestätigte: 62/62
> Prod-Zeilen 1:1 gespiegelt, kein Live-Reader/Writer, FK-sicherer
> Zwei-Schritt-Drop. Der Drop ist seit #1446 als gegatete Guarded-Migration
> `drop-budget-ledger-1443` hinter `APPROVED_DROP_BUDGET_LEDGER` scharfgeschaltet
> (Default-OFF, läuft erst bei gesetztem Flag im Deployment-Scope + Publish). Die
> ursprüngliche NO-GO-Analyse unten beschreibt den Stand VOR den Stufen A→C.

> **Aktualisiert 26.06.2026.** Die ursprüngliche NO-GO-Begründung (12.06.2026)
> ist überholt: jeder damals als „produktiv" gelistete Code-Pfad wurde durch die
> gestaffelte Stufe A→C entfernt oder umgehängt. `budget_ledger` war zuletzt nur
> noch ein reiner, append-only **Spiegel** von `budget_transactions` und trägt
> heute **keine** eindeutige Information mehr.

Was sich seit der NO-GO-Analyse geändert hat (jeder frühere „productive" Hit ist
weg/umgehängt):

| Früherer Pfad (NO-GO-Beleg) | Heutiger Stand |
|---|---|
| `reservation-storage.ts` `captureHolds` `.insert(budgetLedger)` (Capture-**Write**) | **Entfernt.** Capture schreibt nur noch nach `budget_transactions` und setzt `budget_reservations.captured_transaction_id` (→ `budget_transactions.id`). Kein `.insert/.update/.delete(budgetLedger)` mehr im Code. |
| `budget-conservation.ts` `leftJoin(budgetLedger)` (Conservation-**Read**) | **Umgehängt.** Der Kreuzcheck liest jetzt `captured_transaction_id` → `budget_transactions`; kein `budget_ledger`-Zugriff mehr. |
| `invariants.ts` `checkBudgetLedgerConsistency` (Invarianten-**Read**) | **Umgehängt.** Keine `budget_ledger`/`capturedLedger`-Referenz mehr; läuft über `checkBudgetConservation` auf `budget_transactions`. |
| `ensure-budget-ledger-immutability.ts` (GoBD-Trigger auf `budget_ledger`) | **Ersetzt.** Datei existiert nicht mehr; GoBD-BEFORE-Trigger liegen auf `budget_transactions` (`server/startup/ensure-budget-transactions-immutability.ts`). |
| `shared/schema/budget.ts` `budget_ledger`-Def + FK `captured_ledger_id` | **Entfernt (Task #1486).** Nach dem bestätigten Prod-Drop aus dem Drizzle-Modell genommen; kein Code liest/schreibt sie mehr. |

**Konservierung (Prod-Verifikation, read-only):** alle **62** `budget_ledger`-
Zeilen (alle `consumed`, 0 Reversal-Zeilen) sind **1:1** in `budget_transactions`
gespiegelt — doppelt bestätigt strukturell **und** über den deterministischen
ID-Link im `idempotency_key` (`…:l<budget_transactions.id>`). Keine Zeile trägt
Information, die nicht in `budget_transactions` steht → **null Info-Verlust**.

**FK-/Drop-Reihenfolge (FK-sicher, vollzogen):** einziger inbound-FK war
`budget_reservations.captured_ledger_id → budget_ledger.id`. Die Guarded-Migration
`drop-budget-ledger-1443` droppte deshalb zuerst die Spalte `captured_ledger_id`,
danach `DROP TABLE budget_ledger` — idempotentes rohes `IF EXISTS`-SQL, **kein**
`drizzle-kit push`. Nach dem Prod-Drop wurde das gesamte Drop-Gerüst in Task #1486
entfernt.

| Datei → Pfad/Funktion | Urteil | Beweis |
|---|---|---|
| `shared/schema/budget.ts` | Definition entfernt (#1486) | Tabelle + FK-Spalte `captured_ledger_id` nach dem Prod-Drop aus dem Modell genommen. |
| `server/startup/cleanup-legacy-auto-allocations-migration.ts` | Ledger-Bezug entfernt (#1486) | Nullt nur noch `allocation_id` auf referenzierenden `budget_reservations`; in Prod bereits gelaufen (0 Treffer). |
| `tests/startup/startup-schema-drift.test.ts` | Endzustand-Assertion | Prüft, dass weder Tabelle `budget_ledger` noch Spalte `captured_ledger_id` im Modell verbleiben. |

**Go/No-Go:** **GO — vollzogen.** `budget_ledger` ist conservation-neutral und
reader-frei und wurde in Prod gedroppt; das Drop-Gerüst ist in Task #1486
abgebaut.

---

## Tabelle: `budget_migrations` — **PRODUKTIV (operatives Migrations-Bookkeeping) → NO-GO**

| Datei → Pfad/Funktion | Urteil | Beweis |
|---|---|---|
| `shared/schema/budget.ts` (`budgetMigrations`) + `server/startup/ensure-migration-ledger.ts` | Definition (Doppel-Quelle, by design) | Drizzle-Modell + rohes `CREATE TABLE … budget_migrations`; Drift-Test `tests/startup/migration-ledger-schema-drift.test.ts`. |
| `server/startup/budget-migration-runner.ts:106,116` | **produktiv-lesend + -schreibend** | `SELECT 1 FROM budget_migrations WHERE name = …` (genau-einmal-Guard) + `INSERT INTO budget_migrations …` innerhalb der Migrations-Tx. Läuft bei jedem Boot. |
| `server/startup/purge-junk-master-data.ts:250,340` | **produktiv-lesend + -schreibend** | Eigener genau-einmal-Guard (`SELECT 1 FROM budget_migrations …` + `INSERT INTO budget_migrations …`), unabhängig vom Migrations-Runner. |

**Go/No-Go:** **NO-GO.** Funktional orthogonal zu `budget_transactions` — reines
„welche einmalige Budget-Migration ist schon gelaufen?". Wegfall ⇒ jede
geguardete Migration läuft bei jedem Boot erneut. Nicht ersetzbar.

---

## Gesamtempfehlung

| Tabelle | produktiv-lesend | produktiv-schreibend | durch `budget_transactions` ersetzbar | Urteil |
|---|---|---|---|---|
| `budget_reservations` | **ja (ungated, jeder Read)** | ja (flag-gated) | nein | **NO-GO** |
| `budget_ledger` | nein (nach Stufen A→C nur noch Spiegel) | nein (Capture-Insert auf budget_transactions) | ja | **GO (#1443/#1446)** |
| `budget_migrations` | ja | ja | nein | **NO-GO** |

> **Update (#1443/#1446 → #1486):** Für `budget_ledger` gilt dieser
> Ursprungsbefund nach den Stufen A→C **nicht mehr** — die Tabelle war auf einen
> reinen Spiegel reduziert (GO) und ist inzwischen in Prod gedroppt; das
> Drop-Gerüst wurde in Task #1486 abgebaut. Für `budget_reservations` und
> `budget_migrations` bleibt es bei **NO-GO**.

Zum Zeitpunkt der Ursprungsanalyse galt: alle drei Tabellen hatten produktive
Lesepfade, die **nicht** durch `budget_transactions` (oder eine andere
bestehende Tabelle) ersetzbar waren. Die Annahme „tote/giftige
Schatten-Tabellen" traf in dieser Pauschalität nicht zu.

## Operative Leitplanken des Drop-Publishs (vollzogen)

Der Drop/Publish/Flag-Schritt ist in Prod abgeschlossen. Verbindlich galten und
wurden eingehalten:

- **Frischer Prod-Backup** unmittelbar vor dem Publish.
- **Read-only Prod-Replica Schema-Diff VOR und NACH** dem Drop (Tabellen, Spalten,
  Indexe, Constraints, Enums, Defaults) — bestätigte, dass **genau** die Spalte
  `captured_ledger_id` + die Tabelle `budget_ledger` verschwanden und sonst nichts.
- **Genau ein Drop pro Publish** — nicht mit einer abhängigen Migration im selben
  Publish kombiniert.
- **Append-only-Immutability bleibt auf `budget_transactions`** (GoBD-Trigger sind
  bereits von `budget_ledger` umgezogen).
- **PRE/POST Conservation-Check** (no-overdraw + Capture-Link-Integrität) war vor
  UND nach dem Drop grün.
- **Bekannter Nicht-Blocker (schriftlich festgehalten):** historische `captured`
  Reservierungen trugen ihren Capture-Link nur über `captured_ledger_id` und gingen
  nach dem Spalten-Drop auf **NULL** (kein Backfill auf `captured_transaction_id`).
  Das ist **kein** Verstoß: die verbrauchten Beträge liegen sicher in
  `budget_transactions`, jede Reservierung behält ihren eigenen `amount_cents`, und
  der Conservation-Check filtert `captured_transaction_id IS NOT NULL`, behandelt
  NULL also als toleranten Legacy-Zustand.

### Post-Drop-Cleanup (Task #1486, vollzogen)

Nach dem bestätigten Prod-Drop wurde das Drop-Gerüst abgebaut, sodass
`budget_transactions` + `captured_transaction_id` die einzige sichtbare Wahrheit
sind:

1. Schema-Deklaration `budgetLedger` + FK-Spalte `captured_ledger_id` aus
   `shared/schema/budget.ts` entfernt.
2. Drop-Migrationsdatei `server/startup/drop-budget-ledger.ts` gelöscht; Import +
   Registrierung + Freigabe-Flag `APPROVED_DROP_BUDGET_LEDGER` aus dem
   Migrations-Runner und dem Preflight-Deskriptor entfernt; Boot-Kommentar in
   `server/index.ts` auf den Endzustand aktualisiert.
3. Der Drift-Test `tests/startup/startup-schema-drift.test.ts` prüft jetzt den
   Endzustand (weder Tabelle `budget_ledger` noch Spalte `captured_ledger_id`
   dürfen im Modell wiederkehren).

## Entscheidender Kontext: BUDGET_HARD_HOLDS ist in PRODUKTION aktiv

Die Phase-5-Hard-Hold-Schicht beruht **weiterhin** auf `budget_reservations`
(Live-Holds) und ist hinter `BUDGET_HARD_HOLDS` (`hardHoldsEnabled()`) gegated und
**in der Produktion eingeschaltet**:

- `server/index.ts:890-906` warnt beim Prod-Start **laut**, wenn das Flag fehlt,
  und loggt „Budget-Hard-Block aktiv in Produktion", wenn es gesetzt ist.
- Regressions-Wächter `tests/architecture/budget-hard-holds-production-enabled.test.ts`
  schlägt fehl, wenn weder der Prod- noch der Shared-Scope das Flag truthy setzt.
- Sichtbar zur Laufzeit unter `/api/health → budgetHardHolds.enabled`.

Wichtig: **`budget_ledger` ist NICHT mehr das Capture-Ziel** dieser Funktion. Seit
Stufe A→C schreibt der Capture-Pfad direkt in `budget_transactions` und verlinkt
über `budget_reservations.captured_transaction_id`. Die Stilllegung von
`budget_ledger` ist deshalb **kein** Rückbau der Hard-Hold-Funktion — die bleibt
auf `budget_reservations` + `budget_transactions` unverändert aktiv. **Das
`BUDGET_HARD_HOLDS`-Flag wird in dieser Aufgabe NICHT geändert.**

## Offene Rückfrage an Alrik (nur noch für `budget_reservations`/`budget_migrations`)

Für `budget_ledger` ist die Rückfrage **geklärt → GO** (siehe oben). Offen bleibt:

1. **Soll die Hard-Hold-Funktion (BUDGET_HARD_HOLDS) in Produktion
   zurückgebaut werden?** Nur dann würde `budget_reservations` überhaupt
   entbehrlich. Reihenfolge wäre dann: Flag in Prod aus → Engine +
   `unified-reader`-Holds-Read entfernen → erst danach `budget_reservations`
   droppen. Bis dahin: **NO-GO**.
2. **`budget_migrations`** ist davon unabhängig produktive Infrastruktur
   (Migrations-Guard) und sollte unabhängig vom Hard-Hold-Thema **bestehen
   bleiben**, außer der Migrations-Runner selbst wird ersetzt.

Für `budget_ledger` bleibt nur der separate, review-gegatete, FK-freie
Folge-Publish (oben), der Tabelle + Spalte droppt und die Re-Arming-Schritte
ausführt.
