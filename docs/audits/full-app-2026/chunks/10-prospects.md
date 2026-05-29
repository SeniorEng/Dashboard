# Chunk 10 — Lead/Prospect Pipeline

**Tiefenstufe:** Deep (Refresh #822 gap-fill)
**Commit:** `178b2574`
**Risiko:** NIEDRIG (herabgestuft von MITTEL nach Code-Walk)

## Scope & Methodik

Vollständiger Code-Walk der Pipeline: Inbound-Lead-Kanäle (Twilio-Voice-Webhook,
Inbound-E-Mail-Webhook), Parsing, Persistenz, Rollen-Scoping der employee-facing
Routes sowie Frontend-Darstellung der Lead-Notizen.

Geprüfte Dateien: `server/routes/webhook-twilio.ts`, `server/routes/prospects.ts`,
`server/routes/admin/prospects.ts`, `server/routes/admin.ts`,
`server/middleware/twilio-auth.ts`, `server/lib/twilio-callback-token.ts`,
`server/services/email-parser.ts`, `server/services/call-scheduler.ts`,
`server/services/twilio-call-bridge.ts`, `server/services/lead-auto-reply.ts`,
`server/storage/prospects.ts`, `server/middleware/auth.ts`,
`client/src/features/prospects/components/prospect-detail-sheet.tsx`.

Die drei offenen Punkte aus dem #822-Pattern-Scan wurden gezielt verifiziert
(siehe „Auflösung Vorbefunde").

## Befunde nach Severity

### KRITISCH
- Keine.

### HOCH
- Keine. (Der im Pattern-Scan vermutete HOCH-Befund „fehlender Role-Scope-Test"
  ist **kein** Sicherheitsdefekt — siehe Auflösung unten.)

### MITTEL
- Keine.

### NIEDRIG
- **Kein Per-Mitarbeiter-Scoping auf Leads (verifiziert, Design-Entscheidung).**
  `server/routes/prospects.ts:14,18` → `server/storage/prospects.ts:24-55`:
  `GET /api/prospects/search`, `PATCH /:id` (`:100`) und
  `GET /:id/appointment-data` (`:81`) sind ausschließlich über
  `requireRoles("erstberatung")` geschützt. `prospectStorage.getAll()` filtert
  **nicht** nach zugewiesenem Mitarbeiter — jede Person mit der Rolle
  `erstberatung` (inkl. Teamleitung) sieht **alle** Leads inkl. PII (Name,
  Telefon, E-Mail, Adresse, Pflegegrad). Im Gegensatz zur Customer-Domäne, die
  über `assignedCustomerIds` scopt, ist das hier bewusst flach. Kein IDOR im
  engeren Sinn (Rolle = Vollzugriff), aber Least-Privilege wird nicht erzwungen.
  **Folge-Task (optional):** Falls feinere Lead-Zuteilung gewünscht ist, Scope
  in `getAll()` ergänzen.

- **Drift-Risiko bei E-Mail-Parser-Robustheit (Hypothese).**
  `server/services/email-parser.ts` ist reines Regex/String-Parsing ohne
  `eval`/Template-Injection — sicher. Es existiert jedoch **kein** dedizierter
  Unit-Test für die Parser-Heuristik; Regressionen bei Provider-Formatänderungen
  würden still durchschlagen (nur funktional, kein Security-Impact).

## Auflösung der #822-Vorbefunde

- **(war HOCH) Role-Scoping employee-facing Lead-Ops — AUFGELÖST/verifiziert.**
  Employee-Routes: `requireRoles("erstberatung")` (`prospects.ts:14,66,81,100`).
  Admin-Routes: `requireAdmin` + Permission `"prospects"`
  (`server/routes/admin.ts:30,68,150` via `ROUTE_PERMISSION_MAP`). Test-Abdeckung
  vorhanden (s.u.). Kein offener Defekt — nur die NIEDRIG-Anmerkung oben.

- **(war MITTEL) Stored-XSS in Lead-Notes-Anzeige — WIDERLEGT.**
  `prospect-detail-sheet.tsx:515` rendert `note.noteText` als JSX-Text-Knoten
  (`<div className="text-foreground">{note.noteText}</div>`) — React escaped
  automatisch. **Kein** `dangerouslySetInnerHTML` im gesamten Feature-Ordner.
  `prospect.rawEmailContent` wird **nicht** gerendert, sondern gated nur einen
  „Neu parsen"-Button (`:232`). Auch die serverseitig erzeugte Auto-Reply-Mail
  escaped alle dynamischen Felder (`lead-auto-reply.ts:15-21,38-48`). Kein
  Injection-Pfad.

- **(war MITTEL) Twilio-Webhook console-Logs — kosmetisch, kein Security-Impact.**
  Die Signaturprüfung ist hart: `verifyTwilioSignature` ist via `router.use`
  **vor** allen Routen montiert (`webhook-twilio.ts:11`), lehnt unsignierte/
  manipulierte Requests mit 403 ab (`twilio-auth.ts`). Der HMAC-Callback-Token
  (`twilio-callback-token.ts`) ist timing-safe und gegen Tampering/Expiry/Replay
  geschützt.

## Test-Coverage

**Vorhanden / stark:**
- `tests/twilio-webhook-security.test.ts` — Sig-Middleware (unsigned/tampered/
  signed) + Callback-Token (Sign/Verify/Tamper/Expiry/Replay/Malformed).
- `tests/policies/prospects-update-strict.test.ts` — strikte Update-Policy.
- `tests/erstberatung.test.ts`, `tests/team-lead-erstberatung-zugriff.test.ts`,
  `tests/team-lead-erstberatung-anlegen.test.ts`,
  `tests/customer-erstberatung-prospect-link.test.ts`,
  `tests/customer-erstberatung-orphan-prevention.test.ts` — Rollen-/Verknüpfungs-
  Logik.

**Lücken (NIEDRIG):**
- Kein Unit-Test für `email-parser.ts` (Parser-Heuristik / Provider-Formate).
- Kein expliziter Negativ-Test, der bestätigt, dass Nicht-`erstberatung`-Rollen
  `GET /api/prospects/search` mit 403 erhalten (implizit über requireRoles, aber
  ungetestet).
