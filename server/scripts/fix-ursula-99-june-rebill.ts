/**
 * Task #1855 — Prod-Remediation: Ursula Neuber (Kunde 99) Juni 2026 neu abrechnen.
 *
 * Kontext (read-only-Prod-Prüfung, Checks A–G)
 * --------------------------------------------
 * Kundin Ursula Neuber (ID 99, gesetzliche Pflegekasse, PG 2, kein
 * Privatzahler) hat für Juni 2026 vier dokumentierte + signierte Termine
 * (1503, 1591, 1674, 1820). Juni wurde bereits ZWEIMAL berechnet und ZWEIMAL
 * storniert:
 *   - RE-2026-0263 (rechnung, storniert)  ← Stornorechnung RE-2026-0332 (entwurf)
 *   - RE-2026-0401 (rechnung, storniert)  ← Stornorechnung RE-2026-0414 (entwurf)
 * Dadurch ist die gesamte §45b-Konsumption des Juni netto per Reversal auf
 * NULL (Netto-Null-Fall / H1) — die Termine erscheinen wieder „abrechenbar".
 *
 * Fachlicher Kern
 * ---------------
 * Der §45b-Entlastungsbetrag wird zusätzlich von einem zweiten Pflegedienst
 * verbraucht (in CareConnect unsichtbar); die Kasse meldet §45b als
 * ausgeschöpft. Der real gültige §45b-Stand ist der Startwert von 131 € im Mai
 * (`budget_allocations.initial_balance`, „Startwert ab 05/2026"). Der in der
 * Karte gezeigte 393 €-„Gesamt zugewiesen" ist ein ABGELAUFENER
 * Vorjahres-Carryover (`source='carryover'`, gültig nur bis 30.06.2026), der
 * den §45b-Rest fälschlich aufbläht. Nach Entfernen des Carryovers spiegelt der
 * §45b-Reader (netAvailable45bAt / calculateAllocated45b) den realen Rest aus
 * dem Mai-Startwert wider — Juni hat dann KEIN ausreichendes §45b-Headroom mehr,
 * und die Kaskade läuft auf den zweiten aktiven Topf §39/§42a (Ersatzpflege,
 * seit 25.06.2026 aktiv, Prio 2) über.
 *
 * Was dieses Skript tut (nur bestehende Mechanismen, KEINE parallele Mathe)
 * ------------------------------------------------------------------------
 * Tx#1 (committet, GoBD-append-only, KEIN PDF-Render in der Transaktion):
 *   1. Advisory-Lock auf den Kunden (serialisiert Budget-Buchungen).
 *   2. §45b-Baseline fixieren: den/die aktiven §45b-`carryover`-Allokationen
 *      soft-löschen (`deleted_at`). Der Mai-`initial_balance`-Startwert bleibt
 *      die Source of Truth. Precondition: es MUSS ein aktiver §45b-Startwert
 *      existieren — sonst würde das Löschen den einzigen Budget-Anker entfernen
 *      (harter Abbruch).
 *   3. Die zwei hängenden Stornorechnungs-ENTWÜRFE (Juni, `stornorechnung`,
 *      `entwurf`) GoBD-sauber finalisieren → `versendet` (nur Status-Transition,
 *      PDFs existieren bereits; lückenlose Nummerierung bleibt erhalten). Jeder
 *      Storno MUSS auf eine bereits `storniert`e Original-Rechnung verweisen.
 *   4. Rebook-Guard prüfen (Termine sind netto-null & unbilled).
 *   5. Termine in AUFSTEIGENDER Datumsreihenfolge neu buchen (FIFO as-of Datum)
 *      mit auf {§45b, §39/§42a} beschränkter Cascade (kein Privat-Topf).
 *   6. Ledger-Assert: der nicht-gefloorte §45b-Saldo `allocated − consumedNet`
 *      (Monatsende, Holds ignoriert) MUSS exakt 0 sein (§45b bis zum realen Cap
 *      gefüllt, Rest auf §39/§42a übergelaufen).
 * Post-Commit (wiederholbar, eigener Audit-/PDF-Pfad):
 *   7. Juni via `generateInvoiceCore` neu erzeugen (Invoice-per-Pot-Split →
 *      §45b + §39/§42a), Termine werden als abgerechnet markiert. PDFs
 *      persistieren. Read-only-Gegenprobe (Anzeige === Buchung, Σ-Erhaltung).
 *
 * Sicherheit / GoBD
 * -----------------
 *   - Trockenlauf ist DEFAULT: Tx#1 wird komplett simuliert und am Ende
 *     zurückgerollt (kein Schreiben), inkl. der exakten berechneten
 *     Topf-Verteilung. `generateInvoiceCore` läuft im Trockenlauf NICHT.
 *   - `--apply` erfordert `NODE_ENV=production` (Objektspeicher/PDF-Keys sind
 *     env-scoped — ein `--apply` aus Dev schriebe in den falschen Bucket),
 *     `--user=<superadmin-id>` (Audit-Attribution) UND `--reason="…"` (≥10
 *     Zeichen). Zusätzlicher Guard gegen Wegwerf-/Test-DBs.
 *   - Ausführung: in Dev VORBEREITEN + per read-only-Trockenlauf gegen Prod
 *     validieren; `--apply` NUR im Produktionsumfeld.
 *
 * Aufruf
 * ------
 *   Trockenlauf (read-only):  tsx server/scripts/fix-ursula-99-june-rebill.ts
 *   Scharf (nur Prod):        NODE_ENV=production tsx \
 *       server/scripts/fix-ursula-99-june-rebill.ts \
 *       --apply --user=<superadmin-id> --reason="Ursula 99 Juni-Neuabrechnung #1855"
 */

import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db, type Tx } from "../lib/db";
import { withAudit, type TxAuditRecorder } from "../lib/with-audit";
import {
  appointments,
  budgetAllocations,
  customers,
  invoices as invoicesTable,
  users,
} from "@shared/schema";
import { getInvoiceLineItemsTx, updateInvoiceStatusTx } from "../storage/billing-storage";
import { assertRebookAllowed } from "../storage/budget/rebook-guards";
import { rebookNetZeroAppointmentCore } from "../storage/budget/rebook-storage";
import { netAvailable45bAt } from "../storage/budget/net-available-45b";
import { generateInvoiceCore } from "../services/invoice-calc";
import { persistInvoicePdf } from "../services/invoice-pdf-orchestrator";
import { formatEuroDE } from "@shared/utils/money";

const CUSTOMER_ID = 99;
const BILLING_YEAR = 2026;
const BILLING_MONTH = 6;
const B45B = "entlastungsbetrag_45b";
const OVERFLOW_POT = "ersatzpflege_39_42a";
const ALLOWED_POTS: string[] = [B45B, OVERFLOW_POT];
const END_OF_MONTH_ISO = "2026-06-30";

interface Args {
  apply: boolean;
  userId: number | undefined;
  reason: string | undefined;
}

/** Sentinel-Fehler, um Tx#1 im Trockenlauf sauber zurückzurollen. */
class DryRunRollback extends Error {}

interface RemediationSummary {
  droppedCarryovers: { id: number; amountCents: number; validFrom: string; expiresAt: string | null }[];
  finalizedStornos: { id: number; invoiceNumber: string; stornierteRechnungId: number | null }[];
  apptIds: number[];
  perPotConsumedCents: Record<string, number>;
  totalConsumedCents: number;
  allocated45bCents: number;
  consumedNet45bCents: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (p: string) => argv.find((a) => a.startsWith(p))?.split("=")[1];
  const userArg = get("--user=");
  const userId = userArg ? parseInt(userArg, 10) : undefined;
  return {
    apply: argv.includes("--apply"),
    userId: userId !== undefined && Number.isFinite(userId) ? userId : undefined,
    reason: get("--reason="),
  };
}

async function assertSuperadminOrThrow(userId: number): Promise<void> {
  const [row] = await db
    .select({
      id: users.id,
      isSuperAdmin: users.isSuperAdmin,
      isActive: users.isActive,
      displayName: users.displayName,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw new Error(`--user=${userId}: User existiert nicht`);
  if (!row.isActive) throw new Error(`--user=${userId} (${row.displayName}) ist inaktiv`);
  if (!row.isSuperAdmin) {
    throw new Error(
      `--user=${userId} (${row.displayName}) ist kein Superadmin. ` +
        `Diese Prod-Remediation ist auf Superadmins beschränkt.`,
    );
  }
}

/** Grober Schutz gegen versehentliches --apply gegen eine Wegwerf-/Test-DB. */
function assertNotTestDatabase(): void {
  const url = process.env.DATABASE_URL ?? "";
  if (/cc_test_|_ephemeral|localhost:5(0|4)\d\d/.test(url)) {
    throw new Error(
      "--apply gegen eine augenscheinliche Test-/Ephemeral-DB verweigert. " +
        "Bitte im echten Produktionsumfeld ausführen.",
    );
  }
}

function eur(cents: number): string {
  return formatEuroDE(cents);
}

/**
 * Führt die eigentliche Remediation (Schritte 1–6) innerhalb EINER Transaktion
 * aus und gibt eine berechnete Zusammenfassung zurück. Der Aufrufer entscheidet
 * per DryRunRollback über Commit (apply) vs. Rollback (Trockenlauf).
 */
async function remediateTx1(
  tx: Tx,
  audit: TxAuditRecorder,
  userId: number,
  reason: string,
): Promise<RemediationSummary> {
  // (1) Advisory-Lock auf den Kunden.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('budget_consumption_' || ${CUSTOMER_ID}::text))`,
  );

  // (2) §45b-Baseline: aktive Allokationen laden.
  const allocs = await tx
    .select()
    .from(budgetAllocations)
    .where(
      and(
        eq(budgetAllocations.customerId, CUSTOMER_ID),
        eq(budgetAllocations.budgetType, B45B),
        isNull(budgetAllocations.deletedAt),
      ),
    );

  const startwerte = allocs.filter((a) => a.source === "initial_balance");
  const carryovers = allocs.filter((a) => a.source === "carryover");
  if (startwerte.length === 0) {
    throw new Error(
      "Abbruch: Kein aktiver §45b-Startwert (initial_balance) vorhanden. " +
        "Das Löschen der Carryover würde den einzigen §45b-Anker entfernen.",
    );
  }
  if (carryovers.length === 0) {
    throw new Error(
      "Abbruch: Kein aktiver §45b-Carryover gefunden — der aufgeblähte Stand " +
        "ist bereits bereinigt oder der Zustand weicht von der Prüfung ab.",
    );
  }

  const droppedCarryovers: RemediationSummary["droppedCarryovers"] = [];
  for (const c of carryovers) {
    await tx
      .update(budgetAllocations)
      .set({ deletedAt: new Date() })
      .where(and(eq(budgetAllocations.id, c.id), isNull(budgetAllocations.deletedAt)));
    droppedCarryovers.push({
      id: c.id,
      amountCents: c.amountCents,
      validFrom: String(c.validFrom),
      expiresAt: c.expiresAt ? String(c.expiresAt) : null,
    });
    audit.record({
      userId,
      action: "budget_carryover_cleanup_soft_deleted",
      entityType: "budget",
      entityId: CUSTOMER_ID,
      metadata: {
        task: "#1855",
        reason,
        customerId: CUSTOMER_ID,
        allocationId: c.id,
        carryoverYear: c.year,
        carryoverAmountCents: c.amountCents,
        obsoleteReason:
          "Abgelaufener Vorjahres-Carryover blähte §45b-Rest auf; Mai-Startwert ist die reale Baseline.",
      },
    });
  }

  // (3) Stornierte Original-Rechnungen des Monats + deren Termine.
  const stornierteOriginals = await tx
    .select({ id: invoicesTable.id, invoiceNumber: invoicesTable.invoiceNumber })
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.customerId, CUSTOMER_ID),
        eq(invoicesTable.billingYear, BILLING_YEAR),
        eq(invoicesTable.billingMonth, BILLING_MONTH),
        ne(invoicesTable.invoiceType, "stornorechnung"),
        eq(invoicesTable.status, "storniert"),
      ),
    );

  const apptIdSet = new Set<number>();
  for (const orig of stornierteOriginals) {
    const items = await getInvoiceLineItemsTx(tx, orig.id);
    for (const li of items) if (li.appointmentId != null) apptIdSet.add(li.appointmentId);
  }
  if (apptIdSet.size === 0) {
    throw new Error("Abbruch: Keine terminbezogenen Positionen in den stornierten Juni-Rechnungen gefunden.");
  }

  // (4) Hängende Stornorechnungs-Entwürfe des Monats finalisieren → versendet.
  const stornoDrafts = await tx
    .select({
      id: invoicesTable.id,
      invoiceNumber: invoicesTable.invoiceNumber,
      stornierteRechnungId: invoicesTable.stornierteRechnungId,
    })
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.customerId, CUSTOMER_ID),
        eq(invoicesTable.billingYear, BILLING_YEAR),
        eq(invoicesTable.billingMonth, BILLING_MONTH),
        eq(invoicesTable.invoiceType, "stornorechnung"),
        eq(invoicesTable.status, "entwurf"),
      ),
    );

  const stornierteIds = new Set(stornierteOriginals.map((o) => o.id));
  const finalizedStornos: RemediationSummary["finalizedStornos"] = [];
  for (const s of stornoDrafts) {
    if (s.stornierteRechnungId == null || !stornierteIds.has(s.stornierteRechnungId)) {
      throw new Error(
        `Abbruch: Stornorechnung ${s.invoiceNumber} verweist nicht auf eine stornierte Juni-Original-Rechnung ` +
          `(stornierteRechnungId=${s.stornierteRechnungId}).`,
      );
    }
    await updateInvoiceStatusTx(tx, s.id, "versendet", userId);
    finalizedStornos.push({
      id: s.id,
      invoiceNumber: s.invoiceNumber,
      stornierteRechnungId: s.stornierteRechnungId,
    });
    audit.record({
      userId,
      action: "invoice_sent",
      entityType: "invoice",
      entityId: s.id,
      metadata: {
        task: "#1855",
        reason,
        invoiceNumber: s.invoiceNumber,
        stornierteRechnungId: s.stornierteRechnungId,
        fromStatus: "entwurf",
        toStatus: "versendet",
      },
    });
  }

  // (5) Rebook-Guard + Termine aufsteigend nach Datum neu buchen.
  const apptIds = Array.from(apptIdSet);
  await assertRebookAllowed(apptIds, { userId, isSuperAdmin: true }, tx);

  const apptRows = await tx
    .select({ id: appointments.id, date: appointments.date })
    .from(appointments)
    .where(inArray(appointments.id, apptIds))
    .orderBy(asc(appointments.date));
  const orderedApptIds = apptRows.map((r) => r.id);

  const perPotConsumedCents: Record<string, number> = {};
  let totalConsumedCents = 0;
  for (const appointmentId of orderedApptIds) {
    const { rebooked, cascade } = await rebookNetZeroAppointmentCore(tx, {
      customerId: CUSTOMER_ID,
      appointmentId,
      userId,
      overflowRestriction: { allowedPots: ALLOWED_POTS },
      privatePotOverride: null,
    });
    if (rebooked && cascade) {
      for (const b of cascade.breakdown) {
        perPotConsumedCents[b.budgetType] = (perPotConsumedCents[b.budgetType] ?? 0) + b.consumedCents;
        totalConsumedCents += b.consumedCents;
      }
    }
  }

  // (6) Ledger-Assert: §45b `allocated − consumedNet` (Monatsende, Holds
  // ignoriert) MUSS exakt 0 sein.
  const comp = await netAvailable45bAt(
    CUSTOMER_ID,
    END_OF_MONTH_ISO,
    { projectFuture: false, holds: "ignore" },
    tx,
  );
  const rawNet = comp.allocatedCents - comp.consumedNetCents;
  if (Math.round(rawNet) !== 0) {
    throw new Error(
      `Ledger-Assert fehlgeschlagen: nach der Re-Buchung verbleibt eine §45b-Abweichung von ` +
        `${eur(rawNet)} (erwartet 0). §45b allocated=${eur(comp.allocatedCents)}, ` +
        `consumedNet=${eur(comp.consumedNetCents)}.`,
    );
  }

  audit.record({
    userId,
    action: "budget_rebook_month",
    entityType: "customer",
    entityId: CUSTOMER_ID,
    metadata: {
      task: "#1855",
      reason,
      billingYear: BILLING_YEAR,
      billingMonth: BILLING_MONTH,
      droppedCarryoverIds: droppedCarryovers.map((c) => c.id),
      finalizedStornoIds: finalizedStornos.map((s) => s.id),
      apptIds: orderedApptIds,
      perPotConsumedCents,
      totalConsumedCents,
      allocated45bCents: comp.allocatedCents,
    },
  });

  return {
    droppedCarryovers,
    finalizedStornos,
    apptIds: orderedApptIds,
    perPotConsumedCents,
    totalConsumedCents,
    allocated45bCents: comp.allocatedCents,
    consumedNet45bCents: comp.consumedNetCents,
  };
}

function printSummary(s: RemediationSummary): void {
  console.log(`\n  Termine (aufsteigend):     ${s.apptIds.join(", ")}`);
  console.log(`  Carryover soft-gelöscht:   ${s.droppedCarryovers.length}`);
  for (const c of s.droppedCarryovers) {
    console.log(
      `    - Allokation #${c.id}: ${eur(c.amountCents)} (gültig ${c.validFrom} → ${c.expiresAt ?? "offen"})`,
    );
  }
  console.log(`  Storno-Entwürfe finalisiert: ${s.finalizedStornos.length}`);
  for (const st of s.finalizedStornos) {
    console.log(`    - ${st.invoiceNumber} (#${st.id}) → versendet (Storno von #${st.stornierteRechnungId})`);
  }
  console.log(`\n  §45b allocated (real):     ${eur(s.allocated45bCents)}`);
  console.log(`  §45b consumedNet:          ${eur(s.consumedNet45bCents)}`);
  console.log(`  Ledger-Assert §45b raw:    ${eur(s.allocated45bCents - s.consumedNet45bCents)} (erwartet 0,00 €)`);
  console.log(`\n  Kaskaden-Verteilung (Buchung):`);
  for (const [pot, cents] of Object.entries(s.perPotConsumedCents)) {
    console.log(`    - ${pot}: ${eur(cents)}`);
  }
  console.log(`  Σ Verbrauch gesamt:        ${eur(s.totalConsumedCents)}`);
}

async function main() {
  const args = parseArgs();

  if (args.apply) {
    if (process.env.NODE_ENV !== "production") {
      console.error(
        "Fehler: --apply ist nur mit NODE_ENV=production erlaubt.\n" +
          "  Der Objektspeicher (PDF-Keys) ist env-scoped — ein --apply aus Dev\n" +
          "  würde in den falschen Bucket schreiben. Bitte im Produktionsumfeld ausführen.",
      );
      process.exit(1);
    }
    if (args.userId === undefined) {
      console.error("Fehler: --apply erfordert --user=<superadmin-id> für GoBD-Audit-Attribution.");
      process.exit(1);
    }
    if (!args.reason || args.reason.length < 10) {
      console.error('Fehler: --apply erfordert --reason="..." (≥10 Zeichen Begründung für den Audit-Log).');
      process.exit(1);
    }
    assertNotTestDatabase();
    await assertSuperadminOrThrow(args.userId);
  }

  console.log(`\n=== Ursula Neuber (Kunde ${CUSTOMER_ID}) · Juni ${BILLING_YEAR} Neuabrechnung · Task #1855 ===`);
  console.log(`Modus:      ${args.apply ? "SCHARF (--apply)" : "Trockenlauf (read-only, Rollback)"}`);
  if (args.userId !== undefined) console.log(`Superadmin: ${args.userId}`);
  if (args.reason) console.log(`Begründung: ${args.reason}`);

  // Vorher-Stand (read-only).
  const [cust] = await db
    .select({ id: customers.id, name: customers.name, billingType: customers.billingType })
    .from(customers)
    .where(eq(customers.id, CUSTOMER_ID))
    .limit(1);
  if (!cust) throw new Error(`Kunde ${CUSTOMER_ID} nicht gefunden.`);
  console.log(`\nKunde:      #${cust.id} ${cust.name ?? ""} (${cust.billingType})`);

  const before = await netAvailable45bAt(CUSTOMER_ID, END_OF_MONTH_ISO, {
    projectFuture: false,
    holds: "ignore",
  });
  console.log(
    `\n[VORHER] §45b @ ${END_OF_MONTH_ISO}: allocated=${eur(before.allocatedCents)} ` +
      `consumedNet=${eur(before.consumedNetCents)} ` +
      `raw=${eur(before.allocatedCents - before.consumedNetCents)}`,
  );

  // Tx#1 (Trockenlauf: simulieren + rollback; apply: commit).
  const userId = args.userId ?? 0;
  const reason = args.reason ?? "Trockenlauf (nicht persistiert)";
  let summary: RemediationSummary | undefined;
  try {
    await withAudit(async (tx, audit) => {
      summary = await remediateTx1(tx, audit, userId, reason);
      if (!args.apply) throw new DryRunRollback();
    }, {});
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
  }

  if (!summary) throw new Error("Interner Fehler: keine Remediation-Zusammenfassung erzeugt.");

  console.log(`\n[${args.apply ? "AUSGEFÜHRT" : "SIMULIERT"}] Tx#1:`);
  printSummary(summary);

  if (!args.apply) {
    console.log(
      "\nTrockenlauf abgeschlossen — nichts geschrieben (Rollback). " +
        "generateInvoiceCore wird im Trockenlauf NICHT ausgeführt.\n" +
        'Scharf (nur Prod): NODE_ENV=production ... --apply --user=<superadmin-id> --reason="…"',
    );
    process.exit(0);
  }

  // (7) Post-Commit: Juni neu erzeugen (Invoice-per-Pot-Split) + PDFs.
  console.log(`\n--- Post-Commit: generateInvoiceCore(${BILLING_MONTH}/${BILLING_YEAR}) ---`);
  const result = await generateInvoiceCore(
    { customerId: CUSTOMER_ID, billingMonth: BILLING_MONTH, billingYear: BILLING_YEAR },
    { userId, testFaults: new Set<string>() },
  );
  const created = "splitInvoices" in result ? result.invoices : [result];
  for (const inv of created) await persistInvoicePdf(inv.id);

  let generatedTotal = 0;
  console.log(`\nErzeugte Rechnungen (${created.length}):`);
  for (const inv of created) {
    generatedTotal += inv.grossAmountCents;
    console.log(
      `  - ${inv.invoiceNumber} [${inv.status}] Topf=${inv.budgetType ?? "—"} ` +
        `netto=${eur(inv.netAmountCents)} brutto=${eur(inv.grossAmountCents)}`,
    );
  }
  console.log(`  Σ Brutto erzeugt: ${eur(generatedTotal)} (Buchung Σ: ${eur(summary.totalConsumedCents)})`);

  // Gegenprobe (Anzeige === Buchung).
  const after = await netAvailable45bAt(CUSTOMER_ID, END_OF_MONTH_ISO, {
    projectFuture: false,
    holds: "ignore",
  });
  const afterRaw = after.allocatedCents - after.consumedNetCents;
  console.log(
    `\n[NACHHER] §45b @ ${END_OF_MONTH_ISO}: allocated=${eur(after.allocatedCents)} ` +
      `consumedNet=${eur(after.consumedNetCents)} raw=${eur(afterRaw)}`,
  );
  if (Math.round(afterRaw) !== 0) {
    console.error(`  ✗ WARNUNG: §45b-raw nach Generate ≠ 0 (${eur(afterRaw)}). Bitte prüfen!`);
  } else {
    console.log("  ✓ Anzeige === Buchung (§45b raw = 0).");
  }

  console.log("\nRemediation abgeschlossen.");
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fehler:", err);
    process.exit(1);
  });
}
