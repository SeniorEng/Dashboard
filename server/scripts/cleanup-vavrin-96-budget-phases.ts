/**
 * Task #1777 — Datenkorrektur für Katrin Vavrin (Kunde #96, PROD).
 *
 * Am 16.07.2026 hat ein einzelnes Speichern der Budget-Einstellungen versehentlich
 * doppelte, zukunfts-datierte Budget-Phasen auf §45b und §39/§42a erzeugt. Ursache:
 * das Speichern hat zusätzlich die Töpfe umsortiert (§39/§42a → Priorität 1,
 * §45b → Priorität 2). Eine Prioritäts-Änderung zählt für BEIDE Töpfe als echte
 * Änderung → beide bekamen eine neue historisierte Version. §39/§42a nutzte das
 * getippte „Gültig ab" (17.07.), §45b hatte ein leeres „Gültig ab" → Fallback auf
 * „neue Version ab morgen" (= 17.07., weil am 16.07. gespeichert). Die 16.07./17.07.-
 * Zeilen sind Unfall-Einträge, keine echten historischen Zustände.
 *
 * Ziel-Zustand (Beträge unverändert, verfügbares Budget identisch):
 *   - §45b (entlastungsbetrag_45b): GENAU EINE offene Version — id 73, enabled,
 *     Priorität 2, valid_from = Epoch-Sentinel (undatiert), valid_to = NULL (offen),
 *     keine Limits. Zeilen 480 & 481 (Unfall) werden entfernt.
 *   - §39/§42a (ersatzpflege_39_42a): GENAU EINE offene wertbelegte Version — id 447,
 *     enabled, Priorität 1, valid_from = 2026-06-03, valid_to = NULL (offen),
 *     3.539 €/Jahr (yearly_limit 353900). Zeile 479 (Unfall) wird entfernt. Die
 *     deaktivierte Vorgeschichte id 149 (bis 02.06.) bleibt unangetastet.
 *   - §45a (umwandlung_45a): unverändert (148, 446).
 *
 * GoBD: customer_budget_type_settings ist per BEFORE-Trigger geschützt. Hard-DELETE
 * und UPDATE laufen daher in EINER Transaktion mit
 * `SET LOCAL app.allow_gobd_mutation = 'on'`.
 *
 * Reihenfolge wegen des Partial-Unique-Index (nur eine offene Zeile pro
 * customer+budget_type): erst die versehentlichen offenen Zeilen (480, 479)
 * löschen, DANN die Überlebenden (73, 447) wieder öffnen.
 *
 * Ausführung:
 *   tsx server/scripts/cleanup-vavrin-96-budget-phases.ts            # Dry-Run
 *   tsx server/scripts/cleanup-vavrin-96-budget-phases.ts --apply    # Schreibend
 *
 * NUR gegen PRODUKTION ausführen (Prod-Datenkorrektur). NICHT gegen die Dev-DB.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { customerBudgetTypeSettings, users } from "@shared/schema";
import { auditService } from "../services/audit";

const CUSTOMER_ID = 96;
const APPLY = process.argv.includes("--apply");

const EPOCH = "1970-01-01";

interface Row {
  id: number;
  budget_type: string;
  enabled: boolean;
  priority: number;
  monthly_limit_cents: number | null;
  yearly_limit_cents: number | null;
  valid_from: string | null;
  valid_to: string | null;
}

function dateISO(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

async function readRows(): Promise<Row[]> {
  const res = await db.execute(sql`
    SELECT id, budget_type, enabled, priority, monthly_limit_cents,
           yearly_limit_cents, valid_from, valid_to
    FROM customer_budget_type_settings
    WHERE customer_id = ${CUSTOMER_ID}
    ORDER BY budget_type, valid_from
  `);
  return (res.rows as Record<string, unknown>[]).map(r => ({
    id: Number(r.id),
    budget_type: String(r.budget_type),
    enabled: Boolean(r.enabled),
    priority: Number(r.priority),
    monthly_limit_cents: r.monthly_limit_cents == null ? null : Number(r.monthly_limit_cents),
    yearly_limit_cents: r.yearly_limit_cents == null ? null : Number(r.yearly_limit_cents),
    valid_from: dateISO(r.valid_from),
    valid_to: dateISO(r.valid_to),
  }));
}

function printRows(label: string, rows: Row[]) {
  console.log(`\n${label}:`);
  console.table(rows.map(r => ({
    id: r.id,
    typ: r.budget_type,
    on: r.enabled,
    pri: r.priority,
    monat: r.monthly_limit_cents,
    jahr: r.yearly_limit_cents,
    von: r.valid_from ?? "(leer)",
    bis: r.valid_to ?? "(offen)",
  })));
}

/** Sicherheits-Check: erwartete Signatur einer Zeile, bevor wir sie anfassen. */
function assertRow(rows: Row[], id: number, expect: Partial<Row>): Row | null {
  const row = rows.find(r => r.id === id);
  if (!row) return null;
  const rec = row as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(expect)) {
    if (rec[k] !== v) {
      throw new Error(
        `[vavrin-96] Zeile ${id}: unerwarteter Wert ${k}=${JSON.stringify(rec[k])} (erwartet ${JSON.stringify(v)}). Abbruch — keine Änderung.`,
      );
    }
  }
  return row;
}

async function findOperatorUserId(): Promise<number | null> {
  const [u] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isSuperAdmin, true))
    .limit(1);
  return u?.id ?? null;
}

async function main() {
  console.log(`\n=== Vavrin-Korrektur Kunde #${CUSTOMER_ID} (Task #1777) ===`);
  console.log(`Modus: ${APPLY ? "APPLY (schreibend)" : "DRY-RUN"}`);

  const before = await readRows();
  printRows("VORHER", before);

  // Idempotenz: Ziel-Zustand bereits erreicht?
  const openByType = new Map<string, Row[]>();
  for (const r of before) {
    if (r.valid_to == null) {
      const l = openByType.get(r.budget_type) ?? [];
      l.push(r);
      openByType.set(r.budget_type, l);
    }
  }
  const accidentals = before.filter(r => [480, 481, 479].includes(r.id));
  if (accidentals.length === 0) {
    console.log("\n[vavrin-96] Unfall-Zeilen (479/480/481) bereits entfernt — vermutlich schon korrigiert. Prüfe Endzustand …");
  }

  // Sicherheits-Checks der anzufassenden Zeilen (nur wenn noch vorhanden).
  const r73 = assertRow(before, 73, { budget_type: "entlastungsbetrag_45b", enabled: true });
  const r447 = assertRow(before, 447, { budget_type: "ersatzpflege_39_42a", enabled: true, yearly_limit_cents: 353900, valid_from: "2026-06-03" });
  assertRow(before, 481, { budget_type: "entlastungsbetrag_45b", valid_from: "2026-07-16", valid_to: "2026-07-16" });
  assertRow(before, 480, { budget_type: "entlastungsbetrag_45b", valid_from: "2026-07-17" });
  assertRow(before, 479, { budget_type: "ersatzpflege_39_42a", valid_from: "2026-07-17" });

  if (!r73 || !r447) {
    if (accidentals.length === 0) {
      console.log("[vavrin-96] Nichts zu tun.");
      return;
    }
    throw new Error("[vavrin-96] Überlebende Zeilen (73/447) fehlen — Zustand unerwartet. Abbruch.");
  }

  console.log("\nGeplante Änderungen:");
  console.log("  - DELETE §45b Unfall-Zeilen 480, 481");
  console.log("  - DELETE §39/§42a Unfall-Zeile 479");
  console.log("  - UPDATE §45b Zeile 73: priority 1 → 2, valid_to → NULL (offen)");
  console.log("  - UPDATE §39/§42a Zeile 447: priority 2 → 1, valid_to → NULL (offen)");

  if (!APPLY) {
    console.log("\n[vavrin-96] DRY-RUN — mit --apply ausführen (nur gegen PROD).");
    return;
  }

  const operatorUserId = await findOperatorUserId();

  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.allow_gobd_mutation = 'on'`);

    // 1) Unfall-Zeilen löschen (zuerst die offenen 480/479, damit der
    //    Partial-Unique-Index beim Wieder-Öffnen der Überlebenden nicht bricht).
    await tx
      .delete(customerBudgetTypeSettings)
      .where(and(
        eq(customerBudgetTypeSettings.customerId, CUSTOMER_ID),
        sql`${customerBudgetTypeSettings.id} IN (480, 481, 479)`,
      ));

    // 2) §45b Überlebende (73): Priorität 2, wieder öffnen.
    await tx
      .update(customerBudgetTypeSettings)
      .set({ priority: 2, validTo: null, updatedAt: sql`now()` })
      .where(and(
        eq(customerBudgetTypeSettings.customerId, CUSTOMER_ID),
        eq(customerBudgetTypeSettings.id, 73),
      ));

    // 3) §39/§42a Überlebende (447): Priorität 1, wieder öffnen.
    await tx
      .update(customerBudgetTypeSettings)
      .set({ priority: 1, validTo: null, updatedAt: sql`now()` })
      .where(and(
        eq(customerBudgetTypeSettings.customerId, CUSTOMER_ID),
        eq(customerBudgetTypeSettings.id, 447),
      ));
  });

  if (operatorUserId != null) {
    await auditService.log(
      operatorUserId,
      "budget_type_settings_transition",
      "budget",
      CUSTOMER_ID,
      {
        customerId: CUSTOMER_ID,
        task: "task-1777",
        script: "cleanup-vavrin-96-budget-phases",
        reason: "Versehentliche 16.07./17.07.-Budget-Phasen (Prioritäts-Umsortierung) bereinigt: §45b 480/481 + §39/§42a 479 gelöscht, Überlebende 73 (§45b, pri 2) & 447 (§39/§42a, pri 1) wieder geöffnet. Beträge unverändert.",
        removedRowIds: [480, 481, 479],
        reopenedRowIds: [73, 447],
      },
    );
  } else {
    console.warn("[vavrin-96] Kein Superadmin gefunden — Audit-Eintrag übersprungen (Datenfix trotzdem angewendet).");
  }

  const after = await readRows();
  printRows("NACHHER", after);

  // Verifikation des Endzustands.
  const errors: string[] = [];
  const open = after.filter(r => r.valid_to == null);
  const openTypes = new Map<string, Row[]>();
  for (const r of open) {
    const l = openTypes.get(r.budget_type) ?? [];
    l.push(r);
    openTypes.set(r.budget_type, l);
  }
  for (const [type, list] of openTypes) {
    if (list.length !== 1) errors.push(`${type}: ${list.length} offene Zeilen (erwartet 1)`);
  }

  const f45b = open.find(r => r.budget_type === "entlastungsbetrag_45b");
  if (!f45b || f45b.id !== 73 || f45b.priority !== 2 || f45b.valid_from !== EPOCH || f45b.monthly_limit_cents !== null || f45b.yearly_limit_cents !== null) {
    errors.push(`§45b offene Zeile weicht ab: ${JSON.stringify(f45b)}`);
  }
  const f39 = open.find(r => r.budget_type === "ersatzpflege_39_42a");
  if (!f39 || f39.id !== 447 || f39.priority !== 1 || f39.valid_from !== "2026-06-03" || f39.yearly_limit_cents !== 353900) {
    errors.push(`§39/§42a offene Zeile weicht ab: ${JSON.stringify(f39)}`);
  }
  if (after.some(r => [480, 481, 479].includes(r.id))) {
    errors.push("Unfall-Zeilen (479/480/481) noch vorhanden.");
  }

  if (errors.length > 0) {
    console.error("\n⚠ Verifikation fehlgeschlagen:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(2);
  }
  console.log("\n✓ Endzustand verifiziert: genau eine offene Zeile pro aktivem Topf, Beträge unverändert.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[vavrin-96] Fehler:", err);
    process.exit(1);
  });
