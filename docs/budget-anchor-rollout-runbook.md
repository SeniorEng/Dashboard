# Budget-Anker-Production-Rollout — Operator-Runbook (Task #1209)

**Zweck:** Den Budget-Anker-Backfill (`server/scripts/backfill-budget-anchor.ts`,
Task #1203) **sicher gegen die Live-Production-DB** ausrollen — mit Pre-Rollout-
Backup, intaktem Prod-Guard, menschlich-gegateter REVIEW-Stufe und GoBD-Audit.

> **Warum ein eigener Job?** Dieser Workspace hat nur **Read-Only**-Zugriff auf
> Production. Der scharfe `--apply`-Lauf darf NICHT aus einer unverifizierten
> Shell hier passieren. Stattdessen läuft der Rollout in einem **Production-
> Deployment-Kontext** (Scheduled/One-Off Deployment), wo `DATABASE_URL` auf
> Production zeigt — analog zum GitHub-Sync (`docs/ci-pipeline.md`).

---

## 0. Was der Backfill tut (Kurzfassung)

`backfill-budget-anchor.ts` re-deriviert je Kunde den persistierten Budget-Anker
(`customer_budget_preferences.budget_start_date`/`_origin`) über die SSoT-Regel
`resolveBudgetAnchor(careLevelHistory, today)` und stempelt
`origin = 'derived_pflegegrad'`. **Wirkung ist nicht nur kosmetisch** — die
§45a/§39-Topf-Rechner lesen den Anker ROH. Deshalb teilt das Skript die
betroffenen Kunden per echter Messung (§45a/§39-Allocated VOR/NACH in einer
zurückgerollten Transaktion):

| Stufe | Bedeutung | Schreiben |
|---|---|---|
| **SAFE** | §45a UND §39 ändern sich NICHT (Origin-Stempel + ggf. §45b-Bodung) | Default-Job |
| **REVIEW** | §45a und/oder §39-Fenster verschieben sich (aktuell **nur Kunde #164**, §39-Fenster `2026-04-07 → 2026-01-01`) | nur mit explizitem Opt-in |

Erwartete Production-Klassifikation: **~6 reine Origin-Stempel + ~61 §45b-
Korrekturen (SAFE)** und **der einzelne REVIEW-Kunde #164**. Details:
`.agents/memory/45b-anchor-origin-stamp.md`.

---

## 1. Der Wrapper: `scripts/prod-budget-anchor-rollout.sh`

Kapselt **Backup → Dry-Run → (gewählte Stufe) Apply → Idempotenz-Re-Check**. Er
reimplementiert NICHTS — der Prod-Guard, die SAFE/REVIEW-Klassifikation und das
Audit-Logging bleiben im tsx-Skript.

```bash
bash scripts/prod-budget-anchor-rollout.sh dry-run               # Backup + Dry-Run (read-only)
bash scripts/prod-budget-anchor-rollout.sh safe                  # Backup + Dry-Run + SAFE-Apply + Re-Check
bash scripts/prod-budget-anchor-rollout.sh review --i-reviewed-164  # zusätzlich REVIEW (#164-Fenster-Shift)
```

Mehrschichtige Sicherheit:
1. **Backup-Gate:** `scripts/backup-prod-db.sh` MUSS erfolgreich sein (nicht-leerer
   Custom-Dump verifiziert), sonst harter Abbruch VOR jedem Apply.
2. **Prod-Guard intakt:** `--confirm-prod` wird nur im Apply-Pfad weitergegeben;
   das tsx-Skript bricht trotzdem ab, falls der DB-Host nicht prod-artig ist und
   `--confirm-prod` fehlt — der Job kann also nicht still DEV treffen.
3. **REVIEW-Opt-in:** Die Fenster-Shift-Stufe verlangt `--i-reviewed-164`
   (oder Env `CONFIRM_WINDOW_SHIFTS=1`). Der Default-Job (`safe`) fasst #164 NIE an.

---

## 2. Job einrichten (Scheduled / One-Off Deployment)

Ein Task-Agent kann KEIN Deployment anlegen (Publish ist Nutzer-Aktion), und das
`.replit`-`[deployment]`-Feld trägt bereits das Web-App-Autoscale-Deployment. Der
Rollout-Job ist ein **separates Deployment-Objekt** (wie der GitHub-Sync):

1. Publishing-Tool → **Create Deployment** → Typ **Scheduled** (oder ein einmaliger
   **One-Off**-Lauf; keine Cadence nötig — der Rollout ist einmalig + idempotent).
2. **Run-Command** (Default, sicher):
   ```
   bash scripts/prod-budget-anchor-rollout.sh safe
   ```
3. **Environment:** sicherstellen, dass `DATABASE_URL` auf die **Production**-DB
   zeigt (Deployment-Secrets). Optional `PROD_DATABASE_URL` setzen, sonst leitet
   der Wrapper das Backup-Ziel aus `DATABASE_URL` ab.
4. Deployment **starten** und die Logs verfolgen.

> **Erst-Empfehlung:** zuerst einen `dry-run`-Lauf als Run-Command publishen, die
> Klassifikation in den Logs gegen die Erwartung (~6 + ~61 SAFE, #164 REVIEW)
> prüfen, danach auf `safe` umstellen.

---

## 3. Ablauf Schritt für Schritt

### 3.1 Dry-Run (Klassifikation sichten)
Run-Command `… dry-run`. Erwartet in den Logs:
- DB-Host + `PROD-VERDACHT`.
- Backup-Pfad + SHA256 (in `docs/deployment-log.md` eintragen, §5 des Backup-Runbooks).
- Pro Kunde eine Zeile `[SAFE]`/`[REVIEW]` mit Anker-Vorher/Nachher + Topf-Deltas.
- Zusammenfassung: `SAFE-Tier … ~67`, `REVIEW-Tier … 1`, `Tatsächlich committet: 0`.

### 3.2 SAFE-Apply (Standard-Rollout)
Run-Command `… safe`. Der Job:
1. zieht das Pre-Rollout-Backup (Abbruch bei Fehler),
2. läuft den Dry-Run (Klassifikation in den Logs),
3. schreibt die SAFE-Stufe (`--apply --confirm-prod`) inkl. `budget_preferences_updated`-
   Audit pro Kunde,
4. fährt den **Idempotenz-Re-Check**: erneuter Dry-Run muss `SAFE = 0` melden
   (der REVIEW-Kunde #164 bleibt absichtlich offen).

### 3.3 Kunde #164 prüfen (REVIEW-Gate)
Vor der REVIEW-Stufe **manuell** verifizieren:
```bash
# nur #164, read-only Dry-Run (Topf-Deltas sichtbar):
npx tsx server/scripts/backfill-budget-anchor.ts --customer=164
```
Prüfen, dass der gemeldete §39-Fenster-Shift (`2026-04-07 → 2026-01-01`) fachlich
gewollt ist (der gebodete 01.01.-Anker zieht das §39-Ansammlungsfenster nach
vorne). Optional fachliche Gegenprobe mit `server/scripts/verify-45b-anchor-change.ts`.

### 3.4 REVIEW-Apply (nur nach Freigabe für #164)
Run-Command `… review --i-reviewed-164` (oder Env `CONFIRM_WINDOW_SHIFTS=1`). Der
Job zieht erneut ein Backup, läuft Dry-Run, schreibt SAFE-Rest **und** den #164-
Fenster-Shift (`--apply --include-window-shifts --confirm-prod`) und verlangt im
Re-Check, dass **beide** Stufen `0` melden.

### 3.5 Idempotenz final bestätigen
Ein letzter `… dry-run` (oder das eingebaute Re-Check-Log) muss `SAFE = 0` und
`REVIEW = 0` zeigen → `Kein Kunde betroffen`. Ergebnis in `docs/deployment-log.md`
festhalten.

---

## 4. Audit & Verifikation

- Jede Schreiboperation erzeugt einen GoBD-Audit-Eintrag `budget_preferences_updated`
  (entityType `budget`, entityId = Kunde, Metadaten inkl. `tier`, Vorher/Nachher-
  Anker + Origin und gemessene `allocatedByPot`-Deltas).
- Idempotenz: ein Folgelauf meldet `0 affected` — der `affected`-Check vergleicht
  persistierten Anker + Origin gegen das Re-Derivat.

---

## 5. Rollback

Schiefgelaufen? Backup zurückspielen gemäß `docs/pre-publish-backup-runbook.md` §6
(Replit/Neon-PITR bevorzugt; alternativ `pg_restore` aus dem in 3.1/3.2 gezogenen
Pre-Rollout-Dump `tmp/db-backups/prod-…-pre-budget-anchor-rollout.dump`). Da alle
Mutationen append-only auditiert sind, lässt sich der Eingriff zudem über das
`audit_log` (`action='budget_preferences_updated'`) lückenlos nachvollziehen.

---

## 6. Checkliste

- [ ] Deployment mit `DATABASE_URL` = **Production** angelegt (separates Objekt).
- [ ] `dry-run` gelaufen, Klassifikation ≈ erwartet (~6 + ~61 SAFE, #164 REVIEW).
- [ ] Backup-SHA256 + Pfad in `docs/deployment-log.md` notiert.
- [ ] `safe` gelaufen, Re-Check `SAFE = 0`.
- [ ] #164 §39-Fenster-Shift manuell geprüft & freigegeben.
- [ ] `review --i-reviewed-164` gelaufen, Re-Check `SAFE = 0` UND `REVIEW = 0`.
- [ ] Finaler `dry-run` meldet `Kein Kunde betroffen` (Idempotenz).
- [ ] Ergebnis in `docs/deployment-log.md` dokumentiert.
