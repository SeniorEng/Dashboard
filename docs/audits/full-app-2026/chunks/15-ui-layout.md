> **Refresh #822 (2026-05-29):** Deep-Dive-Refresh dieses Chunks. Ersetzt den vorherigen Pattern-Scan (#481 @`3e0d3fb`). Maßgeblich bleibt `../REPORT.md` für die konsolidierten Severity-Counts.

# Chunk 15 — Mobile/Layout/Design-System

**Tiefenstufe:** Deep (Refresh #822 — Gap-Fill Code-Walk)
**Commit:** `178b2574`
**Risiko:** NIEDRIG
**LOC / Files:** ~6 971 / 57
**Code-Walk:** `client/src/components/ui/{dialog,sheet,drawer,alert-dialog,popover,dropdown-menu}.tsx`, Layout-/Design-System-Layer

## Befunde

- ✅ **Overlay-Disziplin (replit.md-Constraint) eingehalten**: Gezielte Suche nach `translate|transform|backdrop-blur|filter:|will-change` über `dialog/sheet/drawer/alert-dialog/popover/dropdown-menu.tsx` ergibt **0 Treffer** für problematische Inline-Transforms/Blur/`will-change` in den Overlay-Primitives. Keine eigenen Stacking-Context-/Compositing-Fallen, die mobile Overlays brechen würden. Konform zu „keine Transforms außer Sheet-Slide, kein exzessives Blur".
- ⚠️ **NIEDRIG — Keine Bundle-Size-Baseline in CI** (Bestand aus #481): 57 Files / ~6 971 LOC, größter NIEDRIG-Chunk. Es gibt keinen Vite-Bundle-Snapshot/Budget-Gate, der Regressions (z. B. versehentlich gebündelte schwere Lib) erkennt.
  - **Folge:** Vite-Bundle-Snapshot-/Size-Budget-Test in CI.
- ⚠️ **NIEDRIG — Design-System-Tokens nicht test-verankert**: `iconSize`/`componentStyles` (`@/design-system`) werden breit konsumiert (z. B. `admin/settings.tsx`), aber es existiert kein Regression-Guard gegen Token-Drift/versehentliche Hardcodes.
  - **Folge:** Optionaler Lint-Rule/Snapshot für Design-Token-Nutzung.

- ✅ Keine KRITISCH/HOCH-Findings in dieser Domäne. Risiko bleibt NIEDRIG.

## Empfohlener Folge-Task

`[NIEDRIG] UI-Layer-Härtung: Vite-Bundle-Size-Snapshot-Test in CI (+ optional Design-Token-Lint).`
