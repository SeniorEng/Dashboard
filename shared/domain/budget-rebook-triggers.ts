/**
 * Task #646 — Einheitliches Trigger-Vokabular für `appointment_km_rebooked`
 * Audit-Einträge.
 *
 * Vor dieser Vereinheitlichung emittierten verschiedene Pfade uneinheitliche
 * Trigger-Werte:
 *   - Edit-Pfad: `km_change` / `date_change` / `services_change` / `duration_change`
 *   - Import-Update: `import-update`
 *   - Import-Backfill: `import-backfill`
 *
 * Das erschwerte Reports/Filter über die Audit-Quelle. Wir verwenden jetzt
 * ein namespaced Schema `<source>:<reason>`, das den Auslöser eindeutig
 * benennt und sich serverseitig per `startsWith("appointment_edit:")` etc.
 * filtern lässt.
 *
 * Forward-Kompatibilität: Historische Audit-Einträge mit den alten Werten
 * bleiben in `audit_log.metadata.trigger` lesbar — es findet keine Migration
 * bestehender Daten statt.
 */

export const REBOOK_TRIGGERS = {
  edit: {
    km: "appointment_edit:km_change",
    date: "appointment_edit:date_change",
    services: "appointment_edit:services_change",
    duration: "appointment_edit:duration_change",
    unknown: "appointment_edit:unknown",
  },
  import: {
    update: "appointment_import:update",
    backfill: "appointment_import:backfill",
  },
  reconcile: {
    driftAudit: "appointment_reconcile:drift-audit",
  },
} as const;

export type RebookTrigger =
  | (typeof REBOOK_TRIGGERS.edit)[keyof typeof REBOOK_TRIGGERS.edit]
  | (typeof REBOOK_TRIGGERS.import)[keyof typeof REBOOK_TRIGGERS.import]
  | (typeof REBOOK_TRIGGERS.reconcile)[keyof typeof REBOOK_TRIGGERS.reconcile];
