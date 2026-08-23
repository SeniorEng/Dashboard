/**
 * Reconciliation-Skript für Task #987 — Phantom-Storno-Korrektur im Budget-Ledger.
 *
 * Problem:
 *   Aus dem Excel-Import von Kunden-Historie sind verwaiste Storno-Zeilen
 *   ("Phantom-Stornos") entstanden: Reversal-Buchungen mit
 *   `reversed_transaction_id IS NULL`, deren `notes` aber
 *   "Storno von Transaktion #N" referenzieren. Wo dieselbe Original-Buchung
 *   ZUSÄTZLICH regulär storniert wurde, ODER wo der referenzierte Konsum zu
 *   einem real geleisteten (lebenden) Termin gehört, schreibt die verwaiste
 *   Zeile den Verbrauch ein zweites Mal gut → Netto-Verbrauch zu niedrig,
 *   Restguthaben zu hoch (z.B. Kunde 39 zeigt 587,02 € statt 609,84 €).
 *
 * Korrektur (GoBD: ausschließlich Append-only — KEIN DELETE/UPDATE):
 *   Pro Phantom-Waise wird eine inverse Ausgleichsbuchung (`consumption`) mit
 *   vorzeichen-invertierten Beträgen UND allen Service-Spalten angelegt. Sie
 *   neutralisiert die verwaiste Gutschrift Spalte für Spalte (Σ Waise +
 *   Korrektur = 0), sodass der Netto-Verbrauch wieder der Summe der tatsächlich
 *   gebuchten, nicht stornierten Termine entspricht. Die ursprüngliche Waise
 *   bleibt unangetastet im Ledger stehen (Revisionssicherheit).
 *
 * Sicherheit / GoBD:
 *   - Trockenlauf ist Default; `--apply` schreibt erst nach explizitem Opt-in.
 *   - `--apply` erfordert `--user=<superadmin-id>` (Audit-Attribution, nur
 *     Superadmins) UND `--reason="…"` (≥10 Zeichen, landet im Audit-Log).
 *   - Jede Korrektur + ein Sammel-Eintrag werden ins Audit-Log geschrieben.
 *   - Idempotent: bereits korrigierte Waisen werden anhand der eindeutigen
 *     Korrektur-Notiz übersprungen.
 *
 * Aufruf:
 *   - Trockenlauf (alle):  tsx server/scripts/reconcile-phantom-stornos.ts
 *   - Einzelne Kunden:     tsx server/scripts/reconcile-phantom-stornos.ts --customer=39,95
 *   - Scharf:              tsx server/scripts/reconcile-phantom-stornos.ts --apply \
 *                            --user=<superadmin-id> --reason="Phantom-Storno Import-Drift #987"
 */

import { randomUUID } from "node:crypto";
import { assertProdWriteAllowedOrThrow, parseProdWriteArgs } from "./lib/prod-write-gate";
import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { appointments, budgetTransactions, customers, users } from "@shared/schema";
import { auditService } from "../services/audit";
import {
  classifyOrphanStornos,
  buildPhantomCorrectionNote,
  isPhantomCorrectionFor,
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
  // Gemeinsame Flags aus der SSoT, per SPREAD — eine Aufzaehlung kann ein
  // Feld verlieren (B1, Gate-2 zu #120). Hier fehlte `confirmTarget`, das
  // das Ziel-Gate braucht.
  return { ...parseProdWriteArgs(process.argv), customerIds };
}


const negate = (v: number | null | undefined): number | null => (v == null ? null : -v);

interface CorrectionPreview {
  orphanId: number;
  refId: number;
  customerId: number;
  budgetType: string;
  reason: string;
  amountCents: number; // Betrag der Gutschrift, die neutralisiert wird (positiv)
  alreadyCorrected: boolean;
}

export interface PhantomReconcileSummary {
  apply: boolean;
  batchId?: string;
  corrections: CorrectionPreview[];
  correctedCount: number;
  skippedAlreadyCorrected: number;
  /** Pro Kunde/Topf: Netto-Verbrauch vor und (rechnerisch) nach Korrektur. */
  perCombo: Array<{ customerId: number; budgetType: string; netUsedBeforeCents: number; netUsedAfterCents: number; phantomCreditCents: number }>;
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

/**
 * Ermittelt für die referenzierten Consumption-IDs, ob ihr Termin real
 * geleistet wurde (lebt): `deleted_at IS NULL AND status <> 'cancelled'`.
 */
async function loadConsumptionAppointmentLiveness(rows: PhantomLedgerRow[]): Promise<Map<number, boolean>> {
  // Map consumption-id → appointment-id
  const consumptionApptId = new Map<number, number | null>();
  for (const r of rows) {
    if (r.transactionType === "consumption") consumptionApptId.set(r.id, r.appointmentId);
  }
  const apptIds = Array.from(new Set(Array.from(consumptionApptId.values()).filter((x): x is number => x != null)));
  const liveAppt = new Map<number, boolean>();
  if (apptIds.length > 0) {
    const apps = await db
      .select({ id: appointments.id, status: appointments.status, deletedAt: appointments.deletedAt })
      .from(appointments)
      .where(inArray(appointments.id, apptIds));
    for (const a of apps) {
      liveAppt.set(a.id, a.deletedAt == null && a.status !== "cancelled");
    }
  }
  const out = new Map<number, boolean>();
  for (const [consId, apptId] of consumptionApptId) {
    out.set(consId, apptId != null && liveAppt.get(apptId) === true);
  }
  return out;
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

export async function reconcilePhantomStornos(args: Args): Promise<PhantomReconcileSummary> {
  const rows = await loadLedger(args.customerIds);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const liveness = await loadConsumptionAppointmentLiveness(rows);
  const classified = classifyOrphanStornos({ rows, consumptionAppointmentLive: liveness });
  const phantoms = classified.filter((c) => c.isPhantom);

  // Bereits geschriebene Korrekturen erkennen (Idempotenz).
  const correctionNotes = rows
    .filter((r) => r.transactionType === "consumption" && r.notes && r.notes.includes("Phantom-Storno-Korrektur"))
    .map((r) => r.notes as string);
  const isAlreadyCorrected = (orphanId: number) => correctionNotes.some((n) => isPhantomCorrectionFor(n, orphanId));

  const previews: CorrectionPreview[] = phantoms.map((p) => ({
    orphanId: p.orphan.id,
    refId: p.referencedConsumptionId,
    customerId: p.orphan.customerId,
    budgetType: p.orphan.budgetType,
    reason: p.reason,
    amountCents: Math.abs(p.orphan.amountCents),
    alreadyCorrected: isAlreadyCorrected(p.orphan.id),
  }));

  // Pro Kunde/Topf den Effekt aufstellen.
  const comboKeys = Array.from(new Set(previews.map((p) => `${p.customerId}::${p.budgetType}`)));
  const perCombo = comboKeys.map((key) => {
    const [cidStr, budgetType] = key.split("::");
    const customerId = parseInt(cidStr, 10);
    const netUsedBeforeCents = netUsedFor(rows, customerId, budgetType);
    const phantomCreditCents = previews
      .filter((p) => p.customerId === customerId && p.budgetType === budgetType && !p.alreadyCorrected)
      .reduce((s, p) => s + p.amountCents, 0);
    return {
      customerId,
      budgetType,
      netUsedBeforeCents,
      netUsedAfterCents: netUsedBeforeCents + phantomCreditCents,
      phantomCreditCents,
    };
  });

  const toApply = previews.filter((p) => !p.alreadyCorrected);
  const batchId = args.apply && args.userId !== undefined && toApply.length > 0 ? randomUUID() : undefined;
  let correctedCount = 0;

  if (args.apply && args.userId !== undefined) {
    for (const p of toApply) {
      const orphan = byId.get(p.orphanId);
      if (!orphan) continue;
      // Vollständige Original-Waise laden (alle Service-Spalten) für die Spiegelung.
      const [full] = await db.select().from(budgetTransactions).where(eq(budgetTransactions.id, p.orphanId)).limit(1);
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
              sql`${budgetTransactions.notes} LIKE ${`%verwaisten Storno #${p.orphanId} (%`}`,
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
          notes: `${buildPhantomCorrectionNote(p.orphanId, p.refId)} ${args.reason}`,
          createdByUserId: args.userId,
        });

        await auditService.log(
          args.userId!,
          "budget_transaction_corrected",
          "budget",
          full.customerId,
          {
            task: "#987",
            batchId,
            reason: args.reason,
            orphanTransactionId: p.orphanId,
            referencedConsumptionId: p.refId,
            budgetType: full.budgetType,
            neutralizedCreditCents: p.amountCents,
            classification: p.reason,
          },
          undefined,
          tx,
        );
      });
      correctedCount++;
    }

    if (batchId) {
      await auditService.log(args.userId!, "budget_transaction_corrected_batch", "budget", 0, {
        task: "#987",
        batchId,
        reason: args.reason,
        correctedCount,
        affectedCombos: perCombo.map((c) => ({ customerId: c.customerId, budgetType: c.budgetType, phantomCreditCents: c.phantomCreditCents })),
        totalNeutralizedCents: perCombo.reduce((s, c) => s + c.phantomCreditCents, 0),
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
    // ERSETZT drei Handpruefungen (--user vorhanden, --reason >= 10 Zeichen,
    // lokale assertSuperadminOrThrow-Kopie) UND ergaenzt, was allen dreien
    // fehlte: die ZIEL-Pruefung. Das Gate vergleicht `--confirm-target` gegen
    // `current_database()` auf DERSELBEN Verbindung, ueber die danach
    // geschrieben wird — eine URL sagt nur, wohin verbunden werden sollte.
    // Es erteilt zugleich die Freigabe fuer die Laufzeit-Schreibsperre (#117).
    await assertProdWriteAllowedOrThrow(args, "Reconcile von Phantom-Stornos (Import-Drift).");
  }

  console.log(`Modus:        ${args.apply ? "SCHARF (--apply)" : "Trockenlauf"}`);
  console.log(`Kunden:       ${args.customerIds.length > 0 ? args.customerIds.join(", ") : "ALLE"}`);
  if (args.userId !== undefined) console.log(`Superadmin:   ${args.userId}`);
  if (args.reason) console.log(`Begründung:   ${args.reason}`);

  const summary = await reconcilePhantomStornos(args);

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

  console.log(`\nPhantom-Waisen gefunden: ${summary.corrections.length} (davon bereits korrigiert: ${summary.skippedAlreadyCorrected})`);
  for (const p of summary.corrections) {
    const tag = p.alreadyCorrected ? "[bereits korrigiert]" : "[zu korrigieren]";
    console.log(
      `  ${tag} Waise #${p.orphanId} → ref #${p.refId} | Kunde #${p.customerId} ${p.budgetType} | ` +
        `neutralisiert ${eur(p.amountCents)} | ${p.reason}`,
    );
  }

  console.log(`\n=== Effekt pro Kunde/Topf ===`);
  let total = 0;
  for (const c of summary.perCombo.sort((a, b) => b.phantomCreditCents - a.phantomCreditCents)) {
    total += c.phantomCreditCents;
    console.log(
      `  Kunde #${c.customerId} ${names.get(c.customerId) ?? ""} [${c.budgetType}]: ` +
        `Netto-Verbrauch ${eur(c.netUsedBeforeCents)} → ${eur(c.netUsedAfterCents)} ` +
        `(Phantom-Gutschrift ${eur(c.phantomCreditCents)})`,
    );
  }
  console.log(`\nGesamt-Phantom-Gutschrift: ${eur(total)}`);
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
