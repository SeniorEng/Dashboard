/**
 * Reconciliation-Skript für Task #1170 — Reversal-Ketten-Korrektur im Budget-Ledger.
 *
 * Problem:
 *   Vor dem Schreib-Guard von Task #1170 konnte (über Import-Altbestand bzw.
 *   den ungeschützten Storno-Endpunkt) ein "Storno eines Stornos" entstehen:
 *   eine Reversal-Zeile R2, deren `reversed_transaction_id` auf eine Zeile R1
 *   zeigt, die SELBST `transaction_type = 'reversal'` ist. R2 trägt das
 *   umgekehrte Vorzeichen von R1 und hebt damit eine legitime Storno-Gutschrift
 *   wieder auf — ohne dass ein realer Termin neu dokumentiert wurde. Folge:
 *   Wieder-Verbrauch ohne Beleg, Netto-Verbrauch zu hoch, und die drei
 *   Lesepfade (Σ Transaktionen / FIFO-Breakdown / Overview) widersprechen sich.
 *   (Proof-Daten: Kunde 203050, Transaktionen 510349–510353; die Kette
 *    510351/510352.)
 *
 * Korrektur (GoBD: ausschließlich Append-only — KEIN DELETE/UPDATE):
 *   Pro Ketten-Zeile R2 wird eine inverse Ausgleichsbuchung (`consumption`) mit
 *   vorzeichen-invertierten Beträgen UND allen Service-Spalten angelegt. Sie
 *   neutralisiert R2 Spalte für Spalte (Σ R2 + Korrektur = 0), sodass nur das
 *   legitime Storno R1 wirksam bleibt. R2 bleibt unangetastet im Ledger stehen
 *   (Revisionssicherheit). Die Gegenbuchung ist eine `consumption` (KEINE neue
 *   `reversal`), damit keine neue Reversal-Kette entsteht.
 *
 * Sicherheit / GoBD:
 *   - Trockenlauf ist Default; `--apply` schreibt erst nach explizitem Opt-in.
 *   - `--apply` erfordert `--user=<superadmin-id>` (Audit-Attribution, nur
 *     Superadmins) UND `--reason="…"` (≥10 Zeichen, landet im Audit-Log).
 *   - Jede Korrektur + ein Sammel-Eintrag werden ins Audit-Log geschrieben.
 *   - Idempotent: bereits korrigierte Ketten werden anhand der eindeutigen
 *     Korrektur-Notiz übersprungen.
 *
 * Aufruf:
 *   - Trockenlauf (alle):  tsx server/scripts/reconcile-reversal-chains.ts
 *   - Einzelne Kunden:     tsx server/scripts/reconcile-reversal-chains.ts --customer=203050
 *   - Scharf:              tsx server/scripts/reconcile-reversal-chains.ts --apply \
 *                            --user=<superadmin-id> --reason="Reversal-Ketten Import-Drift #1170"
 */

import { randomUUID } from "node:crypto";
import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { budgetTransactions, customers, users } from "@shared/schema";
import { auditService } from "../services/audit";
import {
  detectReversalChains,
  buildReversalChainCorrectionNote,
  isReversalChainCorrectionFor,
  type PhantomLedgerRow,
} from "@shared/domain/budget/phantom-storno";

interface Args {
  apply: boolean;
  customerIds: number[];
  userId?: number;
  reason?: string;
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
  return { apply, customerIds, userId: Number.isFinite(userId) ? userId : undefined, reason: get("--reason=") };
}

async function assertSuperadminOrThrow(userId: number): Promise<void> {
  const [row] = await db
    .select({ id: users.id, isSuperAdmin: users.isSuperAdmin, isActive: users.isActive, displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw new Error(`--user=${userId}: User existiert nicht`);
  if (!row.isActive) throw new Error(`--user=${userId} (${row.displayName}) ist inaktiv`);
  if (!row.isSuperAdmin) {
    throw new Error(
      `--user=${userId} (${row.displayName}) ist kein Superadmin. ` +
        `Reversal-Ketten-Korrekturen sind Task #1170 explizit auf Superadmins beschränkt.`,
    );
  }
}

const negate = (v: number | null | undefined): number | null => (v == null ? null : -v);

interface CorrectionPreview {
  reversalId: number;          // R2 — die Storno-Storno-Zeile
  reversedReversalId: number;  // R1 — die referenzierte Reversal
  customerId: number;
  budgetType: string;
  amountCents: number;         // Betrag, der neutralisiert wird (|R2|, positiv)
  alreadyCorrected: boolean;
}

export interface ReversalChainReconcileSummary {
  apply: boolean;
  batchId?: string;
  corrections: CorrectionPreview[];
  correctedCount: number;
  skippedAlreadyCorrected: number;
  /** Pro Kunde/Topf: Netto-Verbrauch vor und (rechnerisch) nach Korrektur. */
  perCombo: Array<{ customerId: number; budgetType: string; netUsedBeforeCents: number; netUsedAfterCents: number; reReaddedConsumptionCents: number }>;
}

/** Lädt alle Ledger-Zeilen der angegebenen Kunden (oder aller Kunden). */
async function loadLedger(customerIds: number[]): Promise<PhantomLedgerRow[]> {
  const base = db
    .select({
      id: budgetTransactions.id,
      customerId: budgetTransactions.customerId,
      budgetType: budgetTransactions.budgetType,
      transactionType: budgetTransactions.transactionType,
      amountCents: budgetTransactions.amountCents,
      appointmentId: budgetTransactions.appointmentId,
      reversedTransactionId: budgetTransactions.reversedTransactionId,
      notes: budgetTransactions.notes,
    })
    .from(budgetTransactions);
  const rows = customerIds.length > 0
    ? await base.where(inArray(budgetTransactions.customerId, customerIds))
    : await base;
  return rows;
}

function netUsedFor(rows: PhantomLedgerRow[], customerId: number, budgetType: string): number {
  // Netto-Verbrauch = Σ |consumption + write_off| − Σ |reversal|
  let net = 0;
  for (const r of rows) {
    if (r.customerId !== customerId || r.budgetType !== budgetType) continue;
    if (r.transactionType === "consumption" || r.transactionType === "write_off") net += Math.abs(r.amountCents);
    else if (r.transactionType === "reversal") net -= Math.abs(r.amountCents);
  }
  return net;
}

export async function reconcileReversalChains(args: Args): Promise<ReversalChainReconcileSummary> {
  const rows = await loadLedger(args.customerIds);
  const chains = detectReversalChains(rows);

  // Bereits geschriebene Korrekturen erkennen (Idempotenz).
  const correctionNotes = rows
    .filter((r) => r.transactionType === "consumption" && r.notes && r.notes.includes("Reversal-Ketten-Korrektur"))
    .map((r) => r.notes as string);
  const isAlreadyCorrected = (reversalId: number) => correctionNotes.some((n) => isReversalChainCorrectionFor(n, reversalId));

  const previews: CorrectionPreview[] = chains.map((c) => ({
    reversalId: c.reversalId,
    reversedReversalId: c.reversedReversalId,
    customerId: c.customerId,
    budgetType: c.budgetType,
    amountCents: Math.abs(c.amountCents),
    alreadyCorrected: isAlreadyCorrected(c.reversalId),
  }));

  // Pro Kunde/Topf den Effekt aufstellen. Die Gegenbuchung re-addiert den durch
  // R2 fälschlich zurückgenommenen Verbrauch (= |R2|) wieder als Verbrauch.
  const comboKeys = Array.from(new Set(previews.map((p) => `${p.customerId}::${p.budgetType}`)));
  const perCombo = comboKeys.map((key) => {
    const [cidStr, budgetType] = key.split("::");
    const customerId = parseInt(cidStr, 10);
    const netUsedBeforeCents = netUsedFor(rows, customerId, budgetType);
    const reReaddedConsumptionCents = previews
      .filter((p) => p.customerId === customerId && p.budgetType === budgetType && !p.alreadyCorrected)
      .reduce((s, p) => s + p.amountCents, 0);
    return {
      customerId,
      budgetType,
      netUsedBeforeCents,
      netUsedAfterCents: netUsedBeforeCents + reReaddedConsumptionCents,
      reReaddedConsumptionCents,
    };
  });

  const toApply = previews.filter((p) => !p.alreadyCorrected);
  const batchId = args.apply && args.userId !== undefined && toApply.length > 0 ? randomUUID() : undefined;
  let correctedCount = 0;

  if (args.apply && args.userId !== undefined) {
    for (const p of toApply) {
      // Vollständige Storno-Storno-Zeile laden (alle Service-Spalten) für die Spiegelung.
      const [full] = await db.select().from(budgetTransactions).where(eq(budgetTransactions.id, p.reversalId)).limit(1);
      if (!full) continue;

      await db.transaction(async (tx) => {
        // Doppelte Idempotenz auf DB-Ebene: falls parallel bereits geschrieben.
        const existing = await tx
          .select({ id: budgetTransactions.id })
          .from(budgetTransactions)
          .where(
            and(
              eq(budgetTransactions.customerId, full.customerId),
              eq(budgetTransactions.transactionType, "consumption"),
              sql`${budgetTransactions.notes} LIKE ${`%Storno-Storno-Zeile #${p.reversalId} (%`}`,
            ),
          )
          .limit(1);
        if (existing.length > 0) return;

        await tx.insert(budgetTransactions).values({
          customerId: full.customerId,
          budgetType: full.budgetType,
          transactionDate: full.transactionDate,
          transactionType: "consumption",
          amountCents: -full.amountCents,
          appointmentId: full.appointmentId,
          allocationId: full.allocationId,
          reversedTransactionId: null,
          hauswirtschaftMinutes: negate(full.hauswirtschaftMinutes),
          hauswirtschaftCents: negate(full.hauswirtschaftCents),
          alltagsbegleitungMinutes: negate(full.alltagsbegleitungMinutes),
          alltagsbegleitungCents: negate(full.alltagsbegleitungCents),
          travelKilometers: negate(full.travelKilometers),
          travelCents: negate(full.travelCents),
          customerKilometers: negate(full.customerKilometers),
          customerKilometersCents: negate(full.customerKilometersCents),
          notes: `${buildReversalChainCorrectionNote(p.reversalId, p.reversedReversalId)} ${args.reason}`,
          createdByUserId: args.userId,
        });

        await auditService.log(
          args.userId!,
          "budget_transaction_corrected",
          "budget",
          full.customerId,
          {
            task: "#1170",
            batchId,
            reason: args.reason,
            reversalChainTransactionId: p.reversalId,
            reversedReversalId: p.reversedReversalId,
            budgetType: full.budgetType,
            reReaddedConsumptionCents: p.amountCents,
            classification: "reversal_chain",
          },
          undefined,
          tx,
        );
      });
      correctedCount++;
    }

    if (batchId) {
      await auditService.log(args.userId!, "budget_transaction_corrected_batch", "budget", 0, {
        task: "#1170",
        batchId,
        reason: args.reason,
        correctedCount,
        affectedCombos: perCombo.map((c) => ({ customerId: c.customerId, budgetType: c.budgetType, reReaddedConsumptionCents: c.reReaddedConsumptionCents })),
        totalReReaddedCents: perCombo.reduce((s, c) => s + c.reReaddedConsumptionCents, 0),
      });
    }
  }

  return {
    apply: args.apply,
    batchId,
    corrections: previews,
    correctedCount,
    skippedAlreadyCorrected: previews.filter((p) => p.alreadyCorrected).length,
    perCombo,
  };
}

function eur(cents: number): string {
  return `${(cents / 100).toFixed(2)} €`;
}

async function main() {
  const args = parseArgs();

  if (args.apply) {
    if (args.userId === undefined) {
      console.error("Fehler: --apply erfordert --user=<superadmin-id> für GoBD-Audit-Attribution.");
      process.exit(1);
    }
    if (!args.reason || args.reason.length < 10) {
      console.error('Fehler: --apply erfordert --reason="..." (≥10 Zeichen Begründung für den Audit-Log).');
      process.exit(1);
    }
    await assertSuperadminOrThrow(args.userId);
  }

  console.log(`Modus:        ${args.apply ? "SCHARF (--apply)" : "Trockenlauf"}`);
  console.log(`Kunden:       ${args.customerIds.length > 0 ? args.customerIds.join(", ") : "ALLE"}`);
  if (args.userId !== undefined) console.log(`Superadmin:   ${args.userId}`);
  if (args.reason) console.log(`Begründung:   ${args.reason}`);

  const summary = await reconcileReversalChains(args);

  // Namen für die Ausgabe.
  const cids = Array.from(new Set(summary.perCombo.map((c) => c.customerId)));
  const names = new Map<number, string>();
  if (cids.length > 0) {
    const rows = await db
      .select({ id: customers.id, vorname: customers.vorname, nachname: customers.nachname })
      .from(customers)
      .where(inArray(customers.id, cids));
    for (const r of rows) names.set(r.id, `${r.vorname} ${r.nachname}`);
  }

  console.log(`\nReversal-Ketten gefunden: ${summary.corrections.length} (davon bereits korrigiert: ${summary.skippedAlreadyCorrected})`);
  for (const p of summary.corrections) {
    const tag = p.alreadyCorrected ? "[bereits korrigiert]" : "[zu korrigieren]";
    console.log(
      `  ${tag} Storno-Storno #${p.reversalId} → storniert #${p.reversedReversalId} | Kunde #${p.customerId} ${p.budgetType} | ` +
        `re-addiert ${eur(p.amountCents)}`,
    );
  }

  console.log(`\n=== Effekt pro Kunde/Topf ===`);
  let total = 0;
  for (const c of summary.perCombo.sort((a, b) => b.reReaddedConsumptionCents - a.reReaddedConsumptionCents)) {
    total += c.reReaddedConsumptionCents;
    console.log(
      `  Kunde #${c.customerId} ${names.get(c.customerId) ?? ""} [${c.budgetType}]: ` +
        `Netto-Verbrauch ${eur(c.netUsedBeforeCents)} → ${eur(c.netUsedAfterCents)} ` +
        `(re-addierter Verbrauch ${eur(c.reReaddedConsumptionCents)})`,
    );
  }
  console.log(`\nGesamt re-addierter Verbrauch: ${eur(total)}`);
  if (args.apply) {
    console.log(`Geschriebene Korrekturen:  ${summary.correctedCount}`);
    if (summary.batchId) console.log(`Audit-Batch-ID:            ${summary.batchId}`);
  } else {
    console.log('\nHinweis: Trockenlauf — keine Änderungen geschrieben. Mit --apply --user=<id> --reason="…" ausführen.');
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fehler:", err);
    process.exit(1);
  });
}
