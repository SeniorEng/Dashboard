---
name: /send route needs SMTP config even in stub mode
description: POST /api/billing/:id/send fails without company_settings SMTP fields even under the test outbox stub.
---

# Email send tests need dummy SMTP config

`sendEmail` (server/services/email-service.ts) calls `ensureSmtpConfigured(settings)`
*before* the stub weiche. So even under `NODE_ENV=test` (which routes mail to the
in-memory `testOutbox` instead of a real connection), a test that hits
`POST /api/billing/:id/send` returns 500 `SMTP-Konfiguration unvollständig` unless
`company_settings` has smtpHost/smtpPort/smtpUser/smtpPass set.

**Fix in test setup:** `PATCH /api/company-settings` with dummy
smtpHost/smtpPort/smtpUser/smtpPass (+ optional smtpFromEmail/smtpFromName). No
connection is made under the stub; the mail lands in the outbox readable via
`getTestOutbox()` (test-utils).

**Why:** validation is intentionally identical in stub and real mode so the admin
SMTP-config error surfaces in dev/test too.
