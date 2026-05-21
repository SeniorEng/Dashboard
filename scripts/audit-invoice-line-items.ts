/**
 * Task #561 — Read-only Audit: km-Line-Items mit Anzeige-vs-Buchungs-Drift.
 *
 * Iteriert über `invoice_line_items` und meldet alle Zeilen mit
 * serviceCode IN ('travel_km','customer_km'), für die
 *   Math.round(durationMinutes * unitPriceCents) !== totalCents
 * gilt — d.h. die persistierte Summe weicht von "Anzeige-Menge × Satz" ab.
 *
 * Reine Diagnose. KEIN Schreibzugriff. Hostname-Guard wie bei den anderen
 * Audit-Skripten — Produktion benötigt `--allow-prod`.
 *
 * Aufruf:
 *   npx tsx scripts/audit-invoice-line-items.ts
 *   npx tsx scripts/audit-invoice-line-items.ts --allow-prod
 */
import { db } from "../server/lib/db";
import { invoiceLineItems, invoices } from "@shared/schema";
import { eq, inArray, isNotNull } from "drizzle-orm";

const KM_SERVICE_CODES = ["travel_km", "customer_km"] as const;

function isProdHost(): boolean {
  const url = process.env.DATABASE_URL ?? "";
  return /neon\.tech|prod|production/i.test(url) && !/test|dev|staging/i.test(url);
}

async function main() {
  const allowProd = process.argv.includes("--allow-prod");
  if (isProdHost() && !allowProd) {
    console.error(
      "REFUSE: DATABASE_URL sieht nach Produktion aus. " +
        "Mit --allow-prod erneut aufrufen, wenn das beabsichtigt ist.",
    );
    process.exit(2);
  }

  const rows = await db
    .select({
      id: invoiceLineItems.id,
      invoiceId: invoiceLineItems.invoiceId,
      serviceCode: invoiceLineItems.serviceCode,
      durationMinutes: invoiceLineItems.durationMinutes,
      quantityRaw: invoiceLineItems.quantityRaw,
      unitPriceCents: invoiceLineItems.unitPriceCents,
      totalCents: invoiceLineItems.totalCents,
      serviceDescription: invoiceLineItems.serviceDescription,
    })
    .from(invoiceLineItems)
    .where(inArray(invoiceLineItems.serviceCode, KM_SERVICE_CODES as unknown as string[]));

  type Drift = {
    lineId: number;
    invoiceId: number;
    serviceCode: string | null;
    displayedKm: number;
    rateCents: number;
    expectedTotalCents: number;
    actualTotalCents: number;
    diffCents: number;
  };
  const drifts: Drift[] = [];
  for (const r of rows) {
    // Anzeige-Menge: vor Task #561 wurde Math.round(km) als `durationMinutes`
    // gespeichert. Wenn `quantityRaw` gesetzt ist (neue Lines), gilt der Wert
    // ohnehin konsistent — wir prüfen trotzdem.
    const displayedKm = r.quantityRaw ?? r.durationMinutes;
    const expected = Math.round(displayedKm * r.unitPriceCents);
    if (expected !== r.totalCents) {
      drifts.push({
        lineId: r.id,
        invoiceId: r.invoiceId,
        serviceCode: r.serviceCode,
        displayedKm,
        rateCents: r.unitPriceCents,
        expectedTotalCents: expected,
        actualTotalCents: r.totalCents,
        diffCents: r.totalCents - expected,
      });
    }
  }

  if (drifts.length === 0) {
    console.log(`✓ Keine Drift gefunden. Geprüft: ${rows.length} km-Lines.`);
    process.exit(0);
  }

  // Rechnungs-Metadaten zu den betroffenen IDs laden.
  const invoiceIds = Array.from(new Set(drifts.map((d) => d.invoiceId)));
  const invs = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      customerName: invoices.customerName,
      recipientName: invoices.recipientName,
      status: invoices.status,
    })
    .from(invoices)
    .where(inArray(invoices.id, invoiceIds));
  const byId = new Map(invs.map((i) => [i.id, i]));

  console.log(`Drift gefunden in ${drifts.length} Line-Item(s) aus ${invoiceIds.length} Rechnung(en):\n`);
  console.log(
    [
      "Rechnungs-Nr".padEnd(16),
      "Kunde".padEnd(28),
      "Zeile".padEnd(8),
      "km".padStart(8),
      "Satz".padStart(8),
      "Erwartet".padStart(10),
      "Ist".padStart(10),
      "Δ".padStart(8),
    ].join(" │ "),
  );
  console.log("─".repeat(110));

  let total = 0;
  for (const d of drifts) {
    const inv = byId.get(d.invoiceId);
    const name = (inv?.customerName ?? inv?.recipientName ?? "?").slice(0, 27);
    console.log(
      [
        (inv?.invoiceNumber ?? `id=${d.invoiceId}`).padEnd(16),
        name.padEnd(28),
        String(d.lineId).padEnd(8),
        d.displayedKm.toFixed(2).padStart(8),
        (d.rateCents / 100).toFixed(2).padStart(8),
        (d.expectedTotalCents / 100).toFixed(2).padStart(10),
        (d.actualTotalCents / 100).toFixed(2).padStart(10),
        (d.diffCents / 100).toFixed(2).padStart(8),
      ].join(" │ "),
    );
    total += Math.abs(d.diffCents);
  }
  console.log("─".repeat(110));
  console.log(`\nKumulierte Drift (Betrag): ${(total / 100).toFixed(2)} €`);
  console.log(
    "\nHinweis: GoBD-Immutabilität — bestehende Rechnungen werden NICHT\n" +
      "überschrieben. Korrekturweg ist Storno + Neuanlage (Runbook).",
  );
  process.exit(1);
}

main().catch((err) => {
  console.error("Audit fehlgeschlagen:", err);
  process.exit(3);
});
