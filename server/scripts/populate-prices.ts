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
import { db } from "../lib/db";
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

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  assertNotProduction();

  const asOf = toDateStr(new Date())!;
  const report = await buildConsolidationReport(asOf);

  if (report.unmapped.length > 0) {
    console.warn(
      `WARNUNG: ${report.unmapped.length} Zeile(n) ohne Katalog-Service (serviceId == null) — ` +
        "werden NICHT eingespielt (Verlust-Risiko). Quellen:",
    );
    for (const u of report.unmapped) {
      console.warn(`  - ${u.source} #${u.sourceRowId} (${u.serviceLabel}, customerId=${u.customerId ?? "—"})`);
    }
  }

  // Quelle → Ziel-Zeile. serviceId-null wurde oben gewarnt und wird hier gefiltert.
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
  if (droppedNoValidFrom.length > 0) {
    console.warn(`WARNUNG: ${droppedNoValidFrom.length} Zeile(n) ohne validFrom übersprungen (validFrom ist NOT NULL).`);
  }

  // Bereits vorhandene `prices`-Zeilen → Natural-Key-Set für Idempotenz.
  const existing = await db
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

  console.log(
    `Report asOf=${asOf}: Quellzeilen=${report.rows.length} · einspielbar=${targets.length} · ` +
      `bereits vorhanden=${existing.length} · NEU=${toInsert.length}`,
  );

  if (!apply) {
    console.log("Trockenlauf (kein --apply): es wird nichts geschrieben.");
    return;
  }

  if (toInsert.length === 0) {
    console.log("Nichts zu tun — `prices` ist bereits aktuell.");
    return;
  }

  await db.insert(prices).values(
    toInsert.map((t) => ({
      scope: t.scope,
      origin: t.origin,
      customerId: t.customerId,
      serviceId: t.serviceId,
      cents: t.cents,
      validFrom: t.validFrom,
      validTo: t.validTo,
    })),
  );
  console.log(`Fertig: ${toInsert.length} Zeile(n) in \`prices\` eingefügt.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
