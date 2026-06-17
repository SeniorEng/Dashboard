/**
 * Task #1301 — Idempotente Befüllung der konsolidierten `prices`-Tabelle.
 *
 * Liest die drei Alt-Quellen READ-ONLY über `buildConsolidationReport` (denselben
 * Report wie die Konflikt-Sondierung) und spiegelt sie ADDITIV nach `prices`:
 *   - service_rates            → scope="standard" (customerId NULL)
 *   - customer_service_prices  → scope="customer"
 *   - customer_contract_rates  → scope="customer"
 *
 * Idempotent: pro Lauf werden nur Zeilen eingefügt, deren Natural-Key
 *   `scope|customerId|serviceId|cents|validFrom|validTo`
 * noch NICHT in `prices` existiert. Mehrfaches Ausführen erzeugt keine Duplikate.
 *
 * Verlust-Schutz: Zeilen ohne Katalog-Service (`serviceId == null`) können nicht
 * eingespielt werden und werden gezählt + gewarnt (NICHT still verworfen). Gate-2
 * hat 0 solcher Zeilen bestätigt — taucht hier eine auf, ist das ein Stopp-Signal.
 *
 * NUR Dev (Hostname-/NODE_ENV-Guard). NIE auf Produktion.
 *
 * Aufruf:
 *   Trockenlauf (Default):  tsx server/scripts/populate-prices.ts
 *   Scharf ausführen:       tsx server/scripts/populate-prices.ts --apply
 */
import { db, type DbOrTx } from "../lib/db";
import { prices, PRICE_ORIGINS, type PriceOriginKind } from "@shared/schema";
import { buildConsolidationReport } from "./report-price-consolidation-conflicts";

type Scope = "standard" | "customer";

interface TargetRow {
  scope: Scope;
  origin: PriceOriginKind;
  customerId: number | null;
  serviceId: number;
  cents: number;
  validFrom: string;
  validTo: string | null;
}

function toDateStr(value: Date | string | null): string | null {
  if (!value) return null;
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  return String(value).substring(0, 10);
}

function naturalKey(r: { scope: Scope; origin: PriceOriginKind; customerId: number | null; serviceId: number; cents: number; validFrom: string | null; validTo: string | null }): string {
  // origin gehört in den Schlüssel: eine csp- und eine ccr-Zeile mit identischen
  // Werten sind unterschiedliche Provenienz und müssen BEIDE existieren.
  return `${r.scope}|${r.origin}|${r.customerId ?? ""}|${r.serviceId}|${r.cents}|${r.validFrom ?? ""}|${r.validTo ?? ""}`;
}

function sourceToOrigin(source: string): PriceOriginKind {
  if ((PRICE_ORIGINS as readonly string[]).includes(source)) return source as PriceOriginKind;
  throw new Error(`Unbekannte Quelle '${source}' — kann keiner prices.origin zugeordnet werden.`);
}

function assertNotProduction(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("ABBRUCH: NODE_ENV=production. Dieses Skript darf nie auf Produktion laufen.");
  }
  const url = process.env.DATABASE_URL || "";
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    const m = url.match(/@([^:/?#]+)/);
    host = (m ? m[1] : "").toLowerCase();
  }
  if (host && /(^|[.-])prod([.-]|$)|production/.test(host)) {
    throw new Error(
      `ABBRUCH: DB-Host '${host}' sieht nach Produktion aus. Dieses Skript darf nie auf Produktion laufen.`,
    );
  }
  console.log(`Sicherheits-Check ok. DB-Host: ${host || "(unbekannt)"}`);
}

export interface PricePopulationPlan {
  asOf: string;
  sourceRowCount: number;
  eligibleCount: number;
  existingCount: number;
  toInsert: TargetRow[];
  unmapped: { source: string; sourceRowId: number; serviceLabel: string; customerId: number | null }[];
  droppedNoValidFrom: TargetRow[];
}

/**
 * Plant die additive `prices`-Befüllung READ-ONLY über den gegebenen Executor
 * (DB oder offene Transaktion). Schreibt NICHTS. Liefert die Liste der noch
 * fehlenden Zeilen (`toInsert`) sowie Diagnose-Zähler.
 */
export async function planPricePopulation(exec: DbOrTx, asOf: string): Promise<PricePopulationPlan> {
  const report = await buildConsolidationReport(asOf, exec);

  const droppedNoValidFrom: TargetRow[] = [];
  const targets: TargetRow[] = [];
  for (const r of report.rows) {
    if (r.serviceId == null) continue;
    const origin = sourceToOrigin(r.source);
    const scope: Scope = r.source === "service_rates" ? "standard" : "customer";
    const customerId = scope === "standard" ? null : r.customerId;
    if (r.validFrom == null) {
      droppedNoValidFrom.push({ scope, origin, customerId, serviceId: r.serviceId, cents: r.priceCents, validFrom: "", validTo: r.validTo });
      continue;
    }
    targets.push({ scope, origin, customerId, serviceId: r.serviceId, cents: r.priceCents, validFrom: r.validFrom, validTo: r.validTo });
  }

  // Bereits vorhandene `prices`-Zeilen → Natural-Key-Set für Idempotenz.
  const existing = await exec
    .select({
      scope: prices.scope,
      origin: prices.origin,
      customerId: prices.customerId,
      serviceId: prices.serviceId,
      cents: prices.cents,
      validFrom: prices.validFrom,
      validTo: prices.validTo,
    })
    .from(prices);
  const existingKeys = new Set(
    existing.map((e) =>
      naturalKey({
        scope: e.scope as Scope,
        origin: e.origin as PriceOriginKind,
        customerId: e.customerId,
        serviceId: e.serviceId,
        cents: e.cents,
        validFrom: toDateStr(e.validFrom),
        validTo: toDateStr(e.validTo),
      }),
    ),
  );

  // Nur fehlende einfügen; identische Tupel innerhalb des Laufs ebenfalls dedupen.
  const seen = new Set<string>(existingKeys);
  const toInsert: TargetRow[] = [];
  for (const t of targets) {
    const key = naturalKey(t);
    if (seen.has(key)) continue;
    seen.add(key);
    toInsert.push(t);
  }

  return {
    asOf,
    sourceRowCount: report.rows.length,
    eligibleCount: targets.length,
    existingCount: existing.length,
    toInsert,
    unmapped: report.unmapped.map((u) => ({
      source: u.source,
      sourceRowId: u.sourceRowId,
      serviceLabel: u.serviceLabel,
      customerId: u.customerId,
    })),
    droppedNoValidFrom,
  };
}

export interface PricePopulationResult {
  inserted: number;
  plan: PricePopulationPlan;
}

/**
 * Additive, idempotente `prices`-Befüllung über den gegebenen Executor. Innerhalb
 * einer Transaktion aufrufbar (z. B. aus der Konsolidierungs-Migration), damit
 * Befüllung + Gate-2 + Drop atomar laufen. Schreibt nur fehlende Natural-Keys.
 */
export async function populatePricesInto(exec: DbOrTx, asOf: string): Promise<PricePopulationResult> {
  const plan = await planPricePopulation(exec, asOf);
  if (plan.toInsert.length > 0) {
    await exec.insert(prices).values(
      plan.toInsert.map((t) => ({
        scope: t.scope,
        origin: t.origin,
        customerId: t.customerId,
        serviceId: t.serviceId,
        cents: t.cents,
        validFrom: t.validFrom,
        validTo: t.validTo,
      })),
    );
  }
  return { inserted: plan.toInsert.length, plan };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  assertNotProduction();

  const asOf = toDateStr(new Date())!;
  const plan = await planPricePopulation(db, asOf);

  if (plan.unmapped.length > 0) {
    console.warn(
      `WARNUNG: ${plan.unmapped.length} Zeile(n) ohne Katalog-Service (serviceId == null) — ` +
        "werden NICHT eingespielt (Verlust-Risiko). Quellen:",
    );
    for (const u of plan.unmapped) {
      console.warn(`  - ${u.source} #${u.sourceRowId} (${u.serviceLabel}, customerId=${u.customerId ?? "—"})`);
    }
  }
  if (plan.droppedNoValidFrom.length > 0) {
    console.warn(`WARNUNG: ${plan.droppedNoValidFrom.length} Zeile(n) ohne validFrom übersprungen (validFrom ist NOT NULL).`);
  }

  console.log(
    `Report asOf=${asOf}: Quellzeilen=${plan.sourceRowCount} · einspielbar=${plan.eligibleCount} · ` +
      `bereits vorhanden=${plan.existingCount} · NEU=${plan.toInsert.length}`,
  );

  if (!apply) {
    console.log("Trockenlauf (kein --apply): es wird nichts geschrieben.");
    return;
  }

  if (plan.toInsert.length === 0) {
    console.log("Nichts zu tun — `prices` ist bereits aktuell.");
    return;
  }

  const result = await populatePricesInto(db, asOf);
  console.log(`Fertig: ${result.inserted} Zeile(n) in \`prices\` eingefügt.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
