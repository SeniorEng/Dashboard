/**
 * Task #1030 — Daten-Korrektur: Entwurf-Rechnungen, deren Rechnungsempfänger
 * bzw. Leistungsnachweis-Adresse vom aktuellen Kunden-Stammstand abweichen,
 * auf die Stammadresse aktualisieren und betroffene PDFs neu rendern.
 *
 * Hintergrund: Vor dieser Korrektur rendert der Leistungsnachweis-
 * „Leistungsempfänger/in" `invoice.recipientAddress` — bei gesetzlichen Kassen
 * ohne Kostenerstattung also die PFLEGEKASSEN-Anschrift statt der Patient-
 * Wohnadresse. Zusätzlich liefen Entwürfe mit veralteter Selbstzahler-Adresse
 * auf einem alten Cache.
 *
 * Sicher per Default: DRY-RUN. Schreiben nur mit `--apply`.
 * Idempotent: ein zweiter Lauf ohne Stammdaten-Änderung ist ein No-Op.
 *
 * Verwendung:
 *   npx tsx scripts/fix-draft-invoice-addresses.ts                # Dry-Run, alle Kunden
 *   npx tsx scripts/fix-draft-invoice-addresses.ts --customer=117 # Dry-Run, nur Kunde 117
 *   npx tsx scripts/fix-draft-invoice-addresses.ts --apply        # schreibt
 */
import { eq } from "drizzle-orm";
import { db } from "../server/lib/db";
import { invoices as invoicesTable } from "@shared/schema";
import { refreshDraftInvoicesForCustomerAddress } from "../server/services/invoice-address-refresh";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const customerArg = process.argv.find((a) => a.startsWith("--customer="));
  const onlyCustomerId = customerArg ? Number.parseInt(customerArg.split("=")[1] ?? "", 10) : null;
  if (customerArg && (onlyCustomerId === null || Number.isNaN(onlyCustomerId))) {
    console.error("Ungültiges --customer=<id> Argument.");
    process.exit(1);
  }

  // Distinct-Kunden mit mindestens einer Entwurf-Rechnung.
  const rows = await db
    .selectDistinct({ customerId: invoicesTable.customerId })
    .from(invoicesTable)
    .where(eq(invoicesTable.status, "entwurf"));
  let customerIds = rows.map((r) => r.customerId);
  if (onlyCustomerId !== null) {
    customerIds = customerIds.filter((c) => c === onlyCustomerId);
  }

  console.log(
    `[fix-draft-invoice-addresses] ${apply ? "APPLY" : "DRY-RUN"} — ${customerIds.length} Kunde(n) mit Entwurf-Rechnungen`,
  );

  let totalChanged = 0;
  for (const cid of customerIds) {
    const report = await refreshDraftInvoicesForCustomerAddress(cid, { dryRun: !apply });
    if (report.changed.length === 0) continue;
    totalChanged += report.changed.length;
    console.log(`  Kunde ${cid} (Stammadresse: ${JSON.stringify(report.masterAddress)}):`);
    for (const c of report.changed) {
      const recipientNote = c.recipientUpdated
        ? ` — recipient: ${JSON.stringify(c.oldRecipientAddress)} → ${JSON.stringify(c.newRecipientAddress)}`
        : "";
      console.log(
        `    - Rechnung ${c.invoiceNumber} [${c.billingType}] recipientUpdated=${c.recipientUpdated} cacheCleared=${c.cacheCleared}${recipientNote}`,
      );
    }
  }

  console.log(
    `[fix-draft-invoice-addresses] ${apply ? "Aktualisiert" : "Würde aktualisieren"}: ${totalChanged} Rechnung(en) über ${customerIds.length} geprüfte(n) Kunde(n).`,
  );
  if (!apply) {
    console.log("Dry-Run abgeschlossen. Mit --apply ausführen, um die Änderungen zu schreiben.");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[fix-draft-invoice-addresses] Fehlgeschlagen:", err);
  process.exit(1);
});
