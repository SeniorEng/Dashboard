/**
 * Task #604 — Audit: verbleibende §45b-Carryover-Duplikate aus Wizard-vs-Auto.
 *
 * Hintergrund:
 *   Task #601 hat den Bug behoben, bei dem der §45b-Übertrag aus dem Vorjahr
 *   bei der Kundenanlage über den Wizard doppelt geschrieben wurde (Wizard
 *   nutzt `year = sourceYear`, Auto-Pfad `year = targetYear` — der Dedup-
 *   Check vergleicht nur `year`). Die Startup-Migration
 *   `server/startup/backfill-duplicate-wizard-carryovers.ts` räumt seit #601
 *   beim Boot idempotent auf — ABER nur, wenn an der zu löschenden Zeile
 *   keine Budget-Transaktionen hängen. Verlinkte Allokationen werden
 *   übersprungen und müssen manuell GoBD-konform aufgelöst werden.
 *
 * Was das Skript tut:
 *   1) Findet alle lebenden §45b-Carryover-Allokationen und gruppiert sie
 *      nach `(customer_id, valid_from, expires_at)`.
 *   2) Meldet pro Gruppe mit ≥ 2 Zeilen, welche Zeile die Backfill-Logik
 *      behalten würde (siehe Sortier-Regel im Backfill: `created_by_user_id
 *      IS NOT NULL` zuerst, dann ID asc) und welche Zeilen Backfill-Kandidaten
 *      wären.
 *   3) Für jeden Kandidaten wird geprüft, ob `budget_transactions.allocation_id`
 *      auf ihn verweist. Gruppen mit verlinkten Kandidaten sind die
 *      „skipped"-Fälle, die der Backfill stehen lässt.
 *   4) Im `--apply`-Modus wird pro skipped-Kandidat eine **Storno-Allokation**
 *      (`source = "carryover"`, `amount_cents = -dupe.amountCents`, gleiche
 *      `valid_from`/`expires_at`/`year` wie das Duplikat) angelegt UND ein
 *      Audit-Eintrag `budget_allocation_storno` geschrieben. Die Original-
 *      Zeile bleibt unverändert (GoBD-Immutabilität) — die verlinkten
 *      Buchungen zeigen weiter auf eine existierende Allokation. Die
 *      negative Carryover-Zeile fließt sowohl in `calculateAllocated45b`
 *      (carryoverTotal, gleiche year/window-Filter) als auch in den
 *      Summary-Pfad `getCarryoverCents` (SUM über `source='carryover'` im
 *      Gültigkeitsfenster) ein und neutralisiert das Duplikat in beiden
 *      Anzeigewegen exakt.
 *
 *   Nicht-verlinkte Kandidaten lässt das Skript bewusst dem Backfill — der
 *   nächste App-Boot räumt sie idempotent per Soft-Delete weg.
 *
 * Aufruf:
 *   npx tsx scripts/audit-duplicate-wizard-carryovers.ts             # Dry-Run
 *   npx tsx scripts/audit-duplicate-wizard-carryovers.ts --apply     # Schreibt Storno + Audit
 *   npx tsx scripts/audit-duplicate-wizard-carryovers.ts --allow-prod
 *
 * Exit-Codes:
 *   0 — Lauf erfolgreich (egal ob es Duplikate gab)
 *   2 — Prod-Guard ausgelöst (DATABASE_URL sieht nach Produktion aus)
 *   3 — Unerwarteter Fehler / kein Audit-Akteur verfügbar
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../server/lib/db";
import {
  auditLog,
  budgetAllocations,
  budgetTransactions,
  customers,
} from "@shared/schema";
import { auditService } from "../server/services/audit";

type AllocRow = typeof budgetAllocations.$inferSelect;

interface DuplicateGroup {
  customerId: number;
  customerName: string;
  validFrom: string;
  expiresAt: string | null;
  keep: AllocRow;
  candidates: Array<{ row: AllocRow; linkedTxIds: number[] }>;
}

function isProdHost(): boolean {
  const url = process.env.DATABASE_URL ?? "";
  return /neon\.tech|prod|production/i.test(url) && !/test|dev|staging/i.test(url);
}

async function loadDuplicates(): Promise<DuplicateGroup[]> {
  const rows = await db
    .select()
    .from(budgetAllocations)
    .where(
      and(
        eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
        eq(budgetAllocations.source, "carryover"),
        isNull(budgetAllocations.deletedAt),
      ),
    );

  const groups = new Map<string, AllocRow[]>();
  for (const row of rows) {
    const key = `${row.customerId}|${row.validFrom}|${row.expiresAt ?? ""}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  const result: DuplicateGroup[] = [];
  const customerIds = new Set<number>();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.forEach((r) => customerIds.add(r.customerId));
  }
  if (customerIds.size === 0) return result;

  const nameRows = await db
    .select({ id: customers.id, name: customers.name })
    .from(customers)
    .where(sql`${customers.id} = ANY(${Array.from(customerIds)})`);
  const names = new Map(nameRows.map((r) => [r.id, r.name]));

  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => {
      const aHasUser = a.createdByUserId != null ? 0 : 1;
      const bHasUser = b.createdByUserId != null ? 0 : 1;
      if (aHasUser !== bHasUser) return aHasUser - bHasUser;
      return a.id - b.id;
    });
    const keep = sorted[0];
    const cands = sorted.slice(1);
    const linked = await Promise.all(
      cands.map(async (row) => {
        const tx = await db
          .select({ id: budgetTransactions.id })
          .from(budgetTransactions)
          .where(eq(budgetTransactions.allocationId, row.id));
        return { row, linkedTxIds: tx.map((t) => t.id) };
      }),
    );
    result.push({
      customerId: keep.customerId,
      customerName: names.get(keep.customerId) ?? `#${keep.customerId}`,
      validFrom: keep.validFrom,
      expiresAt: keep.expiresAt,
      keep,
      candidates: linked,
    });
  }
  return result;
}

async function getAuditUserId(): Promise<number | null> {
  const r = await db.execute(
    /* sql */ `SELECT id FROM users WHERE role IN ('superadmin','admin') ORDER BY id ASC LIMIT 1`,
  );
  const rows = (r as { rows: Array<{ id: number }> }).rows;
  return rows[0]?.id ?? null;
}

async function alreadyStorno(allocationId: number): Promise<boolean> {
  const r = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "budget_allocation_storno"),
        sql`${auditLog.metadata}->>'stornoOfAllocationId' = ${String(allocationId)}`,
      ),
    )
    .limit(1);
  return r.length > 0;
}

async function writeStorno(
  group: DuplicateGroup,
  dupe: AllocRow,
  actorId: number,
): Promise<{ stornoId: number }> {
  const [car] = await db
    .insert(budgetAllocations)
    .values({
      customerId: dupe.customerId,
      budgetType: dupe.budgetType,
      source: "carryover",
      year: dupe.year,
      month: dupe.month,
      amountCents: -dupe.amountCents,
      validFrom: dupe.validFrom,
      expiresAt: dupe.expiresAt,
      createdByUserId: actorId,
      notes: `Task #604 Carryover-Storno für Duplikat ${dupe.id} (Wizard-vs-Auto, #601). Original bleibt wegen verlinkter Buchungen erhalten.`,
    })
    .returning({ id: budgetAllocations.id });
  await auditService.log(
    actorId,
    "budget_allocation_storno",
    "budget",
    dupe.customerId,
    {
      task: "#604",
      reason: "duplicate_carryover_wizard_vs_auto_with_linked_tx",
      stornoOfAllocationId: dupe.id,
      keptAllocationId: group.keep.id,
      stornoAllocationId: car.id,
      budgetType: dupe.budgetType,
      amountCents: dupe.amountCents,
      validFrom: dupe.validFrom,
      expiresAt: dupe.expiresAt,
      linkedTxCount: group.candidates.find((c) => c.row.id === dupe.id)?.linkedTxIds.length ?? 0,
    },
  );
  return { stornoId: car.id };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const allowProd = process.argv.includes("--allow-prod");
  if (isProdHost() && !allowProd) {
    console.error("REFUSE: DATABASE_URL sieht nach Produktion aus. Mit --allow-prod erneut aufrufen.");
    process.exit(2);
  }
  const mode = apply ? "APPLY (schreibt Storno + Audit)" : "DRY-RUN (Default)";
  console.log(`\n=== §45b-Carryover-Duplikate Audit (${mode}) ===\n`);

  const groups = await loadDuplicates();
  if (groups.length === 0) {
    console.log("Keine doppelten §45b-Carryover-Allokationen (lebend, gleiche validFrom/expiresAt) gefunden.");
    console.log("→ Production ist sauber. Der Startup-Backfill aus #601 hat alle Fälle aufgelöst.");
    return;
  }

  let skippedByBackfill = 0;
  let backfillEligible = 0;
  let pendingStornos = 0;
  for (const g of groups) {
    const linkedCands = g.candidates.filter((c) => c.linkedTxIds.length > 0);
    const cleanCands = g.candidates.filter((c) => c.linkedTxIds.length === 0);
    skippedByBackfill += linkedCands.length;
    backfillEligible += cleanCands.length;
    const status = linkedCands.length > 0 ? "SKIPPED (linked tx)" : "backfill-fähig";
    console.log(
      `[#${String(g.customerId).padStart(5)}] ${g.customerName.padEnd(28).slice(0, 28)}  ` +
      `validFrom=${g.validFrom}  keep=#${g.keep.id}  ` +
      `dupes=[${g.candidates.map((c) => `#${c.row.id}(${(c.row.amountCents / 100).toFixed(2)}€${c.linkedTxIds.length ? `,tx=${c.linkedTxIds.length}` : ""})`).join(",")}]  ${status}`,
    );
    for (const c of linkedCands) {
      const dup = await alreadyStorno(c.row.id);
      if (!dup) pendingStornos++;
      console.log(
        `         └─ #${c.row.id}: ${dup ? "Storno bereits geschrieben (idempotent skip)" : "Storno offen"}`,
      );
    }
  }
  console.log("─".repeat(110));
  console.log(
    `\nGruppen gesamt: ${groups.length}   Backfill-fähig: ${backfillEligible}   ` +
    `Backfill-skipped (linked tx): ${skippedByBackfill}   offen zu stornieren: ${pendingStornos}\n`,
  );

  if (!apply) {
    console.log("Hinweis: --apply schreibt pro skipped-Kandidat zwei Korrektur-Allokationen");
    console.log("        (manual_adjustment + carryover, beide negativ) plus einen");
    console.log("        budget_allocation_storno-Audit-Eintrag. Idempotent über stornoOfAllocationId.");
    return;
  }
  if (pendingStornos === 0) {
    console.log("Keine offenen Stornos — entweder alle bereits geschrieben oder alle Duplikate sind backfill-fähig.");
    return;
  }

  const actorId = await getAuditUserId();
  if (actorId == null) {
    console.error("Kein admin/superadmin-User für Audit-Akteur gefunden — Abbruch.");
    process.exit(3);
  }
  let written = 0;
  for (const g of groups) {
    for (const c of g.candidates) {
      if (c.linkedTxIds.length === 0) continue;
      if (await alreadyStorno(c.row.id)) continue;
      const ids = await writeStorno(g, c.row, actorId);
      console.log(
        `✓ Storno für Allokation #${c.row.id} (Kunde ${g.customerName}): carryover=#${ids.stornoId}`,
      );
      written++;
    }
  }
  console.log(`\n✓ ${written} Storno-Block(s) geschrieben.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Audit fehlgeschlagen:", err);
    process.exit(3);
  });
