// Task #1402 (TEIL B) — Tests für den read-only Preflight gegen die stille
// No-Op-Falle gegateter destruktiver Cleanup-Migrationen.
//
// Geprüft werden die drei relevanten Zustände der bekannten gegateten Migration
// `cleanup-legacy-auto-allocations-1409`:
//   (a) Flag FEHLT + pending Altlast-Zeilen + nicht im Ledger
//       ⇒ status 'mismatch', ok=false, LAUTE Warnung im Log.
//   (b) Flag gesetzt ⇒ Migration läuft GENAU EINMAL (ein Ledger-Eintrag),
//       Conservation hält, danach status 'applied' + kein Mismatch.
//   (c) keine pending Zeilen ⇒ status 'clean', keine Warnung.
//
// Der Preflight ist rein lesend; die Migrationslogik selbst (Idempotenz, Guard,
// Ledger, Conservation) wird NICHT verändert — Test (b) verifiziert sie nur
// über den unveränderten Runner-Pfad mit.
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetAllocations } from "@shared/schema";
import {
  verifyPendingDestructiveMigrations,
  assertNoPendingDestructiveMismatch,
  getPendingDestructiveMigrationsStatus,
} from "../../server/startup/pending-destructive-migrations-preflight";
import {
  cleanupLegacyAutoAllocations,
} from "../../server/startup/cleanup-legacy-auto-allocations-migration";
import { runGuardedBudgetMigration } from "../../server/startup/budget-migration-runner";
import { createTestCustomer, cleanupCustomer } from "../test-utils";

const MIGRATION_NAME = "cleanup-legacy-auto-allocations-1409";
const FLAG = "APPROVED_CLEANUP_LEGACY_AUTO_ALLOCATIONS_1409";

/** Anzahl Ledger-Einträge für die Cleanup-Migration. */
async function ledgerCount(): Promise<number> {
  const res = await db.execute(
    sql`SELECT count(*)::int AS c FROM budget_migrations WHERE name = ${MIGRATION_NAME}`,
  );
  const rows = (res as { rows?: Array<{ c: number }> }).rows ?? [];
  return rows[0]?.c ?? 0;
}

/** Ledger-Eintrag entfernen (budget_migrations hat KEINEN GoBD-Trigger). */
async function clearLedger(): Promise<void> {
  await db.execute(
    sql`DELETE FROM budget_migrations WHERE name = ${MIGRATION_NAME}`,
  );
}

/** Aktive Altlast-Auto-Zeilen GoBD-konform (Bypass) hart löschen. */
async function hardDeleteAutoRows(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.allow_gobd_mutation = 'on'`);
    await tx
      .delete(budgetAllocations)
      .where(inArray(budgetAllocations.source, ["monthly_auto", "yearly_auto"]));
  });
}

/** Zwei aktive Altlast-Auto-Zeilen für den Kunden anlegen (INSERT ist erlaubt). */
async function seedAutoRows(customerId: number): Promise<void> {
  await db.insert(budgetAllocations).values([
    {
      customerId,
      budgetType: "entlastungsbetrag_45b",
      year: 2026,
      month: 1,
      amountCents: 13100,
      source: "monthly_auto",
      validFrom: "2026-01-01",
    },
    {
      customerId,
      budgetType: "entlastungsbetrag_45b",
      year: 2026,
      month: null,
      amountCents: 12500,
      source: "yearly_auto",
      validFrom: "2026-01-01",
    },
  ]);
}

let customerId: number;

beforeAll(async () => {
  const customer = await createTestCustomer();
  customerId = customer.id as number;
  // Task #1446 — Die Registry enthält seit #1446 einen zweiten Deskriptor
  // (`drop-budget-ledger-1443`), dessen `countPending` 1 liefert, solange die
  // (im Dev/Test-Schema noch vorhandene) Tabelle `budget_ledger` existiert. Ohne
  // gesetztes Freigabe-Flag wäre dieser Eintrag IMMER `mismatch` und würde die
  // hier geprüfte AGGREGAT-`status.ok`-Semantik der CLEANUP-Migration
  // verfälschen. Wir setzen das Drop-Flag für die Dauer dieser Suite, sodass der
  // budget_ledger-Eintrag als `pending-approved` (ok-neutral, keine Warnung)
  // erscheint und die Tests ausschließlich das Verhalten von
  // `cleanup-legacy-auto-allocations-1409` messen.
  process.env.APPROVED_DROP_BUDGET_LEDGER = "1";
});

afterAll(() => {
  delete process.env.APPROVED_DROP_BUDGET_LEDGER;
});

afterEach(async () => {
  // Determinismus: Flag und ggf. erzeugte Zustände nach jedem Test entfernen.
  delete process.env[FLAG];
  await clearLedger();
  await hardDeleteAutoRows();
});

describe("Pending-Destructive-Migrations-Preflight (Task #1402 TEIL B)", () => {
  it("(a) Flag fehlt + pending Zeilen + nicht im Ledger ⇒ mismatch + laute Warnung", async () => {
    delete process.env[FLAG];
    await clearLedger();
    await seedAutoRows(customerId);

    // Lautes Log abfangen: log() schreibt direkt auf console.log; vi.spyOn
    // greift in diesem Setup nicht für importierte Module ⇒ direktes Rebind.
    const captured: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    let status;
    try {
      status = await assertNoPendingDestructiveMismatch();
    } finally {
      console.log = original;
    }

    expect(status.ok).toBe(false);
    const entry = status.entries.find((e) => e.migrationName === MIGRATION_NAME)!;
    expect(entry.status).toBe("mismatch");
    expect(entry.flagSet).toBe(false);
    expect(entry.appliedInLedger).toBe(false);
    expect(entry.pendingRows).toBeGreaterThanOrEqual(2);

    // Loud-Warning: eigenes auffälliges Präfix, nicht die beiläufige Runner-Zeile.
    const loud = captured.join("\n");
    expect(loud).toContain("PREFLIGHT-WARNUNG: AUSSTEHENDE DESTRUKTIVE MIGRATION");
    expect(loud).toContain(MIGRATION_NAME);
    expect(loud).toContain(FLAG);

    // Read-only: Zeilen existieren weiterhin (Preflight löscht nichts).
    const remaining = await db
      .select({ id: budgetAllocations.id })
      .from(budgetAllocations)
      .where(
        and(
          eq(budgetAllocations.customerId, customerId),
          inArray(budgetAllocations.source, ["monthly_auto", "yearly_auto"]),
          isNull(budgetAllocations.deletedAt),
        ),
      );
    expect(remaining.length).toBeGreaterThanOrEqual(2);
  });

  it("(b) Flag gesetzt ⇒ Migration läuft genau einmal, Conservation hält, danach 'applied' + kein Mismatch", async () => {
    process.env[FLAG] = "1";
    await clearLedger();
    await seedAutoRows(customerId);

    // Migration über den UNVERÄNDERTEN Runner-Pfad ausführen (Guard, Ledger,
    // Conservation-Pre-/Post-Check). Wirft bei Conservation-Verletzung.
    const outcome = await runGuardedBudgetMigration({
      name: MIGRATION_NAME,
      migrate: cleanupLegacyAutoAllocations,
    });
    expect(outcome).toBe("applied");
    expect(await ledgerCount()).toBe(1);

    // Re-Lauf ⇒ Ledger verhindert zweite Ausführung (exactly-once).
    const second = await runGuardedBudgetMigration({
      name: MIGRATION_NAME,
      migrate: cleanupLegacyAutoAllocations,
    });
    expect(second).toBe("skipped");
    expect(await ledgerCount()).toBe(1);

    // Preflight sieht die Migration nun als angewendet ⇒ kein Mismatch.
    const status = await verifyPendingDestructiveMigrations();
    const entry = status.entries.find((e) => e.migrationName === MIGRATION_NAME)!;
    expect(entry.appliedInLedger).toBe(true);
    expect(entry.status).toBe("applied");
    expect(status.ok).toBe(true);

    // Altlast-Zeilen sind hart gelöscht.
    const remaining = await db
      .select({ id: budgetAllocations.id })
      .from(budgetAllocations)
      .where(
        and(
          eq(budgetAllocations.customerId, customerId),
          inArray(budgetAllocations.source, ["monthly_auto", "yearly_auto"]),
          isNull(budgetAllocations.deletedAt),
        ),
      );
    expect(remaining.length).toBe(0);
  });

  it("(c) keine pending Zeilen ⇒ clean, keine Warnung, ok=true", async () => {
    delete process.env[FLAG];
    await clearLedger();
    await hardDeleteAutoRows();

    const captured: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    let status;
    try {
      status = await assertNoPendingDestructiveMismatch();
    } finally {
      console.log = original;
    }

    expect(status.ok).toBe(true);
    const entry = status.entries.find((e) => e.migrationName === MIGRATION_NAME)!;
    expect(entry.status).toBe("clean");
    expect(entry.pendingRows).toBe(0);
    expect(captured.join("\n")).not.toContain("PREFLIGHT-WARNUNG");

    // getStatus liefert das gecachte Ergebnis (für /api/health).
    const cached = getPendingDestructiveMigrationsStatus();
    expect(cached?.ok).toBe(true);
  });

  it("(d) #1446 budget_ledger: Drop-Flag fehlt + Tabelle existiert + nicht im Ledger ⇒ mismatch + laute Warnung", async () => {
    const DROP_FLAG = "APPROVED_DROP_BUDGET_LEDGER";
    const DROP_MIGRATION = "drop-budget-ledger-1443";
    // Für diesen Test das (suite-weit gesetzte) Drop-Flag bewusst entfernen, um
    // den Scope-Mismatch zu provozieren. Danach wiederherstellen, damit die
    // Aggregat-Semantik der übrigen Tests unberührt bleibt.
    delete process.env[DROP_FLAG];

    const captured: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    let status;
    try {
      status = await assertNoPendingDestructiveMismatch();
    } finally {
      console.log = original;
      process.env[DROP_FLAG] = "1";
    }

    const entry = status.entries.find((e) => e.migrationName === DROP_MIGRATION)!;
    expect(entry.status).toBe("mismatch");
    expect(entry.flagSet).toBe(false);
    expect(entry.appliedInLedger).toBe(false);
    // countPending = 1, solange die Tabelle budget_ledger noch existiert.
    expect(entry.pendingRows).toBe(1);
    expect(status.ok).toBe(false);

    const loud = captured.join("\n");
    expect(loud).toContain("PREFLIGHT-WARNUNG: AUSSTEHENDE DESTRUKTIVE MIGRATION");
    expect(loud).toContain(DROP_MIGRATION);
    expect(loud).toContain(DROP_FLAG);
  });
});
