---
name: Wage-data superadmin gate boundary
description: Which wage/cost endpoints are superadmin-only vs admin, and why; the requireWageDataAccess SSoT.
---

# Wage-data access boundary

Per-employee pay/payout/labor-cost figures are **superadmin-only**; aggregate, non-personal business KPIs stay **admin-visible**. This is a deliberate product decision, not just a code detail.

**Superadmin-only (gated by `requireWageDataAccess` in server/middleware/auth.ts, a semantic alias delegating to `requireSuperAdmin`):**
- `GET /api/admin/hours-overview` (+ `/unsigned-appointments`) — Lexware payout per employee
- `GET /api/statistics/v2/performance` — profitability per employee
- `GET /api/billing/economics` — labor cost / margin per employee
- `GET /api/services/role-wage-rates*` — wage-rate matrix (gated by `requireSuperAdmin`)

**Deliberately kept admin-visible (do NOT gate):**
- `GET /api/statistics/v2/revenue` and `GET /api/billing/pipeline` — these render a shared aggregate `EconomicsBlock` (company-wide cost/margin), which is a business KPI, not per-person pay.

**Why:** users wanted the person who runs payroll (superadmin) to be the only one seeing individual wages, while normal admins keep company-level financial visibility.

**How to apply:** any NEW endpoint returning per-employee wage/payout/labor-cost MUST use `requireWageDataAccess`. The architecture guard `tests/architecture/wage-data-access-gate.test.ts` holds a registry of these routes and fails if one loses its gate — register new wage routes there. Frontend mirror: `SuperAdminRoute` in client/src/components/route-guards.tsx (used by client/src/App.tsx) for the pages, and dashboard cards hide via `permissionKey: "super_admin_only"` (hasAdminPermission short-circuits true for superadmin).

Gotcha: `/api/services` GET still exposes catalog `employeeRateCents` to all authed users — known, lower priority, left out of scope.
