> **Refresh #822 (2026-05-29, Commit `178b2574`):** Dieser Chunk wurde in der Refresh-Welle als **Pattern-Scan** behandelt (keine neuen KRITISCH/HOCH-Findings in dieser Domäne). Maßgeblich ist `../REPORT.md` (Severity-Counts, Vorgänger-Status §5). Inhalt unten stammt aus dem #481-Lauf @`3e0d3fb`.

# Chunk 15 — Mobile/Layout/Design-System

**Tiefenstufe:** Pattern-Scan
**Commit:** `3e0d3fb`
**Risiko:** NIEDRIG
**LOC / Files:** 6 971 / 57

## Befunde

- ✅ Overlay-Constraints aus `replit.md` (keine Transforms außer Sheet-Slide,
  keine Blur > 50 %): Pattern-Scan zeigt 0 `backdrop-blur`-Treffer in
  client/src; `translate-*` nur in `toast.tsx`, `switch.tsx`, `alert.tsx`,
  `signature-pad.tsx` — keine davon Dialog/AlertDialog/Sheet/Drawer-Overlay
  → konform.
- ⚠️ **NIEDRIG:** 57 Files / 6 971 LOC — größter NIEDRIG-Chunk. Bundle-Size-
  Baseline nicht in CI verankert; **Folge-Task:** Vite-Bundle-Snapshot-Test.

## Empfohlener Folge-Task

`[NIEDRIG] UI-Layer Bundle-Size-Snapshot-Test`.
