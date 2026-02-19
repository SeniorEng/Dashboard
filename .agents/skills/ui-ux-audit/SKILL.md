---
name: ui-ux-audit
description: Automated UI/UX and accessibility audit agent that checks touch targets, visual feedback, mobile usability, contrast, German wording, keyboard navigation, and screen reader compatibility. Use after adding new pages, forms, interactive components, or before deployment. Ensures the app is usable by caregivers in stressful field conditions on mobile devices.
---

# UI/UX & Accessibility Audit Agent

This agent validates that the user interface is usable, accessible, and appropriate for the target audience: caregivers using mobile phones in patient homes, often under stress, with poor lighting, and unreliable connectivity.

## When to Run

- After adding new pages, forms, or interactive components
- After modifying navigation or layout
- After changing colors, typography, or spacing
- Before deployment/publishing
- When users report usability issues
- During periodic UX reviews (monthly recommended)

## Core Principle

**Design for the worst case: stressed caregiver, old phone, bright sunlight, one hand busy, poor connectivity.** Every interaction must be forgiving, fast, and obvious.

---

## Category 1: Touch Target Compliance

**Goal**: All interactive elements are easily tappable on mobile devices, even with large fingers or while moving.

### Steps:
1. **Minimum touch target size** (44x44px per WCAG 2.5.5):
   ```bash
   # Find buttons and interactive elements
   grep -rn "<Button\|<button\|<IconButton\|onClick=" client/src/ --include="*.tsx" | head -30
   
   # Check for size="icon" buttons — these need min-h-[44px] min-w-[44px]
   grep -rn 'size="icon"\|size="sm"' client/src/ --include="*.tsx"
   ```
   - Verify: All buttons have adequate padding or explicit min-height/min-width
   - Verify: Icon-only buttons are not smaller than 44x44px
   - Verify: Form inputs have adequate height (`text-base` to prevent iOS zoom)

2. **Spacing between touch targets**:
   ```bash
   # Find closely spaced interactive elements
   grep -rn "gap-1\|gap-0\|space-x-1\|space-y-1" client/src/ --include="*.tsx"
   ```
   - Verify: Adjacent buttons/links have at least 8px gap to prevent mis-taps

3. **Input fields**:
   ```bash
   # Check input font size (must be text-base/16px to prevent iOS Safari zoom)
   grep -rn "<Input\|<input\|<Textarea\|<textarea\|<Select" client/src/ --include="*.tsx" | head -20
   ```
   - Verify: All inputs use `text-base` (16px) or larger font size
   - Verify: Input fields have clear focus indicators

### Red Flags:
- Button with only icon and no min-h-[44px] → WARN
- Input with font-size < 16px → FAIL (causes iOS zoom)
- Interactive elements with < 8px gap → WARN
- Checkbox/radio without adequate touch area → WARN

---

## Category 2: Visual Feedback & Loading States

**Goal**: Every user action provides immediate, clear feedback so the user never wonders "Did that work?"

### Steps:
1. **Loading states**:
   ```bash
   # Find mutations without loading indicators
   grep -rn "useMutation\|isPending\|isLoading\|isSubmitting" client/src/ --include="*.tsx" --include="*.ts" | head -30
   
   # Find submit buttons — do they disable during submission?
   grep -rn "type=\"submit\"\|onSubmit" client/src/ --include="*.tsx" -A3
   ```
   - Verify: Every form submission shows a loading spinner or disables the button
   - Verify: Every mutation has a pending state indicator
   - Verify: Page loads show a skeleton or spinner (not a blank screen)

2. **Success/Error feedback**:
   ```bash
   # Find toast/notification usage
   grep -rn "toast\|useToast\|showToast\|Toaster" client/src/ --include="*.tsx" --include="*.ts"
   
   # Find mutations — do they show success/error messages?
   grep -rn "onSuccess\|onError" client/src/ --include="*.tsx" --include="*.ts" -A2
   ```
   - Verify: Every mutation shows a toast on success AND on error
   - Verify: Error messages are in German and actionable ("Termin konnte nicht gespeichert werden" not "Error 500")

3. **Empty states**:
   ```bash
   # Find list renderings — do they handle empty arrays?
   grep -rn "\.length === 0\|\.length > 0\|emptyState\|keine.*gefunden\|Keine.*vorhanden" client/src/ --include="*.tsx"
   ```
   - Verify: Empty lists show a helpful message (not a blank area)
   - Verify: Empty states suggest an action ("Noch keine Termine. Erstellen Sie den ersten Termin.")

### Red Flags:
- Form without loading state during submission → FAIL
- Mutation without error feedback → FAIL
- Empty list without message → WARN
- Success action without confirmation → WARN

---

## Category 3: Mobile Layout & Responsiveness

**Goal**: The app works perfectly on mobile screens (320px–430px width) without horizontal scrolling or layout breaks.

### Steps:
1. **Horizontal overflow prevention**:
   ```bash
   # Find fixed widths that could cause overflow
   grep -rn "w-\[.*px\]\|min-w-\[.*px\]\|width:" client/src/ --include="*.tsx" | grep -v "max-w\|min-w-0"
   
   # Find tables (often problematic on mobile)
   grep -rn "<table\|<Table\|<thead\|<tbody" client/src/ --include="*.tsx"
   ```
   - Verify: No fixed widths wider than mobile viewport
   - Verify: Tables use horizontal scroll wrapper or card layout on mobile
   - Verify: Long text uses `truncate` or `break-words`

2. **Viewport and meta tags**:
   ```bash
   grep -rn "viewport\|maximum-scale" client/index.html
   ```
   - Verify: `<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1">`

3. **Responsive patterns**:
   ```bash
   # Find responsive breakpoints usage
   grep -rn "sm:\|md:\|lg:\|xl:" client/src/ --include="*.tsx" | wc -l
   
   # Find components with fixed layouts
   grep -rn "flex-row\|grid-cols-" client/src/ --include="*.tsx" | grep -v "sm:\|md:\|flex-col"
   ```
   - Verify: Multi-column layouts stack vertically on mobile (flex-col as default, flex-row at sm/md)
   - Verify: Bottom navigation doesn't overlap content

4. **Keyboard doesn't cover inputs**:
   ```bash
   # Check for scroll-into-view on focus
   grep -rn "scrollIntoView\|scroll-margin\|scroll-padding" client/src/ --include="*.tsx" --include="*.css"
   ```
   - Verify: Forms at the bottom of the page are visible when keyboard opens

### Red Flags:
- Fixed width > 400px without responsive alternative → FAIL
- Table without mobile-friendly alternative → WARN
- No viewport meta tag → FAIL
- Horizontal scroll on any page → FAIL

---

## Category 4: German Wording & Terminology

**Goal**: All user-facing text uses correct, professional German with proper care industry terminology.

### Steps:
1. **English text detection**:
   ```bash
   # Find potentially English user-facing text
   grep -rn "Submit\|Cancel\|Delete\|Save\|Loading\|Error\|Success\|Close\|Back\|Next\|Previous" client/src/ --include="*.tsx" | grep -v "//\|console\|import\|export\|type\|interface\|const.*=\|data-testid"
   ```
   - Verify: No English text visible to the user (labels, buttons, messages, placeholders)

2. **Correct terminology**:
   - "Pflegegrad" not "Pflegestufe" (outdated since 2017)
   - "Leistungsnachweis" not "Service Record"
   - "Maßnahme" or "Leistung" not "Task"
   - "Termin" not "Appointment"
   - "Unterschrift" not "Signature"
   - "Mitarbeiter" or "Pflegekraft" not "Employee"
   - "Kunde" or "Klient" not "Customer" (check consistency)

3. **Error message quality**:
   ```bash
   # Find all user-facing error messages
   grep -rn "throw.*Error\|badRequest\|toast.*error\|message:" server/routes/ --include="*.ts" | grep -i "\".*\""
   ```
   - Verify: All error messages explain WHAT went wrong and HOW to fix it
   - BAD: "Validierungsfehler" → GOOD: "Bitte geben Sie einen gültigen Pflegegrad (1-5) ein"
   - BAD: "Server-Fehler" → GOOD: "Der Termin konnte nicht gespeichert werden. Bitte versuchen Sie es erneut."

4. **Date/Time formatting**:
   ```bash
   # Check date display formats
   grep -rn "toLocaleDateString\|toLocaleTimeString\|format(" client/src/ --include="*.tsx"
   ```
   - Verify: Dates use "DD.MM.YYYY" (German format), never "MM/DD/YYYY" (US)
   - Verify: Times use "HH:MM" (24h), never "h:mm AM/PM"
   - Verify: `de-DE` locale is used for all formatting

### Red Flags:
- English label/button text visible to user → FAIL
- Wrong care terminology ("Pflegestufe") → FAIL
- Generic error message without actionable info → WARN
- US date format (MM/DD) → FAIL

---

## Category 5: Accessibility (a11y) Basics

**Goal**: The app is usable for people with visual or motor impairments and meets WCAG 2.1 AA baseline.

### Steps:
1. **Color contrast**:
   ```bash
   # Find text color classes on colored backgrounds
   grep -rn "text-gray-400\|text-gray-300\|text-white.*bg-" client/src/ --include="*.tsx" | head -20
   ```
   - Verify: Text contrast ratio ≥ 4.5:1 for normal text, ≥ 3:1 for large text
   - Verify: Important information is not conveyed by color alone (add icons or text)

2. **Semantic HTML**:
   ```bash
   # Check for missing aria labels on icon-only buttons
   grep -rn 'size="icon"' client/src/ --include="*.tsx" -A2 | grep -v "aria-label\|title\|sr-only"
   
   # Check for accessible form labels
   grep -rn "<Input\|<Select\|<Textarea" client/src/ --include="*.tsx" -B2 | grep -v "Label\|label\|aria-label\|htmlFor"
   ```
   - Verify: All icon-only buttons have `aria-label`
   - Verify: All form inputs have associated labels
   - Verify: Headings follow logical order (h1 → h2 → h3, no skipping)

3. **Keyboard navigation**:
   ```bash
   # Check for click-only interactions (no keyboard alternative)
   grep -rn "onClick=" client/src/ --include="*.tsx" | grep -v "<Button\|<button\|<a \|<Link\|<input\|role="
   ```
   - Verify: All interactive elements are keyboard-accessible (focusable, Enter/Space activates)
   - Verify: Focus is visible (focus ring or outline)
   - Verify: Dialogs trap focus and return it on close

4. **Screen reader support**:
   ```bash
   # Check for images without alt text
   grep -rn "<img\|<Image" client/src/ --include="*.tsx" | grep -v "alt="
   
   # Check for aria-live for dynamic content
   grep -rn "aria-live\|role=\"alert\"\|role=\"status\"" client/src/ --include="*.tsx"
   ```
   - Verify: All images have descriptive `alt` text
   - Verify: Dynamic updates (toasts, loading states) announce to screen readers

### Red Flags:
- Icon-only button without aria-label → FAIL
- Form input without label → FAIL
- Low contrast text (gray-400 on white) → WARN
- Non-button element with onClick but no keyboard handler → WARN
- Image without alt text → WARN

---

## Category 6: Design System & Layout Consistency

**Goal**: All pages use the centralized Layout component and design tokens. No page should define its own background, container width, or duplicate styling that the Layout already provides.

### Steps:
1. **No hardcoded page backgrounds**:
   ```bash
   # Find pages with their own gradient/background wrappers (should NOT exist inside Layout-wrapped pages)
   grep -rn "bg-gradient-to-br from-\[#f5e6d3\]" client/src/pages/ --include="*.tsx" | grep -v login | grep -v forgot-password | grep -v reset-password | grep -v public-signing
   ```
   - Verify: Returns ZERO results. ALL pages (except login/forgot-password/reset-password/public-signing) get their background from the Layout component.
   - If a page has its own `min-h-screen bg-gradient-to-br` wrapper → FAIL

2. **All pages use Layout with correct variant**:
   ```bash
   # Check Layout usage across pages
   grep -rn "<Layout" client/src/pages/ --include="*.tsx" | grep -v "\.test\."
   ```
   - Verify: Employee pages (dashboard, customers, tasks, service-records, etc.) use `<Layout>` (default variant, max-w-2xl)
   - Verify: Admin pages use `<Layout variant="admin">` (max-w-4xl) or `<Layout variant="wide">` (max-w-6xl for tables)
   - Verify: NO page uses its own `<div className="container mx-auto px-4 py-6 max-w-*">` wrapper — Layout handles this

3. **No duplicate container wrappers**:
   ```bash
   # Find pages that might still have their own container div
   grep -rn "container mx-auto px-4 py-6" client/src/pages/ --include="*.tsx"
   ```
   - Verify: Returns ZERO results. Layout provides the container.

4. **Consistent page titles**:
   ```bash
   # Check title patterns
   grep -rn "text-2xl font-bold\|text-xl font-bold\|text-3xl\|text-lg font-bold" client/src/pages/ --include="*.tsx" | head -30
   ```
   - Verify: All page titles use `text-xl sm:text-2xl font-bold text-gray-900` (via `componentStyles.pageTitle` or `PageHeader`)
   - Verify: No page uses `text-3xl` or other non-standard title sizes

5. **Layout variants exist in design tokens**:
   ```bash
   grep -rn "LayoutVariant\|layoutVariants" client/src/design-system/tokens.ts
   ```
   - Verify: `LayoutVariant` type and `layoutVariants` mapping are defined
   - Verify: Values match: default=max-w-2xl, admin=max-w-4xl, wide=max-w-6xl, narrow=max-w-xl, full=max-w-full

### Red Flags:
- Page with own bg-gradient wrapper inside Layout → FAIL
- Page with own `container mx-auto` wrapper → FAIL  
- Page without Layout component → FAIL (except public pages)
- Inconsistent page title sizes across tabs → WARN
- New page not using LayoutVariant → WARN

---

## Category 7: Navigation & Information Architecture

**Goal**: Users can always find what they need, know where they are, and get back to where they were.

### Steps:
1. **Current location indicator**:
   ```bash
   # Check active state on navigation items
   grep -rn "isActive\|active\|aria-current\|currentPath\|pathname" client/src/ --include="*.tsx" | grep -i "nav\|tab\|menu"
   ```
   - Verify: Current page/tab is visually highlighted in navigation
   - Verify: Breadcrumbs or back buttons exist on detail pages

2. **Back navigation**:
   ```bash
   # Find detail/edit pages — do they have back buttons?
   grep -rn "ArrowLeft\|ChevronLeft\|Zurück\|Back" client/src/pages/ --include="*.tsx"
   ```
   - Verify: Every detail page has a back button
   - Verify: Back action doesn't lose unsaved data (or warns the user)

3. **Consistent layout**:
   - Verify: Header/navigation is consistent across all pages
   - Verify: Primary actions are in consistent positions (top-right or bottom)
   - Verify: Destructive actions (Delete) are visually distinct (red) and require confirmation

### Red Flags:
- Detail page without back button → WARN
- No visual indicator for current page in navigation → WARN
- Destructive action without confirmation dialog → FAIL
- Inconsistent action button placement across pages → WARN

---

## Output Format

After completing all checks, produce a summary:

```
## UI/UX & Accessibility Audit Report

| Category | Status | Findings |
|----------|--------|----------|
| 1. Touch Targets | PASS/WARN/FAIL | Details |
| 2. Visual Feedback | PASS/WARN/FAIL | Details |
| 3. Mobile Layout | PASS/WARN/FAIL | Details |
| 4. German Wording | PASS/WARN/FAIL | Details |
| 5. Accessibility | PASS/WARN/FAIL | Details |
| 6. Design System & Layout | PASS/WARN/FAIL | Details |
| 7. Navigation | PASS/WARN/FAIL | Details |

### Critical Findings (must fix)
- [FAIL items affecting usability]

### Recommendations (should improve)
- [WARN items for better UX]

### Screenshots/Pages Checked
[List pages examined and key observations]
```

---

## Cross-References to Other Audit Skills

This audit covers **user interface and accessibility**. For complete coverage, also run:

| Skill | When to Also Run | What It Adds |
|-------|-----------------|--------------|
| `code-quality-supervisor` | **ALWAYS** after every task | Convention compliance, dead code |
| `business-logic-audit` | When workflows are affected | User perspective validation (Category 5 overlaps) |
| `performance-audit` | When new components are added | Rendering efficiency, bundle size, mobile speed |
| `security-audit` | When forms or inputs change | Input validation, XSS prevention |
