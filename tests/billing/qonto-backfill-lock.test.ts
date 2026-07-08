/**
 * Task #1591 / #1718 — Serverseitiger Lauf-Lock für den Qonto-Voll-Sync (Backfill).
 *
 * Der teure Voll-Abzug darf immer nur EINMAL gleichzeitig laufen. Die Route
 * hält dafür einen session-scoped `pg_try_advisory_lock` auf einer dedizierten
 * Pool-Verbindung. Läuft bereits ein Voll-Sync, antwortet die Route mit 409
 * (`QONTO_BACKFILL_RUNNING`) statt einen zweiten Abzug anzustoßen.
 *
 * Verifiziert:
 *  1. Wird der Lock von einer anderen Session gehalten, liefert /backfill 409
 *     (End-to-End über die echte HTTP-Route — die eigentliche Sicherheits-Sperre).
 *  2. Nach Freigabe des Locks ist er wieder erwerbbar, ein neuer Lauf startet
 *     (kein Reststau).
 *
 * Warum Test 2 in-process statt über die HTTP-Route läuft:
 *  Der App-Server läuft in einem SEPARATEN Prozess. `vi.stubGlobal("fetch")`
 *  aus dem Test-Prozess erreicht dessen ausgehende Qonto-HTTP-Aufrufe NICHT,
 *  und das primäre Geschäftskonto ist immer ein überwachtes Konto
 *  (`resolveMonitoredIbans`) → ein echter /backfill über HTTP würde mit den
 *  Test-Zugangsdaten eine echte Qonto-Abfrage versuchen und werfen. Test 2
 *  ruft den geteilten Runner (`withQontoBackfillLock`) daher direkt im
 *  Test-Prozess auf, wo der `fetch`-Stub greift, und prüft so „Lock wieder
 *  frei ⇒ Lauf startet erneut" ohne echte Qonto-HTTP-Abfrage.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { storage } from "../../server/storage";
import { pool } from "../../server/lib/db";
import { qontoService } from "../../server/services/qonto";
import {
  withQontoBackfillLock,
  QONTO_BACKFILL_LOCK_KEY,
} from "../../server/services/qonto-backfill-runner";
import { getAuthCookie, apiPostAs } from "../test-utils";

const PRIMARY_IBAN = "DE00PRIMARY0000000001";

/** Ein gültiges, aktuelles Startdatum (Monatserster) im YYYY-MM-DD-Format. */
function currentMonthStartDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

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

  // Zugangsdaten in-process setzen, damit der in-process Runner-Aufruf in
  // Test 2 gültige Credentials liest. Keine Zusatzkonten → genau ein
  // überwachtes Konto (das primäre).
  await storage.updateCompanySettings(
    {
      qontoLogin: "test-login",
      qontoSecretKey: "test-secret",
      qontoIban: PRIMARY_IBAN,
      qontoAdditionalIbans: [],
    },
    null,
  );
});

afterAll(async () => {
  await storage.updateCompanySettings(savedSettings, null);
});

// Root-Cause-Schutz (siehe .agents/memory/qonto-test-fetch-stub-leak.md): jeder
// Test, der `global.fetch` durch einen Qonto-API-Mock ersetzt, MUSS ihn wieder
// herstellen, sonst erbt eine spätere Suite den Mock und ihr Login schlägt mit
// „CSRF-Token nicht in Cookies gefunden" fehl.
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Qonto-Voll-Sync Lauf-Lock (Task #1591)", () => {
  it("antwortet mit 409, wenn bereits ein Voll-Sync läuft (Lock gehalten)", async () => {
    const auth = await getAuthCookie();

    // Simuliert einen laufenden Voll-Sync: der Lock wird von einer separaten
    // Session gehalten. Advisory-Locks sind cluster-weit — parallele Worker/
    // Workflows auf demselben PG-Cluster können den Schlüssel kurzfristig
    // halten. Statt einmalig zu prüfen und flaky zu scheitern, versuchen wir
    // den Lock in einer kurzen Schleife selbst zu erwerben.
    const holder = await pool.connect();
    let weHoldLock = false;
    try {
      for (let attempt = 0; attempt < 50 && !weHoldLock; attempt++) {
        const held = await holder.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock($1) AS locked",
          [QONTO_BACKFILL_LOCK_KEY],
        );
        weHoldLock = held.rows[0].locked === true;
        if (!weHoldLock) await new Promise((r) => setTimeout(r, 100));
      }

      // Ob WIR den Lock erworben haben oder eine andere Session ihn noch hält:
      // der Schlüssel ist jetzt belegt → die Route MUSS mit 409 ablehnen. Das
      // 409-Verhalten ist die eigentliche Sicherheits-Sperre.
      const res = await apiPostAs<{ message: string; code: string; error?: string }>(
        auth,
        "/api/admin/qonto/backfill",
        { startDate: currentMonthStartDate() },
      );

      expect(res.status).toBe(409);
      expect(res.data.error).toBe("QONTO_BACKFILL_RUNNING");
    } finally {
      if (weHoldLock) {
        await holder.query("SELECT pg_advisory_unlock($1)", [QONTO_BACKFILL_LOCK_KEY]);
      }
      holder.release();
    }
  });

  it("ist nach Freigabe wieder erwerbbar und startet einen neuen Lauf", async () => {
    // Qonto-API leer stubben, damit der in-process Backfill keine echte HTTP-
    // Abfrage macht und deterministisch terminiert.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ transactions: [], meta: { total_pages: 1 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const startDate = new Date();
    startDate.setDate(1);
    startDate.setHours(0, 0, 0, 0);

    // Der Lock ist frei (Test 1 hat ihn wieder freigegeben) → der Runner führt
    // `fn` aus und liefert `ran: true`. Ein Reststau würde hier `ran: false`
    // erzwingen.
    const outcome = await withQontoBackfillLock(() =>
      qontoService.backfillTransactions(startDate),
    );

    expect(outcome.ran).toBe(true);
    if (outcome.ran) {
      // Genau ein überwachtes Konto (das primäre); leerer Stub ⇒ nichts geladen.
      expect(outcome.result.accounts).toBe(1);
      expect(outcome.result.synced).toBe(0);
    }
  });
});
