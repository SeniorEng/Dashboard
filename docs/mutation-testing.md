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

Gemutiert werden **ausschließlich pure Berechnungs-/Buchungs-Module** unter
`shared/domain/`, die reine Unit-Tests **ohne DB und ohne laufenden Server**
besitzen. Nur so läuft ein Lauf in Minuten statt Stunden.

Die fünf Hotspots (`mutate` in `stryker.conf.mjs`):

| Modul | Pure Tests |
|---|---|
| `shared/domain/invoice-line-items.ts` | `tests/equality/invoice-line-item-arithmetic.test.ts` |
| `shared/domain/budget-invoice-split.ts` | `tests/equality/invoice-per-pot-arithmetic.test.ts` |
| `shared/domain/budget/cost-estimate-outcome.ts` | `tests/budget/cost-estimate-outcome.test.ts` |
| `shared/domain/budget/cap-math.ts` | `tests/budget/cap-math.test.ts` |
| `shared/domain/budget/history-aggregation.ts` | `tests/budget/history-aggregation.test.ts` |

**Out of scope** (explizit nicht enthalten):

- **Full-Suite-Mutation in CI** — zu teuer. CI mutiert nur die im PR geänderten Dateien.
- **Frontend-Mutation-Testing** (`client/`).
- **DB-gebundene Services** wie `server/storage/budget/consumption-engine.ts` oder
  `server/services/month-close-scheduler.ts`. Deren Tests brauchen Postgres + App-Server;
  sie zu mutieren würde den „zu teuer"-Out-of-scope verletzen. Statt ihrer decken wir
  die **reinen** Cap-/History-Berechnungen ab, in die ihre Mathematik bereits
  extrahiert ist (`cap-math`, `history-aggregation`).

## Konfiguration

- **Stryker-Config:** `stryker.conf.mjs`
- **Vitest-Config für Mutation-Läufe:** `vitest.stryker.config.ts` (ohne `globalSetup`,
  d.h. ohne DB-Cleanup; nur die fünf puren Test-Dateien)
- **Test-Runner:** `command` (`npx vitest run --config vitest.stryker.config.ts`).
  Grund: vitest 4.x ist neuer als der offizielle Stryker-Vitest-Runner (9.6.1), dessen
  Per-Mutant-Selektion gegen die vitest-4-Internals hängt. Der Command-Runner ist
  versions-agnostisch und bei dieser kleinen, schnellen Suite ausreichend.
- **Incremental-Mode:** aktiv. `reports/stryker-incremental.json` (gitignored, in CI per
  `actions/cache`) merkt sich Ergebnisse; Folge-Läufe prüfen nur betroffene Mutanten erneut.
- **Schwellen (CI-Gate):** `high: 80`, `low: 60`, `break: 60`. Fällt der Score unter 60 %,
  bricht Stryker mit Exit-Code != 0 ab und lässt das CI-Gate fehlschlagen.

## Lokale Nutzung

```bash
# Vollständiger Lauf über alle fünf Hotspots (nutzt/erzeugt Incremental-Report):
npm run mutation

# Nur bestimmte Dateien mutieren (wie CI es im PR tut):
npm run mutation -- --mutate "shared/domain/budget/cap-math.ts"

# Reine Test-Suite (ohne Mutation) zur schnellen Vorab-Prüfung:
npx vitest run --config vitest.stryker.config.ts
```

Der HTML-Report landet unter `reports/mutation/index.html`.

## CI-Integration

Job `mutation` in `.github/workflows/ci.yml`:

1. Läuft **nur bei `pull_request`** (der Diff wird gegen den Base-Branch berechnet).
2. Ermittelt per `git diff`, welche der fünf Hotspot-Dateien im PR geändert wurden.
3. Wurde keine geändert → Schritt wird sauber übersprungen.
4. Andernfalls: `npx stryker run --mutate <geänderte Dateien>`.
5. Der Incremental-Report wird per `actions/cache` über Läufe hinweg erhalten.
6. Score < `break` (60 %) → Job rot (Gate).

## Eine neue Datei in die Mutation-Suite aufnehmen

1. Sicherstellen, dass das Modul **pur** ist (kein DB-/Server-/Netz-I/O).
2. Eine reine Unit-/Equality-Test-Datei dafür schreiben (Vorbild: `tests/budget/cap-math.test.ts`).
3. Test-Datei in `vitest.stryker.config.ts` → `test.include` eintragen.
4. Modulpfad in `stryker.conf.mjs` → `mutate` **und** in die `HOTSPOTS`-Liste des
   CI-Jobs (`.github/workflows/ci.yml`, Step „Determine changed mutation targets") aufnehmen.
5. `npm run mutation` lokal laufen lassen und überlebende Mutanten durch zusätzliche
   Assertions killen, bis der Score ≥ 80 % liegt.

## Überlebende Mutanten interpretieren

Ein überlebender Mutant ist **kein** Bug im Produktivcode, sondern eine **fehlende
Assertion**. Beispiel: Wenn `>` → `>=` überlebt, fehlt ein Test genau auf der
Grenz-Gleichheit. Test ergänzen, der den Unterschied zwischen `>` und `>=` sichtbar
macht — nicht den Produktivcode anpassen.
