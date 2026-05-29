# Chunk 1 — Foundation: Schema / API / Domain (Deep-Audit, Refresh #822)

**Commit:** `178b2574` · **Stand:** 2026-05-29 · **Tiefe:** Deep
**Skills:** Database · API-Contract · Code-Quality

## Befunde

### HOCH-1 — monthly_work_hours nutzt real (Float)
- `shared/schema/users.ts:37` — `monthly_work_hours` ist `real`; Rundungs-Drift in
  Pro-Rata-/Lohn-Berechnung. Nicht von `migrate-km-geo-to-numeric.ts` erfasst.
  Fix: `numeric(6,2)` + idempotente Startup-Migration analog km-geo. Effort M. → T-822-SCHEMA-01

### HOCH-2 — IBAN/BIC Klartext at-rest
- `shared/schema/company.ts`/`billing.ts` — `iban`/`bic` als `text`, obwohl Qonto-Secret
  bereits `encryptedText` ist. Bank-PII (DSGVO). Fix: `encryptedText`. Effort M. → T-822-SECRETS-01

### MITTEL-1 — .unique()-Constraint-Naming-Falle
- `shared/schema/users.ts:11` (`email`), `services.ts:15` (`code`), `insurance.ts:36`
  (`ikNummer`), `budget.ts:114` (`customerId`) nutzen `.unique()` statt
  `unique("name").on(col)` → drizzle-push Duplikat-Constraint-Risiko (replit.md-Gotcha). Effort S.

### MITTEL-2 — Fehlende Indizes
- `appointments.performedByEmployeeId`, `budget_transactions.import_batch_id` ohne Index. Effort S.

### NIEDRIG-1 — aua_approval Drizzle-Drift (NUR NOTIZ)
- `shared/schema/customers.ts` — Legacy `aua_approval_ref`/`aua_approval_date` fehlen im
  Schema; nächster `drizzle-kit push` würde DROP versuchen (Data-Loss-Prompt).
  **Laut Task-Scope nicht zu fixen** — Backup vor Push sicherstellen.

### NIEDRIG-2 — API-SSoT
- Response-Typen meist manuell in Routes statt `z.infer<...Schema>` + `parse()`. OpenAPI-`Exact<>`-Assertions greifen, aber Runtime-Drift möglich.

## Positive Confirmations
- OpenAPI-Drift-Gate (`assertExact<Exact<...>>`) vorhanden und grün.
- Sensitive-Columns-Disziplin (encryptedText/Allowlist) per CI-Test abgesichert.
- km/Geo-Spalten `numeric` (kein IEEE-754-Drift).

## Anhang — Page-Size >500 LOC (Auszug, vollständig in REPORT §6.1)
billing.ts(3656) · appointments.ts(1632) · budget.ts(1278) · allocation-storage.ts(1274) ·
appointment-import.ts(1201) · billing.tsx(1772) · edit-appointment.tsx(1428) · BudgetTypeSettings.tsx(1169)
— insgesamt 36 Client- + 25 Server-Dateien.
