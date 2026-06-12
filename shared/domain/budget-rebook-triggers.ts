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
    /**
     * Task #708 — Excel-Import hebt einen bisher nur geplanten
     * (`status='scheduled'`) Termin auf `completed` an und legt die
     * fehlende Budget-Consumption an (kein Storno+Neuanlage, sondern
     * Ersterfassung).
     */
    upgrade: "appointment_import:upgrade",
  },
  reconcile: {
    driftAudit: "appointment_reconcile:drift-audit",
    fromExcel: "appointment_import:reconcile",
  },
} as const;
