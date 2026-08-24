/**
 * Task #1168 — Idempotenter Datenfix: Bestands-`customer_budget_type_settings`-
 * Zeilen, deren Monats-/Jahreslimit ÜBER dem gesetzlichen Maximum liegt, auf den
 * gesetzlichen Maximalwert KLEMMEN (Single Source of Truth = `clampToStatutoryMax`).
 *
 * Hintergrund: Bevor T1168 die Schreibpfade (PUT type-settings, Create, Wizard)
 * gegen ungültige Beträge abgesichert hat, konnten Über-Limit-Werte persistiert
 * werden (z.B. §39/§42a-Jahreslimit > 3.539,00 €, §45a-Monatslimit > PG-Maximum,
 * §45b-Monatslimit > 131,00 €). Dieses Skript korrigiert solche Bestands-Zeilen.
 *
 * GoBD / Append-only: Die Korrektur läuft AUSSCHLIESSLICH über den regulären
 * `upsertBudgetTypeSettings`-Schreibpfad (kein rohes UPDATE/DELETE). Dieser legt
 * — je nachdem, ob die offene Phase bereits in Kraft war — eine neue, eingeklemmte
 * Phase an (Transition) oder aktualisiert eine noch-nie-in-Kraft-Zeile in place.
 * `customer_budget_type_settings` hat nur DELETE-/TRUNCATE-Schutz-Trigger, KEINEN
 * UPDATE-Trigger, daher ist KEIN `app.allow_gobd_mutation`-Bypass nötig.
 *
 * IDEMPOTENZ: Es werden nur Kunden angefasst, bei denen `clampToStatutoryMax`
 * tatsächlich einen Wert verändert. Ein bereits geklemmter Wert == gesetzlicher
 * Cap → keine Änderung → der zweite Lauf findet nichts mehr.
 *
 * DRY-RUN (Default): Ohne `--apply` wird NICHTS geschrieben — der Report zeigt
 * exakt, welche Zeilen ein scharfer Lauf klemmen WÜRDE (vorher/nachher in Cent).
 *
 * SICHERHEIT: Hard-Stop bei `NODE_ENV=production` und bei einem DB-Host, der nach
 * Produktion aussieht (analog `cleanup-45b-leftover-budgets.ts`). Das Skript wird
 * NIE automatisch ausgeführt — nur manuell durch einen Operator.
 *
 * Aufruf:
 *   tsx server/scripts/clamp-over-limit-budget-type-settings.ts                 # Dry-Run, alle Kunden
 *   tsx server/scripts/clamp-over-limit-budget-type-settings.ts --customer=203050
 *   tsx server/scripts/clamp-over-limit-budget-type-settings.ts --apply         # schreibend
 *   tsx server/scripts/clamp-over-limit-budget-type-settings.ts --customer=203050 --apply
 */
import { and, eq, isNull } from "drizzle-orm";
import { assertDevDatabase } from "../lib/dev-db-guard";
import { db } from "../lib/db";
import {
  customers,
  users,
  customerBudgetTypeSettings,
  type CustomerBudgetTypeSetting,
} from "@shared/schema";
import { clampToStatutoryMax } from "@shared/domain/budgets";
import { budgetStorage } from "../storage/budget-storage";
import { auditService } from "../services/audit";

const APPLY = process.argv.includes("--apply");
const euro = (c: number | null | undefined) =>
  c == null ? "—" : `${(c / 100).toFixed(2)} €`;

function parseCustomerId(): number | null {
  const arg = process.argv.find((a) => a.startsWith("--customer="));
  if (!arg) return null;
  const n = Number(arg.split("=")[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function safetyChecks(apply: boolean): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("ABBRUCH: NODE_ENV=production. Dieses Skript darf nie auf Produktion laufen.");
  }
  // ERSETZT die frueher hier nachgebaute Host-Pruefung durch die SSoT
  // (server/lib/dev-db-guard.ts). Die lokale Kopie war an drei Stellen
  // SCHWAECHER: sie las den Host mit einer reinen `@host`-Regex (die auch aus
  // `postgres ://db.prod.example/app` noch etwas zog), sie prueft mit
  // `if (host && ...)` und liess damit einen NICHT ermittelbaren Host
  // durch (fail-open), und sie kannte PROD_DATABASE_URL nicht.
  assertDevDatabase();
  console.log(`Modus: ${apply ? "APPLY (schreibend)" : "DRY-RUN"}`);
}

interface ClampChange {
  budgetType: string;
  field: "monthlyLimitCents" | "yearlyLimitCents";
  beforeCents: number;
  afterCents: number;
}

interface CustomerPlan {
  customerId: number;
  pflegegrad: number | null;
  changes: ClampChange[];
  /** Vollständiger gewünschter Offen-Stand (geklemmt) für upsertBudgetTypeSettings. */
  clampedPayload: Array<{
    budgetType: string;
    enabled: boolean;
    priority: number;
    monthlyLimitCents: number | null;
    yearlyLimitCents: number | null;
    validFrom: string | null;
    validTo: string | null;
  }>;
}

/**
 * Klemmt eine offene Zeile gegen den gesetzlichen Cap und liefert (a) das
 * geklemmte Payload-Element und (b) etwaige Änderungen für den Report/Audit.
 */
function clampRow(row: CustomerBudgetTypeSetting, pflegegrad: number | null) {
  const clamped = clampToStatutoryMax({
    budgetType: row.budgetType,
    monthlyLimitCents: row.monthlyLimitCents,
    yearlyLimitCents: row.yearlyLimitCents,
    pflegegrad,
  });
  const changes: ClampChange[] = [];
  if (
    row.monthlyLimitCents != null &&
    clamped.monthlyLimitCents != null &&
    clamped.monthlyLimitCents !== row.monthlyLimitCents
  ) {
    changes.push({
      budgetType: row.budgetType,
      field: "monthlyLimitCents",
      beforeCents: row.monthlyLimitCents,
      afterCents: clamped.monthlyLimitCents,
    });
  }
  if (
    row.yearlyLimitCents != null &&
    clamped.yearlyLimitCents != null &&
    clamped.yearlyLimitCents !== row.yearlyLimitCents
  ) {
    changes.push({
      budgetType: row.budgetType,
      field: "yearlyLimitCents",
      beforeCents: row.yearlyLimitCents,
      afterCents: clamped.yearlyLimitCents,
    });
  }
  return {
    payloadItem: {
      budgetType: row.budgetType,
      enabled: row.enabled,
      priority: row.priority,
      monthlyLimitCents: clamped.monthlyLimitCents,
      yearlyLimitCents: clamped.yearlyLimitCents,
      validFrom: row.validFrom,
      validTo: row.validTo,
    },
    changes,
  };
}

async function buildPlans(onlyCustomerId: number | null): Promise<CustomerPlan[]> {
  // Alle OFFENEN Zeilen (validTo IS NULL = aktive Phase) joinen mit dem
  // Pflegegrad des Kunden (für den PG-abhängigen §45a-Cap).
  const rows = await db
    .select({
      setting: customerBudgetTypeSettings,
      pflegegrad: customers.pflegegrad,
    })
    .from(customerBudgetTypeSettings)
    .innerJoin(customers, eq(customers.id, customerBudgetTypeSettings.customerId))
    .where(
      onlyCustomerId == null
        ? isNull(customerBudgetTypeSettings.validTo)
        : and(
            isNull(customerBudgetTypeSettings.validTo),
            eq(customerBudgetTypeSettings.customerId, onlyCustomerId),
          ),
    );

  // Pro Kunde gruppieren (alle offenen Töpfe müssen ins upsert-Payload, sonst
  // würde upsertBudgetTypeSettings nicht-gelistete Töpfe schließen).
  const byCustomer = new Map<number, { pflegegrad: number | null; settings: CustomerBudgetTypeSetting[] }>();
  for (const r of rows) {
    const entry = byCustomer.get(r.setting.customerId);
    if (entry) entry.settings.push(r.setting);
    else byCustomer.set(r.setting.customerId, { pflegegrad: r.pflegegrad, settings: [r.setting] });
  }

  const plans: CustomerPlan[] = [];
  for (const [customerId, { pflegegrad, settings }] of byCustomer) {
    const allChanges: ClampChange[] = [];
    const clampedPayload: CustomerPlan["clampedPayload"] = [];
    for (const row of settings) {
      const { payloadItem, changes } = clampRow(row, pflegegrad);
      clampedPayload.push(payloadItem);
      allChanges.push(...changes);
    }
    if (allChanges.length > 0) {
      plans.push({ customerId, pflegegrad, changes: allChanges, clampedPayload });
    }
  }
  plans.sort((a, b) => a.customerId - b.customerId);
  return plans;
}

async function resolveActorUserId(): Promise<number | null> {
  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isSuperAdmin, true))
    .limit(1);
  return admin?.id ?? null;
}

async function main(): Promise<void> {
  await safetyChecks(APPLY);
  const onlyCustomerId = parseCustomerId();
  if (onlyCustomerId) console.log(`Eingeschränkt auf Kunde ${onlyCustomerId}.`);

  const plans = await buildPlans(onlyCustomerId);
  if (plans.length === 0) {
    console.log("Keine Über-Limit-Zeilen gefunden. Nichts zu tun (idempotent).");
    return;
  }

  console.log(`\n${plans.length} Kunde(n) mit Über-Limit-Zeilen:\n`);
  for (const p of plans) {
    console.log(`Kunde ${p.customerId} (PG ${p.pflegegrad ?? "—"}):`);
    for (const c of p.changes) {
      console.log(
        `  • ${c.budgetType} ${c.field}: ${euro(c.beforeCents)} → ${euro(c.afterCents)}`,
      );
    }
  }

  if (!APPLY) {
    console.log("\nDRY-RUN: nichts geschrieben. Mit --apply scharf ausführen.");
    return;
  }

  const actorUserId = await resolveActorUserId();
  if (actorUserId == null) {
    throw new Error("ABBRUCH (--apply): kein Superadmin-User für Audit-Log gefunden.");
  }

  let repaired = 0;
  for (const p of plans) {
    await budgetStorage.upsertBudgetTypeSettings(
      p.customerId,
      p.clampedPayload,
      undefined,
      actorUserId,
      // Task #1233 — Korrektur-Pfad: klemmt nur Über-Limit-Werte BESTEHENDER
      // Zeilen; eine etwaige Selbstzahler-Altlast (Kunde 41) muss klemmbar
      // bleiben, ohne am Defense-in-Depth-Guard zu scheitern.
      { allowStatutoryForSelbstzahler: true },
    );
    await auditService.log(actorUserId, "budget_type_settings_updated", "budget", p.customerId, {
      reason: "statutory-clamp",
      task: "T1168",
      clamps: p.changes,
    });
    repaired += 1;
    console.log(`✓ Kunde ${p.customerId} geklemmt (${p.changes.length} Wert(e)).`);
  }
  console.log(`\nFertig. ${repaired} Kunde(n) korrigiert.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
