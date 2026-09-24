# Wirkungskarte: §45b-Startwert und -Übertrag

> **Schritt C** des Standards „Änderungen an fachlichen Regeln im Geldpfad"
> (`CLAUDE.md`, Ticket `6hcQPmcrvfj5ghfp`). Nachträglich erstellt für den
> Vorgang #163–#186, **bevor #184 live geht** — Alriks Auflage vom 24.09.2026.
>
> **Gemessen, nicht erinnert.** Jede Zeile trägt `datei:zeile`. Was nicht
> gemessen ist, steht als solches da.

## Stand dieser Karte

| | |
|---|---|
| **Code-Stand** | Branch `feat/45b-verdraengung-scharf` (#184) auf `be650425` — also der Zustand **nach** dem Flip, nicht der heutige Prod-Zustand |
| **Erhoben am** | 24.09.2026 |
| **Womit** | `grep` über `server/`, `shared/`, `client/src`, `scripts/` (ohne `*.test.*`); Prod-Zahlen aus `server/scripts/diff-45b-verdraengung.ts` |

**Warum der #184-Stand und nicht `main`:** die Karte soll die Entscheidung
tragen, ob #184 live geht. Eine Karte des Ist-Zustands beantwortet die Frage
nicht, die ansteht.

---

## Was der Unterschied ist (Kurzfassung)

- **Startwert** (`source = 'initial_balance'`, mit `month`): Inventur zum
  Monatsbeginn. Nennt den **gesamten** Restbestand — der Übertrag ist darin
  enthalten. `0 €` ist eine festgestellte Null.
- **Übertrag** (`source = 'carryover'`, `month = NULL`): Restguthaben des
  Vorjahres, gültig bis 30.06.
- **Verdrängung**: ein Startwert ersetzt jede Zuweisung, die vor ihm beginnt.
  Formel in `server/storage/budget/allocation-window.ts:163` (`displacedByReset`):
  `row.validFrom <= reset.cutoffDate && row.year <= reset.year`.

---

## 1. Schreibwege

Wer legt eine `initial_balance`- oder `carryover`-Zeile an?

### 1.1 Produktiv erreichbar

| # | Weg | Einstieg | Landet bei |
|---|---|---|---|
| W1 | **Startwert-Editor** (Bestandskunde) | `client/src/components/budget/BudgetTypeSettings.tsx:907` → `POST /budget/:id/initial-balance/:budgetType` (`server/routes/budget.ts:671`) | `upsertInitialBalanceAllocation`, `server/routes/budget.ts:735` |
| W2 | **Übertrags-Editor** (Bestandskunde) | `BudgetTypeSettings.tsx:1331` → `POST /budget/:id/carryover/:budgetType` (`server/routes/budget.ts:1140`) | `budget_allocations`, `source='carryover'` |
| W3 | **Anlage-Assistent** | `client/src/features/customers/hooks/use-customer-wizard.ts:376` → `POST /api/admin/customers` → `createCustomerRelatedData` (`server/lib/customer-creation-helpers.ts:295/311/324`) | `applyInitialBudget` (`server/services/budget-initial-setup.ts:77`) |
| W4 | **`POST /budget/:id/initial-budget`** | `server/routes/budget.ts:1391` | `applyInitialBudget`, `budget.ts:1440` |
| W5 | **Wiederhol-Banner „Startbudgets"** | `client/src/features/customers/components/admin/customer-detail-sections.tsx:70` → derselbe Endpunkt wie W4 | `applyInitialBudget` |
| W6 | **Jahreswechsel-Automatik** | `syncCarryoverAndExpiry` → `planCarryoverRolls45b` → `allocation-storage.ts:2055` | `source='carryover'` für das Folgejahr |
| W7 | **Rechnungs-Re-Basierung §45b** | `server/services/invoice-45b-reduction.ts:237` | `upsertInitialBalanceAllocation` |

**W6 hat die meisten Auslöser und keinen davon als Knopf.** `syncCarryoverAndExpiry`
läuft als **Nebenwirkung von Lesepfaden und Terminvorgängen**:

| Auslöser | Stelle |
|---|---|
| Budget-Übersicht lesen | `server/storage/budget/summary-queries.ts:569` |
| Import-Verfügbarkeit lesen | `server/storage/budget/import-availability.ts:64` |
| Buchung/Verbrauch | `server/storage/budget/consumption-engine.ts:498` |
| Termin anlegen | `server/routes/appointments.ts:889` |
| Terminserie anlegen/ändern | `server/routes/appointment-series.ts:273` und `:884` |
| Kundenanlage | `server/lib/customer-creation-helpers.ts:265` |
| Budget-Routen | `server/routes/budget.ts:126`, `:141`, `:1335` |
| **Server-Start** | `server/startup/sync-budget-allocations.ts:19` |

> **Das ist der Befund dieses Abschnitts.** „Wer schreibt einen Übertrag?" hat
> nicht die Antwort „der Operator", sondern „elf Stellen, von denen zehn wie
> Lesen aussehen". Wer die Wirkung einer Regeländerung abschätzt und nur die
> Editoren ansieht, sieht einen Bruchteil.

### 1.2 Einmal-/Wartungswege (nicht im laufenden Betrieb)

| Weg | Stelle |
|---|---|
| Backfill doppelte Wizard-Überträge | `server/startup/backfill-duplicate-wizard-carryovers.ts:133` |
| Backfill verwaiste Auto-Überträge (#684) | `server/startup/backfill-task-684-orphan-auto-carryovers.ts:117` |
| Backfill Relink verwaister Tx (#685) | `server/startup/backfill-task-685-relink-orphan-carryover-tx.ts:194`, `:218` |
| Aufräum-Skript §45b | `server/scripts/cleanup-45b-leftover-budgets.ts:139` |
| Audit doppelte Wizard-Überträge | `scripts/audit-duplicate-wizard-carryovers.ts:187` |

### 1.3 Drei Schichten für den Schreibpfad

| Schicht | |
|---|---|
| **Server** | **sitzt hier:** `applyInitialBudget` (`budget-initial-setup.ts:77`) ist die SSoT für W3/W4/W5. Das Entweder-oder (`:150-160`), der Startwert-Schreibpunkt (`:162`) und die Übertrags-Lesart `!= null` (`:176`) sitzen dort. W1/W2 gehen daran **vorbei** — sie schreiben direkt über `upsertInitialBalanceAllocation` bzw. die Carryover-Route. |
| **Midlayer** | **sitzt hier:** `initialBudgetSchema` (`server/routes/budget.ts`) übersetzt den Body. **Hier saß der S5-Fehler** — `0 → null`, wodurch die Unterscheidung verloren ging, bevor die SSoT sie sehen konnte. |
| **Client** | **sitzt hier als Bequemlichkeit, nicht als Schranke:** der Assistent blendet das Übertragsfeld aus (`budgets-contract-step.tsx`), die Editoren warnen (`VerdraengungsWarnung`). Keine dieser Stellen entscheidet. |

**Offen und nicht geschlossen:** W1/W2 laufen nicht durch `applyInitialBudget`
und kennen das Entweder-oder daher nicht. Das ist **gewollt** (Alrik: im
Bestands-Editor warnen, nicht sperren), aber es heißt: die Regel „Startwert
ODER Übertrag" gilt **nur auf dem Anlage-Pfad**, nicht im Bestand.

---

## 2. Lesewege und Tore, mit ihren Einstellungen

Wer entscheidet, ob eine Zuweisung **mitzählt**?

| # | Leseweg | Stelle | Stichtag |
|---|---|---|---|
| L1 | **Anspruch §45b** (`calculateAllocated45b`) | `allocation-storage.ts:807-813`, Filter `:911` | `opts.asOfDate ?? ${curYear}-12-31` (`:806`) |
| L2 | **Budget-Übersicht** (`getBudgetSummary`) | `summary-queries.ts:114`, Filter `:149` | **hart `today`** |
| L3 | **Übertrags-Summe** (`getTotalCarryoverCents`) | `summary-queries.ts:54`, Filter `:66` | `asOfDate` (Parameter) |
| L4 | **FIFO-Aufschlüsselung** | `fifo-breakdown.ts:97`, Filter `:115` | `asOfDate` (Parameter) |
| L5 | **Verbrauchs-Engine** | `consumption-engine.ts:229-230` | keine eigene Bedingung — nutzt `excludedSpecialAllocationIds` |
| L6 | **Bestandsliste** (`GET /initial-balances`) | `server/routes/budget.ts:589`, `:610`, `:634` | **hart `heute`** |
| L7 | **Verdrängungs-Vorschau** | `server/routes/budget.ts:791-990` | `validFrom`-Parameter (der Monat, ZU DEM gerechnet wird) |
| L8 | **Mess-Skript** | `server/scripts/diff-45b-verdraengung.ts:318-325` | beide Seiten, mit und ohne Flag |

### 2.1 Die Einstellung, an der es sich dreimal verfangen hat

**L2 und L6 rechnen hart auf „heute", L1/L3/L4 auf einen übergebenen
`asOfDate`.** Das ist genau die in `CLAUDE.md` geführte
`todayISO()`-vs-`asOf`-Falle, und sie ist hier **nicht** behoben, sondern nur
kartiert.

Praktische Folge, gemessen an `UW-4` (`tests/budget/45b-uebertrag-verdraengungs-warnung.test.tsx`):
Vorschau (L7) und Bestandsliste (L6) geben für denselben Übertrag
**verschiedene** Auskünfte, sobald der 30.06. überschritten ist — die Vorschau
zum angefragten Monat, die Liste zu heute. Das ist **kein Fehler**: die Liste
meldet ab dem 01.07. absichtlich `null` statt „ersetzt durch Startwert", weil
sonst „ersetzt durch Startwert 06/2026" neben „verfällt 30.06.2026" stünde
(#166, B1). Aber es ist eine Stelle, an der zwei richtige Antworten
widersprüchlich **aussehen**.

### 2.2 Das Flag

`RESET_DISPLACES_ALL_SOURCES_DEFAULT` (`allocation-window.ts:127`) ist die
**eine** Stelle, an der umgeschaltet wird. Der Wächter
`tests/architecture/reset-displaces-default-single-source.test.ts` hält fest,
dass jede Verzweigung darauf den gemeinsamen Default liest — er entstand,
nachdem zwei Stellen an bloßer Truthiness hingen und `false` pinnten.

### 2.3 Drei Schichten für den Lesepfad

| Schicht | |
|---|---|
| **Server** | **sitzt hier:** `displacedByReset` / `notDisplacedByResetWhere` / `resetAnchorFrom` in `allocation-window.ts`, registriert in `shared/ssot-registry.ts:155-164` |
| **Midlayer** | **sitzt hier:** L6 und L7 setzen `zaehltNicht` und `ersetztDurchStartwertMonat` zusammen (`budget.ts:640-642`, `:998`). **Das ist die gefährliche Stelle** — würde die Antwort die Unterscheidung nicht tragen, könnte der Client sie nicht treffen, selbst wenn er wollte. |
| **Client** | **sitzt hier nicht — und das ist die Zusage.** `BetragMitVerdraengung` und `VerdraengungsWarnung` (`BudgetTypeSettings.tsx`) **lesen** nur. Sie rechnen die Verdrängung nicht nach. |

---

## 3. Datenbestand

> **Quelle: `server/scripts/diff-45b-verdraengung.ts` gegen die Prod-Kopie,
> Läufe vom 23./24.09.2026.** Diese Zahlen sind **erhoben, aber nicht
> tagesaktuell**. Vor dem Publish von #184 neu fahren — die Karte gilt
> ausdrücklich nicht als Ersatz für den Lauf.

| Größe | Wert | Anmerkung |
|---|---|---|
| Kunden mit §45b-Startwert **und** noch gültigem Übertrag | **21** | die vom Flip betroffene Menge |
| Summe der Differenz | **−20.395,73 €** | Korrektur einer Doppelzählung, kein Verlust — die Kassenauskunft nennt den Gesamtbestand inkl. Übertrag |
| Kunde 89 (Alriks Testfall) | **184,60 €** ab 01.06. | muss nach dem Publish als IST erscheinen |
| Kunden ohne Änderung | 21 | Gegenprobe zur betroffenen Menge |

### 3.1 Auffälligkeiten (gemessen, nicht erklärt)

| Befund | Status |
|---|---|
| **Kunde 164: negativer Topf** (`current_year = −1.310,00 €`) | **NICHT vom Flip.** Beidseitig gemessen: ohne Flag identisch. Bestehende negative Handkorrektur. |
| **26 Überträge mit `year <> Jahr(valid_from)`** | Konvention, nicht Fehler: der Übertrag trägt das **Ziel**jahr. `displacedByReset` liest beide Felder, deshalb ist die Kombination bedeutungstragend. |
| **E2-Doppel-`write_off`** | NICHT vom Flip; beidseitig gemessen. |

### 3.2 Konventionen im Bestand

- Übertrag: `month = NULL`, `validFrom = ${jahr}-01-01`,
  `expiresAt = carryoverExpiresAtFor(jahr)` (`shared/domain/budget/expiry-45b.ts:44`).
- Startwert: `month` gesetzt, `expiresAt = NULL`.
- **Hartes `DELETE` ist auf `budget_allocations` und `budget_transactions`
  verboten** (GoBD-Trigger) — Soft-Delete oder `cleanupCustomer`.

---

## 4. Was diese Karte NICHT enthält

Nach der Regel „‚nicht geprüft' ist keine zulässige Antwort" gehört hierher,
was ausdrücklich **offen** ist — nicht als Lücke, sondern als benannte Grenze:

1. **Ob auf Prod `setup_pending_payloads` noch Budget-Blöcke trägt.** Entscheidet,
   ob der Wiederhol-Banner (W5) ein akuter Fall ist oder eine scharfe Kante.
   Braucht eine Abfrage gegen die Prod-Kopie — **Gate 4, nicht von mir.**
2. **Die Zahlen aus §3 sind vom 23./24.09.2026**, nicht von heute.
3. **`tests/billing`, `tests/appointments`, `tests/customers` und `e2e/`** sind
   für den #184-Stand nicht gelaufen; gemessen sind `tests/budget`,
   `tests/architecture`, `tests/equality` (1.377 Tests, 1 bekannte Rote).

---

## 5. Zwei Befunde, die aus der Karte selbst folgen

Beide sind beim Erstellen dieser Karte aufgefallen, nicht beim Bauen — das ist
der Zweck von Schritt C.

**B-K1 — Die Regel „Startwert ODER Übertrag" gilt nur auf dem Anlage-Pfad.**
W1 und W2 (die Bestands-Editoren) laufen an `applyInitialBudget` vorbei und
kennen sie nicht. Gewollt (warnen statt sperren), aber nirgends
niedergeschrieben. `FINDING: … [P2]`

**B-K2 — `syncCarryoverAndExpiry` ist ein Schreibweg mit elf Auslösern, von
denen zehn wie Lesen aussehen.** Eine Regeländerung am Übertrag wirkt damit
auch über Pfade, die niemand als „Übertrag schreiben" liest — unter anderem
beim **Server-Start** (`sync-budget-allocations.ts:19`). Wer die Wirkung
abschätzt und nur die Editoren ansieht, sieht einen Bruchteil.
`FINDING: … [P2]`

---

# Anhang: Schritt C zur Prämissen-Frage (Alrik, 24.09.2026)

> **Anlass:** Alrik hat die Prämisse in Frage gestellt, auf der #184 und #186
> stehen. Die Oberfläche hat **getrennte Felder** für „Übertrag aus Vorjahr"
> (Frist 30.06.) und „Startwert laufendes Jahr". Unsere Arbeit nimmt an, dass
> der Startwert den Übertrag EINSCHLIESST. Ist der Prozess stattdessen „beide
> Felder nebeneinander", löschen beide PRs genau den Vorjahresanteil, der am
> 30.06. verfallen soll.
>
> **Nur gemessen, keine Bewertung, kein Lösungsvorschlag.** Schritt A (der
> tatsächliche Prozess) liegt bei Alrik.

**Welcher Code-Stand welche Zeilennummer trägt** — beim Nachschlagen wichtig,
weil zwei Dateien in diesem Vorgang geändert wurden:

| Referenzen aus | Stand |
|---|---|
| `server/services/budget-initial-setup.ts`, `client/.../budgets-contract-step.tsx` | Branch `fix/startwert-oder-uebertrag` (#186) |
| `server/storage/budget/consumption-engine.ts`, `client/src/components/budget/BudgetTypeSettings.tsx` | `main` — dort unverändert |

Alle sieben Referenzen sind gegen den jeweils genannten Stand nachgeschlagen,
nicht gegen den gerade ausgecheckten.

## Aufbau der Messung

Ein Kunde, Pflegegrad 3 seit 2024 (Monatsrate 131,00 €), **beide Zeilen für
dasselbe Jahr**:

| Zeile | Betrag | `validFrom` | `expiresAt` | `month` |
|---|---|---|---|---|
| `carryover` | 500,00 € | 01.01.2026 | **30.06.2026** | `NULL` |
| `initial_balance` | 300,00 € | 01.03.2026 | **`NULL`** | 3 |

Gemessen über `calculateAllocatedCents` und `readBudget45bFifoBreakdown`, je
einmal mit `resetDisplacesAllSources: false` und `: true`.

## 1. + 2. Was das System tut — ohne und mit Flip

| Stichtag | | Anspruch | Topf `carryover` | Topf `current_year` | `carryoverExpiresAt` |
|---|---|---|---|---|---|
| **15.05.** (vor Frist) | ohne Flip | **1.062,00 €** | 500,00 € | 562,00 € | 30.06.2026 |
| **15.05.** (vor Frist) | **mit Flip** | **562,00 €** | **0,00 €** | 562,00 € | **null** |
| **15.07.** (nach Frist) | ohne Flip | **824,00 €** | 0,00 € | 824,00 € | null |
| **15.07.** (nach Frist) | mit Flip | **824,00 €** | 0,00 € | 824,00 € | null |

Rechenweg der Teilbeträge:
- `562,00 € = 300,00 € (Startwert ab März) + 2 × 131,00 € (April, Mai)`
- `824,00 € = 300,00 € + 4 × 131,00 € (April–Juli)`

**Drei Feststellungen daraus:**

1. **Vor der Frist unterscheiden sich die beiden Zustände um genau den
   Übertrag** — 1.062,00 € gegen 562,00 €, Differenz 500,00 €. Mit Flip zählt
   der Übertrag ab dem Tag des Startwerts nicht mehr mit.
2. **Nach der Frist sind beide Zustände identisch** (824,00 €). Der Übertrag
   ist dann ohnehin verfallen; der Flip ändert an diesem Stichtag nichts.
3. **Der Startwert überlebt die Frist vollständig.** Die 300,00 € stehen am
   15.07. unverändert im laufenden Topf.

### Reihenfolge beim Verbrauch

**FIFO, Übertrag zuerst.** Nicht aus dem Docblock übernommen, sondern an der
Abfrage abgelesen (`server/storage/budget/consumption-engine.ts:195-199`):

```sql
ORDER BY CASE WHEN source = 'carryover' THEN 0 ELSE 1 END,
         valid_from ASC,
         id ASC
```

Der Übertrag wird also vor dem Startwert aufgebraucht — **ohne Flip.** Mit Flip
ist er zum selben Zeitpunkt gar nicht mehr im Topf (Zeile 2 der Tabelle), es
gibt für ihn nichts zu verbrauchen.

## 3. Hat ein Startwert je ein `expiresAt`?

**Für §45b: nein, nie.** An beiden Schreibstellen identisch:

| Stelle | Ausdruck |
|---|---|
| `server/services/budget-initial-setup.ts:314` | `budgetType === "ersatzpflege_39_42a" ? \`${year}-12-31\` : null` |
| `server/routes/budget.ts` (Startwert-Editor) | derselbe Ausdruck |

Nur §39/§42a bekommt ein Datum. Ein §45b-Startwert trägt `expiresAt = null` und
verfällt nicht.

**Was daraus folgt, als Messung formuliert:** steckt der Vorjahresrest im
Startwert, dann trägt er dessen Verfallsverhalten — also keines. In Zeile 3 der
Tabelle oben ist das der Fall: am 15.07. stehen die 300,00 € noch da. Es gibt
im System **keine Stelle, an der ein Anteil eines Startwerts zum 30.06.
verfällt**; die Frist hängt ausschließlich am `expiresAt` der
`carryover`-Zeile.

## 4. Woher kam die Annahme „Startwert schließt Übertrag ein"?

Gesucht in Docblocks, UI-Beschriftungen, Tests und der git-Historie.

### Im Code steht sie erst seit dem 24.09.2026

| Fundstelle | Commit | Datum |
|---|---|---|
| `budget-initial-setup.ts:166` („ist eine Bestandsaufnahme und enthält den Übertrag bereits") | `4548a0ec` | 24.09.2026 |
| `budgets-contract-step.tsx:270` („eine Bestandsaufnahme enthält ihn bereits") | `4548a0ec` | 24.09.2026 |
| `docs/architecture/budget.md:227` | dieser Vorgang | 24.09.2026 |

Suche nach der Formulierung vor dem 21.09.2026: **keine Treffer.**

Auch der Verdrängungs-Mechanismus selbst ist neu: `displacedByReset` /
`resetAnchor` erscheinen zuerst in `d7ba1dc1` (22.09.2026), scharf geschaltet in
`379cac79` (23.09.2026) — beides dieser Vorgang.

### Was es VORHER gab, ist etwas anderes

`initialBalanceMonths` stammt aus `2ab844ff` vom **06.03.2026**:

> *„Update budget logic to correctly calculate monthly allocations after initial
> balance"*

Der Commit betrifft ausschließlich die **monatliche Aufstockung** — sie beginnt
nach dem Startwert-Monat. Der Übertrag kommt darin nicht vor. Das ist der
Ansammlungs-Boden, nicht eine Verdrängung des Übertrags.

### Die UI-Historie sagt das Gegenteil

| Commit | Datum | Titel |
|---|---|---|
| `539b7e02` | 27.05.2026 | **„Task #670: §45b Carryover-UI vom Startwert trennen"** |
| `b105d022` | 04.06.2026 | „Task #960: Split §45b block in new-customer wizard into carryover + optional current-year override" |

Aus der Beschreibung von `b105d022` wörtlich:

> *„Restructured the ‚Budgets' step §45b block so the operator enters **two
> distinct amounts** with clear German labels: 1. ‚Übertrag aus Vorjahr'
> (carryover, expires 30.06.) … 2. New optional override ‚Aktuelles Restguthaben
> (laufendes Jahr)'"*

### Die heutigen Beschriftungen

| Feld | Beschriftung | Datei |
|---|---|---|
| Übertrag (Bestand) | **„Restguthaben aus Vorjahr (verfällt 30.06.)"** | `BudgetTypeSettings.tsx:1296` |
| Startwert (Bestand) | **„Restguthaben (€)"** + **„Ab Monat"** | `BudgetTypeSettings.tsx:982`, `:1005` |
| Übertrag (Wizard) | **„Übertrag (€)"** | `budgets-contract-step.tsx:238` |
| Startwert (Wizard) | **„Restguthaben (<Stichmonat>) in €"**, hinter dem Schalter **„Ja, Restbestand ist bekannt"** | `budgets-contract-step.tsx:333`, `:300` |

Der Schaltertext „Ja, Restbestand ist bekannt" stammt aus diesem Vorgang
(Alriks B3-Entscheidung). Die übrigen drei Beschriftungen sind älter und sagen
**an keiner Stelle**, dass der Startwert den Übertrag enthält. Der Startwert
heißt schlicht „Restguthaben" mit einem Stichmonat daneben.

## Zusammenfassung der Messung

| Frage | Befund |
|---|---|
| Beide Zeilen nebeneinander, ohne Flip | zählen **beide**, Summe 1.062,00 €; Übertrag wird zuerst verbraucht und verfällt am 30.06. |
| Beide Zeilen nebeneinander, mit Flip | nur der Startwert zählt, 562,00 €; der Übertrag ist ab dem Startwert-Monat aus dem Topf |
| Startwert und Frist | ein §45b-Startwert hat **nie** ein `expiresAt`; nichts an ihm verfällt zum 30.06. |
| Herkunft der Annahme | **erst 24.09.2026, aus diesem Vorgang.** Die ältere UI-Historie beschreibt die Felder ausdrücklich als „two distinct amounts" und trennt sie bewusst (#670, #960). |

---

# Anhang 2: Schritt C für die Vorgangs-Klammer (24.09.2026)

> **Entscheidung Cowork (technisch):** eine nullable Spalte an
> `budget_allocations`, gesetzt auf **beide** Zeilen eines
> Kassenauskunfts-Vorgangs. Regel: zum wirksamen Stichtag zählen die Zeilen des
> Vorgangs, zu dem der Reset-Anker gehört; alle anderen §45b-Zeilen mit
> `validFrom <= cutoff` sind verdrängt.
>
> Dieser Anhang misst, was das für die vorhandenen Schreibwege heißt — **vor**
> dem Bauen.

## 1. Die Schreibwege und die Klammer

Gemessen an den Wegen aus Abschnitt 1 dieser Karte. Entscheidend ist, ob ein
Weg **beide** Zeilen in einem Aufruf schreibt — nur dann gibt es überhaupt
einen Vorgang zu klammern.

| Weg | schreibt | Klammer |
|---|---|---|
| **`applyInitialBudget`** (`budget-initial-setup.ts:162` + `:179`) | `initial_balance` **und** `carryover` in EINEM Aufruf | **muss sie setzen** — der einzige heutige Weg, der einen Vorgang überhaupt bildet |
| **Startwert-Editor** (`routes/budget.ts` → `upsertInitialBalanceAllocation`) | nur `initial_balance` | **muss sie setzen**, sobald er Teil des Kassenauskunfts-Formulars wird; solange er einzeln bleibt, bildet er einen Vorgang aus einer Zeile |
| **Übertrags-Editor** (`routes/budget.ts:936` → `upsertCarryoverAllocation`) | nur `carryover` | dasselbe |
| **Jahreswechsel-Automatik** (`planCarryoverRolls45b`, `allocation-storage.ts:2055`) | nur `carryover` | **bleibt null** — es gibt keinen Vorgang, niemand hat etwas ausgesagt |
| **§45b-Re-Basierung** (`invoice-45b-reduction.ts:237`) | nur `initial_balance` | **offen** — fachlich ist eine Kassenkürzung durchaus ein eigener Anlass (v2, Fall 3). Gehört in Schritt D, nicht hierher |
| **Backfills / Wartungsskripte** (5 Wege, Abschnitt 1.2) | `carryover` | bleiben null |

**Der Befund daraus:** heute bildet **genau ein** Weg einen Vorgang mit zwei
Zeilen. Die beiden Editoren schreiben je eine — das v2-Formular führt sie
zusammen, und erst dadurch entsteht die Klammer als etwas, das man setzen kann.

## 2. Was für `null` gilt — und warum E1 es NICHT belegt

Die Regel sagt: *„zum wirksamen Stichtag zählen die Zeilen des Vorgangs, zu dem
der Reset-Anker gehört."* Trägt der Anker-Startwert **keine** Klammer
(Altbestand), sind zwei Lesarten möglich:

| Lesart | Folge für Altbestand |
|---|---|
| **(i)** `null` = eigener Vorgang aus einer Zeile | alles andere mit `validFrom <= cutoff` ist verdrängt → **das #184-Verhalten** |
| **(ii)** ein Anker ohne Klammer verdrängt nichts | **das heutige Verhalten** (Flag aus) |

**Die beiden unterscheiden sich genau bei den 21 Kunden aus dem Mess-Lauf** —
Startwert und Übertrag nebeneinander, beide ohne Klammer. Lesart (i) senkt dort
die Verfügbarkeit um zusammen −20.395,73 €, Lesart (ii) ändert nichts.

> ### ⚠ E1 kann diese Frage nicht beantworten
>
> Die Auflage lautet: *„Altbestand ohne Klammer: Regel muss für die heutigen
> Zeilen genau das Verhalten von heute liefern — E1 ist der Beleg, er muss
> unverändert grün bleiben."*
>
> **E1 hat keinen Startwert** (Übertrag 500 €, fünf Verbräuche, sonst nichts).
> Ohne Startwert gibt es keinen Reset-Anker, und ohne Anker verdrängt keine der
> beiden Lesarten irgendetwas. **E1 bleibt in (i) wie in (ii) grün** — er ist
> gegen die Frage blind.
>
> Gemessen ist E1 im Ist-Zustand übrigens exakt richtig, auf den Cent:
> `486,00 / 341,40 / 326,60 / 302,60 / 153,60`.
>
> **Was die Frage entscheidet, ist ein Fall MIT null-Klammer-Startwert neben
> einem gültigen Übertrag** — also genau die Lage der 21 Kunden. Das ist keine
> Testlücke, sondern R3: ob dort Lesart (i) oder (ii) richtig ist, sagt Alriks
> Antwort je Kunde, nicht der Code.

## 3. Additiv — bestätigt

Eine nullable `ADD COLUMN` löst **keine** der Freigabepflichten des
Release-Gates aus. Gemessen an `scripts/lib/destructive-schema-statements.ts`:

```
DROP COLUMN | DROP TABLE            (Zeile 42)
ALTER COLUMN … SET NOT NULL         (Zeile 145)
ADD CONSTRAINT … UNIQUE             (Zeile 149)
ADD CONSTRAINT … CHECK              (Zeile 153)
ALTER COLUMN … TYPE                 (Zeile 157)
```

Keine davon trifft zu. Vorhandene Zeilen bekommen `NULL`, **keine
Daten-Migration**, und der im Deploy-Fenster noch bedienende alte Code
ignoriert die unbekannte Spalte.

## 4. Die zwei verworfenen Alternativen — mit dem gemessenen Grund

### `expiresAt` der alten Zeile vorziehen → löst den Verfalls-Lauf aus

**Ja, und das ist der Grund.** `processExpiredCarryover`
(`allocation-storage.ts:2067`) wählt aus:

```sql
source = 'carryover' AND expires_at IS NOT NULL AND expires_at < today
```

Ein vorgezogenes `expiresAt` liegt in der Vergangenheit und fällt damit in die
Auswahl. Geschrieben wird dann (`:2170`):

```
transactionType: "write_off"
amountCents:     −remaining          (Betrag minus bisheriger Verbrauch)
notes:           "Verfallenes Guthaben aus {Jahr}: {Betrag} (Frist {expiresAt})"
```

Also eine Buchung über den **vollen Restbetrag**, beschriftet als
**verfallen** — eine GoBD-relevante Aussage, die sachlich falsch wäre: der
Betrag ist nicht verfallen, er ist durch eine Inventur ersetzt. Genau der Fall,
den S6 als eigenen Punkt führt.

### `createdAt` als Merkmal → als untauglich gemessen

Die Zeitstempel-Heuristik („Startwert und Übertrag aus demselben Vorgang =
gleicher `created_at` auf die Sekunde") ist am 24.09.2026 gegen Prod gelaufen:
**0 Treffer** bei den vorhandenen Paaren. Sie kann einen Vorgang im Bestand
nicht erkennen — und für neue Vorgänge wäre sie eine Heuristik, wo eine
Zuordnung möglich ist.

## 5. Was daraus für Schritt D offen bleibt

1. **Lesart für `null`** — (i) oder (ii). Hängt an R3, nicht am Code.
2. **Die §45b-Re-Basierung** (`invoice-45b-reduction.ts`): eigener Vorgang oder
   Fortschreibung des letzten? Fachlich, nicht technisch.
3. **Vorbedingung, unabhängig davon:** die FIFO-Aufschlüsselung meldet
   negativen Verbrauch, sobald ein Stichtag schneidet — Ticket
   `6hcVM394XgmP37GG`. Sie wirkt **nach oben** (662,00 € statt 562,00 €), also
   in der Richtung, in der gebucht wird.

---

# Anhang 3: Die FIFO-Aufschlüsselung — Lesewege und ein blinder Wächter

> **Nachtrag vom 24.09.2026**, ausgelöst durch Regel G: Schritt B zu PR #190
> hat zwei Lesewege gezeigt, die in Abschnitt 2 dieser Karte fehlten.

## 1. Die zwei fehlenden Lesewege

| # | Leseweg | Stelle | Art |
|---|---|---|---|
| **L9** | `GET /budget/:customerId/fifo-breakdown` | `server/routes/budget.ts:136`, Aufruf `:142` | Anzeige |
| **L10** | `checkFifoUnifiedEquality` | `server/lib/invariants.ts:194`, Aufruf `:209` | **Invarianten-Prüfung**, erreichbar über `GET /api/admin/invariants-report` |

Abschnitt 2 führte `fifo-breakdown.ts` als **Rechenstelle** (L4), aber keinen
ihrer Verbraucher. Das ist genau die Lücke, die eine Wirkungskarte schließen
soll: wer die Rechnung ändert, sieht nicht, wer davon abhängt.

**Nicht betroffen — geprüft, nicht angenommen:** Reservierung
(`reservation-storage.ts`), Buchung (`consumption-engine.ts`), Verfall
(`processExpiredCarryover`), Rebook. Keiner liest diese Aufschlüsselung.

## 2. ⚠ Die Feldnamen-Falle: `consumedCents` gibt es zweimal

`server/storage/budget/rebook-storage.ts:243` prüft `fifoResult.consumedCents`
— **das ist NICHT diese Aufschlüsselung.** `fifoResult` kommt aus `consumeFifo`
(`rebook-storage.ts:222`), also aus der Buchungs-Engine.

```
Budget45bFifoPot.consumedCents      ← Anzeige-Aufteilung (fifo-breakdown.ts)
consumeFifo(...).consumedCents      ← tatsächlich gebuchter Betrag (consumption-engine.ts)
```

Gleicher Name, verschiedene Quelle, verschiedene Bedeutung. Wer beim Suchen
nach `consumedCents` die Buchungsstelle findet und sie für einen Verbraucher
der Aufschlüsselung hält, schätzt den Blast-Radius falsch ein — in die
gefährliche Richtung, weil Rebook ein Schreibpfad ist.

**Genau diese Verwechslung soll diese Karte verhindern.**

## 3. ⚠ Der Wächter, der nicht fehlschlagen kann

`checkFifoUnifiedEquality` vergleicht für vier Felder die Summe über beide Töpfe
gegen den jeweiligen Gesamtwert. Gemessen an der Arithmetik in
`fifo-breakdown.ts:195-204` gegen die Rückgabe `:243-246`:

| Feld | Aufteilung | Summe | verglichen mit |
|---|---|---|---|
| `allocated` | `allocatedCarry` + (`A` − `allocatedCarry`) | `A` | `totalAllocatedCents: A` |
| `consumed` | `consumedCarry` + (`C` − `consumedCarry`) | `C` | `totalConsumedCents: C` |
| `planned` | `holdsCarry` + (`H` − `holdsCarry`) | `H` | `totalPlannedCents: H` |
| `available` | `freeCarry` + (`V` − `freeCarry`) | `V` | `totalAvailableCents: V` |

**Alle vier Summen sind Identitäten.** Der zweite Topf ist jeweils als
Differenz zum Gesamtwert definiert; die Summe ergibt den Gesamtwert per
Konstruktion zurück. Die Prüfung kann keinen Verstoß melden — auch den
negativen Verbrauch nicht, gegen den sie dem Namen nach schützt.

Das gilt **unabhängig von PR #190**, also auch auf dem heutigen `main`. Es
erklärt, warum der Fehler unbemerkt blieb: die Stelle, die ihn hätte finden
sollen, ist strukturell blind.

Dieselbe Klasse wie die tautologische Assertion aus #174
(`pots.reduce(...) === totalAllocatedCents`) — dort im Test, hier im
Produktivcode und im Admin-Bericht sichtbar.

**Eigenes Ticket `6hcVfPxVrCWVC8wp`**, bewusst nicht in #190: anderer
Gegenstand, und ein Fix dort müsste die Aufteilung an einer echten zweiten
Größe messen statt an sich selbst.

## 4. Die zwei Anker — eine Unterscheidung, die es vorher nicht gab

`fifo-breakdown.ts` führt seit PR #190 **zwei** Reset-Anker:

| Anker | Frage | Flag-abhängig? |
|---|---|---|
| `resetAnchor` | Welche Übertragszeilen sind **verdrängt**? | **ja** (`RESET_DISPLACES_ALL_SOURCES_DEFAULT`) |
| `verbrauchsAnker` | Welche **Buchungen** zählen zum Stichtag? | **nein** |

Der Reader schneidet den Verbrauch flag-unabhängig — `resetAnchorFrom(…)` in
`allocation-storage.ts` hängt nur an `opts.year == null`, nicht am Flag. Wer
beide Fragen mit demselben Anker beantwortet, bekommt bei ausgeschaltetem Flag
`null` und damit **keinen** Schnitt.

**Das war der erste Fehlversuch des Fixes**, und er ist nur aufgefallen, weil
der Test vor dem Fix existierte und rot blieb.

Das gemeinsame Prädikat heißt `countedConsumptionWhere` und liegt in
`allocation-window.ts` neben den übrigen Reset-Prädikaten. Sein Docblock
begründet, warum nur **zwei** der drei Reader-Glieder gelten — sonst hält die
nächste Person die fehlenden für ein Versehen.

## 5. `FS-5` — eine Buchung in der Zukunft belastete den Übertrag rückwirkend

Die Pro-Allocation-Rechnung hatte **kein** `transactionDate <= asOfDate`. Eine
Buchung nach dem Stichtag zählte damit in **jeder** Stichtagssicht gegen den
Übertrag.

Aufgefallen ist das **nicht beim Schreiben des Fixes**, sondern im
Mutations-Gegencheck: das Entfernen des `as-of`-Glieds ließ `FS-1`…`FS-4` grün.
`FS-5` schließt die Lücke.

Das ist der Punkt aus CLAUDE.md („ein Wächter braucht eine Selbstprobe") auf
einen gewöhnlichen Fix angewandt: der Gegencheck fragt nicht, ob die Zusage
plausibel ist, sondern ob ihr Test rot werden kann.
