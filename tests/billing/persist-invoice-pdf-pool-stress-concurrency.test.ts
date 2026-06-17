/**
 * Task #1314 — Stress-/Negativ-Test: Die Rechnungs-PDF-Persistierung hält den
 * DB-Pool auch dann responsiv, wenn die Render-Parallelität WEIT ÜBER der
 * Pool-Größe liegt und ein Render-Schwall GRÖSSER als der Pool gleichzeitig in
 * flight ist.
 *
 * Einordnung im Test-Dreigestirn der Pool-Schonung (Task #1305):
 *   - `persist-invoice-pdf-no-tx-during-render.test.ts` (#1307): rein
 *     STRUKTURELL — misst mit voll gemockter DB die Schachtelungstiefe der
 *     `db.transaction(...)` zum Render-Zeitpunkt (muss 0 sein). Rührt den echten
 *     Pool nicht an.
 *   - `persist-invoice-pdf-pool-responsive-load.test.ts` (#1311): POSITIVE Last
 *     gegen die echte DB + echtes Chromium + echten Object Storage, aber NUR mit
 *     dem Default-Render-Slot-Limiter (PDF_RENDER_CONCURRENCY=2). Bei korrektem
 *     Code würde der Pool selbst dann NICHT aushungern, wenn der Render eine
 *     Verbindung hielte — die 2 gleichzeitigen Renders blieben unter den 20
 *     Pool-Slots. Der Test belegt also die Responsivität, kann aber die
 *     Pool-Erschöpfung als Fehlerbild nicht erzwingen.
 *   - DIESER Test (#1314): erzwingt das Fehlerbild. Er hebt die effektive
 *     Render-Parallelität ÜBER die Pool-Größe (20) und feuert einen Schwall von
 *     `SURGE_SIZE > 20` gleichzeitigen Renders. Damit würde eine Regression, die
 *     Phase 2 (Render + Object-Storage-Upload) wieder in eine GEHALTENE
 *     `db.transaction` einwickelt, ALLE 20 gepoolten Verbindungen über Sekunden
 *     belegen — unbeteiligte Reads liefen in den Acquire-Stau und das
 *     Latenz-Budget unten würde sprengen. Beim korrekten Drei-Phasen-Persist
 *     hält der Render KEINE Verbindung → unbeteiligte Reads bleiben zügig und
 *     `pool.waitingCount` bleibt beschränkt.
 *
 * Render-Parallelität ÜBER die Pool-Größe heben — Designentscheidung:
 * PDF_RENDER_MAX_CONCURRENCY wird in `server/services/pdf-generator.ts` EINMALIG
 * beim Modul-Laden aus `PDF_RENDER_CONCURRENCY` gelesen (Default 2) und im
 * Render-Slot-Limiter (`acquireRenderSlot`) erzwungen. Statt den Slot-Limiter
 * über die Env in einem isolierten Worker hochzudrehen (und damit echtes
 * Chromium mit >20 gleichzeitigen Seiten zu starten — bekannte PID-/EAGAIN-
 * Ressourcenfalle), MOCKEN wir das gesamte `pdf-generator`-Modul. Der Mock
 * umgeht den Slot-Limiter VOLLSTÄNDIG (effektiv unbegrenzte Parallelität, also
 * stärker als jedes endliche PDF_RENDER_CONCURRENCY > 20) und ersetzt den realen
 * Puppeteer-Render durch ein deterministisches `setTimeout`-Render-Fenster. Nur
 * so ist das Pool-Erschöpfungs-Fehlerbild reproduzierbar UND der Test bleibt
 * flake-frei (kein echtes Chromium, kontrollierte Render-Dauer).
 *
 * Echt bleiben: die DB + der Connection-Pool (`server/lib/db`), die Storage-/
 * Cache-/Object-Storage-Schicht und `persistInvoicePdf` selbst — der Pool-Stau
 * (oder eben seine Abwesenheit) wird gegen die ECHTE (ephemere) DB gemessen.
 *
 * Skippt sauber ohne Object Storage (z.B. GitHub-Actions-CI ohne Sidecar) über
 * das object-storage-`describe` — identisch zum positiven Schwester-Test #1311.
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { describe } from "../helpers/object-storage";

// Hoisted-State für den Render-Mock: zählt die GLEICHZEITIG aktiven Renders und
// trägt die künstliche Render-Dauer. `vi.hoisted` ist nötig, weil der
// `vi.mock`-Factory unten vor allen Imports ausgeführt wird.
const renderState = vi.hoisted(() => ({
  activeRenders: 0,
  renderDelayMs: 3_000,
}));

// pdf-generator komplett mocken: ersetzt den realen Puppeteer-Render UND umgeht
// den Render-Slot-Limiter (PDF_RENDER_CONCURRENCY). Dadurch laufen ALLE Renders
// des Schwalls gleichzeitig (Parallelität > Pool-Größe), und jeder Render hält
// das `setTimeout`-Fenster offen, ohne echtes Chromium zu starten.
vi.mock("../../server/lib/pdf-generator", () => ({
  generateInvoiceHtml: () => "<html>invoice</html>",
  generateLeistungsnachweisHtml: () => "<html>ln</html>",
  buildInvoiceFooterTemplate: () => "<footer/>",
  buildLeistungsnachweisFooterTemplate: () => "<footer/>",
  generatePdf: vi.fn(async () => {
    renderState.activeRenders += 1;
    try {
      await new Promise((r) => setTimeout(r, renderState.renderDelayMs));
    } finally {
      renderState.activeRenders -= 1;
    }
    return { buffer: Buffer.from("PDFDATA-STRESS"), pageCount: 1 };
  }),
}));

// ZUGFeRD mocken: der reale Embed (node-zugferd) erwartet ECHTE PDF-Bytes +
// optional Java — beides hier irrelevant. Wir geben die Bytes unverändert zurück
// und melden Strict-Mode, damit der Commit-Pfad kein Non-Strict-Audit schreibt.
vi.mock("../../server/lib/zugferd", () => ({
  DEFAULT_ZUGFERD_PROFILE: "en16931",
  embedZugferdXml: vi.fn(async (pdf: Buffer) => ({
    pdf,
    xml: "<xml/>",
    usedStrictMode: true,
    strictModeReason: null,
  })),
}));

// Determinismus-Normalisierung mocken (längenerhaltende Regex auf echten
// PDF-Bytes) — auf den Fake-Bytes irrelevant, Buffer unverändert durchreichen.
vi.mock("../../server/lib/pdf-determinism", () => ({
  normalizePdfDeterminism: (buf: Buffer) => buf,
}));

import { db, pool } from "../../server/lib/db";
import { invoices as invoicesTable, invoiceLineItems, users } from "@shared/schema";
import { inArray, sql } from "drizzle-orm";
import { persistInvoicePdf } from "../../server/services/invoice-pdf-orchestrator";
import { getAuthCookie, uniqueId, createTestCustomer, cleanupCustomer } from "../test-utils";

// Anzahl gleichzeitig gefeuerter Renders. MUSS > Pool-Größe (20) sein, damit ein
// in eine gehaltene Transaktion eingewickelter Render den Pool tatsächlich
// erschöpfen (und unbeteiligte Acquires aushungern) WÜRDE.
const SURGE_SIZE = 30;

// Pool-Obergrenze laut `server/lib/db.ts` (max: 20). Hier nur zur Lesbarkeit der
// Schwellwerte gespiegelt.
const POOL_MAX = 20;

// Latenz-Budget für eine UNBETEILIGTE DB-Query, gemessen WÄHREND der Schwall in
// flight ist. Beim korrekten Drei-Phasen-Persist hält der Render keine
// Verbindung → einstellige bis niedrige zweistellige Millisekunden. Eine
// Regression (Render in gehaltener Tx) ließe die Query bis zum Render-Ende
// (~`renderDelayMs`) am Acquire warten. Budget bewusst klar UNTER `renderDelayMs`
// und großzügig über der Gut-Latenz.
const UNRELATED_QUERY_BUDGET_MS = 1_500;

// Obergrenze für aufgestaute Acquire-Waiter während des Schwalls. Korrekt: der
// Render hält keine Verbindung → `waitingCount` praktisch 0 (nur kurze Plan-/
// Commit-Bursts). Regression: `SURGE_SIZE - POOL_MAX` (= 10) render-haltende
// Transaktionen warten dauerhaft auf eine Verbindung. 8 trennt beide Fälle
// sauber und lässt Luft für Mess-Jitter.
const MAX_WAITING_BUDGET = 8;

// Nur Messpunkte, die TIEF im Render-Fenster liegen (viele Renders gleichzeitig
// aktiv), zählen für die Pool-Aussage. So werden die kurzen Plan-/Commit-Bursts
// (in denen der Render NICHT aktiv ist) ausgeklammert. Schwelle < POOL_MAX,
// damit sie auch im Regressionsfall erreichbar ist (dort starten max. POOL_MAX
// Renders gleichzeitig, der Rest hängt am Tx-Acquire).
const DEEP_WINDOW_MIN_ACTIVE = Math.ceil(SURGE_SIZE / 2);

// Zeitversatz zwischen zwei Persist-Starts. Bewusst so gewählt, dass der ganze
// Schwall (STAGGER_MS * SURGE_SIZE) DEUTLICH kürzer ist als EIN Render
// (`renderState.renderDelayMs` = 3000 ms) — dadurch sind gegen Ende des Schwalls
// faktisch alle SURGE_SIZE Renders gleichzeitig in flight (Parallelität > Pool),
// während die kurzen Plan-/Commit-Transaktionen sich NICHT im selben Tick
// drängeln (sonst Selbst-Deadlock der Plan-Phase, siehe Schwall-Kommentar unten).
// 75 ms * 30 = 2250 ms < 3000 ms.
const STAGGER_MS = 75;

type Sample = { latencyMs: number; waiting: number; renderActive: number };

describe("Task #1314 — persistInvoicePdf-Schwall (Parallelität > Pool) hält den DB-Pool responsiv", () => {
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

    // SURGE_SIZE eigenständige Selbstzahler-Rechnungen direkt anlegen (Insert ist
    // GoBD-erlaubt). Selbstzahler ⇒ EIN Rechnungs-PDF, kein Leistungsnachweis —
    // jeder `persistInvoicePdf`-Aufruf rendert genau ein Artefakt. `pdfPath` ist
    // null, damit Phase 2 tatsächlich rendert (kein Cache-Hit/No-op). Der
    // in-flight-Mutex dedupliziert pro Rechnungs-ID, deshalb brauchen wir
    // distinkte IDs für echte Parallelität.
    for (let i = 0; i < SURGE_SIZE; i++) {
      const [inv] = await db
        .insert(invoicesTable)
        .values({
          customerId,
          invoiceNumber: `STRESS-${uniqueId()}-${i}`,
          invoiceType: "rechnung",
          billingType: "selbstzahler",
          billingMonth: 6,
          billingYear: 2026,
          status: "entwurf",
          recipientName: "Stress-Test Empfänger",
          recipientAddress: "Teststraße 1\n10115 Berlin",
          customerName: "Stress-Test Empfänger",
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

  it("unbeteiligte DB-Reads bleiben zügig & der Pool staut sich nicht auf, obwohl der Render-Schwall größer als der Pool ist", async () => {
    const samples: Sample[] = [];
    let sampling = true;

    // Sampling-Schleife: misst fortlaufend die Latenz einer unbeteiligten
    // DB-Query (stellvertretend für Session-Validierung / Kundenliste) und hält
    // dabei `pool.waitingCount` sowie die Zahl aktiver Renders fest. WICHTIG:
    // `renderActive` und `waiting` werden VOR dem `await` erfasst — im
    // Regressionsfall blockiert das `SELECT 1` bis zum Render-Ende, sodass das
    // Render-Fenster bei der Rückkehr bereits vorbei wäre und der Messpunkt sonst
    // fälschlich herausgefiltert würde.
    const samplerDone = (async () => {
      while (sampling) {
        const renderActive = renderState.activeRenders;
        const waiting = pool.waitingCount;
        const t0 = Date.now();
        await db.execute(sql`SELECT 1`);
        samples.push({ latencyMs: Date.now() - t0, waiting, renderActive });
        await new Promise((r) => setTimeout(r, 25));
      }
    })();

    // Schwall GESTAFFELT feuern (≈ STAGGER_MS Abstand) statt alle SURGE_SIZE im
    // selben Tick. Begründung: Phase 1 (planInvoicePdfPersist) und Phase 3
    // (Commit) sind jeweils kurze Transaktionen, die EINE gepoolte Verbindung
    // halten und darin einen weiteren Read über das globale `db`-Handle absetzen
    // (storage.getInvoice ⇒ zweite Verbindung). Würden alle SURGE_SIZE Aufrufe
    // EXAKT gleichzeitig starten, belegten POOL_MAX Plan-Transaktionen alle Slots
    // und warteten dann gegenseitig auf eine (POOL_MAX+1)-te Verbindung für den
    // inneren Read — ein Selbst-Deadlock der Plan-Phase, BEVOR überhaupt ein
    // Render beginnt. Das ist NICHT das hier gesuchte Fehlerbild (Render in
    // gehaltener Tx) und entspricht auch nicht der Realität: echte Persist-Aufrufe
    // treffen zeitversetzt ein (im Betrieb zusätzlich auf PDF_RENDER_CONCURRENCY
    // gedrosselt). Die Staffelung entzerrt die kurzen Plan-/Commit-Phasen, während
    // die TEUREN Renders sich trotzdem weit über die Pool-Größe hinaus überlappen:
    // wegen STAGGER_MS * SURGE_SIZE < renderDelayMs sind gegen Ende des Schwalls
    // praktisch alle SURGE_SIZE Renders gleichzeitig in flight. Im Regressionsfall
    // (Render in gehaltener Tx) staut sich der Pool ab dem POOL_MAX-ten Render auf
    // → unbeteiligte Reads blockieren → Latenz-/Waiting-Budget reißt.
    // try/finally stellt sicher, dass die Sampling-Schleife auch bei einem
    // Render-Fehler beendet + abgewartet wird (sonst liefe sie bis zum
    // Test-Timeout weiter und verschleierte die eigentliche Ursache).
    const inFlight: Promise<void>[] = [];
    try {
      for (const id of invoiceIds) {
        inFlight.push(persistInvoicePdf(id));
        await new Promise((r) => setTimeout(r, STAGGER_MS));
      }
      await Promise.all(inFlight);
    } finally {
      sampling = false;
      await samplerDone;
    }

    // (1) Deterministisch: jede Rechnung wurde tatsächlich gerendert + versiegelt.
    const persisted = await db
      .select({ id: invoicesTable.id, pdfPath: invoicesTable.pdfPath })
      .from(invoicesTable)
      .where(inArray(invoicesTable.id, invoiceIds));
    expect(persisted.length).toBe(SURGE_SIZE);
    for (const row of persisted) {
      expect(row.pdfPath, `Rechnung ${row.id} muss ein PDF persistiert haben`).toBeTruthy();
    }

    // (2) Wir haben tatsächlich TIEF im Render-Fenster gemessen (viele Renders
    // gleichzeitig aktiv) — sonst wäre die Aussage über die Pool-Responsivität
    // wertlos. Belegt zugleich, dass die Render-Parallelität die Pool-Größe
    // überstieg: ohne den umgangenen Slot-Limiter wären nie so viele Renders
    // gleichzeitig aktiv.
    const deepWindow = samples.filter((s) => s.renderActive >= DEEP_WINDOW_MIN_ACTIVE);
    expect(
      deepWindow.length,
      `Kein Messpunkt fiel in ein tiefes Render-Fenster (>= ${DEEP_WINDOW_MIN_ACTIVE} ` +
        `gleichzeitige Renders) — Test-Setup/Timing prüfen`,
    ).toBeGreaterThanOrEqual(1);

    // (3) HEADLINE-Garantie: Unbeteiligte DB-Reads blieben WÄHREND des Schwalls
    // zügig. Würde Phase 2 wieder in eine gehaltene `db.transaction` eingewickelt,
    // hielten die Renders bis zu POOL_MAX Verbindungen über Sekunden und dieses
    // `SELECT 1` liefe bis zum Render-Ende (~`renderDelayMs`) in den Acquire-Stau.
    // Bewusst VOR der maxActive-Sanity geprüft, damit eine Regression an der
    // tatsächlichen Schadenswirkung (langsame Fremd-Reads) festgemacht wird.
    const maxLatency = Math.max(...deepWindow.map((s) => s.latencyMs));
    expect(
      maxLatency,
      `Eine unbeteiligte DB-Query brauchte ${maxLatency}ms während des Render-Schwalls — ` +
        `Hinweis auf Pool-Starvation (Render hält wieder eine gepoolte Verbindung).`,
    ).toBeLessThan(UNRELATED_QUERY_BUDGET_MS);

    // (4) HEADLINE-Garantie: Der Pool staute sich während des Schwalls nicht auf.
    // Regression: render-haltende Transaktionen + die wartenden Fremd-Reads lassen
    // `waitingCount` über das Budget steigen.
    const maxWaiting = Math.max(...deepWindow.map((s) => s.waiting));
    expect(
      maxWaiting,
      `pool.waitingCount stieg während des Schwalls auf ${maxWaiting} — Acquire-Stau ` +
        `(render-haltende Transaktionen belegen den Pool).`,
    ).toBeLessThanOrEqual(MAX_WAITING_BUDGET);

    // (5) Sanity UND ergänzender Regressions-Detektor: die effektive
    // Render-Parallelität lag wirklich über der Pool-Größe. Im KORREKTEN Code
    // halten Renders KEINE Verbindung, also überlappen praktisch alle SURGE_SIZE
    // Renders gleichzeitig (maxActive ≈ SURGE_SIZE > POOL_MAX) — das belegt, dass
    // der Schwall die Pool-Größe tatsächlich überschritten hat. Wickelt eine
    // Regression Phase 2 wieder in eine gehaltene `db.transaction`, drosselt der
    // Pool die gleichzeitig laufenden Renders zwangsläufig auf höchstens POOL_MAX
    // (jeder aktive Render belegt einen Slot) → maxActive fällt unter POOL_MAX und
    // diese Assertion greift zusätzlich zu (3)/(4).
    const maxActive = Math.max(...samples.map((s) => s.renderActive));
    expect(
      maxActive,
      `Maximale gleichzeitige Renders (${maxActive}) überstieg die Pool-Größe (${POOL_MAX}) NICHT — ` +
        `entweder SURGE_SIZE zu klein ODER (wahrscheinlicher) Phase 2 hält wieder eine gepoolte ` +
        `Verbindung, sodass der Pool die Renders auf <= POOL_MAX drosselt.`,
    ).toBeGreaterThan(POOL_MAX);

    // (6) Nach Abschluss ist der Pool wieder frei (keine hängende Verbindung).
    expect(pool.waitingCount, "Nach dem Schwall dürfen keine Acquire-Waiter mehr offen sein").toBe(0);
  }, 180_000);
});
