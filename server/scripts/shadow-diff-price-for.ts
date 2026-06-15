/**
 * Task #1291 (Phase 3.3) — Schatten-Diff der `priceFor`-SSoT (READ-ONLY).
 *
 * Zweck:
 *   Beweist VOR dem (menschlich freigegebenen) Cutover, dass die neue eine
 *   Auflösung `priceFor` (`server/storage/pricing/price-for.ts` →
 *   `shared/domain/pricing/price-for.ts`) auf realen Daten WERTGLEICH zum bisher
 *   gelebten Preis-Resolutionsverhalten ist. Verglichen wird gegen einen
 *   UNABHÄNGIGEN Referenz-Resolver (eigenständiger Roh-Read von
 *   `customer_service_prices` + Katalog-Default — importiert NICHT price-for.ts),
 *   damit der Diff aussagekräftig ist und nicht „sich selbst" prüft.
 *
 *   Stichprobe: alle (Kunde, Service, Datum)-Tupel realer Termine der letzten
 *   N Monate (Default 12). Alrik-Constraint #1: die Stichprobe MUSS ≥1 echten
 *   0-Override-Kunden enthalten — sonst bricht der Lauf mit Exit 2 ab, damit der
 *   Schatten-Datensatz nachweislich den 0-Fall abdeckt (kein 0/NULL-Kurzschluss).
 *
 *   GoBD: rein lesend. Bereits berechnete/fakturierte Snapshots werden NICHT
 *   neu berechnet oder überschrieben.
 *
 * Aufruf:
 *   tsx server/scripts/shadow-diff-price-for.ts
 *   tsx server/scripts/shadow-diff-price-for.ts --months=12 --csv=shadow.csv
 */

import { writeFileSync } from "node:fs";
import { and, eq, gte, isNull } from "drizzle-orm";
import { db } from "../lib/db";
import { appointments, appointmentServices, customerServicePrices, services } from "@shared/schema";
import { loadCustomerPriceContext } from "../storage/pricing/price-for";

function toDateStr(d: Date | string | null): string | null {
  if (!d) return null;
  if (d instanceof Date) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return String(d).substring(0, 10);
}

const MIN_DATE = "0000-01-01";
const MAX_DATE = "9999-12-31";

interface LegacyRow { priceCents: number; validFrom: string | null; validTo: string | null; id: number }

/**
 * UNABHÄNGIGER Referenz-Resolver (bewusst NICHT price-for.ts). Bildet die
 * gelebte Legacy-Regel nach: vorhandene Kundenzeile (Existenz gewinnt, auch
 * cents=0) am Datum → sonst Katalog-Default (nicht abrechenbar ⇒ 0).
 */
function legacyResolve(
  customerRows: LegacyRow[],
  date: string,
  catalog: { defaultPriceCents: number; isBillable: boolean } | undefined,
): number | null {
  let best: LegacyRow | null = null;
  for (const r of customerRows) {
    const from = r.validFrom ?? MIN_DATE;
    const to = r.validTo ?? MAX_DATE;
    if (date < from || date > to) continue;
    if (best === null) { best = r; continue; }
    const bestFrom = best.validFrom ?? MIN_DATE;
    if (from > bestFrom || (from === bestFrom && r.id > best.id)) best = r;
  }
  if (best !== null) return best.priceCents; // EXISTENZ gewinnt — kein 0-Kurzschluss.
  if (catalog) return catalog.isBillable === false ? 0 : catalog.defaultPriceCents;
  return null;
}

export interface ShadowDiffResult {
  tuples: number;
  customers: number;
  zeroOverrideCustomers: number[];
  mismatches: Array<{ customerId: number; serviceId: number; date: string; ssot: number | null; legacy: number | null }>;
}

export async function runShadowDiff(months: number): Promise<ShadowDiffResult> {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const cutoffStr = toDateStr(cutoff)!;

  // Reale Termine der letzten N Monate → (customerId, serviceId, date)-Tupel.
  // Services hängen an `appointment_services` (nicht am Termin selbst).
  const appts = await db
    .select({ customerId: appointments.customerId, date: appointments.date, serviceId: appointmentServices.serviceId })
    .from(appointments)
    .innerJoin(appointmentServices, eq(appointmentServices.appointmentId, appointments.id))
    .where(and(isNull(appointments.deletedAt), gte(appointments.date, cutoffStr)));

  // Katalog für Default + 0-Override-Detektion.
  const catalog = await db
    .select({ id: services.id, defaultPriceCents: services.defaultPriceCents, isBillable: services.isBillable })
    .from(services);
  const catalogById = new Map(catalog.map((s) => [s.id, { defaultPriceCents: s.defaultPriceCents ?? 0, isBillable: s.isBillable !== false }]));

  // Tupel deduplizieren.
  const tupleSet = new Map<string, { customerId: number; serviceId: number; date: string }>();
  for (const a of appts) {
    if (a.customerId == null) continue;
    const date = toDateStr(a.date)!;
    tupleSet.set(`${a.customerId}:${a.serviceId}:${date}`, { customerId: a.customerId, serviceId: a.serviceId, date });
  }
  const tuples = [...tupleSet.values()];

  const customerIds = [...new Set(tuples.map((t) => t.customerId))];

  // Pro Kunde: Legacy-Roh-Zeilen + SSoT-Kontext einmal laden.
  const legacyByCustomer = new Map<number, Map<number, LegacyRow[]>>();
  const zeroOverrideCustomers: number[] = [];
  for (const cid of customerIds) {
    const rows = await db
      .select({
        id: customerServicePrices.id,
        serviceId: customerServicePrices.serviceId,
        priceCents: customerServicePrices.priceCents,
        validFrom: customerServicePrices.validFrom,
        validTo: customerServicePrices.validTo,
      })
      .from(customerServicePrices)
      .where(and(eq(customerServicePrices.customerId, cid), isNull(customerServicePrices.deletedAt)));
    const byService = new Map<number, LegacyRow[]>();
    let hasZero = false;
    for (const r of rows) {
      const list = byService.get(r.serviceId) ?? [];
      list.push({ priceCents: r.priceCents, validFrom: toDateStr(r.validFrom), validTo: toDateStr(r.validTo), id: r.id });
      byService.set(r.serviceId, list);
      if (r.priceCents === 0) hasZero = true;
    }
    legacyByCustomer.set(cid, byService);
    if (hasZero) zeroOverrideCustomers.push(cid);
  }

  const mismatches: ShadowDiffResult["mismatches"] = [];
  for (const cid of customerIds) {
    const ctx = await loadCustomerPriceContext(cid);
    const byService = legacyByCustomer.get(cid)!;
    for (const t of tuples.filter((x) => x.customerId === cid)) {
      const ssot = ctx.resolveById(t.serviceId, t.date)?.cents ?? null;
      const legacy = legacyResolve(byService.get(t.serviceId) ?? [], t.date, catalogById.get(t.serviceId));
      if (ssot !== legacy) {
        mismatches.push({ customerId: cid, serviceId: t.serviceId, date: t.date, ssot, legacy });
      }
    }
  }

  return { tuples: tuples.length, customers: customerIds.length, zeroOverrideCustomers, mismatches };
}

async function main() {
  const args = process.argv.slice(2);
  const monthsArg = args.find((a) => a.startsWith("--months="));
  const csvArg = args.find((a) => a.startsWith("--csv="));
  const months = monthsArg ? Math.max(1, parseInt(monthsArg.split("=")[1], 10) || 12) : 12;
  const csvPath = csvArg ? csvArg.split("=").slice(1).join("=").trim() : undefined;

  console.log(`=== priceFor Schatten-Diff (READ-ONLY) ===`);
  console.log(`Zeitfenster: letzte ${months} Monat(e)\n`);

  const res = await runShadowDiff(months);
  console.log(`Verglichene Tupel (Kunde×Service×Datum): ${res.tuples}`);
  console.log(`Betroffene Kunden:                       ${res.customers}`);
  console.log(`Kunden mit 0-Override im Datensatz:      ${res.zeroOverrideCustomers.length} (${res.zeroOverrideCustomers.join(", ") || "—"})`);
  console.log(`\nAbweichungen SSoT vs Legacy-Referenz:    ${res.mismatches.length}`);
  for (const m of res.mismatches) {
    console.log(`  Kunde #${m.customerId} Service #${m.serviceId} @ ${m.date}: SSoT=${m.ssot} ct vs Legacy=${m.legacy} ct`);
  }

  if (csvPath) {
    const lines = ["customerId,serviceId,date,ssotCents,legacyCents"];
    for (const m of res.mismatches) lines.push([m.customerId, m.serviceId, m.date, m.ssot ?? "", m.legacy ?? ""].join(","));
    writeFileSync(csvPath, lines.join("\n"), "utf8");
    console.log(`\nCSV (Abweichungen) geschrieben: ${csvPath}`);
  }

  if (res.zeroOverrideCustomers.length === 0) {
    console.error(
      `\nABBRUCH (Exit 2): Der Schatten-Datensatz enthält KEINEN echten 0-Override-Kunden. ` +
        `Alrik-Constraint #1 verlangt ≥1 0-Override im Diff. Bitte einen Kunden mit ` +
        `priceCents=0-Sonderpreis im Zeitfenster sicherstellen und erneut laufen lassen.`,
    );
    process.exit(2);
  }

  console.log(`\n=== Fazit ===`);
  console.log(res.mismatches.length === 0
    ? "Keine Abweichung — priceFor ist wertgleich zum gelebten Verhalten. Cutover wäre wertneutral."
    : `${res.mismatches.length} Abweichung(en) — VOR Cutover klären (Freigabe durch Alrik erforderlich).`);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fehler:", err);
    process.exit(1);
  });
}
