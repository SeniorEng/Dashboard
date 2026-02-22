# Project-Specific Workflows

This file documents the concrete business workflows for your project.
Use these as checklists when auditing business logic.

**IMPORTANT**: Replace these example workflows with your actual business processes!

---

## Workflow Template

### Workflow: [Name]

**Status Flow:**
```
status_a → status_b → status_c → status_d
```

**Rules:**
- [List transition rules]
- [Define which fields are editable in each status]

**Critical Data at Each Step:**
| Step | User Action | Required Data | Common Skip |
|------|------------|---------------|-------------|
| a → b | [Action] | [Fields] | YES/NO |

**Fallback Logic (for skipped steps):**
- If [field] is NULL at [step]: Set to [default]

**Audit Checklist:**
- [ ] Can user skip steps? With what fallback?
- [ ] Are all required fields set at final status?
- [ ] Does the UI reflect status-based field restrictions?
- [ ] Are error messages specific and actionable?

---

## Cross-Workflow Dependencies

Use this dependency map when auditing cross-feature impact:

```
[Entity A] Created
  └→ [Related Record 1]
  └→ [Related Record 2]

[Entity A] Updated
  └→ [Side Effect 1]
  └→ [Side Effect 2]

[Entity B] Depends On [Entity A]
  └→ Requires: [Preconditions]
  └→ Shows: [Derived Data]
```

---

## How to Document Your Workflows

1. Identify the main entities in your app (Users, Orders, Tasks, etc.)
2. Map the lifecycle of each entity (creation → updates → completion/deletion)
3. Document status transitions and their rules
4. List cross-entity dependencies
5. Note common user behaviors (skipping steps, unusual order of operations)
