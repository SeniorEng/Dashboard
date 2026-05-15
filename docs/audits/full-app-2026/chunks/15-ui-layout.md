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
