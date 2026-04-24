# Audit-Scope (Task #178 – Tiefenanalyse Voll-Audit)

**Datum:** 24.04.2026
**Methodik:** `deep-analysis` (3 Phasen + Architect-Konsolidierung)
**Letzte gemergte Tasks:** #173, #174, #175, #177

## Cluster nach Risiko

### 🔴 HOCH – Always-On (immer prüfen, unabhängig vom Diff)
| Bereich | Dateien |
|---|---|
| Auth / Sessions / CSRF | `server/routes/auth.ts`, `server/middleware/auth.ts`, `server/middleware/csrf.ts`, `server/services/cache.ts` (sessionCache) |
| Budget / Abrechnung | `server/routes/budget.ts`, `server/routes/billing.ts`, `server/storage/budget-ledger.ts`, `shared/domain/budgets.ts` |
| Leistungsnachweise / Unterschriften | `server/routes/service-records.ts`, `server/services/signature-integrity.ts`, `server/routes/public-signing.ts` |
| Preisvereinbarungen | `server/storage/customers/`, `client/src/pages/customers/`, `shared/schema/customers.ts` |

### 🟠 HOCH – Recently-Touched (kürzlich angefasst, dadurch Regressionsrisiko)
| Bereich | Dateien | Quelle |
|---|---|---|
| Adresssuche + Geocoding-Pipeline | `server/routes/index.ts` (`/address-search`), `server/services/geocoding.ts`, `client/src/components/address-autocomplete.tsx` | #171, #173, #174 |
| Termin-Anlage + Wochenend-Sperre | `server/routes/appointments.ts` (POST `/kundentermin`, `/erstberatung`, PATCH), `client/src/pages/dashboard.tsx`, `shared/utils/datetime.ts` | #175 |
| Test-Cleanup-Endpoint (Neu, dev/test) | `server/routes/admin/test-cleanup.ts`, `server/index.ts` (login-Limit Override) | #177 |

### 🟡 MITTEL – Standard
| Bereich | Dateien |
|---|---|
| Dashboard / Wochenleiste | `client/src/pages/dashboard.tsx` |
| Stammdaten (Kunden, Mitarbeiter) | `client/src/pages/customers/`, `server/routes/customers.ts`, `server/routes/admin/users*.ts` |
| Zeiterfassung-Dialog | `client/src/features/time-tracking/`, `shared/domain/time-entries.ts`, `server/routes/time-entries.ts` |
| Termin-Dokumentation | `server/routes/appointment-documentation.ts`, `client/src/pages/appointment-detail.tsx` |

### 🟢 NIEDRIG (nur falls Zeit übrig)
- Statistiken: `server/routes/statistics*`, `client/src/pages/admin/statistics*`
- Settings, Onboarding-UI

## Reihenfolge der Tiefenanalyse
1. **Phase 1 (strukturell)** – Code-Quality + Database über HOCH-Cluster
2. **Phase 2 (domänen-tief)** – Business Logic + Error Handling + Security + Performance über HOCH-Cluster, mit Phase-1-Querverweisen
3. **Phase 3 (UX & Stabilität)** – UI/UX + QA + Regression-Guard, Regression-Guard explizit auf Diff `9930d33~10..9930d33`
4. **Architect-Konsolidierung** – Findings deduplizieren, priorisieren, Fix-Reihenfolge vorschlagen
5. **Smoke-Run + DevOps-Audit** – parallel zur Konsolidierung
6. **Folge-Tasks** – nur KRITISCH und HOCH als Project-Tasks vorschlagen, MITTEL/NIEDRIG nur im Report

## Bereits bekannte offene Tasks (NICHT duplizieren)
- #128 Vertrag-Ende Auto-Deaktivierung
- #125 Duplikatsprüfung Kundenanlage
- #144 "Meine Zeiten" Performance
- #147 Erstberatung in "Meine Zeiten"
- "Budget-Startwert Redesign" (Konzept)
- "Budget-Warnung False-Positive Fix"
- "TypeScript-Fehler im Server beheben" (16 tsc errors)
- "Central Month-Closing"
- "Standardize Phone Handling"

Wenn ein Audit-Finding eines dieser Themen trifft, wird es im Report mit Querverweis erwähnt, aber **kein neuer Task** angelegt.
