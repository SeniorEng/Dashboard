---
name: Document upload version-vs-append (batchId + skipDeactivation)
description: How multi-page customer/employee documents are modeled and the constraint appended pages must satisfy to not corrupt the grouped display.
---

# Document upload: "Neue Version" vs. "Weitere Seiten"

A customer/employee document is one logical unit made of one or more rows sharing
a `batchId`. Uploading normally deactivates (archives) all prior current rows for
that `customerId/employeeId + documentTypeId` inside the storage transaction —
UNLESS `skipDeactivation:true` is passed.

- **New version** = fresh `batchId`, first file archives the old batch (default).
- **Append pages** = reuse the existing current batch's `batchId` + `skipDeactivation:true`
  for every file, so the older pages stay `isCurrent`.

**The constraint (easy to reintroduce as a bug):** the grouping code orders rows
`desc(uploadedAt)` and takes `batchLabel`/`documentDate` for the whole batch from
the FIRST (newest) row per `batchId`. Appended rows are the newest rows, so an
append MUST carry the existing batch's `batchLabel`/`documentDate` forward, or the
batch silently loses its label/date in the UI.

**Why:** Task #1578 — pages photographed one-by-one in separate upload sessions
were each archiving the prior page. Fix reused batchId+skipDeactivation (no new DB
column/table, per Ersetzungs-Regel) and added a version/append radio (default
"version") to all three upload surfaces.

**How to apply:** any new upload path must (1) generate ONE batchId per multi-file
upload and only archive on the first row (`skipDeactivation: i>0`) so a multi-select
doesn't archive its own earlier pages, and (2) on append, pass the target batch's
label/date. Server-side passthrough of skipDeactivation/batchId/batchLabel/documentDate
lives symmetrically in both the admin and non-admin `POST /:id/documents` routes.
