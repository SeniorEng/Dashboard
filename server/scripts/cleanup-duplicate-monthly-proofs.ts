/**
 * Task #1527 — Bereits in Produktion entstandene doppelte monatliche
 * Leistungsnachweise (LN) bereinigen.
 *
 * Problem
 * -------
 * Task #1526 hat die NEU-Entstehung doppelter monatlicher Leistungsnachweise
 * gestoppt (Pending-Merge mit `FOR UPDATE` innerhalb der Erstell-Transaktion)
 * und alle LNs in der Übersicht sichtbar gemacht. Kunden, die VOR dem Fix in
 * den Bug gelaufen sind (z.B. Käthe/Maxim), können jedoch weiterhin ZWEI
 * pending monatliche LNs für denselben (customerId, employeeId, year, month)
 * im Bestand haben. Diese Alt-Duplikate werden vom Code-Fix nicht berührt und
 * müssen einmalig bereinigt werden, damit das Büro pro Monat genau einen
 * sauberen Leistungsnachweis sieht.
 *
 * Erkennung (SSoT)
 * ----------------
 * Gruppen (customerId, employeeId, year, month) mit
 *   recordType='monthly' AND status='pending' AND deleted_at IS NULL
 * und COUNT(*) > 1. Pro Gruppe ist der LN mit der KLEINSTEN id der „Keeper"
 * (deckungsgleich mit `getPendingMonthlyServiceRecord`, das per
 * `ORDER BY id LIMIT 1` immer die niedrigste pending-Zeile zurückgibt — der
 * Live-Code würde also künftig genau diesen LN weiter befüllen).
 *
 * Merge-Pfad (--apply)
 * --------------------
 * Pro Gruppe in EINER Transaktion (`withAudit`, atomar mit Audit-Log):
 *   1. Termin-Verknüpfungen jeder Duplikat-Zeile in den Keeper übernehmen
 *      (`addAppointmentsToServiceRecord`, `onConflictDoNothing` → idempotent,
 *      keine Doppel-Links). Die Verknüpfungen des Duplikats bleiben physisch
 *      bestehen; da das Duplikat soft-gelöscht wird, blendet jeder Reader
 *      (`getAppointmentsForServiceRecord`, `getServiceRecordForAppointment`,
 *      `isAppointmentLocked`, `getAppointmentIdsInServiceRecords`) sie über den
 *      `deleted_at IS NULL`-Filter aus → der Termin löst eindeutig auf den
 *      Keeper auf.
 *   2. Das Duplikat wird soft-gelöscht (`deleted_at = NOW()`).
 *   3. Ein `service_record_deleted`-Audit-Eintrag wird geschrieben (Keeper-ID,
 *      übernommene Termin-IDs, Begründung).
 *
 * GoBD
 * ----
 *   - NUR `status='pending'`-LNs werden gemergt/gelöscht. `employee_signed` und
 *     `completed` (GoBD-versiegelt) werden NIEMALS angefasst — sie sind weder
 *     Keeper-Kandidat noch Lösch-Kandidat (der Status-Filter schließt sie
 *     vollständig aus).
 *   - `monthly_service_records` ist NICHT GoBD-trigger-geschützt (die
 *     Immutabilitäts-Trigger decken nur budget_allocations,
 *     customer_budget_type_settings, invoices, invoice_line_items ab; siehe
 *     server/startup/ensure-gobd-table-immutability.ts). Daher ist KEIN
 *     `SET LOCAL app.allow_gobd_mutation` nötig — der Soft-Delete (UPDATE
 *     deleted_at) läuft ohne Bypass. (Falls künftig ein Trigger ergänzt wird,
 *     müsste hier ein gegateter Bypass eingezogen werden.)
 *   - Idempotent: ist eine Gruppe bereits bereinigt (nur noch ein pending), wird
 *     sie nicht mehr gefunden. Re-Run = No-Op.
 *
 * Sicherheit
 * ----------
 *   - Trockenlauf ist Default; `--apply` schreibt erst nach explizitem Opt-in.
 *   - `--apply` erfordert `--user=<superadmin-id>` (Audit-Attribution, nur
 *     Superadmins) UND `--reason="…"` (≥10 Zeichen, landet im Audit-Log).
 *   - Optionaler `--customer=<id,id>`-Filter, um die Blast-Radius einzugrenzen.
 *
 * Operatives Vorgehen (docs/dev-database-runbook.md, docs/pre-publish-backup-runbook.md)
 * ------------------------------------------------------------------------------------
 *   1. Trockenlauf gegen die READ-ONLY Prod-Replica (DATABASE_URL = Replica)
 *      zum Scopen der Blast-Radius — keine Schreibrechte nötig.
 *   2. Prod-Backup gemäß pre-publish-backup-runbook.
 *   3. `--apply` ausschließlich gegen Prod (DATABASE_URL = Prod-Primary).
 *   4. Verifikation: das Skript gibt nach dem Lauf die verbleibenden
 *      Duplikat-Gruppen aus (Ziel: 0).
 *
 * Aufruf
 * ------
 *   - Trockenlauf (alle):  tsx server/scripts/cleanup-duplicate-monthly-proofs.ts
 *   - Einzelne Kunden:     tsx server/scripts/cleanup-duplicate-monthly-proofs.ts --customer=39,95
 *   - Scharf:              tsx server/scripts/cleanup-duplicate-monthly-proofs.ts --apply \
 *                            --user=<superadmin-id> --reason="Doppelte LN bereinigen #1527"
 *
 * Exit-Code: 0 = keine Duplikat-Gruppe (mehr) vorhanden, 1 = mindestens eine
 * gefunden. `--apply` setzt den Exit-Code nach der Bereinigung neu (Verifikation).
 */

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, type DbOrTx } from "../lib/db";
import {
  customers,
  monthlyServiceRecords,
  serviceRecordAppointments,
  users,
} from "@shared/schema";
import { withAudit } from "../lib/with-audit";
import { addAppointmentsToServiceRecord } from "../storage/service-records-storage";
import { assertProdWriteAllowedOrThrow } from "./lib/prod-write-gate";

interface Args {
  apply: boolean;
  customerIds: number[];
  userId?: number;
  reason?: string;
  confirmTarget?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (p: string) => argv.find((a) => a.startsWith(p))?.split("=")[1];
  const apply = argv.includes("--apply");
  const customerArg = get("--customer=");
  const customerIds: number[] = [];
  if (customerArg) {
    for (const idStr of customerArg.split(",")) {
      const n = parseInt(idStr.trim(), 10);
      if (!Number.isNaN(n)) customerIds.push(n);
    }
  }
  const userArg = get("--user=");
  const userId = userArg ? parseInt(userArg, 10) : undefined;
  return {
    apply,
    customerIds,
    userId: userId !== undefined && Number.isFinite(userId) ? userId : undefined,
    reason: get("--reason="),
    confirmTarget: get("--confirm-target="),
  };
}

// Die beiden lokalen Kopien (`assertApplyTargetIsProdPrimaryOrThrow`,
// `assertSuperadminOrThrow`) sind entfallen — ERSETZT durch die SSoT
// `server/scripts/lib/prod-write-gate.ts`.
//
// Die Kopie war ihr gegenueber bereits abgedriftet: ihr Loopback-Muster
// `/^(localhost|127\.|::1|0\.0\.0\.0)/` kannte weder `::ffff:127.` noch die
// eckigen Klammern, die `new URL().hostname` bei IPv6 liefert — `[::1]`
// rutschte durch. Und sie war SYNCHRON, konnte `current_database()` also gar
// nicht abfragen. Genau die Form, an der der 18.08.2026 gescheitert ist.

export interface DuplicatePendingGroup {
  customerId: number;
  employeeId: number;
  year: number;
  month: number;
  /** Niedrigste pending-id — bleibt erhalten, sammelt alle Termine ein. */
  keeperId: number;
  /** Übrige pending-ids derselben Periode — werden gemergt & soft-gelöscht. */
  duplicateIds: number[];
}

/**
 * Findet alle (customerId, employeeId, year, month)-Gruppen mit >1 PENDING
 * monatlichem Leistungsnachweis. Der Keeper ist die kleinste id.
 */
export async function findDuplicatePendingGroups(
  customerIds: number[] = [],
  exec: DbOrTx = db,
): Promise<DuplicatePendingGroup[]> {
  const conditions = [
    eq(monthlyServiceRecords.recordType, "monthly"),
    eq(monthlyServiceRecords.status, "pending"),
    isNull(monthlyServiceRecords.deletedAt),
  ];
  if (customerIds.length > 0) {
    conditions.push(inArray(monthlyServiceRecords.customerId, customerIds));
  }

  const rows = await exec
    .select({
      id: monthlyServiceRecords.id,
      customerId: monthlyServiceRecords.customerId,
      employeeId: monthlyServiceRecords.employeeId,
      year: monthlyServiceRecords.year,
      month: monthlyServiceRecords.month,
    })
    .from(monthlyServiceRecords)
    .where(and(...conditions))
    .orderBy(
      asc(monthlyServiceRecords.customerId),
      asc(monthlyServiceRecords.employeeId),
      asc(monthlyServiceRecords.year),
      asc(monthlyServiceRecords.month),
      asc(monthlyServiceRecords.id),
    );

  const byKey = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.customerId}|${r.employeeId}|${r.year}|${r.month}`;
    const list = byKey.get(key) ?? [];
    list.push(r);
    byKey.set(key, list);
  }

  const groups: DuplicatePendingGroup[] = [];
  for (const list of byKey.values()) {
    if (list.length <= 1) continue;
    // Bereits aufsteigend nach id sortiert (ORDER BY oben).
    const [keeper, ...duplicates] = list;
    groups.push({
      customerId: keeper.customerId,
      employeeId: keeper.employeeId,
      year: keeper.year,
      month: keeper.month,
      keeperId: keeper.id,
      duplicateIds: duplicates.map((d) => d.id),
    });
  }
  return groups;
}

async function getAppointmentIdsForRecordTx(tx: DbOrTx, serviceRecordId: number): Promise<number[]> {
  const rows = await tx
    .select({ appointmentId: serviceRecordAppointments.appointmentId })
    .from(serviceRecordAppointments)
    .where(eq(serviceRecordAppointments.serviceRecordId, serviceRecordId));
  return rows.map((r) => r.appointmentId);
}

export interface MergeFinding {
  group: DuplicatePendingGroup;
  /** Termin-IDs, die je Duplikat in den Keeper übernommen wurden. */
  movedAppointmentIdsByDuplicate: Record<number, number[]>;
}

export interface CleanupSummary {
  apply: boolean;
  groupsFound: number;
  duplicatesFound: number;
  findings: MergeFinding[];
  mergedGroups: number;
  softDeletedDuplicates: number;
  /**
   * Gruppen, die im Scharflauf übersprungen wurden, weil der Keeper zwischen
   * Erkennung und Mutation versiegelt/gelöscht wurde (Race) — dann wird die
   * GANZE Gruppe NICHT angefasst.
   */
  skippedGroups: number;
  /**
   * Einzelne Duplikate, die übersprungen wurden, weil sie zwischen Erkennung
   * und Lock nicht mehr pending waren (versiegelt/gelöscht) — kein Merge, kein
   * Soft-Delete, kein Audit.
   */
  skippedDuplicates: number;
  /** Nach dem Lauf erneut ermittelte verbleibende Duplikat-Gruppen (Ziel: 0). */
  remainingGroups: number;
}

export interface MergeGroupResult {
  /** Ganze Gruppe übersprungen (Keeper nicht mehr pending unter Lock). */
  skippedGroup: boolean;
  /** Anzahl tatsächlich soft-gelöschter (gemergter) Duplikate. */
  deletedInGroup: number;
  /** Duplikate, die unter Lock nicht mehr pending waren (race-skip). */
  skippedDupsInGroup: number;
}

/**
 * Mergt EINE Duplikat-Gruppe in EINER Transaktion (`withAudit`, atomar mit
 * Audit-Log) — race-sicher: Keeper UND jedes Duplikat werden UNTER LOCK
 * (`FOR UPDATE`) re-verifiziert, BEVOR Termine kopiert, soft-gelöscht oder
 * auditiert werden. Ein zwischen Erkennung und Mutation versiegeltes
 * (employee_signed/completed) oder gelöschtes LN wird NIEMALS gemergt/gelöscht
 * und erzeugt KEINEN irreführenden Audit-Eintrag (kein Zähler-Inkrement).
 * Exportiert, damit das Race-/Skip-Verhalten direkt testbar ist.
 */
export async function mergeDuplicateGroup(
  group: DuplicatePendingGroup,
  opts: { userId: number; reason?: string },
): Promise<MergeGroupResult> {
  return withAudit(async (tx, audit) => {
    // Keeper unter Lock re-verifizieren. Ist er nicht mehr pending → ganze
    // Gruppe unangetastet lassen (nichts darf in einen versiegelten Keeper).
    const [keeperRow] = await tx
      .select({ status: monthlyServiceRecords.status, deletedAt: monthlyServiceRecords.deletedAt })
      .from(monthlyServiceRecords)
      .where(eq(monthlyServiceRecords.id, group.keeperId))
      .for("update");
    if (!keeperRow || keeperRow.status !== "pending" || keeperRow.deletedAt !== null) {
      return { skippedGroup: true, deletedInGroup: 0, skippedDupsInGroup: group.duplicateIds.length };
    }

    let deletedInGroup = 0;
    let skippedDupsInGroup = 0;
    for (const dupId of group.duplicateIds) {
      // Duplikat unter Lock re-verifizieren. Erst NACH „noch pending & nicht
      // gelöscht" werden Termine kopiert, soft-gelöscht und auditiert.
      const [dupRow] = await tx
        .select({ status: monthlyServiceRecords.status, deletedAt: monthlyServiceRecords.deletedAt })
        .from(monthlyServiceRecords)
        .where(eq(monthlyServiceRecords.id, dupId))
        .for("update");
      if (!dupRow || dupRow.status !== "pending" || dupRow.deletedAt !== null) {
        skippedDupsInGroup++;
        continue;
      }

      // 1. Termine des Duplikats in den Keeper übernehmen (idempotent).
      const apptIds = await getAppointmentIdsForRecordTx(tx, dupId);
      if (apptIds.length > 0) {
        await addAppointmentsToServiceRecord(group.keeperId, apptIds, tx);
      }

      // 2. Duplikat soft-löschen. Der WHERE-Guard (pending & nicht gelöscht) ist
      //    unter dem FOR-UPDATE-Lock redundant, bleibt aber als Defense-in-Depth;
      //    `.returning()` belegt, dass tatsächlich eine Zeile mutiert wurde,
      //    bevor Audit/Zähler laufen.
      const deleted = await tx
        .update(monthlyServiceRecords)
        .set({ deletedAt: sql`NOW()`, updatedAt: sql`NOW()` })
        .where(and(
          eq(monthlyServiceRecords.id, dupId),
          eq(monthlyServiceRecords.status, "pending"),
          isNull(monthlyServiceRecords.deletedAt),
        ))
        .returning({ id: monthlyServiceRecords.id });
      if (deleted.length === 0) {
        skippedDupsInGroup++;
        continue;
      }

      // 3. Audit.
      audit.record({
        userId: opts.userId,
        action: "service_record_deleted",
        entityType: "service_record",
        entityId: dupId,
        metadata: {
          task: "#1527",
          reason: opts.reason,
          mergedIntoServiceRecordId: group.keeperId,
          customerId: group.customerId,
          employeeId: group.employeeId,
          year: group.year,
          month: group.month,
          movedAppointmentIds: apptIds,
          duplicateMonthlyProofCleanup: true,
        },
      });
      deletedInGroup++;
    }
    return { skippedGroup: false, deletedInGroup, skippedDupsInGroup };
  });
}

export async function cleanupDuplicateMonthlyProofs(args: Args): Promise<CleanupSummary> {
  const groups = await findDuplicatePendingGroups(args.customerIds);

  // Für die Trockenlauf-Anzeige: pro Duplikat die anhängenden Termine lesen.
  const findings: MergeFinding[] = [];
  for (const group of groups) {
    const movedAppointmentIdsByDuplicate: Record<number, number[]> = {};
    for (const dupId of group.duplicateIds) {
      movedAppointmentIdsByDuplicate[dupId] = await getAppointmentIdsForRecordTx(db, dupId);
    }
    findings.push({ group, movedAppointmentIdsByDuplicate });
  }

  let mergedGroups = 0;
  let softDeletedDuplicates = 0;
  let skippedGroups = 0;
  let skippedDuplicates = 0;

  if (args.apply && args.userId !== undefined) {
    for (const group of groups) {
      const result = await mergeDuplicateGroup(group, { userId: args.userId, reason: args.reason });
      if (result.skippedGroup) {
        skippedGroups++;
        skippedDuplicates += result.skippedDupsInGroup;
        continue;
      }
      softDeletedDuplicates += result.deletedInGroup;
      skippedDuplicates += result.skippedDupsInGroup;
      if (result.deletedInGroup > 0) mergedGroups++;
    }
  }

  const remaining = await findDuplicatePendingGroups(args.customerIds);

  return {
    apply: args.apply,
    groupsFound: groups.length,
    duplicatesFound: groups.reduce((s, g) => s + g.duplicateIds.length, 0),
    findings,
    mergedGroups,
    softDeletedDuplicates,
    skippedGroups,
    skippedDuplicates,
    remainingGroups: remaining.length,
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

async function main() {
  const args = parseArgs();

  if (args.apply) {
    // EIN Aufruf statt vier Einzelpruefungen: Ziel (Host + current_database()
    // aus der OFFENEN Verbindung), Superadmin und Begruendung. Er erteilt
    // ausserdem der Laufzeit-Schreibsperre die Freigabe — ohne ihn wuerde
    // dieses Skript seit #117 beim ersten Schreibzugriff abbrechen.
    const freigabe = await assertProdWriteAllowedOrThrow(
      {
        apply: args.apply,
        userId: args.userId,
        reason: args.reason,
        confirmTarget: args.confirmTarget,
      },
      "Der Lauf merged doppelte Leistungsnachweise und soft-loescht das Duplikat.",
    );
    console.log(`Freigegeben durch: ${freigabe.displayName}`);
  }

  console.log(`\n=== Doppelte monatliche Leistungsnachweise bereinigen · Task #1527 ===`);
  console.log(`Modus:    ${args.apply ? "SCHARF (--apply)" : "Trockenlauf (read-only)"}`);
  console.log(`Kunden:   ${args.customerIds.length > 0 ? args.customerIds.join(", ") : "ALLE"}`);
  if (args.userId !== undefined) console.log(`Superadmin: ${args.userId}`);
  if (args.reason) console.log(`Begründung: ${args.reason}`);

  const summary = await cleanupDuplicateMonthlyProofs(args);

  // Kundennamen für die Ausgabe.
  const cids = Array.from(new Set(summary.findings.map((f) => f.group.customerId)));
  const names = new Map<number, string>();
  if (cids.length > 0) {
    const rows = await db
      .select({ id: customers.id, name: customers.name })
      .from(customers)
      .where(inArray(customers.id, cids));
    for (const r of rows) names.set(r.id, r.name ?? "");
  }

  console.log(`\nDuplikat-Gruppen gefunden: ${summary.groupsFound}`);
  console.log(`Überzählige pending-LNs:   ${summary.duplicatesFound}\n`);

  for (const f of summary.findings) {
    const g = f.group;
    console.log(
      `  Kunde #${g.customerId} ${names.get(g.customerId) ?? ""} · Mitarbeiter #${g.employeeId}` +
        ` · ${g.year}-${pad2(g.month)}` +
        `\n    Keeper-LN: #${g.keeperId}` +
        `\n    Duplikate: ${g.duplicateIds
          .map((d) => `#${d} (Termine: ${(f.movedAppointmentIdsByDuplicate[d] ?? []).join(", ") || "—"})`)
          .join(", ")}`,
    );
  }

  if (args.apply) {
    console.log(`\nGemergte Gruppen:          ${summary.mergedGroups}`);
    console.log(`Soft-gelöschte Duplikate:  ${summary.softDeletedDuplicates}`);
    if (summary.skippedGroups > 0 || summary.skippedDuplicates > 0) {
      console.log(
        `Übersprungen (Race):       ${summary.skippedGroups} Gruppe(n), ` +
          `${summary.skippedDuplicates} Duplikat(e) (zwischenzeitlich versiegelt/gelöscht — nicht angefasst).`,
      );
    }
    console.log(
      summary.remainingGroups === 0
        ? `\n✓ Verifikation: keine Duplikat-Gruppen mehr vorhanden.`
        : `\n! Verifikation: es verbleiben ${summary.remainingGroups} Duplikat-Gruppen (erneut prüfen).`,
    );
  } else if (summary.groupsFound > 0) {
    console.log(
      '\nHinweis: Trockenlauf — keine Änderungen geschrieben.' +
        '\n  Scharf bereinigen mit: --apply --user=<superadmin-id> --reason="…"',
    );
  } else {
    console.log("\n✓ Keine doppelten monatlichen Leistungsnachweise im Bestand.");
  }

  process.exit(summary.remainingGroups === 0 ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fehler:", err);
    process.exit(1);
  });
}
