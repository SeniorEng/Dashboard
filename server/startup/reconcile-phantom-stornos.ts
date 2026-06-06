import { asc, eq, and, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { budgetTransactions, users } from "@shared/schema";
import { log } from "../lib/log";
import { reconcilePhantomStornos } from "../scripts/reconcile-phantom-stornos";

/**
 * Task #988 — Phantom-Storno-Korrektur automatisch beim App-Start anwenden.
 *
 * Hintergrund: Der scharfe Schreiblauf des manuellen Skripts
 * (`server/scripts/reconcile-phantom-stornos.ts`) konnte nur vom Betreiber gegen
 * die Live-DB ausgeführt werden, weil er eine Superadmin-Attribution + eine
 * Audit-Begründung verlangt. Dieser Startup-Hook führt genau diese Korrektur bei
 * jedem App-Start aus, sodass die Produktion sie automatisch beim nächsten
 * (Re-)Deploy/Neustart anwendet.
 *
 * Die eigentliche Klassifikations- und Schreiblogik bleibt der SSoT im Skript
 * (das wiederum die reine Erkennung aus `shared/domain/budget/phantom-storno.ts`
 * nutzt). Dieser Hook ist nur ein dünner Wrapper, der:
 *   1. den System-Actor (ältester aktiver Superadmin, sonst Admin) auflöst,
 *   2. die Korrektur GoBD-konform append-only schreibt (inverse Gegenbuchungen),
 *   3. das Ergebnis loggt.
 *
 * Idempotent: bereits korrigierte Waisen werden anhand der eindeutigen
 * Korrektur-Notiz übersprungen — jeder weitere Start ist ein No-Op
 * (0 geschriebene Korrekturen). Mit `RECONCILE_PHANTOM_STORNOS_DRY_RUN=1` wird
 * nur klassifiziert/geloggt, ohne zu schreiben.
 *
 * Task #993 — Boot-lean Early-Exit. Dies ist eine EINMALIGE Import-Drift-
 * Korrektur (#987). Sobald sie in Produktion gelaufen ist, soll der App-Start
 * nicht weiter den vollen Budget-Ledger in den Speicher laden und klassifizieren.
 * Vor dem teuren Pfad steht deshalb ein billiger Vorab-Count: gibt es überhaupt
 * noch eine verwaiste Storno-Zeile (`reversed_transaction_id IS NULL`, Notiz
 * "Storno von Transaktion #…"), für die KEINE Phantom-Storno-Korrektur existiert?
 * Ist die Zahl 0 → No-Op, sofortiger Abbruch ohne Ledger-Scan und ohne
 * Actor-Auflösung. Der Check ist eine konservative Über-Approximation: er zählt
 * auch legitime Einzel-Stornos mit (die nie eine Korrektur bekommen). In
 * Produktion sind aber alle 28 Waisen Phantoms (siehe
 * `docs/import-budget-drift-report-20260527.md` §10.4), d.h. nach dem einen
 * scharfen Lauf fällt der Count auf 0 und der Boot bleibt schlank. Der manuelle
 * CLI-Fallback (`server/scripts/reconcile-phantom-stornos.ts`) bleibt erhalten.
 */
export async function reconcilePhantomStornosOnStartup(
  dryRun = process.env.RECONCILE_PHANTOM_STORNOS_DRY_RUN === "1",
): Promise<void> {
  // Task #993 — Billiger "nichts zu tun"-Vorab-Check: zähle verwaiste Storno-
  // Zeilen, für die noch keine Gegenbuchung existiert. 0 ⇒ sofortiger No-Op
  // (kein Full-Ledger-Scan, keine Actor-Auflösung).
  const pendingRes = await db.execute(sql`
    SELECT count(*)::int AS n
    FROM ${budgetTransactions} AS o
    WHERE o.transaction_type = 'reversal'
      AND o.reversed_transaction_id IS NULL
      AND o.notes LIKE 'Storno von Transaktion #%'
      AND NOT EXISTS (
        SELECT 1
        FROM ${budgetTransactions} AS c
        WHERE c.transaction_type = 'consumption'
          AND c.notes LIKE '%verwaisten Storno #' || o.id || ' (%'
      )
  `);
  const pendingOrphans = Number(
    (pendingRes.rows?.[0] as { n?: number } | undefined)?.n ?? 0,
  );
  if (pendingOrphans === 0) {
    log(
      "Phantom-Storno-Korrektur (Task #988/#993): keine offenen Phantom-Waisen — übersprungen (lean boot)",
      "startup",
    );
    return;
  }

  // System-Actor für die GoBD-Audit-Attribution: ältester aktiver Superadmin,
  // sonst (Fallback) ältester aktiver Admin.
  const [superActor] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.isSuperAdmin, true), eq(users.isActive, true)))
    .orderBy(asc(users.id))
    .limit(1);
  let systemActorId: number | null = superActor?.id ?? null;
  if (systemActorId == null) {
    const [adminActor] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.isAdmin, true), eq(users.isActive, true)))
      .orderBy(asc(users.id))
      .limit(1);
    systemActorId = adminActor?.id ?? null;
  }

  if (systemActorId == null) {
    log(
      "Phantom-Storno-Korrektur (Task #988) übersprungen: kein aktiver Superadmin/Admin als Audit-Actor gefunden",
      "startup",
    );
    return;
  }

  const summary = await reconcilePhantomStornos({
    apply: !dryRun,
    customerIds: [],
    userId: systemActorId,
    reason: "Phantom-Storno Import-Drift #987 (Auto-Reconcile beim App-Start, Task #988)",
  });

  const toCorrect = summary.corrections.filter((c) => !c.alreadyCorrected).length;
  const totalNeutralizedCents = summary.perCombo.reduce(
    (s, c) => s + c.phantomCreditCents,
    0,
  );
  const prefix = dryRun ? "[DRY-RUN] " : "";

  if (summary.corrections.length === 0) {
    log(
      `${prefix}Phantom-Storno-Korrektur (Task #988): keine verwaisten Phantom-Stornos gefunden — No-Op`,
      "startup",
    );
    return;
  }

  log(
    `${prefix}Phantom-Storno-Korrektur (Task #988): ${summary.corrections.length} Phantom-Waisen ` +
      `(${summary.skippedAlreadyCorrected} bereits korrigiert, ${toCorrect} offen), ` +
      `${summary.correctedCount} Korrekturen geschrieben über ${summary.perCombo.length} Kunden/Topf-Kombis, ` +
      `Σ neutralisiert ${(totalNeutralizedCents / 100).toFixed(2)} €` +
      (summary.batchId ? `, Audit-Batch-ID ${summary.batchId}` : ""),
    "startup",
  );
}
