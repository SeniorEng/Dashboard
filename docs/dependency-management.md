# Dependency-Management (Renovate)

Detail-Runbook zur automatisierten Dependency-Pflege. Übergeordneter Projekt-README:
[`../replit.md`](../replit.md). CI-Pipeline siehe [`ci-pipeline.md`](ci-pipeline.md).

## Überblick

Dependency-Updates werden automatisch über den [Renovate-Bot](https://docs.renovatebot.com/) (`renovate.json` im Repo-Root) gemanagt. Renovate öffnet pro Woche (Montag früh, Berlin-Zeit) gruppierte PRs für veraltete npm-Pakete: `@radix-ui/*`, `@tanstack/*`, `react`+`react-dom`, `drizzle-orm`+`drizzle-zod`+`drizzle-kit` und Dev-Dependencies werden je zusammengefasst; Major-Updates kommen separat und nie als Auto-Merge. Nur grüne **Patch**-Updates auf **Dev-Dependencies** werden automatisch gemergt — alles andere braucht manuelles Review. Vulnerability-Alerts (`vulnerabilityAlerts` + `osvVulnerabilityAlerts`) werden bevorzugt und sofort (nicht nur im Wochenfenster) als PRs mit `security`-Label aufgemacht. Jeder Renovate-PR muss die komplette CI bestehen (inkl. `npm audit --audit-level=high`), bevor er gemergt werden kann.

## Pausieren

Im GitHub-Repo das Issue „Dependency Dashboard" öffnen und Updates dort abwählen, oder in `renovate.json` `"enabled": false` setzen bzw. einzelne `packageRules` mit `"enabled": false` deaktivieren.

## Ausführung = Self-hosted GitHub Action (Task #787)

Da die Renovate-GitHub-App im Org nicht installiert/freigegeben werden konnte, läuft Renovate als eigener Actions-Workflow `.github/workflows/renovate.yml` (täglich 03:00 UTC + manueller `workflow_dispatch`-Trigger). Die `renovate.json` bleibt unverändert die Single-Source-of-Truth für Gruppierung/Auto-Merge/Vulnerability-Alerts; die Action steuert nur das *Wann-läuft-der-Scan*, die *Wann-öffnet-ein-PR*-Logik kommt weiter aus `renovate.json`.

**Benötigtes Repo-Secret `RENOVATE_TOKEN`:** GitHub-PAT mit `repo`+`workflow` (Classic) bzw. Fine-grained-PAT mit Contents/Pull requests/Issues/Workflows = RW auf `SeniorEng/Dashboard`. Es MUSS ein PAT sein, NICHT der automatische `GITHUB_TOKEN` — von `GITHUB_TOKEN` erstellte PRs lösen keine CI-Runs aus (GitHub-Loop-Schutz), sodass die Required-Checks nie liefen und Auto-Merge dauerhaft blockiert bliebe. Fehlt das Secret, überspringt sich der Job sauber (Skip-Step), statt hart zu failen.
