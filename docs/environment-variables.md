# Environment Variables

Vollständige Referenz aller Environment-Variablen von CareConnect. Übergeordneter
Projekt-README: [`../replit.md`](../replit.md) (dort nur Kurz-Verweis hierher).

> Secrets/Env-Vars werden über die Replit-Secrets-/Env-Verwaltung gepflegt, nicht
> durch direktes Editieren von `.replit`. WhatsApp läuft über die Twilio-Credentials
> (Voice-Call-Bridge + WhatsApp Content API); separate Meta-Cloud-API-Token werden
> nicht mehr benötigt.

| Name | Required/Optional | Default | Zweck |
|---|---|---|---|
| `DATABASE_URL` | Required | — | PostgreSQL-Connection-String (Neon serverless). |
| `ENCRYPTION_KEY` | Required | — | 64-char Hex-Key für AES-256-GCM-Verschlüsselung sensibler Spalten (`encryptedText`) und `company_settings`-API-Secrets. Fehlt der Key, werden Secrets unverschlüsselt gespeichert/gelesen (Graceful Fallback, nicht für Prod). |
| `NODE_ENV` | Required | — | `development` / `production` / `test`. Steuert u.a. Puppeteer-Launch-Flags (`--single-process` AUS in Prod) und Logging. |
| `TWILIO_ACCOUNT_SID` | Required | — | Twilio-Account-SID (Voice-Call-Bridge + WhatsApp Content API). |
| `TWILIO_AUTH_TOKEN` | Required | — | Twilio-Auth-Token. Per Kunde via `whatsapp_access_token` in `company_settings` overridebar. |
| `TWILIO_PHONE_NUMBER` | Required | — | Twilio-Absendernummer für Voice-Call-Bridge / Lead-Anrufe. |
| `QONTO_SECRET_KEY` | Required | — | Qonto-Bank-API Secret für Payment-Matching. |
| `QONTO_LOGIN` | Required | — | Qonto-Bank-API Login. |
| `LETTEREXPRESS_API_KEY` | Required | — | LetterExpress API-Key für postalischen Dokumentversand. |
| `APP_URL` | Optional | `""` | Öffentliche Basis-URL für ausgehende Links (WhatsApp-Buttons etc.). Fallback hinter `REPLIT_DEV_DOMAIN`. |
| `REPLIT_DOMAINS` | Optional (Replit-Runtime) | — | Komma-separierte Prod-Domains. Erste Domain wird für E-Mail-Absender und Twilio-Webhook-URLs verwendet. |
| `REPLIT_DEV_DOMAIN` | Optional (Replit-Runtime) | — | Dev-Domain-Hostname als Fallback hinter `REPLIT_DOMAINS` für E-Mails / WhatsApp-Links. |
| `REPL_OWNER` | Optional (Replit-Runtime) | — | Repl-Owner-Slug für Twilio-Call-Bridge-Webhook-URL-Generierung. |
| `REPL_SLUG` | Optional (Replit-Runtime) | — | Repl-Slug für Twilio-Call-Bridge-Webhook-URL-Generierung. |
| `PORT` | Optional | `5000` | HTTP-Listen-Port des Express-Servers. |
| `SUPER_ADMIN_EMAIL` | Optional | — | E-Mail eines Users, der beim Startup automatisch zum Superadmin promoted wird. Fehlt = Promotion übersprungen. |
| `EMAIL_TRANSPORT` | Optional | Auto (stub in Dev/Test, real in Prod) | `real` erzwingt echten SMTP-Versand, `stub` erzwingt In-Memory-Stub. |
| `EMAIL_WEBHOOK_SECRET` | Optional | — | Shared Secret für Inbound-E-Mail-Webhook (`/api/webhook/inbound-email`). Fehlt = Webhook akzeptiert keine Requests. |
| `PUBLIC_OBJECT_SEARCH_PATHS` | Required für Object Storage | — | Komma-separierte Such-Pfade für öffentliche Assets im Object-Storage-Bucket. |
| `PRIVATE_OBJECT_DIR` | Required für Object Storage | — | Pfad für private Uploads (Dokumente, Signaturen, generierte PDFs) im Object-Storage-Bucket. |
| `CHROMIUM_PATH` | Optional | Auto (`which chromium` / `which chromium-browser` / `/usr/bin/chromium*`) | Override für Chromium-Binary-Pfad (Puppeteer). In Deployments empfohlen zu setzen. |
| `PUPPETEER_SINGLE_PROCESS` | Optional | `1` in Dev/Test, `0` in Prod | `1`/`true` erzwingt `--single-process`, `0`/`false` verbietet es. |
| `PUPPETEER_NO_ZYGOTE` | Optional | unset | `1`/`true` erzwingt `--no-zygote`, `0`/`false` verbietet es. |
| `PDF_RENDER_CONCURRENCY` | Optional | `2` | Max. paralleler PDF-Renderings (ein laufender + ein wartender bei Default). |
| `STATS_HEALTH_YELLOW` | Optional | `5` | Schwellwert (Tage) für gelben Health-Status in Statistik-Cockpit. |
| `STATS_HEALTH_RED` | Optional | `20` | Schwellwert (Tage) für roten Health-Status in Statistik-Cockpit. |
| `NEON_POOL_IDLE_TIMEOUT_MS` | Optional | `60000` (60s) | Idle-Timeout des Neon-Connection-Pools (`server/lib/db.ts`). Bewusst niedrig, damit ungenutzte Pool-Sockets zügig schließen und Neon den Compute-Endpoint in Leerlaufphasen suspendieren kann (spart compute-hours; Task #1807). Höher setzen (z.B. `300000`), wenn Last-/E2E-Läufe viele warme Verbindungen halten sollen. Cold-Start-Mitigationen (TLS-Pipelining + 15s connect-Timeout, `keepAlive`) bleiben unabhängig davon aktiv. |
| `NEON_LOCAL_WS_PROXY` | Optional (nur CI/Local) | unset | Host:Port eines Neon-WebSocket-Proxys (z.B. `localhost:4444`). Gesetzt = `server/lib/db.ts` schaltet Secure-WS/TLS-Pipelining ab und routet den WebSocket über den Proxy, um gegen plain Postgres zu testen. NICHT in Produktion setzen (echter Neon-Host braucht Secure-WS). |

> Weitere Feature-/Betriebs-Flags sind in ihren jeweiligen Runbooks dokumentiert:
> `BUDGET_HARD_HOLDS` in [`architecture/budget.md`](architecture/budget.md), die
> Memory-Watchdog-Schwellen (`MEMORY_WATCHDOG_WARN_MB` / `MEMORY_WATCHDOG_INTERVAL_MS`)
> in [`../Replit-Workspace-Overload-Prevention-Plan.md`](../Replit-Workspace-Overload-Prevention-Plan.md).
