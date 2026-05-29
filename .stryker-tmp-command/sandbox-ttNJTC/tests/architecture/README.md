# Architektur-Fitness-Functions

Diese Tests erzwingen Architektur-Konventionen (zentrale Berechnungen, km-/Money-Helper,
Soft-Delete-Coverage, Error-Handling-Wrapper usw.) als CI-Schranke.

## Ausführen

```bash
# Alle Architektur-Tests
npx vitest run tests/architecture

# Einzelner Test
npx vitest run tests/architecture/calculations-in-shared.test.ts
```

## ast-grep (Task #776 — Pilot)

Zwei Fitness-Functions inspizieren den Code nicht mehr per Regex, sondern über den
TypeScript-AST via [`@ast-grep/napi`](https://ast-grep.github.io/) (Dev-Dependency):

- `calculations-in-shared.test.ts` — Hotspot-`calculate*`/`compute*`-Erkennung
- `asyncHandler-coverage.test.ts` — Route-Wrapping-Prüfung

Gemeinsame Helper liegen in `ast-grep-helpers.ts` (`parseSource`, `walkTsFiles`,
`collectNamedFunctions`).

**Warum AST statt Regex?** Regex matcht auch in Kommentaren, String-Literalen und reinen
Wert-Variablen (`const x = computeCap(...)`) und verfehlt mehrzeilige Deklarationen. Der
AST kennt diese Knotentypen und liefert daher keine False-Positives. `@ast-grep/napi`
bringt eine native Binary mit; ein separates CLI ist nicht nötig — das Parsen läuft
in-process im Vitest-Test.

Die übrigen Fitness-Functions nutzen weiterhin Regex; ein Rollout ist optional.
