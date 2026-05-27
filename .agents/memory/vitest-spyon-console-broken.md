---
name: vi.spyOn(console) doesn't capture imported-module console calls
description: In this vitest setup, vi.spyOn(console, "log") fails to capture console.log calls made from imported server modules; use direct console rebinding instead.
---

# Symptom
`vi.spyOn(console, "log").mockImplementation(() => {})` returns `spy.mock.calls.length === 0` even when an imported module definitely calls `console.log` many times during the test. A self-test (calling `console.log("X")` from the test scope itself right after installing the spy) captures `length === 1`, while calls routed through `server/lib/log.ts` → `console.log(...)` from inside an `await`ed imported function are NOT captured.

# Workaround
Rebind `console.log` directly and restore in `finally`:

```ts
const captured: string[] = [];
const origLog = console.log;
console.log = (...args: unknown[]) => {
  captured.push(args.map((a) => String(a)).join(" "));
};
try {
  await fnUnderTest();
} finally {
  console.log = origLog;
}
```

This captures every `console.log` call from anywhere in the process for the duration of the block, including from imported server modules.

**Why:** Root cause not fully understood — likely vitest's own console interception bypasses spyOn's property descriptor for cross-module calls. Direct property reassignment wins because every `console.log(...)` call resolves the property at call time.

**How to apply:** Whenever a test needs to assert on log output produced by `server/lib/log.ts` (or any other module calling `console.log` indirectly), do NOT reach for `vi.spyOn(console, "log")`. Use the direct-rebinding pattern above. `console.error` capture via vitest's stderr surface still works normally — only `console.log` interception via spyOn is unreliable.

# Reference test
`tests/integration/audit-appointment-budget-km-drift-detects-drift.test.ts` uses this pattern with inline comments explaining the workaround.
