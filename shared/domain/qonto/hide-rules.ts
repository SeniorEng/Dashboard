/**
 * Task #1599 — Auto-Ausblenden-Regeln für Qonto-Zahlungseingänge.
 *
 * Pure Matching-Logik: entscheidet, ob eine Transaktion von mindestens einer
 * aktiven Regel getroffen wird. Wird sowohl beim Sync/Backfill als auch bei der
 * Regel-Anlage (rückwirkend auf offene Transaktionen) genutzt — EINE Stelle,
 * damit Anzeige- und Buchungspfad nie auseinanderlaufen.
 */

import { normalizeIban } from "./monitored-ibans";

export interface HideRuleMatchInput {
  ruleType: string;
  value: string;
}

export interface HideRuleTransaction {
  counterpartyName: string | null;
  sourceIban: string | null;
}

/** Trifft eine einzelne Regel auf die Transaktion zu? */
export function matchesHideRule(tx: HideRuleTransaction, rule: HideRuleMatchInput): boolean {
  if (rule.ruleType === "counterparty") {
    const needle = rule.value.trim().toLowerCase();
    if (!needle) return false;
    const hay = (tx.counterpartyName ?? "").toLowerCase();
    return hay.includes(needle);
  }
  if (rule.ruleType === "iban") {
    if (!tx.sourceIban) return false;
    return normalizeIban(tx.sourceIban) === normalizeIban(rule.value);
  }
  return false;
}

/** Trifft mindestens eine der Regeln zu? */
export function matchesAnyHideRule(tx: HideRuleTransaction, rules: HideRuleMatchInput[]): boolean {
  return rules.some((rule) => matchesHideRule(tx, rule));
}

/**
 * Normalisiert einen Regel-Wert vor dem Persistieren: IBAN-Regeln werden
 * kanonisiert (Whitespace weg, Großschreibung), Counterparty-Regeln nur
 * getrimmt. So ist der Vergleich später deterministisch.
 */
export function normalizeHideRuleValue(ruleType: string, value: string): string {
  if (ruleType === "iban") return normalizeIban(value);
  return value.trim();
}
