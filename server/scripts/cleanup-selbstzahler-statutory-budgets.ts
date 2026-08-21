/**
 * Task #1235 — Einmaliger Datenfix (Schwester zu Task #1234): Selbstzahler
 * (`billing_type='selbstzahler'`) dürfen KEINE gesetzlichen Pflegekassen-Töpfe
 * (§45b Entlastungsbetrag, §45a Umwandlungsanspruch, §39/§42a gemeinsamer
 * Jahresbetrag) halten. Task #1233/#1234 haben die SCHREIBPFADE
 * (`upsertBudgetTypeSettings`, Allokations-Schreibpfade) gegen neue Verstöße
 * gesperrt — ALTBESTAND aus der Zeit VOR den Guards bleibt davon aber unberührt.
 *
 * Dieses Skript findet und baut genau diesen Altbestand zurück:
 *   1. AKTIVIERTE gesetzliche Topf-Einstellungen
 *      (`customer_budget_type_settings`, offene Phase `valid_to IS NULL`,
 *      `enabled=true`, gesetzlicher Topf) → über den regulären
 *      `upsertBudgetTypeSettings`-Schreibpfad GESCHLOSSEN (Topf aus dem Payload
 *      entfernt ⇒ `valid_to = heute`). GoBD-konformer Append-only-Pfad, keine
 *      rohen UPDATEs. Escape-Hatch `allowStatutoryForSelbstzahler:true`, damit
 *      der Defense-in-Depth-Guard den legitimen Rückbau nicht blockiert.
 *   2. AKTIVE gesetzliche Allokationen (`budget_allocations`, `deleted_at IS
 *      NULL`, gesetzlicher Topf) → SOFT-DELETE (`deleted_at = now()`) via
 *      GoBD-Bypass `SET LOCAL app.allow_gobd_mutation='on'` + Audit-Log.
 *
 * Topf-Erkennung: ausschließlich über den SSoT-Validator
 * (`validateSelbstzahlerBudget`) — ein Probe-Aufruf mit
 * `billingType:"selbstzahler"` ist genau dann `!ok`, wenn der Topf ein gesperrter
 * gesetzlicher Topf ist (keine zweite Whitelist).
 *
 * Bestehende `budget_transactions` (gebuchter Verbrauch) werden NICHT mutiert —
 * sie sind GoBD-immutable und eine etwaige Korrektur liefe über Storno. Findet
 * das Skript solche Buchungen, weist es im Report WARNEND darauf hin, damit ein
 * Operator den Einzelfall manuell prüfen kann.
 *
 * SICHERHEIT (mirror junk-master-data / clamp-over-limit):
 *   - DEFAULT = read-only Dry-Run. Schreibt NICHTS, erzeugt nur den Report.
 *   - `--apply` aktiviert Mutationen, ABER nur wenn zusätzlich die Freigabe-Env
 *     `SELBSTZAHLER_STATUTORY_CLEANUP_APPROVED` gesetzt ist (`1`/`true`/`yes`).
 *   - Der Report wird IMMER (auch beim Apply, vor der Mutation) nach
 *     `docs/task-1235-selbstzahler-statutory-cleanup-<env>-<ts>.md` archiviert.
 *
 * Aufruf:
 *   tsx server/scripts/cleanup-selbstzahler-statutory-budgets.ts                  # Dry-Run, alle Kunden
 *   tsx server/scripts/cleanup-selbstzahler-statutory-budgets.ts --customer=44    # Dry-Run, nur Kunde 44
 *   SELBSTZAHLER_STATUTORY_CLEANUP_APPROVED=1 \
 *     tsx server/scripts/cleanup-selbstzahler-statutory-budgets.ts --apply        # schreibend
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, pool } from "../lib/db";
import {
  customers,
  users,
  budgetAllocations,
  budgetTransactions,
  customerBudgetTypeSettings,
  type CustomerBudgetTypeSetting,
} from "@shared/schema";
import { dbHostOf } from "@shared/ephemeral-db-target";
import { validateSelbstzahlerBudget } from "@shared/domain/budget-selbstzahler-validator";
import { upsertBudgetTypeSettings } from "../storage/budget/preferences-storage";
import { auditService } from "../services/audit";

const APPLY = process.argv.includes("--apply");

/**
 * Die drei gesetzlichen Pflegekassen-Töpfe. Bewusst hier gelistet, aber gegen
 * den SSoT-Validator abgesichert (siehe `assertStatutoryListMatchesValidator`),
 * damit eine künftige Erweiterung der gesperrten Töpfe nicht still an diesem
 * Skript vorbei läuft.
 */
const STATUTORY_POTS = [
  "entlastungsbetrag_45b",
  "umwandlung_45a",
  "ersatzpflege_39_42a",
] as const;

const euro = (c: number | null | undefined) =>
  c == null ? "—" : `${(c / 100).toFixed(2)} €`;

function isStatutoryPot(budgetType: string): boolean {
  // `!ok` für billingType='selbstzahler' ⇔ gesetzlicher (gesperrter) Topf.
  return !validateSelbstzahlerBudget({
    billingType: "selbstzahler",
    intent: { budgetType },
  }).ok;
}

/**
 * Defensive SSoT-Konsistenzprüfung: Jeder in `STATUTORY_POTS` gelistete Topf
 * MUSS vom Validator als gesetzlich erkannt werden, und der Validator darf
 * keinen gesetzlichen Topf kennen, der hier fehlt — sonst räumt das Skript
 * unvollständig auf. Bricht laut ab, statt still zu driften.
 */
function assertStatutoryListMatchesValidator(): void {
  for (const pot of STATUTORY_POTS) {
    if (!isStatutoryPot(pot)) {
      throw new Error(
        `SSoT-Drift: '${pot}' steht in STATUTORY_POTS, wird vom Validator aber NICHT als gesetzlich erkannt.`,
      );
    }
  }
}

function parseCustomerId(): number | null {
  const arg = process.argv.find((a) => a.startsWith("--customer="));
  if (!arg) return null;
  const n = Number(arg.split("=")[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function isApproved(): boolean {
  const v = (process.env.SELBSTZAHLER_STATUTORY_CLEANUP_APPROVED ?? "")
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

interface AllocationFinding {
  id: number;
  budgetType: string;
  source: string;
  year: number;
  month: number | null;
  amountCents: number;
  validFrom: string;
  expiresAt: string | null;
}

interface TypeSettingFinding {
  id: number;
  budgetType: string;
  enabled: boolean;
  priority: number;
  monthlyLimitCents: number | null;
  yearlyLimitCents: number | null;
  validFrom: string | null;
}

interface CustomerFinding {
  customerId: number;
  name: string;
  /** alle OFFENEN type-settings (für den Schließen-Payload nötig). */
  openTypeSettings: CustomerBudgetTypeSetting[];
  /** gesetzliche, AKTIVIERTE, offene type-settings (= zu schließen). */
  enabledStatutorySettings: TypeSettingFinding[];
  /** aktive gesetzliche Allokationen (= soft-zu-löschen). */
  activeStatutoryAllocations: AllocationFinding[];
  /** Anzahl gesetzlicher budget_transactions (nur WARNUNG, nicht mutiert). */
  statutoryTransactionCount: number;
}

/**
 * ERSETZT die frueher hier nachgebaute Host-Extraktion durch die SSoT
 * (`dbHostOf`). Der lokale Fallback war eine reine `@host`-Regex und zog auch
 * aus `postgres ://db.prod.example/app` noch einen Host — die SSoT verweigert
 * das (kein gueltiges Schema) und ebenso eine mehrdeutige Autoritaet.
 *
 * BEWUSST nicht `assertDevDatabase()`: dieses Skript ist zweistufig. Der
 * Dry-Run-Audit soll ueberall laufen duerfen, auch read-only gegen Prod; nur
 * `--apply` ist gegated (fail-closed ohne Host, Freigabe-Env bei Prod). Ein
 * pauschaler Dev-Zwang wuerde den Audit-Pfad brechen. Die Umstellung betrifft
 * deshalb nur die Extraktion, nicht das Verdikt.
 *
 * Der leere String bleibt hier die Aussenschnittstelle, weil `!host` unten
 * genau der Fail-closed-Zweig ist.
 */
function resolveDbHost(): string {
  return dbHostOf(process.env.DATABASE_URL) ?? "";
}

function looksLikeProd(host: string): boolean {
  return (
    process.env.NODE_ENV === "production" ||
    (!!host && /(^|[.-])prod([.-]|$)|production/.test(host))
  );
}

/**
 * Hostname-Guard (mirror clamp-over-limit / junk-master-data): Der Dry-Run-
 * Audit läuft überall (auch read-only gegen Prod). Der DESTRUKTIVE `--apply`
 * darf die Ausführungs-Umgebung nicht raten:
 *   - Ist der DB-Host nicht ermittelbar, bricht der Apply FAIL-CLOSED ab —
 *     ohne verifizierbaren Scope keine Mutation.
 *   - Sieht der Host nach Produktion aus (oder `NODE_ENV=production`), ist die
 *     Freigabe-Env `SELBSTZAHLER_STATUTORY_CLEANUP_APPROVED` PFLICHT (das ist
 *     der bewusste Prod-Schalter; ohne ihn Abbruch).
 * Liefert den (ggf. leeren) Host + die Prod-Einschätzung zurück.
 */
async function safetyChecks(apply: boolean): Promise<{ host: string; isProd: boolean }> {
  const host = resolveDbHost();
  const isProd = looksLikeProd(host);

  if (apply) {
    if (!host) {
      throw new Error(
        "ABBRUCH (--apply): DB-Host nicht ermittelbar. Fail-closed — ein destruktiver Lauf ist nur mit verifizierbarem Host erlaubt.",
      );
    }
    if (isProd && !isApproved()) {
      throw new Error(
        `ABBRUCH (--apply): Prod-Host '${host}' erkannt, aber SELBSTZAHLER_STATUTORY_CLEANUP_APPROVED ist nicht gesetzt. ` +
          "Produktive Bereinigung nur mit expliziter Freigabe.",
      );
    }
  }

  console.log(
    `Sicherheits-Checks ok. DB-Host: ${host || "(unbekannt)"} · NODE_ENV: ${process.env.NODE_ENV ?? "unset"} · Prod: ${isProd ? "JA" : "nein"} · Modus: ${apply ? "APPLY (schreibend)" : "DRY-RUN (read-only)"}`,
  );
  return { host: host || "(unbekannt)", isProd };
}

async function buildFindings(onlyCustomerId: number | null): Promise<CustomerFinding[]> {
  const selbstzahler = await db
    .select({ id: customers.id, name: customers.name })
    .from(customers)
    .where(
      onlyCustomerId == null
        ? eq(customers.billingType, "selbstzahler")
        : and(
            eq(customers.billingType, "selbstzahler"),
            eq(customers.id, onlyCustomerId),
          ),
    );

  if (selbstzahler.length === 0) return [];
  const ids = selbstzahler.map((c) => c.id);
  const nameById = new Map(selbstzahler.map((c) => [c.id, c.name]));

  // Alle OFFENEN type-settings dieser Kunden (offen = valid_to IS NULL).
  const openSettings = await db
    .select()
    .from(customerBudgetTypeSettings)
    .where(
      and(
        inArray(customerBudgetTypeSettings.customerId, ids),
        isNull(customerBudgetTypeSettings.validTo),
      ),
    );

  // Alle AKTIVEN gesetzlichen Allokationen dieser Kunden.
  const allocs = await db
    .select({
      id: budgetAllocations.id,
      customerId: budgetAllocations.customerId,
      budgetType: budgetAllocations.budgetType,
      source: budgetAllocations.source,
      year: budgetAllocations.year,
      month: budgetAllocations.month,
      amountCents: budgetAllocations.amountCents,
      validFrom: budgetAllocations.validFrom,
      expiresAt: budgetAllocations.expiresAt,
    })
    .from(budgetAllocations)
    .where(
      and(
        inArray(budgetAllocations.customerId, ids),
        isNull(budgetAllocations.deletedAt),
        inArray(budgetAllocations.budgetType, STATUTORY_POTS as unknown as string[]),
      ),
    );

  // Gesetzliche budget_transactions (nur Zählung pro Kunde, WARNUNG).
  const txRows = await db
    .select({
      customerId: budgetTransactions.customerId,
      n: sql<number>`count(*)::int`,
    })
    .from(budgetTransactions)
    .where(
      and(
        inArray(budgetTransactions.customerId, ids),
        inArray(budgetTransactions.budgetType, STATUTORY_POTS as unknown as string[]),
      ),
    )
    .groupBy(budgetTransactions.customerId);
  const txCountById = new Map(txRows.map((r) => [r.customerId, Number(r.n)]));

  const openByCustomer = new Map<number, CustomerBudgetTypeSetting[]>();
  for (const r of openSettings) {
    const list = openByCustomer.get(r.customerId);
    if (list) list.push(r);
    else openByCustomer.set(r.customerId, [r]);
  }
  const allocsByCustomer = new Map<number, AllocationFinding[]>();
  for (const a of allocs) {
    const f: AllocationFinding = {
      id: a.id,
      budgetType: a.budgetType,
      source: a.source,
      year: a.year,
      month: a.month,
      amountCents: a.amountCents,
      validFrom: a.validFrom,
      expiresAt: a.expiresAt,
    };
    const list = allocsByCustomer.get(a.customerId);
    if (list) list.push(f);
    else allocsByCustomer.set(a.customerId, [f]);
  }

  const findings: CustomerFinding[] = [];
  for (const id of ids) {
    const openTypeSettings = openByCustomer.get(id) ?? [];
    const enabledStatutorySettings: TypeSettingFinding[] = openTypeSettings
      .filter((s) => s.enabled && isStatutoryPot(s.budgetType))
      .map((s) => ({
        id: s.id,
        budgetType: s.budgetType,
        enabled: s.enabled,
        priority: s.priority,
        monthlyLimitCents: s.monthlyLimitCents,
        yearlyLimitCents: s.yearlyLimitCents,
        validFrom: s.validFrom,
      }));
    const activeStatutoryAllocations = allocsByCustomer.get(id) ?? [];
    const statutoryTransactionCount = txCountById.get(id) ?? 0;

    if (
      enabledStatutorySettings.length === 0 &&
      activeStatutoryAllocations.length === 0
    ) {
      continue;
    }
    findings.push({
      customerId: id,
      name: nameById.get(id) ?? "",
      openTypeSettings,
      enabledStatutorySettings,
      activeStatutoryAllocations,
      statutoryTransactionCount,
    });
  }
  findings.sort((a, b) => a.customerId - b.customerId);
  return findings;
}

async function resolveActorUserId(): Promise<number | null> {
  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isSuperAdmin, true))
    .limit(1);
  return admin?.id ?? null;
}

function formatReport(
  findings: CustomerFinding[],
  host: string,
  apply: boolean,
  generatedAt: string,
): string {
  const lines: string[] = [];
  lines.push(`# Task #1235 — Selbstzahler-Altbestand gesetzlicher Töpfe`);
  lines.push("");
  lines.push(`- Erzeugt: ${generatedAt}`);
  lines.push(`- DB-Host: ${host}`);
  lines.push(`- NODE_ENV: ${process.env.NODE_ENV ?? "unset"}`);
  lines.push(`- Modus: ${apply ? "APPLY (schreibend)" : "DRY-RUN (read-only)"}`);
  lines.push(`- Betroffene Selbstzahler-Kunden: ${findings.length}`);
  lines.push("");

  if (findings.length === 0) {
    lines.push(
      "✓ Keine Selbstzahler mit aktivierten gesetzlichen Töpfen oder aktiven gesetzlichen Allokationen gefunden. Invariante erfüllt (idempotent).",
    );
    lines.push("");
    return lines.join("\n");
  }

  let totalSettings = 0;
  let totalAllocs = 0;
  let totalAllocCents = 0;
  let customersWithTx = 0;

  for (const f of findings) {
    lines.push(`## Kunde #${f.customerId} — ${f.name}`);
    lines.push("");
    if (f.enabledStatutorySettings.length > 0) {
      lines.push(`### Aktivierte gesetzliche Topf-Einstellungen (werden geschlossen)`);
      for (const s of f.enabledStatutorySettings) {
        totalSettings++;
        lines.push(
          `- \`${s.budgetType}\` (id=${s.id}, priority=${s.priority}, validFrom=${s.validFrom ?? "—"}, monatl.=${euro(s.monthlyLimitCents)}, jährl.=${euro(s.yearlyLimitCents)})`,
        );
      }
      lines.push("");
    }
    if (f.activeStatutoryAllocations.length > 0) {
      lines.push(`### Aktive gesetzliche Allokationen (werden soft-gelöscht)`);
      for (const a of f.activeStatutoryAllocations) {
        totalAllocs++;
        totalAllocCents += a.amountCents;
        lines.push(
          `- \`${a.budgetType}\` (id=${a.id}, source=${a.source}, ${a.year}${a.month ? `-${String(a.month).padStart(2, "0")}` : ""}, Betrag=${euro(a.amountCents)}, validFrom=${a.validFrom}, expiresAt=${a.expiresAt ?? "—"})`,
        );
      }
      lines.push("");
    }
    if (f.statutoryTransactionCount > 0) {
      customersWithTx++;
      lines.push(
        `> ⚠ **WARNUNG**: ${f.statutoryTransactionCount} gesetzliche \`budget_transactions\` (gebuchter Verbrauch) vorhanden. Diese werden NICHT automatisch mutiert (GoBD-immutable). Manuelle Einzelfallprüfung / Storno erforderlich.`,
      );
      lines.push("");
    }
  }

  lines.push(`## Zusammenfassung`);
  lines.push("");
  lines.push(`- Zu schließende gesetzliche Topf-Einstellungen: ${totalSettings}`);
  lines.push(`- Soft-zu-löschende gesetzliche Allokationen: ${totalAllocs} (Σ ${euro(totalAllocCents)})`);
  lines.push(`- Kunden mit gesetzlichen Buchungen (nur WARNUNG): ${customersWithTx}`);
  lines.push("");
  return lines.join("\n");
}

async function applyCleanup(
  findings: CustomerFinding[],
  actorUserId: number,
): Promise<{ settingsClosed: number; allocationsSoftDeleted: number }> {
  let settingsClosed = 0;
  let allocationsSoftDeleted = 0;

  for (const f of findings) {
    // 1. Aktivierte gesetzliche Töpfe schließen: alle ANDEREN offenen Töpfe
    //    unverändert ins Payload zurückgeben (No-Op für unveränderte Zeilen),
    //    die gesetzlichen Töpfe weglassen ⇒ upsertBudgetTypeSettings schließt
    //    sie (valid_to = heute) und schreibt einen Audit-Eintrag. Escape-Hatch
    //    nötig, damit der Defense-in-Depth-Guard den Rückbau nicht blockiert.
    if (f.enabledStatutorySettings.length > 0) {
      const keepPayload = f.openTypeSettings
        .filter((s) => !isStatutoryPot(s.budgetType))
        .map((s) => ({
          budgetType: s.budgetType,
          enabled: s.enabled,
          priority: s.priority,
          monthlyLimitCents: s.monthlyLimitCents,
          yearlyLimitCents: s.yearlyLimitCents,
          validFrom: s.validFrom,
          validTo: s.validTo,
        }));
      await upsertBudgetTypeSettings(
        f.customerId,
        keepPayload,
        undefined,
        actorUserId,
        { allowStatutoryForSelbstzahler: true },
      );
      await auditService.log(
        actorUserId,
        "budget_type_settings_updated",
        "budget",
        f.customerId,
        {
          reason: "selbstzahler-statutory-cleanup",
          task: "T1235",
          closedStatutoryPots: f.enabledStatutorySettings.map((s) => ({
            id: s.id,
            budgetType: s.budgetType,
          })),
        },
      );
      settingsClosed += f.enabledStatutorySettings.length;
    }

    // 2. Aktive gesetzliche Allokationen soft-löschen (GoBD-Bypass für die
    //    UPDATE-auf-deleted_at-Mutation). Audit-Log pro Zeile.
    if (f.activeStatutoryAllocations.length > 0) {
      const allocIds = f.activeStatutoryAllocations.map((a) => a.id);
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL app.allow_gobd_mutation = 'on'`);
        await tx
          .update(budgetAllocations)
          .set({ deletedAt: new Date() })
          .where(
            and(
              inArray(budgetAllocations.id, allocIds),
              isNull(budgetAllocations.deletedAt),
            ),
          );
      });
      for (const a of f.activeStatutoryAllocations) {
        await auditService.log(
          actorUserId,
          "budget_allocation_soft_deleted",
          "budget",
          f.customerId,
          {
            customerId: f.customerId,
            budgetType: a.budgetType,
            allocationId: a.id,
            source: a.source,
            amountCents: a.amountCents,
            reason: "T1235: Selbstzahler darf keine gesetzliche Allokation halten (Altbestand-Rückbau).",
          },
        );
        allocationsSoftDeleted++;
      }
    }
  }

  return { settingsClosed, allocationsSoftDeleted };
}

async function main(): Promise<void> {
  assertStatutoryListMatchesValidator();
  const { host } = await safetyChecks(APPLY);
  const onlyCustomerId = parseCustomerId();
  if (onlyCustomerId) console.log(`Eingeschränkt auf Kunde ${onlyCustomerId}.`);

  const findings = await buildFindings(onlyCustomerId);
  const generatedAt = new Date().toISOString();
  const md = formatReport(findings, host, APPLY, generatedAt);

  // Report IMMER archivieren (Dry-Run UND Apply, vor der Mutation).
  const env = (process.env.NODE_ENV ?? "unset").replace(/[^a-z0-9]+/gi, "");
  const ts = generatedAt.replace(/[:.]/g, "-");
  const outDir = path.resolve(process.cwd(), "docs");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(
    outDir,
    `task-1235-selbstzahler-statutory-cleanup-${env}-${ts}.md`,
  );
  fs.writeFileSync(outFile, md, "utf8");
  console.log(`\nReport → ${outFile}`);

  if (findings.length === 0) {
    console.log(
      "✓ Keine Selbstzahler-Altlast gefunden. Invariante erfüllt — nichts zu tun (idempotent).",
    );
    return;
  }

  const totalSettings = findings.reduce(
    (n, f) => n + f.enabledStatutorySettings.length,
    0,
  );
  const totalAllocs = findings.reduce(
    (n, f) => n + f.activeStatutoryAllocations.length,
    0,
  );
  console.log(
    `\n${findings.length} Selbstzahler mit Altlast: ${totalSettings} aktivierte Töpfe, ${totalAllocs} aktive Allokationen.`,
  );
  for (const f of findings) {
    console.log(
      `  • #${f.customerId} ${(f.name || "").slice(0, 30).padEnd(30)} ` +
        `Töpfe=${f.enabledStatutorySettings.length} Allok=${f.activeStatutoryAllocations.length}` +
        (f.statutoryTransactionCount > 0
          ? ` ⚠ ${f.statutoryTransactionCount} Buchung(en)`
          : ""),
    );
  }

  if (!APPLY) {
    console.log("\nDRY-RUN: nichts geschrieben. Mit --apply scharf ausführen.");
    return;
  }

  if (!isApproved()) {
    console.error(
      "\n--apply angefordert, aber SELBSTZAHLER_STATUTORY_CLEANUP_APPROVED ist NICHT gesetzt. " +
        "Destruktiver Lauf abgebrochen — nur Report erzeugt.",
    );
    process.exitCode = 2;
    return;
  }

  const actorUserId = await resolveActorUserId();
  if (actorUserId == null) {
    throw new Error("ABBRUCH (--apply): kein Superadmin-User für Audit-Log gefunden.");
  }

  console.log("\nFreigabe erkannt — destruktiver Lauf startet …");
  const { settingsClosed, allocationsSoftDeleted } = await applyCleanup(
    findings,
    actorUserId,
  );
  console.log(
    `\n✓ Fertig. Geschlossene Töpfe: ${settingsClosed}, soft-gelöschte Allokationen: ${allocationsSoftDeleted}. ` +
      "Ein erneuter Lauf findet nichts mehr (idempotent).",
  );
}

main()
  .catch((err) => {
    console.error("[selbstzahler-statutory-cleanup] Fehler:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
