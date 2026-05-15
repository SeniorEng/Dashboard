# Chunk 1 — Foundation: Shared Schema/API/Domain

**Tiefenstufe:** Pattern-Scan (existierende CI-Discipline-Tests genutzt)
**Commit:** `3e0d3fb`
**Risiko:** HOCH (Schema-Drift cross-cutting)
**LOC / Files:** 7 730 / 62

## Befunde

- ✅ `tests/architecture/sensitive-columns.test.ts` deckt das HOCH-Risiko
  „neue Spalte mit Namen `secret|token|password|key` ohne `encryptedText`-
  Annotation" CI-seitig ab.
- ✅ `tests/architecture/calculations-in-shared.test.ts` verhindert neue
  `calculate*`/`compute*`-Funktionen außerhalb `shared/domain/`.
- ✅ Query-Invalidation-Discipline (`tests/query-invalidation-discipline.test.ts`)
  prüft `RELATED_DOMAINS` + Budget-Keys-Pattern.
- ⚠️ **MITTEL:** Pattern-Scan zeigt **8 direkte `queryClient.invalidateQueries`-
  Aufrufe** in client/src — Discipline-Test sollte sie als `invalidate-direct-
  allowed`-Kommentar-gestützte Allowlist führen; manuell verifizieren, dass jede
  davon eine begründete Ausnahme hat.
- ⚠️ **NIEDRIG:** `dangerouslySetInnerHTML` an 3 Stellen
  (`public-signing.tsx`, `document-preview.tsx`, `document-templates.tsx`) —
  Output kommt aus DB-Templates, die selbst Placeholder ersetzen → potentielles
  Stored-XSS, falls Admin Template-Body manipuliert. **Folge-Task:** Template-
  Body durch DOMPurify oder ein striktes Allowlist-Parser jagen, bevor injiziert.

## Stop-Kriterium aus Plan

> Alle DB-Tabellen, Zod-Schemas und API-Contracts in Anhang A dokumentiert; alle
> nicht-encrypted Spalten mit `secret|token|password|key` haben Allowlist-Eintrag.

**Deferred — Pflicht für vertieften Folge-Task** (vorgeschlagen in REPORT.md).
Pattern-Scan zeigt: existierende CI-Tests decken die Allowlist-Bedingung ab;
Domain-Map fehlt als geschriebenes Artefakt.

## Empfohlener Folge-Task

`[MITTEL] Foundation-Audit: Schema-Domain-Map + Template-Sanitization`.
