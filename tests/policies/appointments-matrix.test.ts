/**
 * Berechtigungs-Matrix für Termine — Gold-Standard-Test.
 *
 * Iteriert über alle Kombinationen aus Rolle × Status × Lock × Monatsabschluss
 * × Beziehung und prüft jede Aktion gegen `shared/policies/appointments`.
 *
 * Generiert zugleich die Markdown-Doku unter `docs/permissions-matrix-appointments.md`.
 * Der Test schlägt fehl, wenn die generierte Tabelle vom committeten Doku-Stand
 * abweicht — so bleibt Doku und Code in Sync. Mit `UPDATE_MATRIX_DOC=1` wird
 * die Doku neu geschrieben.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  APPOINTMENT_ACTIONS,
  canViewAppointment,
  canCreateAppointment,
  canEditAppointment,
  canDeleteAppointment,
  canDocumentAppointment,
  canReopenAppointment,
  canOverrideClosedMonth,
  type AppointmentAction,
  type PolicyAppointment,
  type PolicyUser,
} from "@shared/policies/appointments";
import type { AppointmentStatus } from "@shared/domain/appointments";

// ============================================
// FIXTURES
// ============================================

type RoleKey =
  | "guest_inactive"
  | "employee_other"
  | "employee_assigned"
  | "employee_assigned_to_customer"
  | "team_lead"
  | "admin"
  | "super_admin";

const ROLES: Record<RoleKey, PolicyUser> = {
  guest_inactive:                { id: 9, isAdmin: false, isSuperAdmin: false, isTeamLead: false, isActive: false, roles: [] },
  employee_other:                { id: 10, isAdmin: false, isSuperAdmin: false, isTeamLead: false, isActive: true, roles: ["hauswirtschaft"] },
  employee_assigned:             { id: 1,  isAdmin: false, isSuperAdmin: false, isTeamLead: false, isActive: true, roles: ["hauswirtschaft"] },
  employee_assigned_to_customer: { id: 11, isAdmin: false, isSuperAdmin: false, isTeamLead: false, isActive: true, roles: ["hauswirtschaft"] },
  team_lead:                     { id: 12, isAdmin: false, isSuperAdmin: false, isTeamLead: true,  isActive: true, roles: ["hauswirtschaft"] },
  admin:                         { id: 13, isAdmin: true,  isSuperAdmin: false, isTeamLead: false, isActive: true, roles: [] },
  super_admin:                   { id: 14, isAdmin: false, isSuperAdmin: true,  isTeamLead: false, isActive: true, roles: [] },
};

const ROLE_LABELS: Record<RoleKey, string> = {
  guest_inactive: "Deaktiviert",
  employee_other: "Mitarbeiter (fremd)",
  employee_assigned: "Mitarbeiter (zugewiesen)",
  employee_assigned_to_customer: "Mitarbeiter (Kunden-Backup)",
  team_lead: "Teamleitung",
  admin: "Admin",
  super_admin: "Superadmin",
};

const STATUSES: AppointmentStatus[] = ["scheduled", "in-progress", "documenting", "completed", "cancelled", "expired_unsigned"];

interface ScenarioFlags {
  isLocked: boolean;
  isMonthClosed: boolean;
}

const FLAG_VARIANTS: Array<{ key: string; label: string; flags: ScenarioFlags }> = [
  { key: "open",         label: "offen",                     flags: { isLocked: false, isMonthClosed: false } },
  { key: "month_closed", label: "Monat geschlossen",         flags: { isLocked: false, isMonthClosed: true } },
  { key: "locked",       label: "LN unterschrieben (Lock)",  flags: { isLocked: true,  isMonthClosed: false } },
];

function buildAppointment(role: RoleKey, status: AppointmentStatus, flags: ScenarioFlags): PolicyAppointment {
  // Termin gehört dem "employee_assigned"-Mitarbeiter (id 1).
  const assignedId = ROLES.employee_assigned.id;
  return {
    assignedEmployeeId: assignedId,
    performedByEmployeeId: assignedId,
    customerId: 100,
    status,
    date: "2026-05-01",
    appointmentType: "Kundentermin",
    isStarted: status !== "scheduled",
    isLocked: flags.isLocked,
    isMonthClosed: flags.isMonthClosed,
    hasSignature: status === "completed",
  };
}

function evalAction(
  action: AppointmentAction,
  user: PolicyUser,
  appt: PolicyAppointment,
  isAssignedToCustomer: boolean,
): boolean {
  switch (action) {
    case "view":
      return canViewAppointment(user, appt, { isAssignedToCustomer }).allowed;
    case "create":
      return canCreateAppointment(user, {
        date: appt.date,
        isWeekend: false,
        isHoliday: false,
        isFarPast: false,
        isMonthClosed: appt.isMonthClosed,
        appointmentType: "Kundentermin",
        isAssignedToCustomer,
        forOtherEmployee: false,
      }).allowed;
    case "edit":
      return canEditAppointment(user, appt).allowed;
    case "delete":
      return canDeleteAppointment(user, appt).allowed;
    case "document":
      return canDocumentAppointment(user, appt).allowed;
    case "reopen":
      return canReopenAppointment(user, appt).allowed;
    case "overrideClosedMonth":
      return canOverrideClosedMonth(user).allowed;
  }
}

// ============================================
// MATRIX-GENERATOR
// ============================================

function generateMatrixMarkdown(): string {
  const lines: string[] = [];
  lines.push("# Berechtigungs-Matrix — Termine");
  lines.push("");
  lines.push("> **Auto-generiert** aus `shared/policies/appointments.ts` durch");
  lines.push("> `tests/policies/appointments-matrix.test.ts`. **Nicht von Hand bearbeiten** —");
  lines.push("> der Test scheitert bei Drift. Aktualisierung mit `UPDATE_MATRIX_DOC=1 npx vitest run tests/policies`.");
  lines.push("");
  lines.push("Lese-Schlüssel: `✓` = erlaubt, `–` = verweigert.");
  lines.push("");
  lines.push("Annahmen pro Zelle:");
  lines.push("- 'Mitarbeiter (zugewiesen)' ist assignedEmployeeId des Termins.");
  lines.push("- 'Mitarbeiter (Kunden-Backup)' ist dem Kunden zugeordnet, aber nicht dem Termin.");
  lines.push("- Wochenende/Feiertag/Vergangenheit sind in den Create-Spalten aus.");
  lines.push("- `overrideClosedMonth` ignoriert Termin-Felder — nur Rolle zählt.");
  lines.push("");

  for (const variant of FLAG_VARIANTS) {
    lines.push(`## Termin-Status: ${variant.label}`);
    lines.push("");
    const header = ["Rolle", "Status", ...APPOINTMENT_ACTIONS];
    lines.push(`| ${header.join(" | ")} |`);
    lines.push(`| ${header.map(() => "---").join(" | ")} |`);

    for (const roleKey of Object.keys(ROLES) as RoleKey[]) {
      for (const status of STATUSES) {
        const appt = buildAppointment(roleKey, status, variant.flags);
        const user = ROLES[roleKey];
        const isAssignedToCustomer = roleKey === "employee_assigned_to_customer";
        const cells = APPOINTMENT_ACTIONS.map((action) =>
          evalAction(action, user, appt, isAssignedToCustomer) ? "✓" : "–",
        );
        lines.push(`| ${ROLE_LABELS[roleKey]} | \`${status}\` | ${cells.join(" | ")} |`);
      }
    }
    lines.push("");
  }

  lines.push("## Aktions-Definitionen");
  lines.push("");
  lines.push("| Aktion | Bedeutung |");
  lines.push("| --- | --- |");
  lines.push("| `view` | Termin lesen / im Kalender sehen |");
  lines.push("| `create` | Neuen Termin im selben Monat anlegen |");
  lines.push("| `edit` | Datum, Zeit, Mitarbeiter, Notizen, Services ändern (PATCH) |");
  lines.push("| `delete` | Termin löschen |");
  lines.push("| `document` | Start, Ende, Dokumentation, Kundenunterschrift |");
  lines.push("| `reopen` | Abgeschlossenen Termin zur Korrektur öffnen |");
  lines.push("| `overrideClosedMonth` | In einem geschlossenen Monat handeln dürfen |");
  lines.push("");
  return lines.join("\n");
}

// ============================================
// TESTS
// ============================================

const DOC_PATH = path.resolve(__dirname, "..", "..", "docs", "permissions-matrix-appointments.md");

describe("Berechtigungs-Matrix Termine", () => {
  it("APPOINTMENT_ACTIONS deckt alle Policy-Funktionen ab", () => {
    expect([...APPOINTMENT_ACTIONS].sort()).toEqual([
      "create", "delete", "document", "edit", "overrideClosedMonth", "reopen", "view",
    ]);
  });

  it("Deaktivierte User dürfen nichts", () => {
    for (const status of STATUSES) {
      for (const variant of FLAG_VARIANTS) {
        const appt = buildAppointment("guest_inactive", status, variant.flags);
        for (const action of APPOINTMENT_ACTIONS) {
          expect(evalAction(action, ROLES.guest_inactive, appt, false)).toBe(false);
        }
      }
    }
  });

  it("Nur Superadmin darf in geschlossenem Monat editieren / dokumentieren / wiedereröffnen / löschen", () => {
    const flags: ScenarioFlags = { isLocked: false, isMonthClosed: true };
    const appt = buildAppointment("admin", "documenting", flags);
    expect(canEditAppointment(ROLES.admin, appt).allowed).toBe(false);
    expect(canEditAppointment(ROLES.super_admin, appt).allowed).toBe(true);
    expect(canDocumentAppointment(ROLES.admin, appt).allowed).toBe(false);
    expect(canDocumentAppointment(ROLES.super_admin, appt).allowed).toBe(true);
    expect(canDeleteAppointment(ROLES.admin, appt).allowed).toBe(false);
    expect(canDeleteAppointment(ROLES.super_admin, appt).allowed).toBe(true);
    const completed = buildAppointment("admin", "completed", flags);
    expect(canReopenAppointment(ROLES.admin, completed).allowed).toBe(false);
    expect(canReopenAppointment(ROLES.super_admin, completed).allowed).toBe(true);
  });

  it("Lock blockiert edit/document/reopen — nur Admin darf gesperrte Termine löschen", () => {
    const flags: ScenarioFlags = { isLocked: true, isMonthClosed: false };
    const appt = buildAppointment("admin", "completed", flags);
    expect(canEditAppointment(ROLES.admin, appt).allowed).toBe(false);
    expect(canEditAppointment(ROLES.admin, appt, { notesOnly: true }).allowed).toBe(true);
    expect(canDocumentAppointment(ROLES.admin, appt).allowed).toBe(false);
    expect(canReopenAppointment(ROLES.admin, appt).allowed).toBe(false);
    expect(canDeleteAppointment(ROLES.admin, appt).allowed).toBe(true);
    expect(canDeleteAppointment(ROLES.employee_assigned, appt).allowed).toBe(false);
  });

  it("Teamleiter darf editieren, aber nicht dokumentieren oder wiedereröffnen", () => {
    const flags: ScenarioFlags = { isLocked: false, isMonthClosed: false };
    const inProgress = buildAppointment("team_lead", "in-progress", flags);
    expect(canEditAppointment(ROLES.team_lead, inProgress).allowed).toBe(true);
    expect(canDocumentAppointment(ROLES.team_lead, inProgress).allowed).toBe(false);
    const completed = buildAppointment("team_lead", "completed", flags);
    expect(canReopenAppointment(ROLES.team_lead, completed).allowed).toBe(false);
    // Teamleiter darf nur nicht-gestartete Termine löschen.
    expect(canDeleteAppointment(ROLES.team_lead, completed).allowed).toBe(false);
    const scheduled = buildAppointment("team_lead", "scheduled", flags);
    expect(canDeleteAppointment(ROLES.team_lead, scheduled).allowed).toBe(true);
  });

  it("Erstberatung-Create benötigt Erstberater-Rolle (außer Admin/TL)", () => {
    const base = {
      date: "2026-05-01",
      isWeekend: false,
      isHoliday: false,
      isFarPast: false,
      isMonthClosed: false,
      appointmentType: "Erstberatung" as const,
    };
    expect(canCreateAppointment(ROLES.employee_assigned, base).allowed).toBe(false);
    expect(canCreateAppointment({ ...ROLES.employee_assigned, roles: ["erstberatung"] }, base).allowed).toBe(true);
    expect(canCreateAppointment(ROLES.team_lead, base).allowed).toBe(true);
    expect(canCreateAppointment(ROLES.admin, base).allowed).toBe(true);
  });

  it("Wochenende / Feiertag blockiert ALLE Rollen; >3 Monate Vergangenheit nur Mitarbeiter", () => {
    const base = {
      date: "2026-05-02",
      appointmentType: "Kundentermin" as const,
      isMonthClosed: false,
      isAssignedToCustomer: true,
    };
    // Wochenende & Feiertag: harte Sperre für alle (auch Admin), entspricht
    // der Erwartung der bestehenden Geschäftsregel (siehe BIZ-1.3 in
    // tests/appointments.test.ts).
    const weekend = { ...base, isWeekend: true, isHoliday: false, isFarPast: false };
    expect(canCreateAppointment(ROLES.employee_assigned, weekend).allowed).toBe(false);
    expect(canCreateAppointment(ROLES.admin, weekend).allowed).toBe(false);
    expect(canCreateAppointment(ROLES.super_admin, weekend).allowed).toBe(false);
    const holiday = { ...base, isWeekend: false, isHoliday: true, isFarPast: false };
    expect(canCreateAppointment(ROLES.employee_assigned, holiday).allowed).toBe(false);
    expect(canCreateAppointment(ROLES.admin, holiday).allowed).toBe(false);
    // >3 Monate Vergangenheit: Mitarbeiter blockiert, Admin/SuperAdmin dürfen
    // (z. B. nachträgliche Buchung).
    const farPast = { ...base, isWeekend: false, isHoliday: false, isFarPast: true };
    expect(canCreateAppointment(ROLES.employee_assigned, farPast).allowed).toBe(false);
    expect(canCreateAppointment(ROLES.admin, farPast).allowed).toBe(true);
  });

  /**
   * Explizite Wahrheits-Tabelle als externer Oracle: jede Zeile ist eine
   * vollständige (Rolle × Status × Flags × Aktion) → erwartetes Boolean-Tupel.
   * Damit prüft der Test nicht nur „Doku == Code", sondern „Code == fixierte
   * Spezifikation". Wer Verhalten ändert, muss diese Tabelle bewusst anpassen.
   */
  it("Wahrheits-Tabelle (Rolle × Status × Flags) liefert exakt erwartete Decisions", () => {
    type Row = {
      role: RoleKey;
      status: AppointmentStatus;
      flags: ScenarioFlags;
      assignedToCustomer?: boolean;
      expected: Partial<Record<AppointmentAction, boolean>>;
    };
    const open: ScenarioFlags = { isLocked: false, isMonthClosed: false };
    const closed: ScenarioFlags = { isLocked: false, isMonthClosed: true };
    const locked: ScenarioFlags = { isLocked: true, isMonthClosed: false };

    const rows: Row[] = [
      // Deaktivierter User: nichts erlaubt
      { role: "guest_inactive", status: "scheduled", flags: open,
        expected: { view: false, create: false, edit: false, delete: false, document: false, reopen: false, overrideClosedMonth: false } },

      // Fremder Mitarbeiter (nicht zugewiesen, nicht Kunden-Backup)
      { role: "employee_other", status: "scheduled", flags: open,
        expected: { view: false, edit: false, delete: false, document: false, reopen: false } },
      { role: "employee_other", status: "completed", flags: open,
        expected: { view: false, edit: false, delete: false, document: false, reopen: false } },

      // Zugewiesener Mitarbeiter — Happy Path
      { role: "employee_assigned", status: "scheduled", flags: open,
        expected: { view: true, edit: true, delete: true, document: true, reopen: false, overrideClosedMonth: false } },
      { role: "employee_assigned", status: "in-progress", flags: open,
        expected: { edit: true, delete: true, document: true, reopen: false } },
      { role: "employee_assigned", status: "completed", flags: open,
        expected: { edit: true, delete: false, document: false, reopen: true } },
      // Lock blockiert Edit/Document/Reopen, MA darf nicht löschen
      { role: "employee_assigned", status: "completed", flags: locked,
        expected: { edit: false, delete: false, document: false, reopen: false } },
      // Monatsabschluss blockiert Edit/Document/Reopen/Delete für MA
      { role: "employee_assigned", status: "completed", flags: closed,
        expected: { edit: false, delete: false, document: false, reopen: false } },

      // Mitarbeiter (Kunden-Backup, nicht direkt zugewiesen)
      { role: "employee_assigned_to_customer", status: "scheduled", flags: open, assignedToCustomer: true,
        expected: { view: true, edit: false, delete: false, document: false } },
      { role: "employee_assigned_to_customer", status: "scheduled", flags: open, assignedToCustomer: false,
        expected: { view: false } },

      // Teamleitung
      { role: "team_lead", status: "scheduled", flags: open,
        expected: { view: true, edit: true, delete: true, document: false, reopen: false } },
      { role: "team_lead", status: "in-progress", flags: open,
        expected: { edit: true, delete: false, document: false } },
      { role: "team_lead", status: "completed", flags: open,
        expected: { edit: true, delete: false, document: false, reopen: false } },
      { role: "team_lead", status: "completed", flags: closed,
        expected: { edit: false, delete: false, reopen: false, overrideClosedMonth: false } },

      // Admin
      { role: "admin", status: "completed", flags: open,
        expected: { view: true, edit: true, delete: true, document: false, reopen: true } },
      { role: "admin", status: "completed", flags: locked,
        expected: { edit: false, delete: true, document: false, reopen: false } },
      { role: "admin", status: "completed", flags: closed,
        expected: { edit: false, delete: false, reopen: false, overrideClosedMonth: false } },

      // Superadmin
      { role: "super_admin", status: "completed", flags: closed,
        expected: { view: true, edit: true, delete: true, document: false, reopen: true, overrideClosedMonth: true } },
      { role: "super_admin", status: "completed", flags: locked,
        expected: { edit: false, delete: true, document: false, reopen: false, overrideClosedMonth: true } },
    ];

    for (const row of rows) {
      const appt = buildAppointment(row.role, row.status, row.flags);
      const user = ROLES[row.role];
      const isAssignedToCustomer = row.assignedToCustomer
        ?? row.role === "employee_assigned_to_customer";
      for (const [action, expected] of Object.entries(row.expected) as [AppointmentAction, boolean][]) {
        const actual = evalAction(action, user, appt, isAssignedToCustomer);
        expect(
          actual,
          `${row.role} / ${row.status} / lock=${row.flags.isLocked} / monthClosed=${row.flags.isMonthClosed} / ${action}`,
        ).toBe(expected);
      }
    }
  });

  it("Generierte Markdown-Matrix entspricht docs/permissions-matrix-appointments.md", () => {
    const expected = generateMatrixMarkdown();
    if (process.env.UPDATE_MATRIX_DOC === "1") {
      fs.mkdirSync(path.dirname(DOC_PATH), { recursive: true });
      fs.writeFileSync(DOC_PATH, expected, "utf-8");
    }
    const actual = fs.existsSync(DOC_PATH) ? fs.readFileSync(DOC_PATH, "utf-8") : "";
    expect(actual).toBe(expected);
  });
});
