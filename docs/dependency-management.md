# Dependency-Management (Renovate)

Detail-Runbook zur automatisierten Dependency-Pflege. Übergeordneter Projekt-README:
[`../replit.md`](../replit.md). CI-Pipeline siehe [`ci-pipeline.md`](ci-pipeline.md).

## Überblick

Dependency-Updates werden automatisch über den [Renovate-Bot](https://docs.renovatebot.com/) (`renovate.json` im Repo-Root) gemanagt. Renovate öffnet pro Woche (Montag früh, Berlin-Zeit) gruppierte PRs für veraltete npm-Pakete: `@radix-ui/*`, `@tanstack/*`, `react`+`react-dom`, `drizzle-orm`+`drizzle-zod`+`drizzle-kit` und Dev-Dependencies werden je zusammengefasst; Major-Updates kommen separat und nie als Auto-Merge. Nur grüne **Patch**-Updates auf **Dev-Dependencies** werden automatisch gemergt — alles andere braucht manuelles Review. Vulnerability-Alerts (`vulnerabilityAlerts` + `osvVulnerabilityAlerts`) werden bevorzugt und sofort (nicht nur im Wochenfenster) als PRs mit `security`-Label aufgemacht. Jeder Renovate-PR muss die komplette CI bestehen (inkl. `npm run audit:ci`, siehe unten), bevor er gemergt werden kann.

## Security-Audit-Gate (`npm run audit:ci` + `.nsprc`-Allowlist)

Das CI-Security-Gate (Job `static-analysis`) läuft über `npm run audit:ci`
(= `better-npm-audit audit --level high`) statt direkt über `npm audit`.
[`better-npm-audit`](https://www.npmjs.com/package/better-npm-audit) respektiert
eine versionierte Allowlist-Datei `.nsprc` im Repo-Root, mit der einzelne,
bewusst akzeptierte Advisories **befristet** ausgenommen werden können. Das Gate
bleibt strikt auf `--level high`: Jede **neue** High-/Critical-Lücke, die nicht
explizit in `.nsprc` steht, bricht die CI weiterhin rot.

**Regeln für Einträge in `.nsprc`:**

- Key = **GHSA-ID** des Advisories (z. B. `GHSA-gv7w-rqvm-qjhr`).
  `better-npm-audit` matcht über die GHSA-ID, nicht über numerische npm-IDs.
- Jeder Eintrag braucht `"active": true`, ein **Ablaufdatum** (`"expiry"`,
  YYYY-MM-DD) und eine `"notes"`-Begründung, **warum** die Lücke vertretbar ist
  (insb.: betrifft nur Dev-/Build-Tooling und ist nicht im Produktiv-Bundle
  `dist/index.cjs` enthalten).
- Das Ablaufdatum erzwingt eine Neubewertung: Läuft die Ausnahme ab, fällt das
  Advisory automatisch wieder ins Gate.

**Aktueller Stand:** `GHSA-gv7w-rqvm-qjhr` (esbuild Dev-Server/Deno-RCE, high) ist
bis 2026-09-15 freigegeben — die Lücke betrifft ausschließlich Dev-/Build-Tooling
(`vite`, `tsx`, `drizzle-kit`, `esbuild`, `@vitest/coverage-v8`) und nicht den
produktiven Server-Build. Ein Major-Upgrade von `vite`/`esbuild` (das die Lücke
schließen würde) ist als **separater Follow-up** geplant, nicht Teil dieses
Audit-Gate-Umbaus.

## Pausieren

Im GitHub-Repo das Issue „Dependency Dashboard" öffnen und Updates dort abwählen, oder in `renovate.json` `"enabled": false` setzen bzw. einzelne `packageRules` mit `"enabled": false` deaktivieren.

## Ausführung = Self-hosted GitHub Action (Task #787)

Da die Renovate-GitHub-App im Org nicht installiert/freigegeben werden konnte, läuft Renovate als eigener Actions-Workflow `.github/workflows/renovate.yml` (täglich 03:00 UTC + manueller `workflow_dispatch`-Trigger). Die `renovate.json` bleibt unverändert die Single-Source-of-Truth für Gruppierung/Auto-Merge/Vulnerability-Alerts; die Action steuert nur das *Wann-läuft-der-Scan*, die *Wann-öffnet-ein-PR*-Logik kommt weiter aus `renovate.json`.

**Benötigtes Repo-Secret `RENOVATE_TOKEN`:** GitHub-PAT mit `repo`+`workflow` (Classic) bzw. Fine-grained-PAT mit Contents/Pull requests/Issues/Workflows = RW auf `SeniorEng/Dashboard`. Es MUSS ein PAT sein, NICHT der automatische `GITHUB_TOKEN` — von `GITHUB_TOKEN` erstellte PRs lösen keine CI-Runs aus (GitHub-Loop-Schutz), sodass die Required-Checks nie liefen und Auto-Merge dauerhaft blockiert bliebe. Fehlt das Secret, überspringt sich der Job sauber (Skip-Step), statt hart zu failen.
