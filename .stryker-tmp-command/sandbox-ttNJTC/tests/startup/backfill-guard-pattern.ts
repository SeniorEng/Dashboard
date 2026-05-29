/**
 * Task #578 — Standard-Assertions für Startup-Backfill-Migrationen.
 *
 * Jede Backfill-Migration in `server/startup/` mutiert produktive Daten und
 * muss daher vier Eigenschaften erfüllen, deren manuelle Code-Review wir
 * durch wiederverwendbare Test-Bausteine ersetzen:
 *
 *   1. **Idempotenz / One-Shot-Guard** — die zweite Ausführung darf weder
 *      Daten verändern noch neue Audit-Einträge schreiben.
 *   2. **Tuple-Mismatch No-Op** — wird ein Anker-Feld (z.B. customerId,
 *      employeeId, year/month) abgewandelt, darf die Migration NICHT
 *      greifen, auch nicht für den "richtigen" Teil der Bedingung.
 *   3. **Fenster-Mismatch No-Op** — Mutationen außerhalb des definierten
 *      Incident-Fensters bleiben unangetastet.
 *   4. **Fehlender Audit-Akteur** — ohne Super-/Admin-User in der DB
 *      schreibt die Migration weder Daten noch Audit-Einträge.
 *
 * Die Helfer hier nehmen Run-Funktionen plus Snapshotter und assertieren
 * Gleichheit vor/nach. Der DB-Setup (Fixtures, Cleanup) bleibt im Test selbst.
 */
// @ts-nocheck

import { expect } from "vitest";

export interface BackfillSnapshot {
  /** Stable, deep-comparable Repräsentation des relevanten DB-Zustands. */
  data: unknown;
  /** Anzahl Audit-Einträge, die mit der Migration verknüpft sind. */
  auditCount: number;
}

/**
 * Garantiert, dass der zweite Lauf der Migration keine Datenänderung und
 * keinen neuen Audit-Eintrag erzeugt (One-Shot-Guard / Idempotenz).
 *
 * Verwendung:
 *   await assertSecondRunIsNoOp({
 *     run: () => restoreServiceRecordsByTuples(opts),
 *     snapshot: () => snapshotState(opts),
 *     label: "restore-storno",
 *   });
 */
export async function assertSecondRunIsNoOp(args: {
  run: () => Promise<unknown>;
  snapshot: () => Promise<BackfillSnapshot>;
  label?: string;
}): Promise<void> {
  const { run, snapshot, label = "backfill" } = args;
  await run();
  const after1 = await snapshot();
  await run();
  const after2 = await snapshot();
  expect(after2.data, `${label}: zweiter Lauf darf Daten nicht verändern`).toEqual(after1.data);
  expect(
    after2.auditCount,
    `${label}: zweiter Lauf darf keinen zusätzlichen Audit-Eintrag schreiben`,
  ).toBe(after1.auditCount);
}

/**
 * Garantiert, dass ein gezielt "verstimmtes" Setup (falscher Tupel-Wert
 * oder deletedAt außerhalb des Fensters) die Migration NICHT triggert.
 *
 * `mutate` baut den falschen Zustand auf, `restore` setzt zurück. Snapshot
 * vor `run` muss identisch zu Snapshot nach `run` sein.
 */
export async function assertNoOpForMismatch(args: {
  mutate: () => Promise<void>;
  restore: () => Promise<void>;
  run: () => Promise<unknown>;
  snapshot: () => Promise<BackfillSnapshot>;
  label: string;
}): Promise<void> {
  const { mutate, restore, run, snapshot, label } = args;
  await mutate();
  try {
    const before = await snapshot();
    await run();
    const after = await snapshot();
    expect(after.data, `${label}: Migration darf bei Mismatch nichts verändern`).toEqual(before.data);
    expect(
      after.auditCount,
      `${label}: Migration darf bei Mismatch keinen Audit-Eintrag schreiben`,
    ).toBe(before.auditCount);
  } finally {
    await restore();
  }
}

/**
 * Garantiert, dass die Migration ohne Audit-Akteur (kein Super-/Admin)
 * weder Daten noch Audit-Einträge schreibt. `removeActors` muss den
 * letzten verbleibenden Akteur entziehen (z.B. via Flag-Toggle), `restore`
 * stellt ihn anschließend wieder her.
 */
export async function assertSkipsWithoutAuditActor(args: {
  removeActors: () => Promise<void>;
  restoreActors: () => Promise<void>;
  run: () => Promise<unknown>;
  snapshot: () => Promise<BackfillSnapshot>;
  label?: string;
}): Promise<void> {
  const { removeActors, restoreActors, run, snapshot, label = "backfill" } = args;
  await removeActors();
  try {
    const before = await snapshot();
    const result = await run();
    const after = await snapshot();
    expect(after.data, `${label}: ohne Akteur darf nichts mutiert werden`).toEqual(before.data);
    expect(
      after.auditCount,
      `${label}: ohne Akteur dürfen keine Audit-Einträge geschrieben werden`,
    ).toBe(before.auditCount);
    // Optionaler Vertrag: wenn die Migration ein RestoreResult-ähnliches
    // Objekt mit `skipReason` zurückgibt, prüfen wir auf den Skip-Marker.
    if (result && typeof result === "object" && "skipReason" in (result as Record<string, unknown>)) {
      const reason = (result as { skipReason: unknown }).skipReason;
      expect(
        reason,
        `${label}: skipReason muss 'no_audit_actor' melden`,
      ).toBe("no_audit_actor");
    }
  } finally {
    await restoreActors();
  }
}
