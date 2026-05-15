# Chunk 12a — Settings Backend & External Integrations

**Tiefenstufe:** Pattern-Scan
**Commit:** `3e0d3fb`
**Risiko:** MITTEL (hochgesetzt wegen Secret-Storage)
**LOC / Files:** 3 763 / 19

## Befunde

- ✅ AES-256-GCM-Encryption ist getestet (`tests/architecture/sensitive-
  columns.test.ts`).
- ⚠️ **HOCH:** Twilio-WhatsApp-Webhook-Sig-Check vor allen Mutationen
  (Stop-Kriterium) — laut Plan in `webhook.ts`; ein Folge-Audit muss
  verifizieren, dass jeder POST-Pfad in webhook-Endpoints den Twilio-Sig-
  Check passiert hat, BEVOR State geändert wird.
- ⚠️ **MITTEL:** Geocoding-Outbound — Allow-Listen für Host-Whitelist (SSRF-
  Schutz) nicht pattern-scanbar; vertiefter Audit empfohlen.

## Empfohlener Folge-Task

`[HOCH] Settings-BE Webhook-Sig-Coverage + Geocoding-SSRF-Allowlist`.
