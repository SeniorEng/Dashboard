import { and, eq, ne } from "drizzle-orm";
import { neverIssuedCondition } from "../lib/invoice-issued";
import { invoices as invoicesTable } from "@shared/schema";
import { withAudit } from "../lib/with-audit";
import { getBlockingDraftInvoices } from "./invoice-data";
import { generateInvoiceCore, type GenerateInvoiceResult } from "./invoice-calc";

/**
 * Task #1785 — Nach einer Monats-Umwidmung (Budgettopf gewechselt) beziehen sich
 * bereits erzeugte ENTWURFS-Rechnungen des Monats noch auf den alten Topf-Split.
 * Dieser Helfer verwirft die verwaisten Entwürfe GoBD-konform (nur
 * `status='entwurf'`, nie festgeschriebene/Storno-Belege) und erzeugt die
 * Rechnung(en) aus den jetzt umgebuchten Live-Zeilen NEU.
 *
 * Wichtig: läuft NICHT innerhalb der Umbuchungs-Transaktion. Die Umbuchung ist
 * bereits committet; scheitert die Neuerstellung, bleibt die Umbuchung bestehen
 * und der Aufrufer bekommt eine klare deutsche Fehlermeldung (Rechnung manuell
 * neu erzeugen). `generateInvoiceCore` rendert PDFs im Hintergrund und darf
 * daher nicht in eine DB-Transaktion eingebettet werden (Pool-Starvation).
 */
export async function discardAndRegenerateDrafts(params: {
  customerId: number;
  year: number;
  month: number;
  userId: number;
  ipAddress?: string;
  reason?: string;
  testFaults?: Set<string>;
}): Promise<{ discardedInvoiceNumbers: string[]; regenerated: GenerateInvoiceResult | null }> {
  const { customerId, year, month, userId, ipAddress, reason, testFaults } = params;

  const drafts = await getBlockingDraftInvoices(customerId, year, month);
  if (drafts.length === 0) {
    return { discardedInvoiceNumbers: [], regenerated: null };
  }

  // (1) Entwürfe verwerfen — gleiche Semantik wie POST /billing/discard-drafts:
  // je Beleg defensiv auf Entwurf + kein Storno gescopt, einzeln auditiert,
  // Line-Items kaskadieren per FK ON DELETE CASCADE.
  //
  // #66 — inklusive des Löschschutzes: eine JE AUSGEGEBENE Rechnung wird auch
  // hier nie hart gelöscht. Dieser Pfad hatte den Guard beim ersten Wurf
  // vergessen, weil das Prädikat inline stand statt als SSoT — deshalb jetzt
  // `neverIssuedCondition()` aus `server/lib/invoice-issued.ts`.
  const discardedInvoiceNumbers = await withAudit(async (tx, audit) => {
    const numbers: string[] = [];
    for (const draft of drafts) {
      const deleted = await tx.delete(invoicesTable)
        .where(and(
          eq(invoicesTable.id, draft.id),
          eq(invoicesTable.customerId, customerId),
          eq(invoicesTable.billingYear, year),
          eq(invoicesTable.billingMonth, month),
          eq(invoicesTable.status, "entwurf"),
          // Seit dem Status-Umbau entstehen Storno-Dokumente auf
          // `abgeschlossen`, koennen also gar nicht mehr in diese Menge fallen.
          // Der Guard bleibt trotzdem: auf einem LOESCHPFAD ist eine
          // ueberfluessige Schranke billiger als eine fehlende, und
          // Altbestand vor der Migration traegt weiterhin `entwurf`.
          ne(invoicesTable.invoiceType, "stornorechnung"),
          neverIssuedCondition(),
        ))
        .returning({ id: invoicesTable.id, invoiceNumber: invoicesTable.invoiceNumber });
      if (deleted.length === 0) continue;
      numbers.push(deleted[0].invoiceNumber);
      audit.record({
        userId,
        action: "invoice_draft_discarded",
        entityType: "invoice",
        entityId: draft.id,
        metadata: {
          invoiceNumber: deleted[0].invoiceNumber,
          customerId,
          billingMonth: month,
          billingYear: year,
          billingRunId: draft.billingRunId,
          grossAmountCents: draft.grossAmountCents,
          reason: reason ?? "rebook_month_regenerate",
        },
        ipAddress,
      });
    }
    return numbers;
  }, { faults: testFaults });

  // Entwürfe waren zwischenzeitlich weg (Race) — nichts neu zu erzeugen.
  if (discardedInvoiceNumbers.length === 0) {
    return { discardedInvoiceNumbers: [], regenerated: null };
  }

  // (2) Rechnung(en) für den Monat aus den jetzt umgebuchten Live-Zeilen NEU
  // erzeugen (außerhalb jeder DB-Transaktion; Render läuft im Hintergrund).
  try {
    const regenerated = await generateInvoiceCore(
      { customerId, billingMonth: month, billingYear: year },
      { userId, ipAddress, testFaults: testFaults ?? new Set<string>() },
    );
    return { discardedInvoiceNumbers, regenerated };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Die Umbuchung wurde gespeichert, aber die Entwurfs-Rechnung(en) für ${String(month).padStart(2, "0")}/${year} konnten nicht neu erstellt werden: ${msg}. Bitte die Rechnung für den Monat manuell neu erzeugen.`,
    );
  }
}
