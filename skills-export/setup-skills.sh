#!/bin/bash
# ============================================================
# Agent Skills Installer
# Kopiert die AI-Audit-Skills in ein neues Replit-Projekt.
#
# Verwendung:
#   1. Kopiere den gesamten "skills-export" Ordner in dein neues Projekt
#   2. Führe aus: bash skills-export/setup-skills.sh
#   3. Fertig! Die Skills sind unter .agents/skills/ installiert.
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_DIR=".agents/skills"

echo "🔧 Installing AI Agent Skills..."
echo ""

mkdir -p "$TARGET_DIR"

SKILLS=(
  "team-orchestration"
  "code-quality-supervisor"
  "database-audit"
  "security-audit"
  "devops-release"
  "qa-testing"
  "performance-audit"
  "ui-ux-audit"
  "business-logic-audit"
)

for skill in "${SKILLS[@]}"; do
  if [ -d "$SCRIPT_DIR/$skill" ]; then
    echo "  Installing: $skill"
    cp -r "$SCRIPT_DIR/$skill" "$TARGET_DIR/"
  else
    echo "  Skipping (not found): $skill"
  fi
done

echo ""
echo "Done! ${#SKILLS[@]} skills installed to $TARGET_DIR/"
echo ""
echo "IMPORTANT: Some skills contain placeholder references like [YOUR_APP_NAME]."
echo "Search and replace these in the SKILL.md files to match your new project."
echo ""
echo "  grep -r '\\[YOUR_APP' $TARGET_DIR/"
echo ""
