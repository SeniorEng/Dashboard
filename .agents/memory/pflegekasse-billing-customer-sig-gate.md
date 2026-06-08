---
name: Pflegekasse billing requires customer signature
description: Eligibility gate for billing a service record is billingType-aware — Pflegekasse needs a customer signature, Selbstzahler does not.
---

A service record is only billable for **Pflegekassen-Abrechnung** (`billingType` `pflegekasse_gesetzlich` / `pflegekasse_privat`) when its status is `completed` (i.e. the customer signed). A reine Mitarbeiter-Unterschrift (`employee_signed`) is NOT enough for Pflegekasse. For **Selbstzahler** (and any non-Pflegekasse type), `employee_signed` still counts as billable.

**Why:** GoBD/Kassen-correctness — invoices sent to a Pflegekasse must rest on a customer-signed Leistungsnachweis. The gate lives as one billingType-aware check in `shared/domain/invoice-calc.ts`; the billing route (`server/routes/billing.ts`, isSkip) mirrors the same German message ("Bei Pflegekassen-Abrechnung muss der Leistungsnachweis vom Kunden unterschrieben sein …").

**How to apply:** Any test/fixture that bills a Pflegekasse customer MUST sign BOTH employee and customer (the `for (const signerType of ["employee","customer"] as const)` pattern every `tests/billing/*` file already uses). Employee-only signing now yields a 400 from billing/generate for Pflegekasse. Selbstzahler fixtures may sign employee-only.
