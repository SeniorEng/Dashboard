/**
 * Escapes the five XML predefined entities so that arbitrary user input can be
 * safely embedded into TwiML / XML payloads without enabling XML injection.
 *
 * Zentralisiert (Task #450), damit nicht zwei lokale Kopien (Call-Bridge,
 * Webhook-Route) auseinanderdriften.
 */
export function escapeXml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
