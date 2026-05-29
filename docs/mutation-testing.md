# Mutation-Testing mit Stryker (Task #770)

## Warum Mutation-Testing?

Line-/Branch-Coverage beantwortet nur die Frage „wird diese Zeile **ausgeführt**?" —
nicht „würde ein Fehler in dieser Zeile von einem Test **gefangen**?". Mutation-Testing
schließt diese Lücke: Stryker verändert (mutiert) den Produktivcode systematisch
(z.B. `+` → `-`, `>` → `>=`, `&&` → `||`, Konstanten/Booleans kippen, `return`-Werte
entfernen) und führt nach jeder Mutation die Tests aus.

- **Killed** = mindestens ein Test wird rot → die Mutation wurde gefangen. Gut.
- **Survived** = alle Tests bleiben grün → blinder Fleck. Hier fehlt eine Assertion.
- **No coverage** = die mutierte Zeile wird von keinem Test ausgeführt.

Der **Mutation-Score** = `killed / (killed + survived + no-coverage)`.

## Scope (bewusst eng gehalten)

Gemutiert werden **ausschließlich pure Berechnungs-/Buchungs-Module** (vorrangig
unter `shared/domain/`, ergänzt um pure Helfer wie `shared/utils/money.ts`), die
reine Unit-Tests **ohne DB und ohne laufenden Server** besitzen. Nur so läuft ein
Lauf in Minuten statt Stunden.

Die elf Hotspots sind seit Task #804 auf **zwei Profile** aufgeteilt (siehe
Abschnitt „Konfiguration: zwei Profile"):

**Profil `vitest`** (nativer `@stryker-mutator/vitest-runner`, schnell — `mutate`
in `stryker.vitest.conf.mjs`):

| Modul | Pure Tests |
|---|---|
| `shared/domain/budget/cost-estimate-outcome.ts` | `tests/budget/cost-estimate-outcome.test.ts` |
| `shared/domain/budget/cap-math.ts` | `tests/budget/cap-math.test.ts` |
| `shared/domain/budget/history-aggregation.ts` | `tests/budget/history-aggregation.test.ts` |
| `shared/domain/budgets.ts` | `tests/budget/statutory-clamp.test.ts` |
| `shared/domain/vacation.ts` | `tests/unit/vacation-pro-rata.test.ts` |
| `shared/domain/cancellation-policy.ts` | `tests/unit/cancellation-policy.test.ts` |
| `shared/utils/money.ts` | `tests/utils/money.test.ts` |
| `shared/domain/import-cutoff.ts` | `tests/unit/import-cutoff.test.ts` |
| `shared/utils/month-close-cutoff.ts` | `tests/month-close-cutoff.test.ts` |

**Profil `command`** (Command-Runner, SIGKILL-sicher — `mutate` in
`stryker.command.conf.mjs`): die zwei PROPERTY-basierten Module, deren
fast-check-Tests bei manchen Mutanten in eine *synchrone* Endlosschleife laufen:

| Modul | Pure Tests |
|---|---|
| `shared/domain/invoice-line-items.ts` | `tests/equality/invoice-line-item-arithmetic.test.ts` |
| `shared/domain/budget-invoice-split.ts` | `tests/equality/invoice-per-pot-arithmetic.test.ts` |

**Out of scope** (explizit nicht enthalten):

- **Full-Suite-Mutation in CI** — zu teuer. CI mutiert nur die im PR geänderten Dateien.
- **Frontend-Mutation-Testing** (`client/`).
- **DB-gebundene Services** wie `server/storage/budget/consumption-engine.ts` oder
  `server/services/month-close-scheduler.ts`. Deren Tests brauchen Postgres + App-Server;
  sie zu mutieren würde den „zu teuer"-Out-of-scope verletzen. Statt ihrer decken wir
  die **reinen** Cap-/History-Berechnungen ab, in die ihre Mathematik bereits
  extrahiert ist (`cap-math`, `history-aggregation`).

## Konfiguration: zwei Profile

Seit Task #804 ist die Suite in **zwei Stryker-Profile** mit unterschiedlichen
Test-Runnern aufgeteilt, plus ein Orchestrator, der beide fährt und den Score
**aggregiert** gatet:

- **Geteilte Basis:** `stryker.base.mjs` (`baseOptions`) — gemeinsame Optionen
  (Reporter, `incremental: true`, `ignorePatterns`-Allowlist, `timeoutMS`,
  Schwellen). **Wichtig:** Die Einzel-Profile setzen `thresholds.break: null` —
  das harte Gate (`break: 60`) erzwingt der Orchestrator auf dem AGGREGIERTEN
  Score, sonst würde ein einzelnes Profil <60 % den Lauf killen, obwohl der
  kombinierte Score das Gate besteht.
- **Profil `vitest`:** `stryker.vitest.conf.mjs` — die neun DETERMINISTISCHEN
  Module auf dem nativen `@stryker-mutator/vitest-runner`
  (`coverageAnalysis: "off"`). Vitest-Config: `vitest.stryker-vitest.config.ts`
  (nur die neun deterministischen Test-Dateien). Eigene Incremental-Datei
  `reports/stryker-incremental-vitest.json`. Deutlich schneller als der
  Command-Runner-Kaltstart (~1 Min für die ganze Gruppe).
- **Profil `command`:** `stryker.command.conf.mjs` — die zwei PROPERTY-basierten
  Module auf dem `command`-Runner
  (`npx vitest run --config vitest.stryker.config.ts`). Vitest-Config:
  `vitest.stryker.config.ts` (nur die zwei Property-Test-Dateien). Eigene
  Incremental-Datei `reports/stryker-incremental-command.json`.
- **Orchestrator:** `scripts/run-mutation.mjs` (`npm run mutation`) fährt beide
  Profile nacheinander, routet ein optionales `--mutate <datei>` automatisch ins
  richtige Profil, aggregiert die zwei JSON-Reports zu einem Gesamt-Score und
  erzwingt `break: 60` auf dem aggregierten Score (Exit ≠ 0, wenn drunter).

**Warum der Command-Runner nur für die zwei Property-Module?**
(re-verifiziert 2026-05-28, Runner 9.6.1 / vitest 4.0.18): Manche Mutanten der
Property-Module erzeugen in den fast-check-Tests (`tests/equality/*`) eine
*synchrone* Endlosschleife. Der native vitest-Worker lässt sich synchron nicht
abbrechen, der Per-Mutant-Timeout greift nicht, der Lauf hängt. Der
Command-Runner umgeht das, weil Stryker pro Mutant einen frischen Kindprozess
startet und ihn nach `timeoutMS` hart per SIGKILL beendet — versions-agnostisch
sicher, aber pro Mutant ein teurer Kaltstart. Die neun DETERMINISTISCHEN Module
haben dieses Risiko nicht und laufen daher auf dem schnellen nativen Runner.
Wieder-Umstellung der Property-Module auf den nativen Runner erst, wenn ein neuer
Runner einen VOLLEN Lauf (nicht nur den Dry-Run) ohne Hänger durchzieht.

**Stryker-CLI-Falle (Task #804):** Die Config-Datei MUSS als POSITIONALES
Argument an `stryker run` übergeben werden (`npx stryker run stryker.X.conf.mjs`),
NICHT via `-c` — `-c` ist die Kurzform für `--concurrency`. Über `-c <datei>`
landet der Dateipfad als concurrency-Wert und der Lauf bricht mit der
irreführenden Meldung `concurrency must match pattern …` ab. Der Orchestrator
übergibt die Config korrekt positional.

- **Incremental-Mode:** aktiv, pro Profil eine eigene Datei (siehe oben;
  gitignored, in CI per `actions/cache`). Folge-Läufe prüfen nur betroffene
  Mutanten erneut.
- **Schwellen (CI-Gate):** `high: 80`, `low: 60`, `break: 60` — auf dem
  AGGREGIERTEN Score über beide Profile. Fällt er unter 60 %, beendet der
  Orchestrator mit Exit-Code ≠ 0 und lässt das CI-Gate fehlschlagen.

## Lokale Nutzung

```bash
# Vollständiger Lauf über beide Profile (Orchestrator, nutzt/erzeugt
# beide Incremental-Reports, aggregiert den Score, Gate break:60):
npm run mutation

# Nur bestimmte Dateien mutieren (wie CI es im PR tut). Der Orchestrator
# routet jede Datei automatisch ins richtige Profil; ein Profil ohne
# passende Datei wird übersprungen:
npm run mutation -- --mutate "shared/domain/budget/cap-math.ts"

# Reine Test-Suiten (ohne Mutation) zur schnellen Vorab-Prüfung:
npx vitest run --config vitest.stryker-vitest.config.ts   # deterministische Module
npx vitest run --config vitest.stryker.config.ts          # Property-Module
```

Die HTML-Reports landen pro Profil unter `reports/mutation/vitest/index.html` bzw.
`reports/mutation/command/index.html`; der Orchestrator druckt am Ende den
aggregierten Gesamt-Score.

**Hinweis zur Laufzeit:** Das Profil `vitest` ist schnell (~1 Min für alle neun
Module). Das Profil `command` ist pro Mutant deutlich teurer (frischer
`npx vitest run`-Kaltstart je Mutant), deckt aber nur zwei Module ab. Ein
**kalter** Voll-Lauf beider Profile kann daher mehrere Minuten dauern;
Folge-Läufe sind dank Incremental-Mode (zwei getrennte Report-Dateien) deutlich
schneller. Genau dieser Split ist der Speedup gegenüber dem früheren
Single-Command-Runner-Lauf, der ALLE zehn Module über den langsamen Kaltstart
mutierte.

## CI-Integration

Job `mutation` in `.github/workflows/ci.yml`:

1. Läuft **nur bei `pull_request`** (der Diff wird gegen den Base-Branch berechnet).
2. Ermittelt per `git diff`, welche der elf Hotspot-Dateien im PR geändert wurden.
3. Wurde keine geändert → Schritt wird sauber übersprungen.
4. Andernfalls: `npm run mutation -- --mutate <geänderte Dateien>` (Orchestrator
   routet die Dateien in die passenden Profile und gatet den aggregierten Score).
5. **Beide** Incremental-Reports (`reports/stryker-incremental-vitest.json` und
   `reports/stryker-incremental-command.json`) werden per `actions/cache` über
   Läufe hinweg erhalten.
6. Aggregierter Score < `break` (60 %) → Orchestrator Exit ≠ 0 → Job rot (Gate).

## Eine neue Datei in die Mutation-Suite aufnehmen

1. Sicherstellen, dass das Modul **pur** ist (kein DB-/Server-/Netz-I/O).
2. Eine reine Unit-/Equality-Test-Datei dafür schreiben (Vorbild: `tests/budget/cap-math.test.ts`).
3. Profil wählen:
   - **Deterministisch** (keine fast-check-Endlosschleifen-Gefahr) → schnelles
     Profil `vitest`: Test-Datei in `vitest.stryker-vitest.config.ts` →
     `test.include` und Modulpfad in `stryker.vitest.conf.mjs` → `mutate`. (Der
     Orchestrator `scripts/run-mutation.mjs` routet automatisch alles ins
     `vitest`-Profil, was NICHT in `COMMAND_MODULES` steht — daher keine eigene
     Liste pflegen.)
   - **Property-basiert** (fast-check, Endlosschleifen-Risiko) → sicheres Profil
     `command`: Test-Datei in `vitest.stryker.config.ts` → `test.include`,
     Modulpfad in `stryker.command.conf.mjs` → `mutate`, und in die
     `COMMAND_MODULES`-Liste in `scripts/run-mutation.mjs`.
4. Modulpfad zusätzlich in die `HOTSPOTS`-Liste des CI-Jobs
   (`.github/workflows/ci.yml`, Step „Determine changed mutation targets") aufnehmen.
5. `npm run mutation` lokal laufen lassen und überlebende Mutanten durch zusätzliche
   Assertions killen, bis der Score ≥ 80 % liegt.

## Überlebende Mutanten interpretieren

Ein überlebender Mutant ist **kein** Bug im Produktivcode, sondern eine **fehlende
Assertion**. Beispiel: Wenn `>` → `>=` überlebt, fehlt ein Test genau auf der
Grenz-Gleichheit. Test ergänzen, der den Unterschied zwischen `>` und `>=` sichtbar
macht — nicht den Produktivcode anpassen.
