/**
 * Task #1311 — Last-Test: Die Rechnungs-PDF-Persistierung hält den DB-Pool
 * WÄHREND eines Bursts paralleler Renders responsiv.
 *
 * Komplementär zu `persist-invoice-pdf-no-tx-during-render.test.ts` (Task #1307):
 * Jener Test ist rein STRUKTURELL — er misst mit Mocks die Schachtelungstiefe
 * der `db.transaction(...)` zum Render-Zeitpunkt und beweist, dass Render +
 * Object-Storage-Upload außerhalb jeder gehaltenen Transaktion laufen. Er rührt
 * aber weder den echten Connection-Pool noch echtes Puppeteer/Object-Storage an.
 *
 * Dieser Test belegt die TATSÄCHLICHE, nutzerseitige Garantie end-to-end gegen
 * die echte (ephemere) DB, echtes Chromium und echten Object Storage:
 * Während ein Burst von `persistInvoicePdf`-Renders in flight ist (Phase 2,
 * KEINE gehaltene DB-Verbindung), laufen unbeteiligte DB-Reads weiterhin zügig
 * durch und der Pool staut sich nicht auf (`pool.waitingCount` bleibt
 * beschränkt). Eine Regression, die den teuren Render wieder in eine gehaltene
 * `db.transaction` einwickelt, würde die 20 gepoolten Verbindungen über
 * Sekunden belegen — unbeteiligte Acquires liefen dann in den 15s-Connect-
 * Timeout und das Latenz-Budget unten würde sprengen.
 *
 * Robustheit gegen Timing-Flakes: großzügige Budgets, und die Kern-Aussagen
 * hängen an deterministischen Fakten (alle Rechnungen wurden gerendert; es gab
 * Messpunkte WÄHREND ein Render aktiv war; der Pool ist danach wieder leer).
 *
 * Skippt sauber ohne Object Storage (z.B. GitHub-Actions-CI ohne Sidecar) über
 * das object-storage-`describe`.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { describe } from "../helpers/object-storage";
import { db, pool } from "../../server/lib/db";
import { invoices as invoicesTable, invoiceLineItems, users } from "@shared/schema";
import { inArray, sql } from "drizzle-orm";
import { persistInvoicePdf } from "../../server/services/invoice-pdf-orchestrator";
import { _getRenderSlotState } from "../../server/services/pdf-generator";
import { getAuthCookie, uniqueId, createTestCustomer, cleanupCustomer } from "../test-utils";

// Anzahl gleichzeitig gefeuerter Renders. Der Render-Slot-Limiter
// (PDF_RENDER_CONCURRENCY, Default 2) arbeitet den Burst in Wellen ab, sodass
// die Persist-Phase mehrere Sekunden in flight bleibt — genug Zeit, um den
// Pool-Zustand währenddessen zu sampeln.
const BURST_SIZE = 10;

// Großzügiges Latenz-Budget für eine unbeteiligte DB-Query WÄHREND des Bursts.
// Normal sind das einstellige Millisekunden; selbst auf langsamer CI bleibt ein
// `SELECT 1` weit darunter, solange der Pool nicht durch render-haltende
// Transaktionen ausgehungert wird (dann: ~15s Connect-Timeout-Stau).
const UNRELATED_QUERY_BUDGET_MS = 5_000;

// Obergrenze für aufgestaute Acquire-Waiter während des Bursts. Bei korrektem
// Drei-Phasen-Persist hält der Render KEINE Verbindung → `waitingCount` bleibt
// praktisch 0; großzügig auf 8 gesetzt gegen Mess-Jitter.
const MAX_WAITING_BUDGET = 8;

type Sample = { latencyMs: number; waiting: number; renderActive: number };

describe("Task #1311 — persistInvoicePdf-Burst hält den DB-Pool responsiv", () => {
  let customerId: number;
  let userId: number;
  const invoiceIds: number[] = [];

  beforeAll(async () => {
    await getAuthCookie();

    const [u] = await db.select({ id: users.id }).from(users).limit(1);
    expect(u, "Mindestens ein User (Superadmin) muss geseedet sein").toBeTruthy();
    userId = u.id;

    const customer = await createTestCustomer({ billingType: "selbstzahler" });
    customerId = customer.id;

    // BURST_SIZE eigenständige Selbstzahler-Rechnungen direkt anlegen (Insert ist
    // GoBD-erlaubt). Selbstzahler ⇒ EIN Rechnungs-PDF, kein Leistungsnachweis —
    // jeder `persistInvoicePdf`-Aufruf rendert also genau ein Artefakt. `pdfPath`
    // ist null, damit Phase 2 tatsächlich rendert (kein Cache-Hit/No-op). Der
    // in-flight-Mutex dedupliziert pro Rechnungs-ID, deshalb brauchen wir
    // distinkte IDs für echte Parallelität.
    for (let i = 0; i < BURST_SIZE; i++) {
      const [inv] = await db
        .insert(invoicesTable)
        .values({
          customerId,
          invoiceNumber: `LOAD-${uniqueId()}-${i}`,
          invoiceType: "rechnung",
          billingType: "selbstzahler",
          billingMonth: 6,
          billingYear: 2026,
          status: "entwurf",
          recipientName: "Last-Test Empfänger",
          recipientAddress: "Teststraße 1\n10115 Berlin",
          customerName: "Last-Test Empfänger",
          netAmountCents: 5000,
          vatAmountCents: 950,
          grossAmountCents: 5950,
          vatRate: 19,
          createdByUserId: userId,
          pdfPath: null,
        } as typeof invoicesTable.$inferInsert)
        .returning({ id: invoicesTable.id });

      await db.insert(invoiceLineItems).values({
        invoiceId: inv.id,
        appointmentId: null,
        appointmentDate: "2026-06-05",
        serviceDescription: "Hauswirtschaftliche Versorgung",
        durationMinutes: 60,
        unitPriceCents: 5000,
        totalCents: 5000,
        sortOrder: 0,
      } as typeof invoiceLineItems.$inferInsert);

      invoiceIds.push(inv.id);
    }
  }, 120_000);

  afterAll(async () => {
    if (invoiceIds.length > 0) {
      try {
        await db.delete(invoicesTable).where(inArray(invoicesTable.id, invoiceIds));
      } catch {
        /* best-effort */
      }
    }
    await cleanupCustomer(customerId);
  });

  it("unbeteiligte DB-Reads bleiben zügig & der Pool staut sich nicht auf, während ein Render-Burst läuft", async () => {
    const samples: Sample[] = [];
    let sampling = true;

    // Sampling-Schleife: misst fortlaufend die Latenz einer unbeteiligten
    // DB-Query (stellvertretend für Session-Validierung / Kundenliste) und hält
    // dabei `pool.waitingCount` sowie die Zahl aktiver Renders fest.
    const samplerDone = (async () => {
      while (sampling) {
        const t0 = Date.now();
        await db.execute(sql`SELECT 1`);
        samples.push({
          latencyMs: Date.now() - t0,
          waiting: pool.waitingCount,
          renderActive: _getRenderSlotState().active,
        });
        await new Promise((r) => setTimeout(r, 25));
      }
    })();

    // Burst feuern: alle Renders parallel anstoßen. try/finally stellt sicher,
    // dass die Sampling-Schleife auch bei einem Render-Fehler beendet + abgewartet
    // wird (sonst liefe sie bis zum Test-Timeout weiter und verschleierte die
    // eigentliche Ursache).
    try {
      await Promise.all(invoiceIds.map((id) => persistInvoicePdf(id)));
    } finally {
      sampling = false;
      await samplerDone;
    }

    // (1) Deterministisch: jede Rechnung wurde tatsächlich gerendert + versiegelt.
    const persisted = await db
      .select({ id: invoicesTable.id, pdfPath: invoicesTable.pdfPath })
      .from(invoicesTable)
      .where(inArray(invoicesTable.id, invoiceIds));
    expect(persisted.length).toBe(BURST_SIZE);
    for (const row of persisted) {
      expect(row.pdfPath, `Rechnung ${row.id} muss ein PDF persistiert haben`).toBeTruthy();
    }

    // (2) Wir haben tatsächlich WÄHREND eines laufenden Renders gemessen —
    // sonst wäre die Aussage über die Pool-Responsivität wertlos.
    const inFlight = samples.filter((s) => s.renderActive > 0);
    expect(
      inFlight.length,
      "Kein Messpunkt fiel in eine aktive Render-Phase — Test-Setup/Timing prüfen",
    ).toBeGreaterThanOrEqual(1);

    // (3) Unbeteiligte DB-Reads blieben WÄHREND des Bursts zügig.
    const maxLatency = Math.max(...inFlight.map((s) => s.latencyMs));
    expect(
      maxLatency,
      `Eine unbeteiligte DB-Query brauchte ${maxLatency}ms während des Render-Bursts — ` +
        `Hinweis auf Pool-Starvation (Render hält wieder eine gepoolte Verbindung).`,
    ).toBeLessThan(UNRELATED_QUERY_BUDGET_MS);

    // (4) Der Pool staute sich während des Bursts nicht auf.
    const maxWaiting = Math.max(...inFlight.map((s) => s.waiting));
    expect(
      maxWaiting,
      `pool.waitingCount stieg während des Bursts auf ${maxWaiting} — Acquire-Stau.`,
    ).toBeLessThanOrEqual(MAX_WAITING_BUDGET);

    // (5) Nach Abschluss ist der Pool wieder frei (keine hängende Verbindung).
    expect(pool.waitingCount, "Nach dem Burst dürfen keine Acquire-Waiter mehr offen sein").toBe(0);
  }, 180_000);
});
