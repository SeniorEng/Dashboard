/**
 * Task #1591 — Serverseitiger Lauf-Lock für den Qonto-Voll-Sync (Backfill).
 *
 * Der teure Voll-Abzug darf immer nur EINMAL gleichzeitig laufen. Die Route
 * hält dafür einen session-scoped `pg_try_advisory_lock` auf einer dedizierten
 * Pool-Verbindung. Läuft bereits ein Voll-Sync, antwortet die Route mit 409
 * (`QONTO_BACKFILL_RUNNING`) statt einen zweiten Abzug anzustoßen.
 *
 * Verifiziert:
 *  1. Wird der Lock von einer anderen Session gehalten, liefert /backfill 409.
 *  2. Nach Freigabe des Locks funktioniert /backfill wieder (kein Reststau).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { storage } from "../../server/storage";
import { pool } from "../../server/lib/db";
import { getAuthCookie, apiPostAs, apiPatchAs } from "../test-utils";

// Muss exakt dem Schlüssel in server/routes/admin/qonto.ts entsprechen
// ("QBKF" = Qonto BacKFill).
const QONTO_BACKFILL_LOCK_KEY = String(0x51424b46);

let savedSettings: {
  qontoLogin: string | null;
  qontoSecretKey: string | null;
  qontoIban: string | null;
  qontoAdditionalIbans: string[];
};

beforeAll(async () => {
  const current = await storage.getCompanySettings();
  savedSettings = {
    qontoLogin: current.qontoLogin ?? null,
    qontoSecretKey: current.qontoSecretKey ?? null,
    qontoIban: current.qontoIban ?? null,
    qontoAdditionalIbans: current.qontoAdditionalIbans ?? [],
  };

  // Zugangsdaten setzen, aber KEINE Zusatzkonten: so bricht backfill nicht an
  // fehlenden Credentials ab und liefert im Erfolgsfall accounts:0 (keine echte
  // Qonto-HTTP-Abfrage nötig). Der Schreibvorgang läuft über die HTTP-PATCH-
  // Route des App-Servers, damit dessen eigener Company-Settings-Cache frisch
  // ist (Cross-Prozess-Cache-Falle: eine In-Process-storage-Mutation im
  // Test-Prozess erreicht den App-Server-Cache nicht).
  const auth = await getAuthCookie();
  await apiPatchAs(auth, "/api/company-settings", {
    qontoLogin: "test-login",
    qontoSecretKey: "test-secret",
    qontoIban: "DE00PRIMARY0000000001",
    qontoAdditionalIbans: [],
  });
});

afterAll(async () => {
  const auth = await getAuthCookie();
  await apiPatchAs(auth, "/api/company-settings", {
    qontoLogin: savedSettings.qontoLogin,
    qontoSecretKey: savedSettings.qontoSecretKey,
    qontoIban: savedSettings.qontoIban,
    qontoAdditionalIbans: savedSettings.qontoAdditionalIbans,
  });
});

describe("Qonto-Voll-Sync Lauf-Lock (Task #1591)", () => {
  it("antwortet mit 409, wenn bereits ein Voll-Sync läuft (Lock gehalten)", async () => {
    const auth = await getAuthCookie();

    // Simuliert einen laufenden Voll-Sync: der Lock wird von einer separaten
    // Session gehalten.
    const holder = await pool.connect();
    try {
      const held = await holder.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [QONTO_BACKFILL_LOCK_KEY],
      );
      expect(held.rows[0].locked).toBe(true);

      const res = await apiPostAs<{ message: string; code: string; error?: string }>(
        auth,
        "/api/admin/qonto/backfill",
        {},
      );

      expect(res.status).toBe(409);
      expect(res.data.error).toBe("QONTO_BACKFILL_RUNNING");
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1)", [QONTO_BACKFILL_LOCK_KEY]);
      holder.release();
    }
  });

  it("funktioniert wieder, nachdem der Lock freigegeben wurde", async () => {
    const auth = await getAuthCookie();

    const res = await apiPostAs<{ synced: number; total: number; accounts: number }>(
      auth,
      "/api/admin/qonto/backfill",
      {},
    );

    expect(res.status).toBe(200);
    // Keine Zusatzkonten hinterlegt → nichts zu laden.
    expect(res.data.accounts).toBe(0);
  });
});
