---
name: focus() on conditionally-disabled button is a no-op
description: Why a useEffect that focuses a button which is disabled-while-pending must depend on the pending flag
---

# Focusing a button that is disabled-while-pending

When a dialog moves keyboard focus to a footer button (so Radix Escape keeps
working after the confirm button gets disabled), the focus `useEffect` MUST
include the "is it currently disabled" condition in its dependency array and
guard, e.g. `if (progress && open && !mutation.isPending)`.

**Why:** `element.focus()` on a `disabled` button is a silent no-op. If the
effect only depends on the result/open state, it can fire while the button is
still disabled (mutation still pending), do nothing, and never re-run once the
button becomes enabled — so focus stays on `<body>`, Radix Escape never closes
the dialog, and the e2e Escape assertion flakes/fails. Adding `isPending` to
deps makes the effect re-fire when the button becomes focusable.

**How to apply:** Any "auto-focus the footer button after an async action"
pattern in dialogs (billing generate-all, bulk-send, etc.) — gate the focus on
the not-pending state AND list it in the dep array. In e2e, assert
`expect(closeBtn).toBeFocused()` before pressing Escape; it's both the
regression guard and a deterministic wait.
