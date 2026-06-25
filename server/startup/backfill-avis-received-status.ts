import { and, asc, eq, isNull } from "drizzle-orm";
import { db, type DbOrTx } from "../lib/db";
import { invoices, paymentAdviceItems, paymentAdvices, users } from "@shared/schema";
import { auditService } from "../services/audit";
import { log } from "../lib/log";

/**
 * Task #1284 — Einmaliger Backfill für den neuen Status "avis_erhalten".
 *
 * Hintergrund: Mit Task #1284 erhält der Rechnungs-Lebenszyklus die Stufe
 *   Entwurf → Versendet → Avis erhalten → Bezahlt (+Storniert).
 * Bereits importierte Zahlungsavise (z.B. die April-Avise) haben ihre
 * Rechnungen über die Auto-Zuordnung verknüpft, der Status blieb aber auf
 * "versendet", weil es den Zwischenstatus noch nicht gab.
 *
 * Dieser Backfill hebt alle Rechnungen, die
 *   - aktuell den Status "versendet" tragen UND
 *   - mindestens einer Position eines NICHT gelöschten Zahlungsavis
 *     (payment_advice_items.matched_invoice_id) zugeordnet sind
 * auf "avis_erhalten" an. Bereits "bezahlt"/"storniert" markierte Rechnungen
 * werden NICHT angefasst (kein Downgrade) — der Guard auf status='versendet'
 * im UPDATE stellt das sicher.
 *
 * GoBD: nur der Status wird angehoben (keine Beträge/Daten verändert), jede
 * Änderung wird mit `invoice_avis_received` auditiert. Vollständig idempotent
 * (nach einem Lauf gibt es keine passenden "versendet"-Rechnungen mehr).
 */
export async function backfillAvisReceivedStatus(exec: DbOrTx = db): Promise<void> {
  // Kandidaten: versendete Rechnungen mit aktiver Avis-Zuordnung.
  const candidates = await exec
    .select({ id: invoices.id })
    .from(invoices)
    .innerJoin(paymentAdviceItems, eq(paymentAdviceItems.matchedInvoiceId, invoices.id))
    .innerJoin(paymentAdvices, eq(paymentAdviceItems.paymentAdviceId, paymentAdvices.id))
    .where(and(
      eq(invoices.status, "versendet"),
      isNull(paymentAdvices.deletedAt),
    ))
    .groupBy(invoices.id);

  if (candidates.length === 0) return;

  // System-Actor (Super-/Admin) für die Audit-Einträge.
  const [superActor] = await exec
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isSuperAdmin, true))
    .orderBy(asc(users.id))
    .limit(1);
  let systemActorId: number | null = superActor?.id ?? null;
  if (systemActorId == null) {
    const [adminActor] = await exec
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isAdmin, true))
      .orderBy(asc(users.id))
      .limit(1);
    systemActorId = adminActor?.id ?? null;
  }

  if (systemActorId == null) {
    log(
      `Avis-Received-Backfill (Task #1284): ${candidates.length} Kandidaten, aber kein System-Actor — übersprungen.`,
      "startup",
    );
    return;
  }

  const candidateIds = candidates.map(c => c.id);
  let updatedCount = 0;

  // Geguarded auf status='versendet', danach Audit. invoices ist GoBD-immutable;
  // der GoBD-Bypass (`app.allow_gobd_mutation`) wird vom aufrufenden
  // `runGuardedBudgetMigration`-Runner transaktions-lokal gesetzt
  // (gobdBypass: true). Update + Audit laufen in DESSEN Transaktion gemeinsam
  // mit dem Ledger-Eintrag (exactly-once, atomar).
  for (const invoiceId of candidateIds) {
    const updated = await exec
      .update(invoices)
      .set({ status: "avis_erhalten" })
      .where(and(eq(invoices.id, invoiceId), eq(invoices.status, "versendet")))
      .returning({ id: invoices.id });

    if (updated.length === 0) continue;

    await auditService.log(
      systemActorId!,
      "invoice_avis_received",
      "invoice",
      invoiceId,
      { task: "#1284", matchedBy: "avis", reason: "backfill" },
      undefined,
      exec,
    );
    updatedCount++;
  }

  log(
    `Avis-Received-Backfill (Task #1284): ${candidateIds.length} Kandidaten geprüft, ${updatedCount} auf "avis_erhalten" angehoben.`,
    "startup",
  );
}
