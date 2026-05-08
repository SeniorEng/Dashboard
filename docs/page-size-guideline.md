# Page-Size Guideline

## Targets

- **Soft target: ≤ 500 LOC** per page file under `client/src/pages/`.
- **Hard limit: 800 LOC.** Any new page exceeding 800 LOC must be decomposed before merge.

These limits apply to page wrapper files. They do not apply to feature components or hooks under `client/src/features/<domain>/`, where natural cohesion may justify larger files (a single dialog, a complex form section, etc.).

## Rationale

- Page files at >900 LOC become unreadable, hide subtle data-flow bugs, and slow code review.
- Pages should be **thin composition layers** that wire routing, top-level state, and feature components together. Domain logic and reusable UI belong in `features/`.
- Consistent page size makes it easier to reason about cross-cutting concerns (auth gates, layout, error boundaries, query invalidation).

## Decomposition Pattern

For any page above the soft target, extract to `client/src/features/<domain>/`:

```
client/src/features/<domain>/
├── components/        # Presentational + composed UI used by the page
├── hooks/             # Domain hooks (data fetching, form state, mutations)
├── types.ts           # Domain types shared by the feature
└── index.ts           # Public barrel — page imports from here
```

The page itself should:

1. Resolve route params and auth context.
2. Compose the feature components in a top-level layout.
3. Avoid embedding presentational JSX longer than ~30 lines per section.

### Anti-patterns to avoid

- `pages/admin/components/` and `pages/admin/hooks/` — colocating feature code under `pages/` blurs the page-vs-feature boundary. Migrate such code to `features/<domain>/`.
- Re-implementing logic in pages that already exists in a feature hook.
- Passing 10+ props to a sub-component instead of letting it consume a domain hook directly.

## Reference Examples

- `client/src/pages/profile.tsx` (61 LOC) → `client/src/features/profile/`
- `client/src/pages/admin/prospects.tsx` (233 LOC) → `client/src/features/prospects/components/`
- `client/src/pages/new-appointment.tsx` (207 LOC) → `client/src/features/appointments/components/new-appointment-*-tab.tsx`

## Known Exceptions

- `client/src/pages/edit-appointment.tsx` currently exceeds the hard limit. It is a single tightly-coupled form whose state cannot be split without a substantial prop-drilling refactor or a dedicated form-state hook. Decomposition is tracked as a follow-up task.

## Enforcement

Reviewers should flag any new page over 500 LOC and block any new page over 800 LOC. Existing pages between 500 and 800 LOC are acceptable but should be decomposed opportunistically when touched.
