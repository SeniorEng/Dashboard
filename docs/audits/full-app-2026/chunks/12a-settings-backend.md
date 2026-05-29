# Chunk 12a — Settings Backend & External Integrations

**Tiefenstufe:** Deep (Refresh #822 gap-fill)
**Commit:** `178b2574`
**Risiko:** NIEDRIG (herabgestuft von MITTEL nach Code-Walk)

## Scope & Methodik

Code-Walk der Settings-Persistenz inkl. Secret-at-Rest-Verschlüsselung,
der ausgehenden Integrationen (Twilio/WhatsApp, Nominatim-Geocoding,
LetterXpress, Qonto, SMTP) sowie der Startup-Importe.

Geprüfte Dateien: `server/lib/crypto.ts`, `server/lib/encrypted-row.ts`,
`shared/schema/encrypted-columns.ts`, `shared/schema/company.ts`,
`server/storage.ts` (Company-Settings-CRUD), `server/routes/company.ts`,
`server/routes/settings.ts`, `server/routes/admin/whatsapp.ts`,
`server/routes/whatsapp.ts`, `server/services/whatsapp-service.ts`,
`server/services/geocoding.ts`, `server/routes/index.ts` (`/address-search`),
`server/startup/import-pflegekassen.ts`.

Die drei offenen Punkte aus dem #822-Pattern-Scan wurden gezielt verifiziert
(siehe „Auflösung Vorbefunde").

## Befunde nach Severity

### KRITISCH
- Keine.

### HOCH
- Keine.

### MITTEL
- Keine.

### NIEDRIG
- **Manuelle Masking-Liste vs. Encryption-Registry — Drift-Risiko (Hypothese).**
  `server/routes/company.ts:14` definiert `SENSITIVE_FIELDS` als **handgepflegte**
  Liste, die das Maskieren der Secrets für Nicht-Admins in `GET /` steuert
  (`:21-30`). Diese Liste ist **unabhängig** von der Encryption-Registry
  (`shared/schema/encrypted-columns.ts` → `encryptedText`). Aktueller Stand:
  beide Mengen sind konsistent (alle 5 verschlüsselten Spalten — `smtp_pass`,
  `letterxpress_api_key`, `qonto_secret_key`, `whatsapp_access_token`,
  `twilio_auth_token` — sind in `SENSITIVE_FIELDS` enthalten; zusätzlich
  `twilioAccountSid`, kein echtes Secret). **Risiko:** Wird künftig eine neue
  `encryptedText`-Spalte ergänzt, aber `SENSITIVE_FIELDS` vergessen, lieferte
  `GET /api/company-settings` das (entschlüsselte) Secret an **jeden
  authentifizierten Nicht-Admin** aus. Kein Test erzwingt Parität.
  **Folge-Task:** Parity-Test (Registry ⊆ SENSITIVE_FIELDS) bzw. Masking direkt
  aus `getSensitiveDbColumns()` ableiten.

## Auflösung der #822-Vorbefunde

- **(war ✅) AES-256-GCM-Encryption — verifiziert korrekt.**
  `server/lib/crypto.ts`: 12-Byte-Random-IV (`:4,28`), 16-Byte-Auth-Tag
  (`:5,31`), Layout `iv|tag|ciphertext` base64 mit `enc:`-Prefix (`:32-33`).
  `encryptSecret` ist idempotenzsicher (Prefix-Guard `:26`); `decryptSecret`
  verifiziert den Auth-Tag (`:49-50`) → Manipulation schlägt fehl. Schlüssel:
  64-Hex/32-Byte erzwungen (`:8,18-19`). Roundtrip & Cross-Key-Replay durch
  `tests/twilio-webhook-security.test.ts` (Callback-Token nutzt denselben Key)
  belegt. Anwendung automatisch via `encryptRow`/`decryptRow`
  (`server/lib/encrypted-row.ts`) in `storage.ts:278,289,293,305`. Die
  Sensitiv-Erkennung ist **registry-basiert** (`encrypted-columns.ts:5-12`,
  nicht namens-pattern-basiert) → robust; zusätzlich erzwingt
  `tests/architecture/sensitive-columns.test.ts`, dass jede Spalte mit Namen
  `/secret|token|password|key/i` `encryptedText` nutzt oder allowlisted ist.

- **(war HOCH) Twilio-WhatsApp-Webhook-Sig-Check vor Mutationen — N/A.**
  Es existiert **kein** Inbound-WhatsApp-Webhook. `whatsapp-service.ts` ist rein
  **ausgehend** (`client.messages.create`, `:97-98`); `routes/whatsapp.ts` und
  `routes/admin/whatsapp.ts` enthalten nur Konfig-/Test-/Log-Endpunkte (alle
  hinter `requireAuth`/`requireAdmin` + Permission `"whatsapp"`,
  `admin.ts:86,141`). Der einzige Inbound-Twilio-Pfad (Voice) ist in Chunk 10
  abgedeckt und durch `verifyTwilioSignature` hart geschützt. Der test-Endpoint
  `POST /admin/whatsapp/test` validiert Input via Zod (`admin/whatsapp.ts:64-69`)
  und nutzt nur konfigurierte Content-SIDs.

- **(war MITTEL) Geocoding-Outbound SSRF / Host-Allowlist — widerlegt.**
  `server/services/geocoding.ts:10` nutzt eine **feste** Host-Konstante
  (`https://nominatim.openstreetmap.org/search`). Benutzereingaben fließen
  ausschließlich über `URLSearchParams` in den Query-String (URL-encodiert,
  `:57-65`) — keine Host-/Pfad-Kontrolle, kein SSRF. Gleiches für
  `GET /api/address-search` (`routes/index.ts:253-268`): fester Host, Eingabe nur
  in `q`/`viewbox`-Params. `rateLimitedFetch` setzt zusätzlich Timeout
  (`AbortSignal.timeout(5000)`) und einen festen User-Agent.

## Weitere verifizierte Punkte

- **Startup-Import `import-pflegekassen.ts` — kein Formula-/SQL-Injection.**
  Liest ausschließlich **server-lokale** EDIFACT-Dateien aus `attached_assets`
  (`:23-26`), keine Nutzer-Uploads. DB-Writes laufen über parametrisierte
  Drizzle-`sql`-Templates bzw. `db.insert(...).values(...)` (`:163-197`) → keine
  Injection-Fläche.
- **`POST /api/company-settings` & `/api/settings`** sind `requireAdmin`-gated
  (`company.ts:34`, `settings.ts:16`) und validieren via Zod
  (`updateCompanySettingsSchema` / `updateSystemSettingsSchema`).
- **WhatsApp-Recipient-Normalisierung** erzwingt DACH/E.164
  (`whatsapp-service.ts:35-42`), verhindert Versand an unvalidierte Nummern.

## Test-Coverage

**Vorhanden / stark:**
- `tests/architecture/sensitive-columns.test.ts` — erzwingt `encryptedText` für
  alle Secret-Spalten (verhindert Klartext-Drift im Schema).
- `tests/company-settings.test.ts` — CRUD-Roundtrip Firmendaten/Systemeinstell.
- `tests/whatsapp-twilio-service.test.ts` — WhatsApp-Service (Payload-Bau,
  Normalisierung).
- `tests/email-service.test.ts`, `tests/letterxpress-service.test.ts` — weitere
  Integrationen.
- `tests/twilio-webhook-security.test.ts` — Crypto-Key-Verwendung indirekt.

**Lücken (NIEDRIG):**
- Kein Parity-Test `getSensitiveDbColumns()` ⊆ `company.ts:SENSITIVE_FIELDS`
  (siehe NIEDRIG-Befund) — Masking-Drift bliebe unentdeckt.
- Kein dedizierter Test, der bestätigt, dass `GET /api/company-settings` Secrets
  für Nicht-Admins tatsächlich maskiert (Masking-Logik `company.ts:21-30`).
- Kein Test für `geocoding.ts`/`address-search` (fester Host ist code-seitig
  belegt, aber nicht regressionsgesichert).
