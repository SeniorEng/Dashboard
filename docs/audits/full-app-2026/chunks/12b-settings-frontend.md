> **Refresh #822 (2026-05-29):** Deep-Dive-Refresh dieses Chunks. Ersetzt den vorherigen Pattern-Scan (#481 @`3e0d3fb`). Maßgeblich bleibt `../REPORT.md` für die konsolidierten Severity-Counts.

# Chunk 12b — Settings Frontend

**Tiefenstufe:** Deep (Refresh #822 — Gap-Fill Code-Walk)
**Commit:** `178b2574`
**Risiko:** MITTEL
**LOC / Files:** ~5 016 / 11 (`client/src/pages/admin/settings.tsx` 835 LOC, `admin/users.tsx` 586, `admin/whatsapp.tsx` 591, `admin/settings/*` Sub-Cards)
**Code-Walk:** `settings.tsx`, `users.tsx`, `settings/{company-details-form,smtp-settings,letterxpress-settings,logo-upload,lead-auto-reply-card}.tsx`

## Befunde

- ⚠️ **NIEDRIG — Self-Demote-Schutz nur serverseitig durchgesetzt** (`client/src/pages/admin/users.tsx`): Der UI-Pfad gated Rollen-Editierung über `isSuperAdmin`/`AdminPermissionsSection`, aber der „Superadmin entfernen"-Schalter für die **eigene** Zeile ist nicht clientseitig vor-deaktiviert. Der maßgebliche Schutz liegt serverseitig (`server/routes/employee-users.ts:281` Self-Demote-Block, REPORT §5 — FIXED), greift also zuverlässig. Reines UX-Residuum: Nutzer kann den Button drücken und erhält erst per Server-Fehler Feedback.
  - **Folge (optional):** Button für eigene Superadmin-Row clientseitig disablen für sauberes Feedback. Kein Sicherheitsrisiko.

- ⚠️ **MITTEL — Destruktive Wartungs-Jobs aus der Settings-UI auslösbar** (`client/src/pages/admin/settings.tsx:27-131`): `BackfillBudgetCard` (`POST /admin/budget/backfill-transactions`) und `RepairOrphanedTransactionsCard` (`POST /budget/admin/repair-orphaned-transactions?execute=true`, `:116-120`) triggern schreibende, GoBD-relevante Massen-Reparaturen direkt aus der allgemeinen Einstellungsseite. Schutz hängt allein an den Server-Route-Guards (Admin). Kein zusätzliches Confirm-Gate / kein Hinweis auf Irreversibilität im destruktiven Pfad (`execute=true`).
  - **Folge:** Destruktive Maintenance-Cards in einen klar getrennten „Wartung/Reparatur"-Bereich mit Confirm-Dialog ziehen; serverseitige Admin-Gates auf diesen Routen verifizieren.

- ⚠️ **NIEDRIG — Page-Size / Mutations-Hygiene**: `settings.tsx` (835 LOC) bündelt sehr viele unabhängige Mutationen (`companySaveMutation`, `qontoSaveMutation`, `twilioSaveMutation`, `coverLetterSaveMutation`, `toggleMutation` …). Alle haben sauberes `onError`-Toast-Handling (`:40-41`, `:358-359`, …). Cache-Invalidierung uneinheitlich (Cross-Ref REPORT **M10**, ~20% `invalidateRelated`-Adoption) — einzelne Save-Mutationen verlassen sich auf manuelles `queryClient.invalidateQueries` statt der zentralen Helper.
  - **Folge:** `settings.tsx` in Karten-Module aufsplitten (Sub-Cards existieren bereits — Migration fortsetzen); Invalidierung auf `invalidateRelated` vereinheitlichen.

- ✅ Telefon-Validierung clientseitig via `validateDachPhone` / `libphonenumber-js` mit Toast-Feedback (`settings.tsx:324-342`).
- ✅ Keine `dangerouslySetInnerHTML`, kein `eval`, kein `as any`/`@ts-ignore`, keine `localStorage`-Geheimnisse in den geprüften Settings-Pages.
- ✅ E2E-Smoke (Firmenstammdaten-Telefon Round-Trip) deckt Persistenz-Pfad.

## Empfohlener Folge-Task

`[MITTEL] Settings-FE Hardening: destruktive Wartungs-Cards in separaten Bereich + Confirm-Gate, settings.tsx weiter in Sub-Cards splitten, Cache-Invalidierung auf invalidateRelated vereinheitlichen. (Self-Demote-UI-Disable optional mitnehmen — Server enforced.)`
