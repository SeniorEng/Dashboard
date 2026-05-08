# Task #393 — Cache-Invalidierung Findings (Paket D1)

Audit der `queryClient.invalidateQueries(...)`-Direktaufrufer im Frontend. Pro Aufruf entschieden: **migriert** zu `invalidateRelated()` aus `client/src/lib/query-invalidation.ts` oder als **legitimer Einzelfall** mit `// invalidate-direct-allowed: <reason>` + `// eslint-disable-next-line no-restricted-syntax` markiert.

Erzwingung der Konvention:
- ESLint-Regel `no-restricted-syntax` in `eslint.config.js` (npm-Skript: `npm run lint`)
- Vitest-Statik-Check in `tests/query-invalidation-discipline.test.ts` (Sekundär-Guard)
- Erlaubter Aufrufer: ausschließlich `client/src/lib/query-invalidation.ts`

## Migrierte Aufrufer

| Datei | Mutation/Stelle | Domäne |
|---|---|---|
| `client/src/pages/profile.tsx` | Profil-Update (`["profile"]`, `["user"]`) | `profile` |
| `client/src/pages/profile.tsx` | Notfallkontakt (`["profile"]`) | `profile` |
| `client/src/pages/profile.tsx` | Haustier-Toggle (`["profile"]`, `["user"]`) | `profile` |
| `client/src/pages/profile.tsx` | WhatsApp-Einstellungen (`["whatsapp-preferences"]`) | `profile` |
| `client/src/pages/profile.tsx` | WhatsApp-Nummer (`["whatsapp-preferences"]`) | `profile` |
| `client/src/pages/profile.tsx` | Nachweis-Upload (`["profile-proofs"]`) | `profile` |
| `client/src/pages/profile.tsx` | Dokument-Upload (`["profile-documents"]`) | `profile` |
| `client/src/pages/admin/whatsapp.tsx` | Regeln speichern (`["whatsapp", "rules"]`) | `whatsapp` |
| `client/src/pages/admin/time-entries.tsx` | `invalidateAll` (Zeiterfassung + Monatsabschluss) | `admin-time-entries` |
| `client/src/pages/admin/time-entries.tsx` | Urlaubskontingent (`["admin-vacation-summary"]`) | `admin-time-entries` |
| `client/src/pages/admin/customer-detail.tsx` | Hard-Delete (`["customers"]`, `["admin","customers"]`) | `customers` |
| `client/src/pages/admin/users.tsx` | Übergabe (`["admin"]`, `["customers"]`, `["appointments"]`) | `admin-users`, `customers`, `appointments` |
| `client/src/pages/admin/users.tsx` | Benutzer erstellen (`["admin","users"]`) | `admin-users` |
| `client/src/pages/admin/users.tsx` | Benutzer aktualisieren (`["admin","users"]`, `["admin","vacation-summaries"]`) | `admin-users` |
| `client/src/pages/admin/users.tsx` | (De)Aktivieren (`["admin","users"]`) | `admin-users` |
| `client/src/pages/admin/users.tsx` | Löschen (`["admin","users"]`) | `admin-users` |
| `client/src/pages/admin/users.tsx` | Anonymisieren (`["admin","users"]`) | `admin-users` |
| `client/src/pages/admin/billing.tsx` | Rechnung erstellen (`["billing-invoices"]`) | `billing` |
| `client/src/pages/admin/billing.tsx` | Statuswechsel (`["billing-invoices"]`, `["billing-invoice-detail"]`) | `billing` |
| `client/src/pages/admin/billing.tsx` | Versand (`["billing-invoices"]`, `["billing-delivery-history"]`) | `billing` |
| `client/src/pages/admin/billing.tsx` | Stapelversand (`["billing-invoices"]`, `["billing-delivery-history"]`) | `billing` |
| `client/src/pages/admin/document-types.tsx` | Erstellen (`["admin","document-types"]`) | `document-types` |
| `client/src/pages/admin/document-types.tsx` | Aktualisieren (+ trigger key) | `document-types` |
| `client/src/pages/admin/document-templates.tsx` | Erstellen (`["admin","document-templates"]`) | `document-templates` |
| `client/src/pages/admin/document-templates.tsx` | Aktualisieren (`["admin","document-templates"]`) | `document-templates` |
| `client/src/pages/admin/services.tsx` | Erstellen (`["/api/services/all"]`) | `services` |
| `client/src/pages/admin/services.tsx` | Aktualisieren (`["/api/services/all"]`) | `services` |
| `client/src/pages/admin/services.tsx` | Bulk-Preise (`["/api/services/all"]`, `["/api/services"]`) | `services` |
| `client/src/pages/admin/qonto.tsx` | Sync (`["qonto"]`) | `qonto` |
| `client/src/pages/admin/qonto.tsx` | Match (`["qonto"]`, `["billing"]`) | `qonto` (→ `billing`) |
| `client/src/pages/admin/qonto.tsx` | Unmatch (`["qonto"]`, `["billing"]`) | `qonto` (→ `billing`) |
| `client/src/pages/admin/qonto.tsx` | Auto-Match (`["qonto"]`, `["billing"]`) | `qonto` (→ `billing`) |
| `client/src/pages/admin/qonto.tsx` | CSV-Import (`["qonto"]`) | `qonto` |
| `client/src/pages/admin/qonto.tsx` | Avis erzeugen (`["qonto","payment-advices"]`) | `qonto` |
| `client/src/pages/admin/qonto.tsx` | Avis löschen (`["qonto","payment-advices"]`) | `qonto` |
| `client/src/pages/admin/duplicates.tsx` | Merge (`["admin-customers-duplicates"]`, `["admin-customers"]`) | `customers` |
| `client/src/pages/admin/birthday-cards.tsx` | Toggle (`["birthday-cards"]`) | `birthday-cards` |
| `client/src/pages/admin/proof-review.tsx` | Review (`["admin","pending-proofs"]`) | `pending-proofs` |
| `client/src/pages/admin/contact-migration.tsx` | Einzel-Migration | `contact-migration` |
| `client/src/pages/admin/contact-migration.tsx` | Bulk-Migration onSuccess | `contact-migration` |
| `client/src/pages/admin/contact-migration.tsx` | Bulk-Migration onError | `contact-migration` |
| `client/src/features/customers/components/customer-assignment-section.tsx` | Mitarbeiter-Zuordnung speichern (`["customer", customerId]`) | `customers` |
| `client/src/features/customers/hooks/use-insurance-providers.ts` | Pflegekasse anlegen | `insurance-providers` |
| `client/src/features/customers/hooks/use-insurance-providers.ts` | Pflegekasse aktualisieren | `insurance-providers` |
| `client/src/features/notifications/use-notifications.ts` | Visibility-Refresh (`["notifications"]`) | `notifications` |
| `client/src/features/appointments/hooks/use-new-appointment-form.ts` | Erstberatung onSuccess (`["/admin/employees/availability"]`) | `appointments` |
| `client/src/features/appointments/hooks/use-new-appointment-form.ts` | Geocode (`["customers"]`) | `customers` |

## Legitime Einzelfälle (mit Marker + ESLint-Disable)

Diese Aufrufer betreffen Query-Keys, die per Datensatz-ID parametrisiert sind und (noch) keiner zentralen Domäne entsprechen. Sie tragen `// invalidate-direct-allowed: <reason>` und `// eslint-disable-next-line no-restricted-syntax`.

| Datei:Zeile | Query-Key | Begründung |
|---|---|---|
| `client/src/pages/admin/customer-detail.tsx:222` | `["backfill-preview", customerId]` | Kunden-skopierter Preview-Key |
| `client/src/pages/admin/customer-detail.tsx:465` | `["conversion-readiness", customerId]` | Kunden-skopierter Readiness-Key |
| `client/src/pages/admin/customer-detail.tsx:468` | `["deactivation-readiness", customerId]` | Kunden-skopierter Readiness-Key |
| `client/src/pages/admin/components/customer-contract-tab.tsx:179` | `["deactivation-readiness", customerId]` | Kunden-skopierter Readiness-Key |
| `client/src/pages/admin/components/customer-contacts-tab.tsx:137` | `contactsQueryKey` (kunden-skopiert) | Kunden-skopierte Kontaktliste |
| `client/src/pages/admin/components/customer-contacts-tab.tsx:167` | `contactsQueryKey` (kunden-skopiert) | Kunden-skopierte Kontaktliste |
| `client/src/pages/admin/components/customer-contacts-tab.tsx:186` | `contactsQueryKey` (kunden-skopiert) | Kunden-skopierte Kontaktliste |
| `client/src/pages/admin/users.tsx:169` | `["admin","users", userId, "permissions"]` | Benutzer-skopierte Permissions |
| `client/src/features/appointments/hooks/use-appointment-mutations.ts:73` | `[`/api/appointments/${id}/services`]` | Termin-skopierte Services |

Folge-Aufgabe (`#400`): diese Einzelfälle ebenfalls in `query-invalidation.ts` zentralisieren (z. B. via Predicate-Invalidation), damit auch diese Marker entfallen können.

## Erweiterte Domänen-Map

`client/src/lib/query-invalidation.ts` wurde um folgende Domänen ergänzt: `profile`, `whatsapp`, `admin-users`, `admin-time-entries`, `billing`, `qonto`, `services`, `document-types`, `document-templates`, `birthday-cards`, `pending-proofs`, `contact-migration`, `insurance-providers`. Bestehende `customers`-Domäne wurde um `["admin","customers"]`, `["admin-customers"]`, `["admin-customers-duplicates"]` erweitert; `appointments`-Domäne um `["/admin/employees/availability"]`. Neue Cross-Domain-Beziehungen: `qonto ↔ billing`, `profile → auth`, `contact-migration → customers`, `pending-proofs → employee-proofs`.
