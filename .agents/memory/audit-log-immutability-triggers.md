---
name: audit_log GoBD immutability (triggers, not RULEs/REVOKE)
description: Why audit_log uses raising BEFORE triggers + a transaction-local bypass GUC, and how to mutate it legitimately.
---

# audit_log GoBD-Unveränderbarkeit

`audit_log` ist append-only erzwungen über **raising BEFORE triggers** (UPDATE/DELETE row-level + TRUNCATE statement-level), die eine Exception werfen, statt die Mutation still zu verschlucken.

**Why:**
- Früher gab es silent `DO INSTEAD NOTHING` RULEs auf audit_log. GoBD-schwach: Mutationen wurden lautlos zum No-Op statt zu failen — kein Tamper-Signal.
- `REVOKE UPDATE/DELETE` ist wirkungslos, weil die App als DB-Owner (`postgres`) verbindet; Owner umgehen Tabellen-Grants. Trigger greifen auch für den Owner.

**How to apply:**
- Setup läuft idempotent als Startup-Migration (dropt alte RULEs, legt die Prevent-Funktionen + Trigger an).
- Legitimes Mutieren (NUR Test-/Cleanup-Pfade, NIE Produktion): in einer Transaktion `SET LOCAL app.allow_audit_log_mutation = 'on'`, dann delete/update. Der Trigger lässt durch, wenn `current_setting('app.allow_audit_log_mutation', true) = 'on'`. `SET LOCAL` ist transaktions-scoped → parallel-test-sicher.
- Beim Umstellen eines Cleanup-Pfads auf den Bypass die bestehende Lösch-Reihenfolge unangetastet lassen (z.B. erst Appointments/Kinder detachen/löschen, User zuletzt) — der Bypass ändert nur, ob audit_log-Zeilen fallen dürfen, nicht die FK-Ordnung.
- Drizzle-Fehler-Falle: Bei verworfener Mutation enthält `error.message` nur `Failed query: …`, NICHT die deutsche RAISE-Message des Triggers. Tests dürfen also nicht auf den Meldungstext matchen — nur auf `.rejects.toThrow()` plus ein Folge-SELECT, das die Zeile unverändert/vorhanden zeigt.
