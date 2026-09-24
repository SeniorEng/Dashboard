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
