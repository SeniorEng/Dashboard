# AI Agent Skills — Exportpaket

Dieses Paket enthält 9 spezialisierte Audit-Skills für den Replit AI Agent.
Sie bilden ein virtuelles Entwicklungsteam, das Code-Qualität, Sicherheit,
Performance und UX automatisch prüft.

## Skills im Überblick

| # | Skill | Aufgabe |
|---|-------|---------|
| 1 | **team-orchestration** | Master-Koordination: Wann läuft welcher Agent? |
| 2 | **code-quality-supervisor** | DRY, Konventionen, tote Code-Erkennung |
| 3 | **database-audit** | Schema, Queries, Indexierung, DSGVO |
| 4 | **security-audit** | OWASP, Auth, CSRF, Secrets |
| 5 | **performance-audit** | Queries, Rendering, Bundle-Size, Mobile |
| 6 | **ui-ux-audit** | Touch-Targets, Feedback, Mobile, Barrierefreiheit |
| 7 | **qa-testing** | Happy Path, Edge Cases, Regression |
| 8 | **business-logic-audit** | Workflows, Domain-Regeln, Compliance |
| 9 | **devops-release** | Env-Vars, Dependencies, Build, Deployment |

## Installation in einem neuen Replit-Projekt

### Option 1: Setup-Script (empfohlen)

1. Kopiere den gesamten `skills-export/` Ordner in dein neues Projekt
2. Öffne die Shell und führe aus:
   ```bash
   bash skills-export/setup-skills.sh
   ```
3. Die Skills werden nach `.agents/skills/` kopiert und sind sofort aktiv

### Option 2: Manuell

1. Erstelle den Ordner `.agents/skills/` in deinem Projekt
2. Kopiere jeden Skill-Ordner einzeln hinein:
   ```
   .agents/skills/
   ├── team-orchestration/
   │   └── SKILL.md
   ├── code-quality-supervisor/
   │   ├── SKILL.md
   │   └── reference/orchestration.md
   ├── database-audit/
   │   ├── SKILL.md
   │   └── reference/audit-queries.sql
   ├── business-logic-audit/
   │   ├── SKILL.md
   │   └── reference/workflows.md
   ├── security-audit/
   │   └── SKILL.md
   ├── performance-audit/
   │   └── SKILL.md
   ├── ui-ux-audit/
   │   └── SKILL.md
   ├── qa-testing/
   │   └── SKILL.md
   └── devops-release/
       └── SKILL.md
   ```

## Anpassung an dein Projekt

### Generische Skills (sofort einsatzbereit)
- code-quality-supervisor
- database-audit (+ audit-queries.sql)
- security-audit
- devops-release
- qa-testing

### Skills mit projektspezifischen Beispielen (anpassen!)
- **business-logic-audit**: Die `reference/workflows.md` enthält Beispiel-Workflows.
  Ersetze sie durch deine eigenen Geschäftsprozesse.
- **ui-ux-audit**: Referenziert "Caregivers" als Zielgruppe.
  Passe die Beschreibung der Zielgruppe an.
- **performance-audit**: Referenziert mobile Pflegekräfte.
  Passe die Nutzerszenarien an.
- **team-orchestration**: Enthält "GoBD" und Pflegeterminologie.
  Passe die Fachbegriffe an.

### Was du anpassen solltest:
1. `reference/workflows.md` → Deine eigenen Business-Workflows dokumentieren
2. `reference/audit-queries.sql` → SQL-Queries an dein Schema anpassen
3. Zielgruppen-Beschreibungen in ui-ux-audit und performance-audit

## Aufräumen nach Installation

Nach erfolgreicher Installation kannst du den `skills-export/` Ordner löschen:
```bash
rm -rf skills-export/
```
