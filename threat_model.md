# Threat Model

## Project Overview

CareConnect is a mobile-first React/Vite + Express application for elderly care operations. It stores sensitive customer, employee, prospect, billing, scheduling, and document-signing data in PostgreSQL, generates PDFs, stores uploaded/generated files in private object storage, and exposes webhook and tokenized public-signing endpoints.

Production entry points are `server/index.ts` and the route tree rooted at `server/routes.ts` and `server/routes/index.ts`. The primary users are admins, superadmins, and employees. Per project assumptions, only production-reachable code matters; dev/test-only routes and sandbox code should be ignored unless production reachability is demonstrated.

## Assets

- **User accounts and sessions** — employee/admin credentials, password reset tokens, session cookies, CSRF tokens. Compromise allows impersonation and broad access to care records.
- **Customer data** — names, addresses, phone numbers, care levels, contracts, medical context, schedules, notes, and generated documents. This is high-sensitivity personal and business data.
- **Prospect / lead data** — inbound lead contact details, addresses, notes, qualification state, offer data, and raw parsed email content. Exposure affects privacy and sales workflow integrity.
- **Billing and compliance records** — service records, invoices, signatures, audit data, and PDF artifacts. These affect legal and financial correctness.
- **Stored files** — uploaded employee/customer documents, generated PDFs, logos, and signature-bearing documents in object storage. Unauthorized access exposes sensitive documents.
- **Application secrets** — database credentials, encryption key, SMTP/E-POST/Twilio/WhatsApp/Qonto secrets. Leakage enables account takeover or third-party abuse.

## Trust Boundaries

- **Browser to API** — all client input is untrusted. The server must authenticate, authorize, validate, and rate-limit requests.
- **Public token holder to signing endpoint** — `server/routes/public-signing.ts` intentionally allows unauthenticated access based on possession of a signing token. Token secrecy and one-time semantics are the security boundary.
- **Server to PostgreSQL** — API handlers and storage modules have full database reach. Broken authorization or injection at the route/service layer can expose all records.
- **Server to object storage** — files are stored outside the DB and served through `GET /objects/*`. DB-backed authorization must match object-path authorization.
- **Server to external services** — geocoding, Twilio webhooks, OpenPLZ, email, and messaging providers receive selected data. Outbound requests must avoid SSRF-style abuse and inbound callbacks must be authenticated.
- **Authenticated employee to admin/prospect/customer data** — the app separates superadmin, admin, employee, and role-scoped workflows. Server-side checks must enforce those boundaries consistently.
- **Internal/dev/test to production** — routes such as `/api/test/*`, coverage artifacts, scripts, and local tooling are out of scope unless mounted in production.

## Scan Anchors

- **Production entry points:** `server/index.ts`, `server/routes.ts`, `server/routes/index.ts`
- **Auth and role checks:** `server/middleware/auth.ts`, `server/routes/auth.ts`, `server/lib/params.ts`
- **Highest-risk code areas:** `server/routes/public-signing.ts`, `server/replit_integrations/object_storage/*`, `server/routes/prospects.ts`, `server/routes/admin/*`, `server/routes/admin/employee-users.ts`, `server/routes/customers/*.ts`, `server/routes/customers/contacts.ts`, `server/storage/documents.ts`
- **Public surfaces:** `/api/public/sign/:token`, `/api/public/logo/:type`, `/api/public/branding`, `/api/health`, Twilio/webhook endpoints
- **Authenticated employee surfaces:** `/api/customers/*`, `/api/appointments/*`, `/api/search`, `/api/prospects/*`, `/objects/*`
- **Admin-only surfaces:** `/api/admin/*`, billing, audit, document-delivery, Qonto, WhatsApp config
- **Usually dev/test-only:** `/api/test/*`, `coverage/`, `e2e/`, `tests/`, scripts, startup-only migration helpers unless they affect production runtime behavior

## Threat Categories

### Spoofing

The application relies on session cookies in `server/middleware/auth.ts`, password reset flows in `server/routes/auth.ts`, and signed webhook requests such as `server/routes/webhook-twilio.ts`. Protected API endpoints MUST require a valid session, password-reset tokens MUST be unguessable and expire, and webhook requests MUST be signature-verified before any state change.

### Tampering

Employees and admins can mutate appointments, customer data, documents, budgets, and prospect records. The server MUST validate request bodies with schemas and MUST enforce server-side authorization for every mutation, especially where route files accept record IDs in the path. Public-signing flows MUST preserve one-time token semantics and document integrity when applying signatures.

### Information Disclosure

The system contains sensitive customer, employee, and lead data, plus signed PDFs and uploaded compliance documents. API responses and object downloads MUST be scoped to the current user’s role and assignments. Public endpoints MUST reveal only intentionally public data. Logs and error responses MUST not leak secrets, raw credentials, or unnecessary PII.

### Denial of Service

The app performs PDF generation, document rendering, geocoding, search, and external API calls. Public or low-friction endpoints MUST be rate-limited or otherwise bounded, especially public signing and auth flows. Expensive operations triggered by authenticated users should still validate input size and avoid unbounded fan-out.

### Elevation of Privilege

The biggest project-specific risk is broken access control: employee users reaching admin-only or role-specific data, IDOR-style access to customers/prospects/documents, object-path access that bypasses record-level permissions, or lower-tier admins mutating superadmin accounts. Every route that accepts a customer, prospect, document, invoice, or employee ID MUST enforce the intended role/ownership check on the server, independent of frontend routing or navigation controls.

Recent high-value anchors for repeated scans are:
- `server/routes/prospects.ts` for role-scoping of employee-facing lead operations
- `server/routes/customers/documents.ts` and `server/routes/customers/contacts.ts` for record binding checks on secondary IDs
- `server/routes/admin/employee-users.ts` for admin-versus-superadmin hierarchy enforcement
- `server/routes/public-signing.ts` and `server/services/document-pdf.ts` for server-side HTML/PDF rendering of token-holder input
