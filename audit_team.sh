#!/bin/bash
# ==============================================================================
# AI DEVELOPMENT TEAM — AUTOMATED PRE-AUDIT SCRIPT
# ==============================================================================
# Runs automated checks before triggering the AI team audit.
# Usage: ./audit_team.sh
# ==============================================================================

set -e

echo "=============================================="
echo "  AI DEVELOPMENT TEAM — PRE-AUDIT"
echo "=============================================="
echo ""

ERRORS=0
WARNINGS=0

# --- 1. TYPESCRIPT TYPE CHECK ---
echo "--- 1/6: TypeScript Type Check ---"
if npx tsc --noEmit 2>/dev/null; then
  echo "  PASS: Keine TypeScript-Fehler"
else
  echo "  FAIL: TypeScript-Fehler gefunden!"
  ERRORS=$((ERRORS + 1))
fi
echo ""

# --- 2. SECURITY: npm audit ---
echo "--- 2/6: Security (npm audit) ---"
AUDIT_OUTPUT=$(npm audit --production 2>&1 || true)
CRITICAL=$(echo "$AUDIT_OUTPUT" | grep -c "critical" 2>/dev/null || echo "0")
HIGH=$(echo "$AUDIT_OUTPUT" | grep -c "high" 2>/dev/null || echo "0")
if [ "$CRITICAL" -gt 0 ]; then
  echo "  FAIL: $CRITICAL kritische Schwachstelle(n) gefunden!"
  ERRORS=$((ERRORS + 1))
elif [ "$HIGH" -gt 0 ]; then
  echo "  WARN: $HIGH hohe Schwachstelle(n) gefunden"
  WARNINGS=$((WARNINGS + 1))
else
  echo "  PASS: Keine kritischen Schwachstellen"
fi
echo ""

# --- 3. TODO/FIXME SCAN ---
echo "--- 3/6: Offene TODOs/FIXMEs ---"
TODO_COUNT=$(grep -rn "TODO\|FIXME\|HACK\|XXX" server/ client/src/ shared/ --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v "node_modules" | wc -l || echo "0")
if [ "$TODO_COUNT" -gt 0 ]; then
  echo "  WARN: $TODO_COUNT offene TODO/FIXME-Markierungen:"
  grep -rn "TODO\|FIXME\|HACK\|XXX" server/ client/src/ shared/ --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v "node_modules" | head -5
  WARNINGS=$((WARNINGS + 1))
else
  echo "  PASS: Keine offenen TODOs"
fi
echo ""

# --- 4. DEAD IMPORTS CHECK ---
echo "--- 4/6: Unbenutzte Exports (Stichprobe) ---"
DEAD_EXPORTS=$(grep -rn "^export function " shared/utils/ server/services/ 2>/dev/null | while IFS=: read -r file line content; do
  FUNC=$(echo "$content" | sed 's/export function //' | sed 's/(.*//');
  USAGE=$(grep -rn "import.*$FUNC\|$FUNC" server/ client/src/ --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v "$file" | wc -l)
  if [ "$USAGE" -eq 0 ]; then
    echo "  Unused: $FUNC in $file"
  fi
done)
if [ -n "$DEAD_EXPORTS" ]; then
  echo "  WARN: Potenziell unbenutzte Exports gefunden:"
  echo "$DEAD_EXPORTS" | head -5
  WARNINGS=$((WARNINGS + 1))
else
  echo "  PASS: Keine unbenutzten Exports gefunden"
fi
echo ""

# --- 5. CONVENTION CHECK ---
echo "--- 5/6: Konventions-Schnellcheck ---"
ISO_VIOLATIONS=$(grep -rn "toISOString()" server/ client/src/ shared/ --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v "node_modules\|\.d\.ts" | wc -l || echo "0")
if [ "$ISO_VIOLATIONS" -gt 0 ]; then
  echo "  WARN: $ISO_VIOLATIONS Verwendung(en) von toISOString() (Projektkonvention: verboten)"
  WARNINGS=$((WARNINGS + 1))
else
  echo "  PASS: Keine toISOString()-Verletzungen"
fi
echo ""

# --- 6. DEPENDENCY COUNT ---
echo "--- 6/6: Abhängigkeiten ---"
DEP_COUNT=$(cat package.json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('dependencies',{})))" 2>/dev/null || echo "?")
DEV_COUNT=$(cat package.json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('devDependencies',{})))" 2>/dev/null || echo "?")
echo "  INFO: $DEP_COUNT Produktions-Abhängigkeiten, $DEV_COUNT Dev-Abhängigkeiten"
if [ "$DEP_COUNT" != "?" ] && [ "$DEP_COUNT" -gt 80 ]; then
  echo "  WARN: Viele Abhängigkeiten — Aufräumen empfohlen"
  WARNINGS=$((WARNINGS + 1))
else
  echo "  PASS: Abhängigkeiten im Rahmen"
fi
echo ""

# --- SUMMARY ---
echo "=============================================="
echo "  ERGEBNIS"
echo "=============================================="
if [ "$ERRORS" -gt 0 ]; then
  echo "  FEHLER: $ERRORS | WARNUNGEN: $WARNINGS"
  echo "  STATUS: NICHT BEREIT — Fehler beheben!"
  exit 1
elif [ "$WARNINGS" -gt 0 ]; then
  echo "  FEHLER: 0 | WARNUNGEN: $WARNINGS"
  echo "  STATUS: BEREIT MIT WARNUNGEN"
else
  echo "  FEHLER: 0 | WARNUNGEN: 0"
  echo "  STATUS: BEREIT"
fi
echo ""
echo "  Nächster Schritt: AI-Team-Audit starten"
echo "  (Im Chat: 'Starte einen vollständigen Team-Audit')"
echo "=============================================="
