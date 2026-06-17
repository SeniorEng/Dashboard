/**
 * Task #1329 — Idempotente Startup-Befüllung der konsolidierten `prices`-SSoT aus
 * den drei Alt-Preis-Tabellen (`service_rates`, `customer_contract_rates`,
 * `customer_service_prices`).
 *
 * Hintergrund: Der Preis-Cutover (#1325) liest/schreibt ausschließlich `prices`,
 * und die Drop-Migration der drei Alt-Tabellen (#1326) liegt bereits gemerged auf
 * `main`. Es fehlte aber das Bindeglied — NICHTS befüllte `prices` in Produktion.
 * Diese Migration schließt die Lücke: sie spielt die Alt-Zeilen verlustfrei und
 * `origin`-gestempelt nach `prices` ein, BEVOR `dropLegacyPriceTables` läuft.
 *
 * Mapping (wie in #1326 dokumentiert):
 *   - service_rates            → scope="standard" (origin="service_rates", customerId NULL)
 *   - customer_contract_rates  → scope="customer"  (origin="customer_contract_rates",
 *                                customerId via JOIN customer_contracts)
 *   - customer_service_prices  → scope="customer"  (origin="customer_service_prices")
 *
 * Die Kategorie-Quellen (service_rates / customer_contract_rates) referenzieren
 * `service_category`, das per `services.code` auf den Katalog-Service gemappt wird.
 *
 * Eigenschaften:
 *   - Ledger-gegated (einmaliger Lauf über `budget_migrations`), aber NICHT
 *     flag-gegated — additiver Daten-Transport, kein Sign-off nötig.
 *   - Idempotent: Dedup über den vollständigen Natural Key inkl. `origin`; ein
 *     erneuter Lauf über identische Quelldaten ist ein No-Op.
 *   - Respektiert den partiellen Unique-Index `prices_active_validfrom_uniq`
 *     (scope, origin, customerId, serviceId, validFrom) WHERE deleted_at IS NULL:
 *     erst Soft-Delete einer bestehenden aktiven Index-Key-Zeile, dann Insert.
 *   - Verlustfrei: Zeilen ohne `validFrom` oder ohne Katalog-Zuordnung werden
 *     GEMELDET (Log), nicht stillschweigend verworfen.
 *   - Fehlende Alt-Tabellen (z. B. dev nach #1326) → sauberer No-Op statt Fehler.
 *
 * Direkt nach der Befüllung läuft ein harter Gate-2-Paritäts-Selbstcheck: die
 * konsolidierte `priceFor`-Auflösung (aus `prices`) muss über die volle Abdeckung
 * mit einer UNABHÄNGIGEN Legacy-Auflösung (aus den Alt-Zeilen) übereinstimmen.
 * Jede Abweichung ≠ 0 Cent → harter Startup-Fehlschlag (kein Serving mit falschen
 * Preisen). Anschließend wird eine Pre-Publish-Verifikation geloggt.
 *
 * Die drei Alt-Tabellen sind aus dem Drizzle-Schema entfernt → Zugriff per
 * Raw-SQL (`db.execute(sql\`…\`)`).
 */
import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "../lib/db";
import { log } from "../lib/log";
import {
  appointments,
  appointmentServices,
  prices,
  services as servicesTable,
} from "@shared/schema";
import {
  resolvePriceFor,
  type PriceCatalogEntry,
  type PriceResolution,
  type VersionedPriceRow,
} from "@shared/domain/pricing/price-for";
import {
  runGuardedBudgetMigration,
  type BudgetMigrationSummary,
} from "./budget-migration-runner";

export const POPULATE_PRICES_MIGRATION_NAME = "populate-prices-from-legacy-1329";

/** Wie weit die Gate-2-Termin-Abdeckung zurückreicht (Monate). */
const GATE2_APPOINTMENT_MONTHS = 24;

type LegacyOrigin =
  | "service_rates"
  | "customer_contract_rates"
  | "customer_service_prices";

/** Eine kanonische Zielzeile für `prices` (aus einer Alt-Zeile abgeleitet). */
export interface TargetPriceRow {
  scope: "standard" | "customer";
  origin: LegacyOrigin;
  customerId: number | null;
  serviceId: number;
  cents: number;
  validFrom: string | null;
  validTo: string | null;
  /** Einfüge-Reihenfolge — deterministischer Tiebreaker = spätere prices.id. */
  ordinal: number;
}

interface LegacyLoadResult {
  /** Mappbare Zielzeilen (serviceId aufgelöst, geordnet csp → ccr → service_rates). */
  rows: TargetPriceRow[];
  /** Zeilen ohne Katalog-Zuordnung (serviceId == null) — Verlust-Risiko, gemeldet. */
  unmapped: Array<{ origin: LegacyOrigin; sourceRowId: number; label: string; cents: number }>;
  /** Zeilen ohne validFrom — können nicht eingefügt werden, gemeldet. */
  droppedNoValidFrom: Array<{ origin: LegacyOrigin; sourceRowId: number; serviceId: number; cents: number }>;
  /** Roh-Zeilenzahl je Quelle (mit derselben Filterung wie das Lesen). */
  legacyCounts: Record<LegacyOrigin, number>;
  /** Welche Alt-Tabellen überhaupt existieren. */
  present: Record<LegacyOrigin, boolean>;
  catalogById: Map<number, PriceCatalogEntry>;
}

function toDateStr(d: unknown): string | null {
  if (d == null) return null;
  if (d instanceof Date) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return String(d).substring(0, 10);
}

function todayStr(): string {
  return toDateStr(new Date())!;
}

async function legacyTableExists(exec: Tx, table: string): Promise<boolean> {
  const res = await exec.execute(sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ${table}
    LIMIT 1
  `);
  return ((res as { rows?: unknown[] }).rows?.length ?? 0) > 0;
}

function rowsOf<T>(res: unknown): T[] {
  return ((res as { rows?: T[] }).rows ?? []) as T[];
}

/**
 * Liest die drei Alt-Tabellen (sofern vorhanden) READ-ONLY und baut die
 * geordnete Liste kanonischer Zielzeilen sowie die Verlust-Reports.
 */
async function loadLegacyPriceSources(exec: Tx): Promise<LegacyLoadResult> {
  const catalog = await exec
    .select({
      id: servicesTable.id,
      code: servicesTable.code,
      defaultPriceCents: servicesTable.defaultPriceCents,
      isBillable: servicesTable.isBillable,
    })
    .from(servicesTable);
  const serviceIdByCode = new Map<string, number>();
  const catalogById = new Map<number, PriceCatalogEntry>();
  for (const s of catalog) {
    if (s.code) serviceIdByCode.set(s.code, s.id);
    catalogById.set(s.id, {
      defaultPriceCents: s.defaultPriceCents ?? 0,
      isBillable: s.isBillable !== false,
    });
  }

  const present: LegacyLoadResult["present"] = {
    service_rates: await legacyTableExists(exec, "service_rates"),
    customer_contract_rates: await legacyTableExists(exec, "customer_contract_rates"),
    customer_service_prices: await legacyTableExists(exec, "customer_service_prices"),
  };

  const rows: TargetPriceRow[] = [];
  const unmapped: LegacyLoadResult["unmapped"] = [];
  const droppedNoValidFrom: LegacyLoadResult["droppedNoValidFrom"] = [];
  const legacyCounts: LegacyLoadResult["legacyCounts"] = {
    service_rates: 0,
    customer_contract_rates: 0,
    customer_service_prices: 0,
  };
  let ordinal = 0;

  const pushTarget = (
    origin: LegacyOrigin,
    scope: "standard" | "customer",
    customerId: number | null,
    sourceRowId: number,
    serviceId: number | null,
    label: string,
    cents: number,
    validFrom: string | null,
    validTo: string | null,
  ) => {
    if (serviceId == null) {
      unmapped.push({ origin, sourceRowId, label, cents });
      return;
    }
    if (validFrom == null) {
      droppedNoValidFrom.push({ origin, sourceRowId, serviceId, cents });
      return;
    }
    rows.push({ scope, origin, customerId, serviceId, cents, validFrom, validTo, ordinal: ordinal++ });
  };

  // 1. customer_service_prices (Kunden-Override pro Service, nur nicht soft-deleted).
  if (present.customer_service_prices) {
    const csp = rowsOf<{
      id: number;
      customer_id: number;
      service_id: number;
      price_cents: number;
      valid_from: unknown;
      valid_to: unknown;
    }>(
      await exec.execute(sql`
        SELECT id, customer_id, service_id, price_cents, valid_from, valid_to
        FROM customer_service_prices
        WHERE deleted_at IS NULL
      `),
    );
    legacyCounts.customer_service_prices = csp.length;
    for (const r of csp) {
      pushTarget(
        "customer_service_prices",
        "customer",
        Number(r.customer_id),
        Number(r.id),
        Number(r.service_id),
        `service#${r.service_id}`,
        Number(r.price_cents),
        toDateStr(r.valid_from),
        toDateStr(r.valid_to),
      );
    }
  }

  // 2. customer_contract_rates (Vertrags-/Stundensatz pro Kunde + Service-Kategorie).
  if (present.customer_contract_rates) {
    const ccr = rowsOf<{
      id: number;
      customer_id: number;
      service_category: string;
      hourly_rate_cents: number;
      valid_from: unknown;
      valid_to: unknown;
    }>(
      await exec.execute(sql`
        SELECT r.id, c.customer_id, r.service_category, r.hourly_rate_cents, r.valid_from, r.valid_to
        FROM customer_contract_rates r
        INNER JOIN customer_contracts c ON r.contract_id = c.id
      `),
    );
    legacyCounts.customer_contract_rates = ccr.length;
    for (const r of ccr) {
      const serviceId = serviceIdByCode.get(r.service_category) ?? null;
      pushTarget(
        "customer_contract_rates",
        "customer",
        Number(r.customer_id),
        Number(r.id),
        serviceId,
        serviceId != null ? r.service_category : `category:${r.service_category}`,
        Number(r.hourly_rate_cents),
        toDateStr(r.valid_from),
        toDateStr(r.valid_to),
      );
    }
  }

  // 3. service_rates (firmenweiter Standard pro Service-Kategorie, kein Kunde).
  if (present.service_rates) {
    const sr = rowsOf<{
      id: number;
      service_category: string;
      hourly_rate_cents: number;
      valid_from: unknown;
      valid_to: unknown;
    }>(
      await exec.execute(sql`
        SELECT id, service_category, hourly_rate_cents, valid_from, valid_to
        FROM service_rates
      `),
    );
    legacyCounts.service_rates = sr.length;
    for (const r of sr) {
      const serviceId = serviceIdByCode.get(r.service_category) ?? null;
      pushTarget(
        "service_rates",
        "standard",
        null,
        Number(r.id),
        serviceId,
        serviceId != null ? r.service_category : `category:${r.service_category}`,
        Number(r.hourly_rate_cents),
        toDateStr(r.valid_from),
        toDateStr(r.valid_to),
      );
    }
  }

  return { rows, unmapped, droppedNoValidFrom, legacyCounts, present, catalogById };
}

/** Vollständiger Natural Key inkl. origin (Dedup gegen bereits vorhandene Zeilen). */
function naturalKey(r: {
  scope: string;
  origin: string;
  customerId: number | null;
  serviceId: number;
  cents: number;
  validFrom: string | null;
  validTo: string | null;
}): string {
  return `${r.scope}|${r.origin}|${r.customerId ?? ""}|${r.serviceId}|${r.cents}|${r.validFrom ?? ""}|${r.validTo ?? ""}`;
}

/** Index-Key des partiellen Unique-Index (scope, origin, customer, service, validFrom). */
function indexKey(r: {
  scope: string;
  origin: string;
  customerId: number | null;
  serviceId: number;
  validFrom: string | null;
}): string {
  return `${r.scope}|${r.origin}|${r.customerId ?? ""}|${r.serviceId}|${r.validFrom ?? ""}`;
}

export class PricePopulationConflictError extends Error {
  constructor(public readonly conflicts: string[]) {
    super(
      `Preis-Befüllung abgebrochen: ${conflicts.length} kollidierende Zielzeile(n) teilen denselben ` +
        `Index-Key (scope|origin|Kunde|Service|validFrom) mit ABWEICHENDEM Betrag/validTo — ` +
        `der partielle Unique-Index ließe nur EINE aktiv zu (Datenverlust-Risiko):\n` +
        conflicts.join("\n"),
    );
    this.name = "PricePopulationConflictError";
  }
}

/**
 * Befüllt `prices` aus den geladenen Zielzeilen. Dedupliziert gegen bereits
 * aktive Zeilen (Natural Key), Soft-Delete-vor-Insert je Index-Key, und bricht
 * bei einer In-Batch-Index-Key-Kollision mit abweichendem Wert hart ab
 * (Rollback statt stillem Überschreiben).
 */
export async function applyPricePopulation(exec: Tx, targetRows: TargetPriceRow[]): Promise<number> {
  // Bereits aktive prices-Zeilen der drei Provenienzen einmal laden.
  const existingActive = await exec
    .select({
      scope: prices.scope,
      origin: prices.origin,
      customerId: prices.customerId,
      serviceId: prices.serviceId,
      cents: prices.cents,
      validFrom: prices.validFrom,
      validTo: prices.validTo,
    })
    .from(prices)
    .where(
      and(
        isNull(prices.deletedAt),
        inArray(prices.origin, [
          "service_rates",
          "customer_contract_rates",
          "customer_service_prices",
        ]),
      ),
    );
  const existingKeys = new Set(
    existingActive.map((r) =>
      naturalKey({
        scope: r.scope,
        origin: r.origin,
        customerId: r.customerId,
        serviceId: r.serviceId,
        cents: r.cents,
        validFrom: toDateStr(r.validFrom),
        validTo: toDateStr(r.validTo),
      }),
    ),
  );

  // In-Batch-Kollisionen am Index-Key (gleiche Index-Tuple, abweichender
  // Voll-Key) erkennen → harter Abbruch.
  const byIndexKey = new Map<string, TargetPriceRow>();
  const conflicts: string[] = [];
  for (const r of targetRows) {
    const ik = indexKey(r);
    const prev = byIndexKey.get(ik);
    if (prev && naturalKey(prev) !== naturalKey(r)) {
      conflicts.push(
        `  [${r.origin}] Kunde ${r.customerId ?? "—"} Service #${r.serviceId} @ ${r.validFrom}: ` +
          `${prev.cents} ct (bis ${prev.validTo ?? "offen"}) vs ${r.cents} ct (bis ${r.validTo ?? "offen"})`,
      );
    } else if (!prev) {
      byIndexKey.set(ik, r);
    }
  }
  if (conflicts.length > 0) {
    throw new PricePopulationConflictError(conflicts);
  }

  let inserted = 0;
  for (const r of targetRows) {
    if (existingKeys.has(naturalKey(r))) continue; // bereits aktiv repräsentiert → No-Op.
    if (r.validFrom == null) continue; // bereits in droppedNoValidFrom gemeldet.

    // Soft-Delete einer bestehenden aktiven Index-Key-Zeile (anderer Wert) —
    // damit der Insert den partiellen Unique-Index nicht verletzt.
    await exec.execute(sql`
      UPDATE prices
      SET deleted_at = now()
      WHERE deleted_at IS NULL
        AND scope = ${r.scope}
        AND origin = ${r.origin}
        AND customer_id IS NOT DISTINCT FROM ${r.customerId}
        AND service_id = ${r.serviceId}
        AND valid_from = ${r.validFrom}
    `);

    await exec.insert(prices).values({
      scope: r.scope,
      origin: r.origin,
      customerId: r.customerId,
      serviceId: r.serviceId,
      cents: r.cents,
      validFrom: r.validFrom,
      validTo: r.validTo,
    });
    inserted++;
  }
  return inserted;
}

interface Gate2Deviation {
  customerId: number | null;
  serviceId: number;
  date: string;
  baselineCents: number | null;
  consolidatedCents: number | null;
}

export class Gate2ParityError extends Error {
  constructor(public readonly deviations: Gate2Deviation[]) {
    super(
      `GATE 2 ROT — die konsolidierte priceFor-Auflösung weicht an ${deviations.length} Abdeckungspunkt(en) ` +
        `vom unabhängigen Legacy-Verhalten ab (≠ 0 Cent). Der Server serviced NICHT mit falschen Preisen:\n` +
        deviations
          .map(
            (d) =>
              `  ${d.customerId == null ? "Standard" : `Kunde #${d.customerId}`} Service #${d.serviceId} @ ${d.date}: ` +
              `legacy=${d.baselineCents ?? "—"} ct → prices=${d.consolidatedCents ?? "—"} ct`,
          )
          .join("\n"),
    );
    this.name = "Gate2ParityError";
  }
}

/**
 * Harter Paritäts-Selbstcheck NACH der Befüllung: konsolidierte Auflösung (aus
 * `prices`) gegen die UNABHÄNGIGE Legacy-Auflösung (aus den kanonischen Alt-
 * Zeilen) über die volle Abdeckung. Wirft bei JEDER Abweichung ≠ 0 Cent.
 */
async function runGate2ParitySelfCheck(
  exec: Tx,
  loaded: LegacyLoadResult,
  asOf: string,
): Promise<number> {
  const catalogById = loaded.catalogById;

  // --- Legacy-Auflösung (unabhängig): csp ∪ ccr (customer) → service_rates
  // (standard) → Katalog. Tiebreaker-id = Einfüge-Ordinal (= prices.id-Ordnung). ---
  const legacyCustomerByKey = new Map<string, VersionedPriceRow[]>(); // `${cust}:${svc}`
  const legacyStandardBySvc = new Map<number, VersionedPriceRow[]>();
  for (const r of loaded.rows) {
    const row: VersionedPriceRow = {
      id: r.ordinal,
      priceCents: r.cents,
      validFrom: r.validFrom,
      validTo: r.validTo,
    };
    if (r.scope === "customer" && r.customerId != null) {
      const key = `${r.customerId}:${r.serviceId}`;
      const list = legacyCustomerByKey.get(key) ?? [];
      list.push(row);
      legacyCustomerByKey.set(key, list);
    } else if (r.scope === "standard") {
      const list = legacyStandardBySvc.get(r.serviceId) ?? [];
      list.push(row);
      legacyStandardBySvc.set(r.serviceId, list);
    }
  }
  const legacyResolve = (customerId: number | null, serviceId: number, date: string): PriceResolution | null => {
    const customerRows = customerId != null ? (legacyCustomerByKey.get(`${customerId}:${serviceId}`) ?? []) : [];
    const standardRows = legacyStandardBySvc.get(serviceId) ?? [];
    return resolvePriceFor({ date, customerRows, standardRows, catalog: catalogById.get(serviceId) });
  };

  // --- Konsolidierte Auflösung: live aus der `prices`-SSoT (alle aktiven Zeilen). ---
  const activePrices = await exec
    .select({
      id: prices.id,
      scope: prices.scope,
      customerId: prices.customerId,
      serviceId: prices.serviceId,
      cents: prices.cents,
      validFrom: prices.validFrom,
      validTo: prices.validTo,
    })
    .from(prices)
    .where(isNull(prices.deletedAt));
  const consCustomerByKey = new Map<string, VersionedPriceRow[]>();
  const consStandardBySvc = new Map<number, VersionedPriceRow[]>();
  for (const r of activePrices) {
    const row: VersionedPriceRow = {
      id: Number(r.id),
      priceCents: Number(r.cents),
      validFrom: toDateStr(r.validFrom),
      validTo: toDateStr(r.validTo),
    };
    if (r.scope === "customer" && r.customerId != null) {
      const key = `${r.customerId}:${r.serviceId}`;
      const list = consCustomerByKey.get(key) ?? [];
      list.push(row);
      consCustomerByKey.set(key, list);
    } else if (r.scope === "standard") {
      const list = consStandardBySvc.get(r.serviceId) ?? [];
      list.push(row);
      consStandardBySvc.set(r.serviceId, list);
    }
  }
  const consolidatedResolve = (customerId: number | null, serviceId: number, date: string): PriceResolution | null => {
    const customerRows = customerId != null ? (consCustomerByKey.get(`${customerId}:${serviceId}`) ?? []) : [];
    const standardRows = consStandardBySvc.get(serviceId) ?? [];
    return resolvePriceFor({ date, customerRows, standardRows, catalog: catalogById.get(serviceId) });
  };
  // --- Abdeckung: Termine (N Monate) + alle Kunden-Paare + alle Standard-Services. ---
  const coverage = new Map<string, { customerId: number | null; serviceId: number; date: string }>();
  const addPoint = (customerId: number | null, serviceId: number, date: string) => {
    coverage.set(`${customerId ?? "*"}:${serviceId}:${date}`, { customerId, serviceId, date });
  };

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - GATE2_APPOINTMENT_MONTHS);
  const cutoffStr = toDateStr(cutoff)!;
  const appts = await exec
    .select({
      customerId: appointments.customerId,
      date: appointments.date,
      serviceId: appointmentServices.serviceId,
    })
    .from(appointments)
    .innerJoin(appointmentServices, eq(appointmentServices.appointmentId, appointments.id))
    .where(and(isNull(appointments.deletedAt), gte(appointments.date, cutoffStr)));
  for (const a of appts) {
    if (a.customerId == null) continue;
    addPoint(a.customerId, a.serviceId, toDateStr(a.date)!);
  }
  for (const key of legacyCustomerByKey.keys()) {
    const [cid, sid] = key.split(":").map((n) => parseInt(n, 10));
    addPoint(cid, sid, asOf);
  }
  for (const sid of legacyStandardBySvc.keys()) addPoint(null, sid, asOf);

  const deviations: Gate2Deviation[] = [];
  for (const p of coverage.values()) {
    const baseline = legacyResolve(p.customerId, p.serviceId, p.date);
    const consolidated = consolidatedResolve(p.customerId, p.serviceId, p.date);
    const baseCents = baseline?.cents ?? null;
    const consCents = consolidated?.cents ?? null;
    if (baseCents !== consCents) {
      deviations.push({
        customerId: p.customerId,
        serviceId: p.serviceId,
        date: p.date,
        baselineCents: baseCents,
        consolidatedCents: consCents,
      });
    }
  }

  if (deviations.length > 0) {
    throw new Gate2ParityError(deviations);
  }
  return coverage.size;
}

/**
 * Pre-Publish-Verifikation ins Migrations-Log: prices-Zeilenzahl == Summe der
 * Alt-Tabellen je origin (abzgl. gemeldeter unmapped/no-validFrom), plus
 * Stichprobe, dass ein bekannter 0-Override auf 0 Cent auflöst (Existence-Wins).
 */
async function logPrePublishVerification(exec: Tx, loaded: LegacyLoadResult): Promise<void> {
  const origins: LegacyOrigin[] = [
    "service_rates",
    "customer_contract_rates",
    "customer_service_prices",
  ];
  for (const origin of origins) {
    const res = await exec
      .select({ c: sql<number>`count(*)::int` })
      .from(prices)
      .where(and(eq(prices.origin, origin), isNull(prices.deletedAt)));
    const pricesCount = Number(res[0]?.c ?? 0);
    const legacyCount = loaded.legacyCounts[origin];
    const unmappedCount = loaded.unmapped.filter((u) => u.origin === origin).length;
    const noValidFromCount = loaded.droppedNoValidFrom.filter((d) => d.origin === origin).length;
    const expected = legacyCount - unmappedCount - noValidFromCount;
    const match = pricesCount === expected ? "OK" : "ABWEICHUNG";
    log(
      `[populate-prices] Pre-Publish-Verifikation origin=${origin}: prices(aktiv)=${pricesCount}, ` +
        `legacy=${legacyCount} (unmapped=${unmappedCount}, ohne-validFrom=${noValidFromCount}) ` +
        `⇒ erwartet=${expected} [${match}]`,
      "startup",
    );
  }

  // Stichprobe: ein 0-Cent-Kunden-Override muss auf 0 auflösen (Existence-Wins
  // über 0-Override, z. B. „keine Anfahrt").
  const zeroOverride = await exec
    .select({
      customerId: prices.customerId,
      serviceId: prices.serviceId,
      validFrom: prices.validFrom,
    })
    .from(prices)
    .where(and(eq(prices.scope, "customer"), eq(prices.cents, 0), isNull(prices.deletedAt)))
    .limit(1);
  if (zeroOverride.length === 0) {
    log(
      "[populate-prices] Pre-Publish-Stichprobe: kein 0-Cent-Kunden-Override vorhanden — übersprungen.",
      "startup",
    );
    return;
  }
  const ov = zeroOverride[0];
  const date = toDateStr(ov.validFrom) ?? todayStr();
  const customerRows = await exec
    .select({
      id: prices.id,
      cents: prices.cents,
      validFrom: prices.validFrom,
      validTo: prices.validTo,
    })
    .from(prices)
    .where(
      and(
        eq(prices.scope, "customer"),
        eq(prices.customerId, ov.customerId!),
        eq(prices.serviceId, ov.serviceId),
        isNull(prices.deletedAt),
      ),
    );
  const resolution = resolvePriceFor({
    date,
    customerRows: customerRows.map((r) => ({
      id: Number(r.id),
      priceCents: Number(r.cents),
      validFrom: toDateStr(r.validFrom),
      validTo: toDateStr(r.validTo),
    })),
    standardRows: [],
    catalog: loaded.catalogById.get(ov.serviceId),
  });
  const ok = resolution?.cents === 0 && resolution.scope === "customer";
  log(
    `[populate-prices] Pre-Publish-Stichprobe 0-Override Kunde #${ov.customerId} Service #${ov.serviceId} @ ${date}: ` +
      `aufgelöst=${resolution?.cents ?? "—"} ct (scope=${resolution?.scope ?? "—"}) [${ok ? "OK" : "ABWEICHUNG"}]`,
    "startup",
  );
}

/**
 * Die eigentliche Migration (läuft innerhalb der Guarded-Transaktion):
 * Laden → Befüllen → Gate-2-Selbstcheck → Pre-Publish-Verifikation.
 */
export async function populatePricesFromLegacy(tx: Tx): Promise<BudgetMigrationSummary> {
  const loaded = await loadLegacyPriceSources(tx);

  const anyPresent =
    loaded.present.service_rates ||
    loaded.present.customer_contract_rates ||
    loaded.present.customer_service_prices;
  if (!anyPresent) {
    log(
      "[populate-prices] Keine Alt-Preis-Tabellen vorhanden (z. B. dev nach #1326) — sauberer No-Op.",
      "startup",
    );
    return { changed: 0, note: "keine Alt-Tabellen vorhanden" };
  }

  // Verlust-Risiken melden (nicht verwerfen).
  for (const u of loaded.unmapped) {
    log(
      `[populate-prices] WARN unmapped (keine Katalog-Zuordnung, NICHT migriert): ` +
        `[${u.origin}] #${u.sourceRowId} ${u.label} (${u.cents} ct).`,
      "startup",
    );
  }
  for (const d of loaded.droppedNoValidFrom) {
    log(
      `[populate-prices] WARN ohne validFrom (NICHT migriert, prices.valid_from ist NOT NULL): ` +
        `[${d.origin}] #${d.sourceRowId} Service #${d.serviceId} (${d.cents} ct).`,
      "startup",
    );
  }

  const inserted = await applyPricePopulation(tx, loaded.rows);

  const asOf = todayStr();
  const coveragePoints = await runGate2ParitySelfCheck(tx, loaded, asOf);
  log(
    `[populate-prices] GATE 2 GRÜN: ${coveragePoints} Abdeckungspunkt(e) wertgleich ` +
      `(konsolidierte prices ≡ unabhängige Legacy-Auflösung).`,
    "startup",
  );

  await logPrePublishVerification(tx, loaded);

  return {
    changed: inserted,
    note:
      `eingefügt=${inserted}, mappbar=${loaded.rows.length}, ` +
      `unmapped=${loaded.unmapped.length}, ohne-validFrom=${loaded.droppedNoValidFrom.length}`,
  };
}

/**
 * Entry-Point für die Startup-Sequenz: führt die Befüllung Ledger-gegated (aber
 * NICHT flag-gegated) über den Guarded-Runner aus. Kein GoBD-Bypass und kein
 * Conservation-Check nötig — `prices` ist weder Trigger-geschützt noch Teil der
 * Budget-Erhaltungs-Invariante.
 */
export async function runPopulatePricesFromLegacy(): Promise<void> {
  await runGuardedBudgetMigration({
    name: POPULATE_PRICES_MIGRATION_NAME,
    version: "1",
    gobdBypass: false,
    conservationCheck: false,
    migrate: populatePricesFromLegacy,
  });
}
