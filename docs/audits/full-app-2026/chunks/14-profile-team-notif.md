> **Refresh #822 (2026-05-29):** Deep-Dive-Refresh dieses Chunks. Ersetzt den vorherigen Pattern-Scan (#481 @`3e0d3fb`). Maßgeblich bleibt `../REPORT.md` für die konsolidierten Severity-Counts.

# Chunk 14 — Profile, Team, Notifications, Tasks

**Tiefenstufe:** Deep (Refresh #822 — Gap-Fill Code-Walk)
**Commit:** `178b2574`
**Risiko:** MITTEL
**LOC / Files:** ~7 523 / 45
**Code-Walk:** `server/routes/{tasks,team,notifications,birthdays}.ts`, `server/services/birthday-notification-checker.ts`, `server/storage/notifications.ts`, `server/lib/team-workload.ts`, `shared/utils/datetime.ts`, `client/src/pages/admin/users.tsx`

## Befunde

- ⚠️ **MITTEL — Geburtstags-Reminder: Exact-Equality-Horizont ohne Catch-up** (`server/services/birthday-notification-checker.ts:35` und `:60`): Der Check feuert nur bei `daysUntil !== BIRTHDAY_HORIZON_DAYS (7)` → **continue**, also bei *exakt* 7 Tagen. Der Scheduler läuft alle 6 h (`server/index.ts:688`, plus 5-min-Boot-Delay `:687`). Innerhalb eines Kalendertags ist `daysUntil` stabil und Mehrfachläufe werden über `hasRecentNotification(..., 48)` (`:45`, `:73`) deduped. **Aber:** Läuft an *einem* Kalendertag kein Lauf mit `daysUntil===7` (Server-Downtime/Deploy über den ganzen Tag), wird der 7-Tage-Reminder **dauerhaft übersprungen** — es gibt kein `<= 7 && noch nicht benachrichtigt`-Catch-up-Fenster.
  - **Folge:** Horizont von Exact-Equality auf „≤ Horizont und noch nicht für dieses Jahr benachrichtigt" umstellen (Dedup via `birthdayYear` + `hasRecentNotification`).

- ⚠️ **MITTEL — Zeitzonen-Abhängigkeit vom Container-TZ (Off-by-one-Risiko)** (`shared/utils/datetime.ts:53-65` → `formatDateISO`/`todayISO`; konsumiert in `birthday-notification-checker.ts:11,39,68` und `server/routes/tasks.ts:54,57-59`): `todayISO()`/`currentTimeHHMMSS()` leiten „heute" aus `new Date()` mit **Server-lokaler** Zeitzone ab (`.getFullYear()`/`.getMonth()`/`.getHours()`), nicht explizit aus `Europe/Berlin`. Läuft der Container in UTC (Default vieler Deploy-Umgebungen, kein dokumentiertes `TZ=Europe/Berlin`), liegt die Tagesgrenze auf UTC-Mitternacht statt Berlin → `daysUntil`/`badge-count`-Monatsgrenze (`tasks.ts:57-61`, `:78-83`) können im 00:00–02:00-Berlin-Fenster um einen Tag/Monat danebenliegen. Determinismus hängt damit an einer nicht im Code erzwungenen ENV-Voraussetzung.
  - **Folge:** TZ explizit auf Berlin festnageln (zentrale `todayISO`/`currentTime*` über `Intl`/`toLocaleString('…', {timeZone:'Europe/Berlin'})`) ODER `TZ=Europe/Berlin` als verpflichtende ENV dokumentieren + Boot-Assertion.

- ⚠️ **MITTEL — `GET /tasks/badge-count` fan-out pro Poll** (`server/routes/tasks.ts:63-72`): Jeder Badge-Request feuert 5 parallele Queries (u. a. `getUndocumentedAppointments`, `getMonthClosing`, `getPendingServiceRecords`). Das Badge wird von der Shell häufig gepollt → spürbare DB-Grundlast. Funktional korrekt, aber Hotspot.
  - **Folge:** Badge-Count cachen (kurzes TTL) oder in eine kombinierte Query zusammenziehen.

- ⚠️ **MITTEL (Cross-Ref M7) — `console.*` statt `log()` in Route-Layer**: REPORT **M7** zählt ~46 `console.*` in 14 Route-Files; in diesem Chunk u. a. die Scheduler-Catch-Blöcke (`server/index.ts:658,672,684,696,730`) nutzen `console.error` direkt statt der zentralen `log()`-Senke (`server/lib/log.ts`).
  - **Folge:** Im M7-Sammel-Task mitnehmen.

- ✅ **Tasks-Permissions korrekt**: `POST /tasks` blockt Fremd-Zuweisung für Nicht-Admins (`tasks.ts:139-143`); `GET/PATCH/DELETE /:id` prüfen `assignedToUserId`/`createdByUserId` bzw. `isAdmin` (`:119-121`, `:222-225`, `:244-247`).
- ✅ **Birthday-Card-Tracking transaktional** (`tasks.ts:183-216`): Tracking-Upsert + `completeAllBirthdayTasks`/`reopenAllBirthdayTasks` laufen atomar in `db.transaction`.
- ✅ **Team-Workload korrekt gegated** (`server/routes/team.ts:12-24`): Admin **oder** Teamlead, sonst 403; Antwort via `sanitizeUser` gefiltert (kein PII-Leak). Konsumiert `monthlyWorkHours` (Cross-Ref H3, siehe Chunk 11).
- ✅ **Notifications-Storage**: `getNotifications`/`getUnreadCount` mit `withDbRetry` + Limit (`server/storage/notifications.ts:10-40`); `markAsRead`/`markAllAsRead` scoped auf `userId` (`:42-54`).

## Empfohlener Folge-Task

`[MITTEL] Notif/Tasks-Determinismus: (a) Geburtstags-Horizont auf ≤7+Jahres-Dedup statt Exact-Equality, (b) zentrale Datums-Utils auf Europe/Berlin festnageln oder TZ-ENV erzwingen, (c) badge-count cachen/bündeln.`
