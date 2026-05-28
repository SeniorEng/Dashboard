/**
 * Task #749 — Read-only Audit: findet alle `monthly_service_records` mit
 * `status='completed'` (oder `customer_signed`), deren gespeicherte
 * `customerSignatureData` den Meaningful-Pixel-Check NICHT besteht.
 *
 * Symptom in Prod: das Leistungsnachweis-PDF zeigt "signed text + leeres
 * <img>" (RE-2026-0010-Drift). Solche Datensätze müssen manuell
 * re-signiert werden — anschließend invalidiert `signServiceRecord` die
 * gecachten LN-PDFs automatisch.
 *
 * Aufruf:
 *   tsx server/scripts/audit-empty-signatures.ts
 *
 * Setzt KEINE Daten — reine SELECT-Abfrage + Validator-Aufruf.
 */
import { db } from "../lib/db";
import { monthlyServiceRecords, customers, invoices as invoicesTable } from "@shared/schema";
import { and, eq, isNotNull, isNull, inArray } from "drizzle-orm";
import { analyzeSignatureImage } from "../lib/signature-validation";

async function main(): Promise<void> {
  const rows = await db.select({
    id: monthlyServiceRecords.id,
    customerId: monthlyServiceRecords.customerId,
    year: monthlyServiceRecords.year,
    month: monthlyServiceRecords.month,
    status: monthlyServiceRecords.status,
    customerSignatureData: monthlyServiceRecords.customerSignatureData,
    employeeSignatureData: monthlyServiceRecords.employeeSignatureData,
    customerSignedAt: monthlyServiceRecords.customerSignedAt,
    employeeSignedAt: monthlyServiceRecords.employeeSignedAt,
  })
    .from(monthlyServiceRecords)
    .where(and(
      isNull(monthlyServiceRecords.deletedAt),
      inArray(monthlyServiceRecords.status, ["employee_signed", "completed"]),
      isNotNull(monthlyServiceRecords.customerSignatureData),
    ));

  type Bad = {
    id: number; customerId: number; year: number; month: number; status: string;
    field: "customer" | "employee"; code: string; reason: string;
  };
  const bad: Bad[] = [];
  for (const r of rows) {
    if (r.customerSignatureData) {
      const res = analyzeSignatureImage(r.customerSignatureData);
      if (!res.ok) {
        bad.push({ id: r.id, customerId: r.customerId, year: r.year, month: r.month, status: r.status, field: "customer", code: res.code, reason: res.reason });
      }
    }
    if (r.employeeSignatureData) {
      const res = analyzeSignatureImage(r.employeeSignatureData);
      if (!res.ok) {
        bad.push({ id: r.id, customerId: r.customerId, year: r.year, month: r.month, status: r.status, field: "employee", code: res.code, reason: res.reason });
      }
    }
  }

  if (bad.length === 0) {
    console.log(`[audit-empty-signatures] OK — geprüft: ${rows.length} Service-Records, keine leeren Unterschriften gefunden.`);
    process.exit(0);
  }

  const customerIds = Array.from(new Set(bad.map(b => b.customerId)));
  const customerRows = customerIds.length > 0 ? await db.select({
    id: customers.id,
    vorname: customers.vorname,
    nachname: customers.nachname,
  }).from(customers).where(inArray(customers.id, customerIds)) : [];
  const customerName = new Map(customerRows.map(c => [c.id, `${c.vorname} ${c.nachname}`]));

  console.log(`[audit-empty-signatures] WARN — ${bad.length} leere Signatur(en) in ${rows.length} geprüften Records:\n`);
  for (const b of bad) {
    const invs = await db.select({
      id: invoicesTable.id,
      invoiceNumber: invoicesTable.invoiceNumber,
      status: invoicesTable.status,
      leistungsnachweisPath: invoicesTable.leistungsnachweisPath,
    }).from(invoicesTable).where(and(
      eq(invoicesTable.customerId, b.customerId),
      eq(invoicesTable.billingYear, b.year),
      eq(invoicesTable.billingMonth, b.month),
    ));
    const invLabel = invs.length > 0
      ? invs.map(i => `${i.invoiceNumber}[${i.status}${i.leistungsnachweisPath ? ",cached" : ""}]`).join(", ")
      : "—";
    console.log(`  SR#${b.id} | ${customerName.get(b.customerId) ?? `customer#${b.customerId}`} | ${b.year}-${String(b.month).padStart(2, "0")} | status=${b.status} | ${b.field}-sig: ${b.code} (${b.reason}) | invoices: ${invLabel}`);
  }
  console.log(`\nManuelle Nachsorge: betroffene Service-Records (a) zurücksetzen auf 'employee_signed' und vom Mitarbeiter neu unterschreiben lassen, oder (b) per Storno+Neuanlage auf Rechnungsseite korrigieren — siehe docs/deployment-log.md (RE-2026-0010).`);
  process.exit(1);
}

main().catch((err) => {
  console.error("[audit-empty-signatures] FAILED", err);
  process.exit(2);
});
