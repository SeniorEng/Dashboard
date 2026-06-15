/**
 * Phase 3.3 — GATE 2: Schatten-Diff der KONSOLIDIERTEN `priceFor` (READ-ONLY).
 *
 * Abgrenzung zu `shadow-diff-price-for.ts` (Gate 1):
 *   Gate 1 beweist nur `priceFor == heute` IM SCHATTENMODUS — also solange der
 *   Standard-Scope leer ist und `service_rates` + `customer_contract_rates` für
 *   die Preisbildung SCHLAFEN. Heute liest die Live-Auflösung ausschließlich
 *   `customer_service_prices` → Katalog-Default. Gate 1 sagt damit NICHTS darüber
 *   aus, ob die fertig KONSOLIDIERTE Tabelle (Standard-Scope aus `service_rates`
 *   befüllt + `customer_contract_rates` eingespielt) das heutige Live-Verhalten
 *   reproduziert.
 *
 *   Gate 2 schließt genau diese Lücke: es simuliert die KONSOLIDIERTE Auflösung
 *   (csp → ccr → service_rates(Standard) → Katalog-Default) und vergleicht sie
 *   gegen das HEUTIGE Live-Verhalten. Jede Abweichung = eine bisher schlafende
 *   Quelle, die durch die Konsolidierung AKTIV würde. Gate = 0 Cent.
 *
 * Baseline (= heutiges Live-Verhalten):
 *   Der UNABHÄNGIGE Legacy-Resolver: vorhandene `customer_service_prices`-Zeile
 *   (Existenz gewinnt, auch cents=0) am Datum → sonst Katalog-Default. Bewusst
 *   NICHT die konsolidierte `priceFor` (kein Selbstvergleich).
 *
 * Abdeckung (BREITER als nur gebuchte Termine — sonst entgehen dormante Overrides,
 * die im Termin-Fenster nie abgerechnet wurden, aber künftige Buchungen ändern):
 *   1. reale Termin-Tupel (Kunde × Service × Datum) der letzten N Monate, und
 *   2. ALLE (Kunde, Service)-Paare aus `customer_contract_rates`, am Stichtag, und
 *   3. ALLE Services aus `service_rates` (Standard-Scope, firmenweit) am Stichtag —
 *      betreffen JEDEN Kunden ohne csp/ccr-Override.
 *
 * Konsolidierungs-Präzedenz (simuliert, MINIMIERT Verhaltensänderung):
 *   csp (Kunde) gewinnt vor ccr (Kunde) vor service_rates (Standard) vor Katalog.
 *   csp-gewinnt hält Paare mit heutigem Kunden-Override stabil; ccr/service_rates
 *   "aktivieren" nur dort, wo heute auf den Katalog-Default durchgefallen wird.
 *   Wo csp UND ccr gleichzeitig aktiv sind, wird ccr unter dieser Präzedenz
 *   VERWORFEN — separat als "shadowedContractRates" ausgewiesen, damit Alrik je
 *   Zeile entscheiden kann (ccr soll gelten ODER wird verworfen). Die finale
 *   Präzedenz ist Alriks Entscheidung; dieses Skript schreibt nichts.
 *
 *   GoBD: rein lesend. Keine fakturierten Snapshots werden neu berechnet.
 *
 * Aufruf:
 *   tsx server/scripts/shadow-diff-price-for-consolidated.ts
 *   tsx server/scripts/shadow-diff-price-for-consolidated.ts --months=12 --asof=2026-06-15 --csv=gate2.csv
 */

import { writeFileSync } from "node:fs";
import { and, eq, gte, isNull } from "drizzle-orm";
import { db } from "../lib/db";
import { appointments, appointmentServices, services } from "@shared/schema";
import { resolvePriceFor, type VersionedPriceRow, type PriceCatalogEntry } from "@shared/domain/pricing/price-for";
import { buildConsolidationReport } from "./report-price-consolidation-conflicts";

const MIN_DATE = "0000-01-01";
const MAX_DATE = "9999-12-31";

function toDateStr(d: Date | string | null): string | null {
  if (!d) return null;
  if (d instanceof Date) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return String(d).substring(0, 10);
}

/** Am `date` aktive Zeile: spätestes validFrom, dann höchste id. Sonst null. */
function pickActive(rows: readonly VersionedPriceRow[], date: string): VersionedPriceRow | null {
  let best: VersionedPriceRow | null = null;
  for (const r of rows) {
    const from = r.validFrom ?? MIN_DATE;
    const to = r.validTo ?? MAX_DATE;
    if (date < from || date > to) continue;
    if (best === null) { best = r; continue; }
    const bestFrom = best.validFrom ?? MIN_DATE;
    if (from > bestFrom || (from === bestFrom && r.id > best.id)) best = r;
  }
  return best;
}

/** Baseline = heutiges Live-Verhalten: csp (Existenz gewinnt) → Katalog-Default. */
function legacyResolve(cspRows: readonly VersionedPriceRow[], date: string, catalog: PriceCatalogEntry | undefined): number | null {
  const csp = pickActive(cspRows, date);
  if (csp !== null) return csp.priceCents; // Existenz gewinnt — kein 0-Kurzschluss.
  if (catalog) return catalog.isBillable === false ? 0 : catalog.defaultPriceCents;
  return null;
}

export type DeviationSource = "customer_contract_rates" | "service_rates";

export interface Gate2Result {
  asOf: string;
  coveragePoints: number;
  /** (csp & ccr beide aktiv, abweichend) ⇒ ccr unter csp-gewinnt verworfen — Alrik-Entscheidung je Zeile. */
  shadowedContractRates: Array<{ customerId: number; serviceId: number; cspCents: number; ccrCents: number }>;
  /** 0-Cent-Gate: jede Abweichung = aktivierte dormante Quelle → einzeln an Alrik. */
  deviations: Array<{
    customerId: number | null; // null = firmenweiter Standard-Scope (alle Kunden ohne Override)
    serviceId: number;
    date: string;
    baselineCents: number | null;
    consolidatedCents: number | null;
    activatedSource: DeviationSource;
    /** Konkrete Quell-Zeile, die die Abweichung auslöst — Alrik entscheidet GENAU diese Zeile. */
    triggeredRowId: number;
    triggeredValidFrom: string | null;
    triggeredValidTo: string | null;
  }>;
}

export async function runGate2Diff(months: number, asOf: string): Promise<Gate2Result> {
  // EINE Lade-/Mapping-Quelle für alle drei Tabellen (Soft-Delete-konform,
  // Kategorie→Service-ID gemappt) — wiederverwendet aus dem Konflikt-Report.
  const report = await buildConsolidationReport(asOf);

  // Gruppieren nach Quelle in zeitversionierte Zeilen.
  const cspByKey = new Map<string, VersionedPriceRow[]>(); // `${cust}:${svc}`
  const ccrByKey = new Map<string, VersionedPriceRow[]>(); // `${cust}:${svc}`
  const srBySvc = new Map<number, VersionedPriceRow[]>();   // svc
  const pushTo = <K>(map: Map<K, VersionedPriceRow[]>, key: K, row: VersionedPriceRow) => {
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  };
  for (const r of report.rows) {
    if (r.serviceId == null) continue; // unzuordenbare Zeilen klärt der Konflikt-Report
    const row: VersionedPriceRow = { id: r.sourceRowId, priceCents: r.priceCents, validFrom: r.validFrom, validTo: r.validTo };
    if (r.source === "customer_service_prices" && r.customerId != null) {
      pushTo(cspByKey, `${r.customerId}:${r.serviceId}`, row);
    } else if (r.source === "customer_contract_rates" && r.customerId != null) {
      pushTo(ccrByKey, `${r.customerId}:${r.serviceId}`, row);
    } else if (r.source === "service_rates") {
      pushTo(srBySvc, r.serviceId, row);
    }
  }

  // Katalog (Default + billable).
  const catalogRows = await db
    .select({ id: services.id, defaultPriceCents: services.defaultPriceCents, isBillable: services.isBillable })
    .from(services);
  const catalogById = new Map<number, PriceCatalogEntry>(
    catalogRows.map((s) => [s.id, { defaultPriceCents: s.defaultPriceCents ?? 0, isBillable: s.isBillable !== false }]),
  );

  // Prospektive KONSOLIDIERTE Auflösung: csp → ccr → service_rates(Standard) → Default.
  // Gibt zusätzlich die KONKRETE auslösende Quell-Zeile zurück (für Alriks
  // Je-Zeile-Entscheidung); `row=null`/`source=null` ⇒ reiner Katalog-Default.
  function consolidatedResolve(
    customerId: number | null,
    serviceId: number,
    date: string,
  ): { cents: number | null; row: VersionedPriceRow | null; source: DeviationSource | null } {
    const catalog = catalogById.get(serviceId);
    if (customerId != null) {
      const csp = pickActive(cspByKey.get(`${customerId}:${serviceId}`) ?? [], date);
      // csp gewinnt — stabil zu heute (Baseline nutzt dieselbe Zeile) ⇒ nie eine Abweichung.
      if (csp !== null) return { cents: csp.priceCents, row: null, source: null };
      const ccr = pickActive(ccrByKey.get(`${customerId}:${serviceId}`) ?? [], date);
      if (ccr !== null) return { cents: ccr.priceCents, row: ccr, source: "customer_contract_rates" };
    }
    const std = pickActive(srBySvc.get(serviceId) ?? [], date);
    if (std !== null) return { cents: std.priceCents, row: std, source: "service_rates" };
    // Reiner Katalog-Default über die SSoT-Funktion (isBillable===false ⇒ 0).
    return { cents: resolvePriceFor({ date, customerRows: [], standardRows: [], catalog })?.cents ?? null, row: null, source: null };
  }

  // --- Abdeckung 1: reale Termin-Tupel der letzten N Monate. ---
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const cutoffStr = toDateStr(cutoff)!;
  const appts = await db
    .select({ customerId: appointments.customerId, date: appointments.date, serviceId: appointmentServices.serviceId })
    .from(appointments)
    .innerJoin(appointmentServices, eq(appointmentServices.appointmentId, appointments.id))
    .where(and(isNull(appointments.deletedAt), gte(appointments.date, cutoffStr)));

  // Abdeckungspunkte deduplizieren: customerId (null = Standard) × serviceId × date.
  const coverage = new Map<string, { customerId: number | null; serviceId: number; date: string }>();
  const add = (customerId: number | null, serviceId: number, date: string) => {
    coverage.set(`${customerId ?? "*"}:${serviceId}:${date}`, { customerId, serviceId, date });
  };
  for (const a of appts) {
    if (a.customerId == null) continue;
    add(a.customerId, a.serviceId, toDateStr(a.date)!);
  }
  // --- Abdeckung 2: ALLE (Kunde, Service) aus contract_rates, am Stichtag. ---
  for (const key of ccrByKey.keys()) {
    const [cid, sid] = key.split(":").map((n) => parseInt(n, 10));
    add(cid, sid, asOf);
  }
  // --- Abdeckung 3: ALLE Services aus service_rates (Standard, firmenweit), am Stichtag. ---
  for (const sid of srBySvc.keys()) add(null, sid, asOf);

  // Diff je Abdeckungspunkt.
  const deviations: Gate2Result["deviations"] = [];
  for (const p of coverage.values()) {
    const cspRows = p.customerId != null ? (cspByKey.get(`${p.customerId}:${p.serviceId}`) ?? []) : [];
    const baseline = legacyResolve(cspRows, p.date, catalogById.get(p.serviceId));
    const consolidated = consolidatedResolve(p.customerId, p.serviceId, p.date);
    if (baseline === consolidated.cents) continue;
    // Eine Abweichung kann nur entstehen, wenn eine dormante Quelle (ccr/service_rates)
    // ausgelöst hat — csp gewinnt in beiden Pfaden. row/source sind dann gesetzt.
    if (consolidated.row === null || consolidated.source === null) continue;
    deviations.push({
      customerId: p.customerId,
      serviceId: p.serviceId,
      date: p.date,
      baselineCents: baseline,
      consolidatedCents: consolidated.cents,
      activatedSource: consolidated.source,
      triggeredRowId: consolidated.row.id,
      triggeredValidFrom: consolidated.row.validFrom,
      triggeredValidTo: consolidated.row.validTo,
    });
  }

  // Verschattete ccr (csp & ccr beide aktiv am Stichtag, abweichend) — Awareness.
  const shadowedContractRates: Gate2Result["shadowedContractRates"] = [];
  for (const key of ccrByKey.keys()) {
    const csp = pickActive(cspByKey.get(key) ?? [], asOf);
    const ccr = pickActive(ccrByKey.get(key) ?? [], asOf);
    if (csp !== null && ccr !== null && csp.priceCents !== ccr.priceCents) {
      const [cid, sid] = key.split(":").map((n) => parseInt(n, 10));
      shadowedContractRates.push({ customerId: cid, serviceId: sid, cspCents: csp.priceCents, ccrCents: ccr.priceCents });
    }
  }

  return { asOf, coveragePoints: coverage.size, shadowedContractRates, deviations };
}

async function main() {
  const args = process.argv.slice(2);
  const monthsArg = args.find((a) => a.startsWith("--months="));
  const asofArg = args.find((a) => a.startsWith("--asof="));
  const csvArg = args.find((a) => a.startsWith("--csv="));
  const months = monthsArg ? Math.max(1, parseInt(monthsArg.split("=")[1], 10) || 12) : 12;
  const asOf = asofArg ? asofArg.split("=")[1] : toDateStr(new Date())!;
  const csvPath = csvArg ? csvArg.split("=").slice(1).join("=").trim() : undefined;

  console.log(`=== priceFor GATE 2 — Schatten-Diff der KONSOLIDIERTEN Auflösung (READ-ONLY) ===`);
  console.log(`Stichtag (asOf): ${asOf} · Termin-Fenster: letzte ${months} Monat(e)\n`);

  const res = await runGate2Diff(months, asOf);
  console.log(`Abdeckungspunkte (Termine + ccr-Paare + service_rates-Services): ${res.coveragePoints}`);

  console.log(`\nVerschattete Vertragssätze (csp & ccr aktiv, abweichend — ccr würde verworfen): ${res.shadowedContractRates.length}`);
  for (const s of res.shadowedContractRates) {
    console.log(`  Kunde #${s.customerId} Service #${s.serviceId}: csp=${s.cspCents} ct (gilt) vs ccr=${s.ccrCents} ct (verworfen) — Alrik entscheidet`);
  }

  console.log(`\n=== GATE 2 (0-Cent) — Abweichungen konsolidiert vs heute: ${res.deviations.length} ===`);
  for (const d of res.deviations) {
    const who = d.customerId == null ? "Standard (alle Kunden ohne Override)" : `Kunde #${d.customerId}`;
    const window = `validFrom=${d.triggeredValidFrom ?? "—"} validTo=${d.triggeredValidTo ?? "offen"}`;
    console.log(
      `  ${who} Service #${d.serviceId} @ ${d.date}: heute=${d.baselineCents} ct → konsolidiert=${d.consolidatedCents} ct ` +
        `[aktiviert: ${d.activatedSource} #${d.triggeredRowId}, ${window}] — Alrik: Zeile anwenden ODER verwerfen`,
    );
  }

  if (csvPath) {
    const lines = ["customerId,serviceId,date,baselineCents,consolidatedCents,activatedSource,triggeredRowId,triggeredValidFrom,triggeredValidTo"];
    for (const d of res.deviations) {
      lines.push([
        d.customerId ?? "", d.serviceId, d.date, d.baselineCents ?? "", d.consolidatedCents ?? "",
        d.activatedSource, d.triggeredRowId, d.triggeredValidFrom ?? "", d.triggeredValidTo ?? "",
      ].join(","));
    }
    writeFileSync(csvPath, lines.join("\n"), "utf8");
    console.log(`\nCSV (Abweichungen, je Zeile entscheidbar) geschrieben: ${csvPath}`);
  }

  console.log(`\n=== Fazit ===`);
  console.log(res.deviations.length === 0
    ? "GATE 2 GRÜN: konsolidierte Auflösung ist 0-Cent-wertgleich zum heutigen Verhalten. Cutover wäre wertneutral (nach Freigabe)."
    : `GATE 2 ROT: ${res.deviations.length} Abweichung(en) — jede ist eine aktivierte dormante Quelle und MUSS einzeln von Alrik entschieden werden, BEVOR gelöscht wird.`);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fehler:", err);
    process.exit(1);
  });
}
