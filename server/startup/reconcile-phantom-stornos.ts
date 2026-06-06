import { asc, eq, and } from "drizzle-orm";
import { db } from "../lib/db";
import { users } from "@shared/schema";
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
 */
export async function reconcilePhantomStornosOnStartup(
  dryRun = process.env.RECONCILE_PHANTOM_STORNOS_DRY_RUN === "1",
): Promise<void> {
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
