import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../lib/db";
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
export async function backfillAvisReceivedStatus(): Promise<void> {
  // Kandidaten: versendete Rechnungen mit aktiver Avis-Zuordnung.
  const candidates = await db
    .selectDistinct({ id: invoices.id })
    .from(invoices)
    .innerJoin(paymentAdviceItems, eq(paymentAdviceItems.matchedInvoiceId, invoices.id))
    .innerJoin(paymentAdvices, eq(paymentAdviceItems.paymentAdviceId, paymentAdvices.id))
    .where(and(
      eq(invoices.status, "versendet"),
      isNull(paymentAdvices.deletedAt),
    ));

  if (candidates.length === 0) return;

  // System-Actor (Super-/Admin) für die Audit-Einträge.
  const [superActor] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isSuperAdmin, true))
    .orderBy(asc(users.id))
    .limit(1);
  let systemActorId: number | null = superActor?.id ?? null;
  if (systemActorId == null) {
    const [adminActor] = await db
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

  // Pro Rechnung transaktional: geguarded auf status='versendet', danach Audit.
  for (const invoiceId of candidateIds) {
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(invoices)
        .set({ status: "avis_erhalten" })
        .where(and(eq(invoices.id, invoiceId), eq(invoices.status, "versendet")))
        .returning({ id: invoices.id });

      if (updated.length === 0) return;

      await auditService.log(
        systemActorId!,
        "invoice_avis_received",
        "invoice",
        invoiceId,
        { task: "#1284", matchedBy: "avis", reason: "backfill" },
        undefined,
        tx,
      );
      updatedCount++;
    });
  }

  log(
    `Avis-Received-Backfill (Task #1284): ${candidateIds.length} Kandidaten geprüft, ${updatedCount} auf "avis_erhalten" angehoben.`,
    "startup",
  );
}
