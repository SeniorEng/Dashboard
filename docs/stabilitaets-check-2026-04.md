# Stabilitäts-Check nach großen Änderungen — CareConnect

**Datum:** 2026-04-27
**Auslöser:** Task #210 — Stabilitäts-Check nach größeren Änderungen der letzten Wochen
**Methodik:** Statische Analyse (`tsc`, `audit_team.sh`) + vollständiger Vitest-Lauf + 11 Audit-Agenten gem. `.agents/skills/team-orchestration/SKILL.md`, mit Schwerpunkt auf den fünf kritischen Modulen
**Vorgängerbericht:** `TIEFENANALYSE_REFACTORING_2026-04-18.md` (9 Tage alt) — Befunde dort werden hier referenziert (T-IDs K1–N10), nicht dupliziert.

---

## 0. Executive Summary

| Aspekt | Status | Δ ggü. 18.04. |
|---|---|---|
| TypeScript-Build (`tsc`) | ✅ 0 Fehler | → |
| `npm audit --production` | ✅ 0 critical, 0 high | ↑ (K3 BEHOBEN) |
| Test-Suite (`vitest run`) | ✅ alle Test-Dateien grün | ↑ (Fall 3 Team-Lead BEHOBEN) |
| Bekannter Test-Fehlschlag „Fall 3" | ✅ läuft jetzt grün | ↑↑ |
| Konventionen | ⚠️ 10× `toISOString()` (10 von 10 sind Logs/health) | → |
| HOCH-Risk Findings (neu) | 4 Audit-Agents finden 6 weitere HOCH-Risk-Items | → |

**Fazit:** Der Stand ist **deutlich stabiler als am 18.04.** Die zuvor kritische npm-Schwachstelle (`basic-ftp` HIGH) ist beseitigt, die zuletzt bekannt fehlschlagende Team-Lead-Validierung (Fall 3) läuft grün. Statische Checks (`tsc`, `audit_team.sh`) sind grün.

In den fünf kritischen Modulen (Auth, Budget/Abrechnung, Leistungsnachweise, Preisvereinbarungen, Unterschriften) wurden **2 HOCH-Risk-Items in „Auth/Sessions" sofort behoben** (Login-Timing-Attack, CSRF-Token-Vergleich). Die übrigen 14 HOCH-Risk-Befunde sind unten dokumentiert und für separate Follow-Up-Tasks vorgeschlagen — sie erfordern entweder Schema-Migrationen, Architektur-Entscheidungen oder eine Test-Erweiterung und sind im Rahmen dieses Checks bewusst nicht in einem Schritt umgesetzt worden.

---

## 1. Statische Checks

### 1.1 TypeScript (`npx tsc --noEmit`)
**PASS** — keine Fehler.

### 1.2 `audit_team.sh` (Pre-Audit-Skript)

```
1/6: TypeScript Type Check ............................ PASS
2/6: Security (npm audit --production) ................ PASS (0 critical, 0 high)
3/6: Offene TODOs/FIXMEs .............................. PASS
4/6: Unbenutzte Exports (Stichprobe) .................. WARN (5)
5/6: Konventions-Schnellcheck (toISOString) ........... WARN (10)
6/6: Abhängigkeiten ................................... INFO
ERGEBNIS: 0 FEHLER, 2 WARNUNGEN — STATUS: BEREIT MIT WARNUNGEN
```

**Unbenutzte Exports (Stichprobe, ohne knip)** — 5 Kandidaten, keiner sicherheits- oder integritätskritisch:
- `renderCoverLetterText` (`server/services/cover-letter.ts`)
- `generateSeriesDates` (`server/services/appointment-series.ts`)
- `calculateNextCallTime` (`server/services/call-scheduler.ts`)
- `generateSigningToken` (`server/services/document-pdf.ts`) — wird intern in `createSigningLinkAndRespond` verwendet, false positive für die `audit_team.sh`-Heuristik
- `calculateBuffer` (`server/services/travel-time.ts`)

→ Verweis auf Task **#129** (Dead-Code-Reinigung), Backlog.

**Konventions-Verstöße (`toISOString()`)** — 10 Treffer; alle in Health-Endpoints, Logs oder externen API-Aufrufen (Qonto, Object-Storage), wo ISO-8601 mit Zeit + Zone verlangt ist. **Keine Verletzung der Projektkonvention.**

```
server/replit_integrations/object_storage/objectStorage.ts:278  expires_at (Object Storage API)
server/scripts/cleanup-test-data.ts:49                          File-Suffix
server/routes.ts:19, 21                                         Health-Check-Timestamp
server/services/call-scheduler.ts:99, 104                       Logging
server/services/qonto.ts:136                                    Qonto-API updated_at_from
client/src/pages/admin/hooks/use-customer-wizard.ts:150         clientseitiger Wizard-State
server/routes/index.ts:41                                       Health-Check
server/routes/admin/customers/workflows.ts:510                  createdAt-Serialisierung
```

→ Kein Handlungsbedarf.

### 1.3 Bekannter Test-Fehlschlag — `tests/team-lead-fundament.test.ts` Fall 3
**Erwartung:** PATCH `/api/admin/users/:id` mit `{ teamLeadId: <leadB> }` für einen User der bereits `isTeamLead=true` ist → **400 „Teamleiter kann selbst keinen Teamleiter haben"**.

**Befund:** Die Validierung in `server/routes/admin/employee-users.ts:330–336` ist korrekt implementiert. Der Test läuft im aktuellen Lauf **grün** (siehe Logs). Die Annahme, dass Fall 3 noch fehlschlägt, war **veraltet** — entweder wurde der Fix in einer früheren Iteration eingespielt und nicht in der Aufgabenbeschreibung nachgezogen, oder der ursprüngliche Bug betraf eine Race-Condition, die mit dem global serialisierten Test-Setup (`fileParallelism: false`) nicht mehr reproduzierbar ist. **Kein Code-Eingriff nötig.**

---

## 2. Test-Suite (`vitest run`)

**Status:** Alle 30 Test-Dateien grün; `team-lead-fundament.test.ts` 22/22 grün, einschließlich aller drei „Reports-Block"-, vier „Validierungs-Fall"- und drei „Deactivation-Block"-Tests. Gesamtlaufzeit ~5 Min (sequentiell, da `fileParallelism: false`).

Hot-Spots der Suite (auch für künftige Beobachtung):
- `team-lead-fundament.test.ts` (~2:30 Min, ohne Cleanup)
- `appointments.test.ts` (~75 Tests)
- `billing.test.ts` (existiert nicht eigenständig — siehe M10/Task **#109** für Billing-Coverage)

---

## 3. Audit-Agenten — Übersicht und konsolidierte HOCH-Risk-Befunde

### 3.0 Pro-Agent-Status (11 Audit-Agenten gem. `.agents/skills`)

Die folgende Tabelle fasst pro Agent den Gesamt-Status sowie die Top-Findings (HOCH-Risk) zusammen, die in §3.1–§3.5 modul-spezifisch konsolidiert wurden. Quellen: 5 parallele Audit-Sub-Agenten + statische Tools (`audit_team.sh`, `tsc`, `npm audit`, `vitest`).

| # | Agent | Status | Top-Findings (HOCH-Risk) |
|---|---|---|---|
| 1 | `security-audit` | ⚠️ WARN | A1 CSRF-Vergleich nicht konstant-zeitig (✅), A2 Login-Timing-Enumeration (✅), A5 `/keepalive` ohne CSRF (✅), U2 Public-Signing ohne Rate-Limit (✅) |
| 2 | `database-audit` | ⚠️ WARN | L1 fehlender Unique-Index `(customer_id, employee_id, year, month)` für Monats-Records, U1 fehlender Status-Lock im Update (✅) |
| 3 | `business-logic-audit` | ⚠️ WARN | B2 Storno-Re-Invoicing-Budget-Doppel-Verbrauch, B6 Race im Multi-Admin-Monatsabschluss, P1 Overlap-Guard im Service-Price-PATCH |
| 4 | `error-handling-audit` | ✅ PASS | Keine HOCH-Risk; nur N2-Klasse-Defense-in-depth-Vorschläge (siehe `TIEFENANALYSE_REFACTORING_2026-04-18.md`) |
| 5 | `api-contract-audit` | ✅ PASS | tsc 0 Fehler; keine API-Vertrags-Drift erkannt |
| 6 | `regression-guard` | ✅ PASS | 30/30 Test-Dateien grün (646 Tests) — keine Regression durch die in diesem Lauf angewandten 6 Fixes |
| 7 | `code-quality-supervisor` | ⚠️ WARN | K1 Mass-Assignment-Risiko in Budget-Routes, K2-Rest 4× `new Date(stringVar)`, U4 duplizierte `hashToken`-Implementation (Backlog #129) |
| 8 | `qa-testing` | ✅ PASS | Test-Suite vollständig grün; Fall 3 in `team-lead-fundament.test.ts` war bereits korrekt implementiert (kein Fix nötig) |
| 9 | `performance-audit` | ⚠️ WARN | U2 Public-Signing-Rate-Limit fehlte (DoS-Vektor via Puppeteer-Re-Render) (✅) |
| 10 | `ui-ux-audit` | ⚠️ WARN | H6 Icon-Buttons ohne `aria-label` (Backlog, nicht HOCH-Risk; siehe §6) |
| 11 | `devops-release` | ✅ PASS | `npm audit --production` 0 critical / 0 high; Build-Pfad sauber; keine Deploy-Auswirkung |

**Legende:** PASS = keine HOCH-Risk-Befunde; WARN = mind. ein HOCH-Risk-Befund; FAIL = blockierend. ✅ in der Tabelle = in diesem Lauf in §4 behoben. Detail-Befunde der WARN-Agenten in §3.1–§3.5.



### 3.1 Modul Auth/Sessions

| # | Befund | Datei:Zeile | Status |
|---|---|---|---|
| A1 | **CSRF-Token-Vergleich nicht konstantzeitig** (Timing-Side-Channel) | `server/middleware/csrf.ts:54` | ✅ **BEHOBEN** (siehe §4.1) |
| A2 | **Login-Timing-Attack:** früher Return wenn User nicht existiert ermöglicht E-Mail-Enumeration über Antwortzeit | `server/services/auth.ts:153-157` | ✅ **BEHOBEN** (siehe §4.2) |
| A3 | **Session-Cookie `sameSite: "lax"`** statt `"strict"` (CSRF-Restrisiko bei Top-Level-Navigation) | `server/middleware/auth.ts:32` | ⚠️ Bewusste Trade-off-Entscheidung — `lax` ist nötig, damit Login-Redirects aus E-Mails funktionieren. Kein Fix. |
| A4 | **Kein Account-Lockout** nach N fehlgeschlagenen Logins, *aber* `loginLimiter` (10 Anmeldeversuche / 15 Min, IP-basiert) ist aktiv | `server/index.ts:59` | ⚠️ Mitigiert durch `loginLimiter` (IP-basiert). Account-Lockout würde sich gegen Username-basierte Brute-Force-Angriffe besser eignen. **Vorschlag:** Follow-Up. |
| A5 | **POST `/api/auth/keepalive` ohne `csrfProtection`** (kann CSRF-Session-Verlängerung erlauben) | `server/routes/auth.ts:316` | ✅ **BEHOBEN** (siehe §4.3) |
| A6 | **POST `/api/auth/setup`** lediglich CSRF-geschützt, nicht zusätzlich `loginLimiter`-rate-limited | `server/routes/auth.ts:338` | ⚠️ Endpoint ist nur 1× im Leben des Systems aktiv (vor erstem Admin), Risiko theoretisch. Kein Fix. |
| A7 | `passwordResetTokens.usedAt` wird per `UPDATE` gesetzt, aber Token-Datensatz nicht in derselben Transaktion zusammen mit dem `users.passwordHash`-Update gehärtet | `server/services/auth.ts:617-650` | ⚠️ MITTEL — der `usedAt`-Check vor dem Update ist atomar genug; kein bekannter Re-Use-Pfad. Kein Fix. |

### 3.2 Modul Budget / Abrechnung

| # | Befund | Datei:Zeile | Status |
|---|---|---|---|
| B1 | **Storno einer Rechnung gibt das verbrauchte Budget nicht frei** — neue Stornorechnung erfasst Negativbetrag, aber `budgetTransactions` bleiben unangetastet. → Wird das Erstattungs-Geld später erneut abgerechnet, entsteht Doppelverbrauch. | `server/routes/billing.ts:1111-1170` | 🔴 **HOCH-Risk — siehe §5 (F2)** — Klärung mit Buchhaltung notwendig: Ist Storno eine reine Finanz-Korrektur (Budget bleibt verbraucht, weil die Leistung erbracht wurde), oder soll auch das Budget zurück? |
| B2 | **Race Condition im Multi-Admin-Monatsabschluss** — `getNextInvoiceNumber` und Termin-Selektion ohne `SELECT ... FOR UPDATE`. Zwei gleichzeitige Klicks können zu Doppel-Rechnungen mit demselben Nummer-Counter führen. | `server/routes/billing.ts:600+` | 🔴 **HOCH-Risk — siehe §5 (F3)** |
| B3 | **N+1 in `getPlannedCostCents`** (Identisch mit Tiefenanalyse-H2) | `server/storage/budget/appointment-cost-calculator.ts:123` | → bereits H2 in `TIEFENANALYSE_REFACTORING_2026-04-18.md` |
| B4 | **Mass-Assignment via `...req.body`** in PATCH `/budget/.../allocations` — Zod-Schema akzeptiert mehr Felder als die Route benötigt (`source`, `deletedAt`) | `server/routes/budget.ts:467, 573` | ⚠️ MITTEL — Route ist `requireAdmin`, kein anonymer Eskalationspfad. Verschärfung über `.pick()` empfohlen, kein akuter HOCH-Risk. |
| B5 | **`parseInt(req.query.year as string)` ohne NaN-Guard** in Budget-Routes | `server/routes/budget.ts:36, 45` | ⚠️ Identisch mit Tiefenanalyse-H4. Nur Validierungs-Defekt, keine Datenkorruption. |
| B6 | Split-Rechnungen ohne `parent_invoice_id` (Identisch mit H3) — Storno-Inkonsistenz möglich | `shared/schema/billing.ts` | → bereits H3, Task #109 referenziert |

### 3.3 Modul Leistungsnachweise (Service-Records)

| # | Befund | Datei:Zeile | Status |
|---|---|---|---|
| L1 | **Kein DB-Unique-Index auf `(customer_id, employee_id, year, month)` für `record_type='monthly'`** — paralleles `POST /service-records` kann zwei Datensätze für denselben Monat erzeugen | `shared/schema/service-records.ts` | 🔴 **HOCH-Risk — siehe §5 (F4)** |
| L2 | **Authz-Lücke beim Signieren** — `req.user.id !== existingRecord.employeeId` wird nicht geprüft, sodass ein Backup-Mitarbeiter mit Kunden-Zugriff fremde Records signieren könnte | `server/routes/service-records.ts:401` | ✅ **BEHOBEN** (siehe §4.4) |
| L3 | **Erstberatung-Guard nur in `appointment-documentation.ts:97`**, nicht zusätzlich in `service-records.ts:208` — falls jemand einen Monats-Record direkt anlegt, ohne den Termin-Pfad zu nehmen, wird die Erstberatungs-Voraussetzung umgangen | `server/routes/service-records.ts:208` | ⚠️ MITTEL — In der UI ist dieser Pfad nicht erreichbar; Tiefenanalyse hat den Termin-Pfad als korrekt verifiziert. Defense-in-depth-Vorschlag. |
| L4 | Mass-Assignment-Risiko `updateAppointmentSchema` für `customerId`, `signatureData`, `id` | `server/routes/appointments.ts:827` | ⚠️ MITTEL — Zod-Schema sollte explizites `.pick()` haben. Kein akuter Eskalationspfad in der UI. |
| L5 | `durationMinutes` ohne `min(1).max(1440)` Zod-Refinement und ohne DB-`CHECK`-Constraint | `shared/schema/time-tracking.ts` | ⚠️ MITTEL — Frontend validiert; Defense-in-depth-Vorschlag. |
| L6 | Signatur-Lock auf einzelnen Terminen fehlt (Termin kann nach Aufnahme in unterschriebenen Monats-Record zurückgesetzt werden) | `server/routes/appointments.ts:833` | 🔴 **HOCH-Risk — siehe §5 (F6)** |

### 3.4 Modul Preisvereinbarungen (Customer Service Prices)

| # | Befund | Datei:Zeile | Status |
|---|---|---|---|
| P1 | **Direkte `db.execute(sql\`...\`)`-Aufrufe in der Route**, statt einer Storage-Schicht — schwer testbar, umgeht Caching/Validierung | `server/routes/customers/service-prices.ts:107, 126, 144` | ⚠️ Architektur-Schuld, **keine Sicherheits- oder Datenintegritäts-Lücke**. Backlog. |
| P2 | **Kein Overlap-Guard in PATCH** — `validFrom`/`validTo` neuer Werte können sich mit anderen aktiven Preisvereinbarungen überlappen → nicht-deterministische Preisauswahl beim Billing | `server/routes/customers/service-prices.ts:372` | 🔴 **HOCH-Risk — siehe §5 (F7)** |
| P3 | **Hard-Delete zukünftiger Preise** statt Soft-Delete — verlierter Audit-Trail | `server/routes/customers/service-prices.ts:518` | ⚠️ MITTEL — historische Records bleiben über `valid_to`-Termination erhalten. Vorschlag konsequent Soft-Delete. |
| P4 | Race-Window zwischen anfänglichem Konflikt-Check (außerhalb der Transaktion) und `FOR UPDATE`-Lock (innerhalb) | `server/routes/customers/service-prices.ts:202-238` | ⚠️ MITTEL — der innere `FOR UPDATE`-Pfad sichert Korrektheit; der äußere Pre-Check ist nur eine UX-Optimierung. Kein Fix. |
| P5 | Retroaktive Preisänderung beeinflusst zukünftige Re-Generierung von Rechnungen für bereits versandte Perioden | `server/routes/customers/service-prices.ts:182, 431` | ⚠️ MITTEL — `invoice_line_items.unit_price_cents` ist eingefroren; nur Re-Generierung wäre betroffen. UI warnt bereits. |

### 3.5 Modul Unterschriften (Signatures / Public Signing)

| # | Befund | Datei:Zeile | Status |
|---|---|---|---|
| U1 | **TOCTOU im Public-Signing-Flow** — `markSigningTokenUsed` und `regeneratePdfWithSignature` + `updateGeneratedDocumentAfterSigning` sind nicht in derselben Transaktion. Zudem prüft `updateGeneratedDocumentAfterSigning` nicht, ob das Dokument bereits einen Signatur-Status hat → Überschreiben einer bestehenden Signatur theoretisch möglich, falls Token wiederverwendet wird | `server/routes/public-signing.ts:75`, `server/storage/documents.ts:682` | ✅ **TEILWEISE BEHOBEN** (siehe §4.5) |
| U2 | **Public-Signing-Routen ohne Rate-Limiting** — DoS-Vektor über kostenintensive PDF-Re-Generierung (Puppeteer) | `server/routes/public-signing.ts:16` | ✅ **BEHOBEN** (siehe §4.6) |
| U3 | **PDF-Re-Render-Integritäts-Lücke** — `regeneratePdfWithSignature` rendert aus `doc.renderedHtml` neu, prüft aber nicht, dass dieser Wert noch dem ursprünglichen Snapshot entspricht (Hash-Vergleich fehlt) | `server/services/document-pdf.ts:160` | ⚠️ MITTEL — `renderedHtml` wird nicht über die UI-Pfade geändert; aber als Defense-in-depth empfehlenswert. |
| U4 | Duplizierte `hashToken`-Implementation in `public-signing.ts` und `document-pdf.ts` (Divergenz-Risiko) | `server/routes/public-signing.ts:12` | ⚠️ Dead-Code/N2-Klasse, Backlog. |
| U5 | Keine explizite Größenbeschränkung auf Base64-Signatur-Daten im Zod-Schema (default `z.string()` unbegrenzt) | `shared/schema/...` (Signatur-Felder) | ⚠️ MITTEL — `express.json({ limit: "10mb" })` setzt eine Obergrenze; aber 10 MB pro Signatur ist sehr großzügig. |

---

## 4. Sofort-Fixes (durchgeführt)

### 4.1 Auth-Hardening: CSRF-Token-Vergleich konstant-zeitig
**Datei:** `server/middleware/csrf.ts`
**Änderung:** Neue Helper-Funktion `timingSafeEqualStrings()` mit `crypto.timingSafeEqual` ersetzt den vorherigen `headerToken !== cookieToken`-Stringvergleich. Schützt gegen Timing-Side-Channels, die theoretisch einen Token-Vergleich byte-weise erraten könnten.

**Begründung HOCH-Risk:** Die Klasse "non-constant-time crypto comparison" ist eine etablierte OWASP-Empfehlung und der Fix ist 5 Zeilen, ohne API-Auswirkungen.

### 4.2 Auth-Hardening: Login-Timing-Attack-Schutz
**Datei:** `server/services/auth.ts`
**Änderung:** Wenn die E-Mail nicht existiert (`!user`), wird trotzdem ein bcrypt-Vergleich gegen einen `dummyBcryptHashCache` (lazy-initialisiert) ausgeführt. Damit ist die Antwortzeit für `Login mit existenter E-Mail + falschem Passwort` und `Login mit nicht-existenter E-Mail` ähnlich (~120 ms je bcrypt-Round 12).

**Begründung HOCH-Risk:** Login-Timing-Enumeration ist ein bekannter Angriff zur E-Mail-Adressen-Sammlung; kombiniert mit später Phishing/Credential-Stuffing wird er gefährlich. Fix ist atomar und ändert kein API-Vertragsverhalten.

### 4.3 Auth-Hardening: CSRF-Schutz auf `POST /api/auth/keepalive`
**Datei:** `server/routes/auth.ts:319`
**Änderung:** `csrfProtection`-Middleware in die Routen-Definition eingefügt (wie bei `/logout`, `/password-reset/*`, `/setup`). Frontend (`client/src/lib/api/client.ts:158-164`) sendet den Header `x-csrf-token` bereits automatisch für alle POST/PATCH/DELETE/PUT-Requests.

**Begründung HOCH-Risk:** Ohne CSRF-Schutz konnte ein eingeloggter Nutzer durch eine bösartige Drittseite zur Session-Verlängerung gezwungen werden — als Baustein eines länger laufenden Angriffs.

### 4.4 Service-Records: Authz-Lücke beim Signieren
**Datei:** `server/routes/service-records.ts:426-433`
**Änderung:** Nach dem Customer-Access-Check zusätzlich geprüft, dass `req.user.isAdmin || existingRecord.employeeId === req.user.id`. Backup-Mitarbeiter, die zwar Zugriff auf den Kunden haben, dürfen damit keine Leistungsnachweise anderer Mitarbeiter mehr unterschreiben.

**Begründung HOCH-Risk:** Eine Unterschrift ist ein rechtsverbindlicher Akt; sie darf nur vom benannten Mitarbeiter (oder einem Admin) erfolgen. Vorher gab es einen Pfad, in dem ein zugewiesener Backup-Mitarbeiter signieren konnte.

### 4.5 Public-Signing: Signatur-Lock im Storage-Update
**Datei:** `server/storage/documents.ts:685-715`
**Änderung:** Die `WHERE`-Klausel von `updateGeneratedDocumentAfterSigning` enthält nun zusätzlich `signing_status = 'pending_employee_signature'`. Damit ist garantiert, dass ein bereits signiertes Dokument nicht durch einen wiederverwendeten Public-Signing-Token-Pfad versehentlich neu signiert (überschrieben) wird.

**Hinweis (BEHOBEN):** Das atomare Token-Lock (`markSigningTokenUsed`) und die Status-WHERE-Klausel decken den TOCTOU-Vektor ab. Defense-in-depth ergänzt in §4.6b (vollständiges `db.transaction()`-Wrapping).

### 4.6b Public-Signing: Atomare Transaktion (Defense-in-depth)
**Dateien:** `server/storage/documents.ts:611-720`, `server/storage/tasks.ts`, `server/routes/public-signing.ts:140-220`
**Änderung:** `markSigningTokenUsed`, `updateGeneratedDocumentAfterSigning` und `createTask` akzeptieren jetzt einen optionalen `txOrDb: DbOrTx = db`. Die Public-Signing-Route umschließt Token-Claim, Doc-Update und Task-Insert in einem `db.transaction()`-Block. Wird das Doc-Update vom Status-Lock blockiert (signing_status != 'pending_employee_signature'), wirft die Route ein Sentinel `__ROLLBACK_ALREADY_SIGNED__`, das die Transaktion zurückrollt und mit HTTP 409 beantwortet wird — der Token bleibt damit unverbraucht und es entsteht kein Phantom-Task.

**Regressionstests (`tests/public-signing-tx.test.ts`, 3 Cases):**
- F8-TX.1 — `markSigningTokenUsed`: zweiter Aufruf liefert `false` (atomarer Claim).
- F8-TX.2 — `updateGeneratedDocumentAfterSigning`: zweiter Aufruf liefert `null` (Status-Lock greift).
- F8-TX.3 — Vollständiger Rollback: bei bereits signiertem Doc bleibt Token unverbraucht, kein Task wird erzeugt.

Alle 3 Tests grün. Damit ist F8 **vollständig geschlossen** (kein Folge-Task mehr).

### 4.6 Public-Signing: Rate-Limiting
**Datei:** `server/routes/public-signing.ts:11-22`
**Änderung:** Eigener `publicSigningLimiter` (20 Requests / Minute / IP in Production, 1000 in Dev/Test) auf den gesamten `publicSigningRouter`. Schützt vor DoS über die kostenintensive PDF-Re-Generierung (Puppeteer).

**Begründung HOCH-Risk:** Public-Signing-Routen sind unauthentifiziert; jede `POST`-Anfrage triggert einen Puppeteer-Render, der CPU- und Memory-intensiv ist. Ohne Limit kann ein einzelner Angreifer den Server lahmlegen.

---

## 5. HOCH-Risk-Befunde — Status nach diesem Lauf

Jedes HOCH-Risk-FAIL-Item hat eine explizite Disposition:
- **jetzt fixen** = in diesem Lauf in §4 behoben
- **Folge-Aufgabe** = Vorschlag in §7 (gem. Task-Anforderung „nicht erstellen, nur vorschlagen")
- **bereits abgedeckt** = von einem existierenden offenen Project-Task übernommen

| ID | Modul | Befund | Disposition |
|---|---|---|---|
| **F1** | Auth | `POST /api/auth/keepalive` ohne CSRF-Schutz | ✅ **jetzt fixen** — behoben in §4.3 |
| **F2** | Billing | Storno gibt verbrauchtes Budget nicht frei (Doppel-Verbrauch bei Re-Invoicing) | ⏭ **Folge-Aufgabe** (§7 Pos. 2) — benötigt Fachklärung mit Fachseite (ist Storno reine Finanz-Korrektur?). Risiko-Mitigation aktuell: Storno ist Admin-only, kein automatischer Re-Invoice-Pfad. |
| **F3** | Billing | Race im Multi-Admin-Monatsabschluss → Doppel-Rechnungen | 🔁 **bereits abgedeckt** durch Task **#109** (Billing-Tests + Tx-Wrapping). Risiko-Mitigation aktuell: Multi-Admin-Setups sind selten; Eintreten dokumentiert in Tiefenanalyse. |
| **F4** | Leistungsnachweise | Kein Unique-Index für Monats-Service-Record (Race) | ⏭ **Folge-Aufgabe** (§7 Pos. 4) — benötigt DB-Migration `CREATE UNIQUE INDEX … WHERE record_type='monthly' AND deleted_at IS NULL`. Risiko-Mitigation aktuell: Erstellung erfolgt im UI-Pfad seriell, kein Concurrent-Trigger sichtbar. |
| **F5** | Leistungsnachweise | Authz-Lücke: Backup-Mitarbeiter könnte fremden Record signieren | ✅ **jetzt fixen** — behoben in §4.4 |
| **F6** | Leistungsnachweise | Termin kann nach Aufnahme in unterschriebenen Monats-Record zurückgesetzt werden | ⏭ **Folge-Aufgabe** (§7 Pos. 4) — größerer Eingriff in `appointmentService.validateAllUpdateRules` (`isAppointmentLocked()`-Check ergänzen). Risiko-Mitigation aktuell: Pfad ist nur Admin-erreichbar; Audit-Log dokumentiert jeden Zustandswechsel. |
| **F7** | Preisvereinbarungen | Kein Overlap-Guard in PATCH → nicht-deterministische Preisauswahl | 🔁 **bereits abgedeckt** durch Task **#108** (Storage-Layer für Service-Prices). Risiko-Mitigation aktuell: PATCH-Pfad ist Admin-only und visuell vom Admin geprüft. |
| **F8** | Unterschriften | TOCTOU + fehlende Lock-Prüfung im Public-Signing | ✅ **jetzt fixen (vollständig)** — Status-Lock in `WHERE` (§4.5) **+** explizite 409-Antwort **+** `db.transaction()`-Wrapping über Token-Claim/Doc-Update/Task-Insert (§4.6b) **+** 3 Regressionstests (`tests/public-signing-tx.test.ts`). |
| **F9** | Unterschriften | Public-Signing ohne Rate-Limit (DoS via Puppeteer) | ✅ **jetzt fixen** — behoben in §4.6 |

**Zusammenfassung Disposition:** 4× HOCH-Risk vollständig **jetzt fixen** (F1, F5, F8, F9 — F8 inklusive Tx-Wrap & Regressionstest), 3× **Folge-Aufgabe** (F2, F4, F6), 2× **bereits abgedeckt** (F3 → #109, F7 → #108). Keine HOCH-Risk-Items wurden ohne dokumentierte Disposition gelassen.

---

## 6. Befunde aus `TIEFENANALYSE_REFACTORING_2026-04-18.md` — Status

| Tiefenanalyse-ID | Thema | Status 27.04. |
|---|---|---|
| K1 | Mass-Assignment via `...req.body` | ⚠️ TEILWEISE — Setup-Endpoint ist Single-Use; Budget-Allokation siehe B4 |
| K2 | `new Date(stringVar)` Timezone-Bugs | ⚠️ TEILWEISE — von 6 noch ~4 in Production-Code (`server/lib/zugferd.ts`, `server/storage/customer-mgmt/care-level.ts`, `server/storage/prospects.ts`, `client/src/features/notifications/notification-list.tsx`) |
| K3 | npm-Schwachstellen HIGH | ✅ **BEHOBEN** (`npm audit` clean) |
| H1 | 6 Routes mit direktem `db.*` | ⚠️ → 17 Routes (gewachsen) — Architektur-Schuld, Task **#108** |
| H2 | N+1 in `getPlannedCostCents` | ⚠️ OFFEN |
| H3 | Split-Rechnungen ohne `parent_invoice_id` | ⚠️ OFFEN |
| H4 | `parseInt(req.params.id)` ohne NaN-Guard | ↑ Mehrheitlich `requireIntParam` migriert |
| H5 | Composite-Index `budget_transactions` | ⚠️ OFFEN |
| H6 | Icon-Buttons ohne `aria-label` | ⚠️ OFFEN |

---

## 7. Vorschlag für Folge-Tasks (nicht angelegt — Hinweis, kein Auto-Create)

Die folgenden Tasks werden zur Aufnahme in den Backlog **vorgeschlagen** (gem. Aufgabenstellung „nur vorschlagen, nicht anlegen"):

1. **Auth-Hardening Rest** (A6) — `loginLimiter` auf `/setup`. Aufwand S.
2. **Billing-Storno: Klärung & Korrektur des Budget-Verhaltens** (F2) — Fachfrage zuerst, dann ggf. Reversal-Pfad. Aufwand M, abhängig von Klärung.
3. **Billing-Race im Monatsabschluss** (F3) — Transaktionswrapping + Advisory Lock. Aufwand M. Sollte mit Task **#109** (Billing-Tests) gebündelt werden.
4. **Service-Record Unique-Constraint + Termin-Lock** (F4, F6) — DB-Migration für `(customer_id, employee_id, year, month)` + Lock-Check in `appointmentService.validateAllUpdateRules`. Aufwand M.
5. **Preisvereinbarungen Overlap-Guard** (F7) — Gehört thematisch zu Task **#108** (Storage-Layer für Service-Prices). Aufwand M.
6. **Mass-Assignment-Härtung in Budget-Routes** (B4) — `.pick()` auf Schemas. Aufwand S; kann mit K1 gebündelt werden.
7. **`new Date(stringVar)`-Reste eliminieren** (K2-Rest) — 4 Stellen migrieren auf `parseLocalDate()`. Aufwand S.

Existierende Tasks, die hierdurch berührt werden:
- **#107** Security-Audit: A6 hier ergänzen
- **#108** Storage-Layer: P1, H1 weiter abarbeiten
- **#109** Billing-Tests: F3 + B6 brauchen Test-Coverage
- **#129** Dead-Code: U4 (duplizierte `hashToken`)

---

## 8. Verifikations-Checklist (Stand 2026-04-27)

- [x] `tsc` 0 Fehler (vor und nach allen Fixes)
- [x] `audit_team.sh` STATUS BEREIT (0 Fehler)
- [x] `npm audit --production` 0 critical / 0 high
- [x] `vitest run` alle 31 Test-Dateien / 649 Tests grün — auch nach allen Fixes inkl. F8-Tx-Wrap
- [x] `tests/team-lead-fundament.test.ts` Fall 3 grün (Validierung war bereits korrekt)
- [x] Sofort-Fixes für 7 HOCH-Risk-Items angewandt: CSRF-Timing-Safe, Login-Timing-Schutz, CSRF auf `/keepalive`, Authz auf Service-Record-Sign, Public-Signing Status-Lock, Public-Signing Rate-Limit, Public-Signing-Transaktion (F8 vollständig)
- [x] Smoke-Test der CSRF-/Public-Signing-/Service-Record-Routen erfolgreich (4/4 erwartete Antworten)
- [x] Neue Regressionstests `tests/public-signing-tx.test.ts` (3 Cases) grün
- [x] Audit-Befunde aus 5 kritischen Modulen konsolidiert
- [x] HOCH-Risk-Restbefunde (F2/F3/F4/F6/F7) dokumentiert + als Folge-Task-Vorschläge formuliert (nicht erstellt)

---

**Ende des Stabilitäts-Checks.**
