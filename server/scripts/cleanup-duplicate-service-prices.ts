/**
 * Cleanup-Skript für Task #199:
 *   Alte Doppel-Einträge in der Preishistorie aufräumen
 *
 * Hintergrund: Vor dem PATCH-Endpoint aus Task #196 hat jeder reine Preis-Edit
 * in `customer_service_prices` den bisherigen Eintrag mit `valid_to` geschlossen
 * und einen neuen Datensatz mit identischem Preis ab dem Folgetag (oder demselben
 * Tag) angelegt. Solche Splits enthalten keine echte Preisänderung und blähen
 * die Preishistorie auf.
 *
 * Dieses Skript identifiziert pro Kunde + Service Sequenzen, in denen
 *   - der "alte" Eintrag genau am Vortag (oder am selben Tag) endet, an dem der
 *     "neue" Eintrag startet, UND
 *   - der `price_cents` identisch ist
 * und konsolidiert sie zu einem einzigen Eintrag mit dem ältesten `valid_from`
 * und dem spätesten `valid_to` (bzw. NULL).
 *
 * Aufruf:
 *   - Trockenlauf (Default):  tsx server/scripts/cleanup-duplicate-service-prices.ts
 *   - Scharf ausführen:       tsx server/scripts/cleanup-duplicate-service-prices.ts --apply
 */

import { eq, asc, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { customerServicePrices, customers, services, users } from "@shared/schema";
import { auditService } from "../services/audit";
import { addDays } from "@shared/utils/datetime";

interface PriceRow {
  id: number;
  customerId: number;
  serviceId: number;
  priceCents: number;
  validFrom: string;
  validTo: string | null;
}

interface MergeAction {
  customerId: number;
  customerName: string;
  serviceId: number;
  serviceName: string;
  priceCents: number;
  keptId: number;
  keptValidFrom: string;
  newValidTo: string | null;
  oldKeptValidTo: string | null;
  removedIds: number[];
  removedValidFroms: string[];
}

function toISODate(value: unknown): string {
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  return String(value).substring(0, 10);
}

function customerLabel(c: { id: number; vorname: string | null; nachname: string | null }): string {
  const name = `${c.vorname ?? ""} ${c.nachname ?? ""}`.trim();
  return name.length > 0 ? name : `#${c.id}`;
}

/**
 * Findet zusammenhängende Sequenzen redundanter Preis-Einträge pro Kunde+Service.
 * Eine Sequenz beginnt mit einem "Kopf"-Eintrag und schluckt alle direkt folgenden
 * Einträge mit identischem Preis, die am Tag nach dem `valid_to` des Vorgängers
 * (oder am selben Tag) starten.
 */
function buildMergeActions(
  rows: PriceRow[],
  customerName: string,
  serviceName: string,
): MergeAction[] {
  const actions: MergeAction[] = [];
  const sorted = [...rows].sort((a, b) => {
    if (a.validFrom !== b.validFrom) return a.validFrom < b.validFrom ? -1 : 1;
    return a.id - b.id;
  });

  let i = 0;
  while (i < sorted.length) {
    const head = sorted[i];
    const removedIds: number[] = [];
    const removedValidFroms: string[] = [];
    let currentValidTo = head.validTo;
    let j = i + 1;

    while (j < sorted.length) {
      const next = sorted[j];
      if (next.priceCents !== head.priceCents) break;
      if (currentValidTo === null) break; // offener Kopf kann nichts mehr "anschließen"
      const expectedNextStart = addDays(currentValidTo, 1);
      const sameDay = next.validFrom === currentValidTo;
      const dayAfter = next.validFrom === expectedNextStart;
      if (!sameDay && !dayAfter) break;

      removedIds.push(next.id);
      removedValidFroms.push(next.validFrom);
      currentValidTo = next.validTo;
      j++;
    }

    if (removedIds.length > 0) {
      actions.push({
        customerId: head.customerId,
        customerName,
        serviceId: head.serviceId,
        serviceName,
        priceCents: head.priceCents,
        keptId: head.id,
        keptValidFrom: head.validFrom,
        newValidTo: currentValidTo,
        oldKeptValidTo: head.validTo,
        removedIds,
        removedValidFroms,
      });
    }

    i = j > i + 1 ? j : i + 1;
  }

  return actions;
}

async function findRedundantSplits(): Promise<MergeAction[]> {
  const allCustomers = await db.select({
    id: customers.id,
    vorname: customers.vorname,
    nachname: customers.nachname,
  }).from(customers);

  const allServices = await db.select({ id: services.id, name: services.name }).from(services);
  const serviceNameById = new Map(allServices.map((s) => [s.id, s.name]));

  const actions: MergeAction[] = [];

  for (const c of allCustomers) {
    const rows = await db.select({
      id: customerServicePrices.id,
      customerId: customerServicePrices.customerId,
      serviceId: customerServicePrices.serviceId,
      priceCents: customerServicePrices.priceCents,
      validFrom: customerServicePrices.validFrom,
      validTo: customerServicePrices.validTo,
      deletedAt: customerServicePrices.deletedAt,
    })
      .from(customerServicePrices)
      .where(eq(customerServicePrices.customerId, c.id))
      .orderBy(asc(customerServicePrices.serviceId), asc(customerServicePrices.validFrom));

    const active = rows.filter((r) => r.deletedAt === null);
    if (active.length < 2) continue;

    const byService = new Map<number, PriceRow[]>();
    for (const r of active) {
      const arr = byService.get(r.serviceId) ?? [];
      arr.push({
        id: r.id,
        customerId: r.customerId,
        serviceId: r.serviceId,
        priceCents: r.priceCents,
        validFrom: toISODate(r.validFrom),
        validTo: r.validTo === null ? null : toISODate(r.validTo),
      });
      byService.set(r.serviceId, arr);
    }

    const cName = customerLabel(c);
    for (const [serviceId, group] of byService) {
      if (group.length < 2) continue;
      const sName = serviceNameById.get(serviceId) ?? `#${serviceId}`;
      const merges = buildMergeActions(group, cName, sName);
      actions.push(...merges);
    }
  }

  return actions;
}

function formatValidTo(v: string | null): string {
  return v === null ? "offen" : v;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const mode = apply ? "APPLY (scharf)" : "DRY-RUN (Default)";
  console.log(`\n=== Cleanup duplicate service prices (${mode}) ===\n`);

  const actions = await findRedundantSplits();

  if (actions.length === 0) {
    console.log("Keine redundanten Preis-Splits gefunden. Nichts zu tun.");
    return;
  }

  const byCustomer = new Map<number, MergeAction[]>();
  for (const a of actions) {
    const arr = byCustomer.get(a.customerId) ?? [];
    arr.push(a);
    byCustomer.set(a.customerId, arr);
  }

  const totalRemoved = actions.reduce((s, a) => s + a.removedIds.length, 0);
  console.log(
    `Betroffene Kunden: ${byCustomer.size}, Konsolidierungen: ${actions.length}, ` +
    `zu entfernende Splits: ${totalRemoved}\n`,
  );

  let auditUserId: number | null = null;
  if (apply) {
    const [admin] = await db.select({ id: users.id })
      .from(users)
      .where(eq(users.isAdmin, true))
      .orderBy(asc(users.id))
      .limit(1);
    if (admin) auditUserId = admin.id;
    else console.warn("Warnung: Kein Admin-User gefunden – Audit-Logs werden übersprungen.");
  }

  for (const [customerId, customerActions] of byCustomer) {
    const name = customerActions[0].customerName;
    console.log(`Kunde #${customerId} (${name})`);
    for (const a of customerActions) {
      console.log(
        `  - ${a.serviceName} @ ${(a.priceCents / 100).toFixed(2)} €: ` +
        `behalte #${a.keptId} (${a.keptValidFrom} → ${formatValidTo(a.oldKeptValidTo)}), ` +
        `entferne ${a.removedIds.map((id, idx) => `#${id} (ab ${a.removedValidFroms[idx]})`).join(", ")} ` +
        `→ neuer Bereich ${a.keptValidFrom} → ${formatValidTo(a.newValidTo)}`,
      );
    }
    console.log("");
  }

  if (!apply) {
    console.log("Trockenlauf abgeschlossen. Mit --apply scharf ausführen.");
    return;
  }

  for (const a of actions) {
    await db.transaction(async (tx) => {
      const newValidToSql = a.newValidTo === null
        ? sql`NULL`
        : sql`${a.newValidTo}::date`;
      await tx.execute(sql`
        UPDATE customer_service_prices
        SET valid_to = ${newValidToSql}
        WHERE id = ${a.keptId}
      `);

      for (const removedId of a.removedIds) {
        await tx.execute(sql`
          UPDATE customer_service_prices
          SET deleted_at = NOW()
          WHERE id = ${removedId}
        `);
      }
    });

    if (auditUserId !== null) {
      await auditService.log(
        auditUserId,
        "customer_price_history_consolidated",
        "customer",
        a.customerId,
        {
          customerId: a.customerId,
          serviceId: a.serviceId,
          serviceName: a.serviceName,
          priceCents: a.priceCents,
          keptPriceId: a.keptId,
          keptValidFrom: a.keptValidFrom,
          newValidTo: a.newValidTo,
          oldKeptValidTo: a.oldKeptValidTo,
          removedPriceIds: a.removedIds,
          reason: "Redundante Preis-Splits ohne Preisänderung zusammengeführt (Task #199)",
        },
        undefined,
      );
    }
  }

  console.log(`Cleanup abgeschlossen: ${actions.length} Konsolidierungen, ${totalRemoved} Splits entfernt.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Cleanup fehlgeschlagen:", err);
    process.exit(1);
  });
