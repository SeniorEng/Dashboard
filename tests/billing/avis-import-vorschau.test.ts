/**
 * P1 6hXqFcc2hRQfC9qp, Schritt 0 und 2 — Vorschau und Prüfsummen-Riegel.
 *
 * ── Warum die Vorschau vor dem ersten echten Import steht ────────────────
 * Die Avis-Dateien tragen Versichertennamen und -nummern. Sie können deshalb
 * nur bei Alrik geprüft werden — und ohne Vorschau hieße „prüfen" importieren.
 * Die Vorschau parst und zeigt, ohne dass ein einziger Avis entsteht.
 *
 * ── Die Zusage, die hier festgenagelt wird ───────────────────────────────
 * **Ein Pfad, ein Schalter.** Die Vorschau läuft durch denselben
 * `parseAvisCsv`-Aufruf und denselben Riegel wie der echte Import; nur der
 * Schreibteil fällt weg. Ein danebengebauter Vorschau-Pfad wäre genau der
 * Zweitbegriff, den dieses Ticket in `gesamt_betrag_cents` gefunden hat — und
 * er liefe auseinander, sobald sich jemand auf ihn verlässt.
 *
 * Fixtures anonymisiert: echte Struktur, erfundene Beträge und Namen.
 */
import { describe, it, expect, afterAll } from "vitest";
import { apiPost } from "../test-utils";
import { db } from "../../server/lib/db";
import { paymentAdvices, paymentAdviceItems } from "../../shared/schema";
import { eq, inArray, like } from "drizzle-orm";

const TAG = `vorschau-${Date.now()}`;

/** Stimmige Kassen-CSV: zwei Posten, eine `3;`-Summenzeile, Summe geht auf. */
const STIMMIG = [
  "1;200000000;Testempfaenger;",
  "2;RE-2026-9201 Beispiel;RE-2026-9201;01.09.2026;150,00;+;EUR;",
  "2;RE-2026-9202 Beispiel;RE-2026-9202;01.09.2026;1.234,90;+;EUR;",
  "3;BELEG-1;15.09.2026;1.384,90;DE00000000000000000000;",
].join("\n");

/** Dieselbe Datei, Summenzeile um 1,00 € daneben. */
const UNSTIMMIG = STIMMIG.replace("1.384,90", "1.385,90");

/** Dieselbe Datei ohne Summenzeile — nichts zu vergleichen. */
const OHNE_SUMME = STIMMIG.split("\n").filter((l) => !l.startsWith("3;")).join("\n");

async function sende(csvContent: string, extra: Record<string, unknown> = {}) {
  return apiPost<Record<string, unknown>>("/api/admin/qonto/payment-advices", {
    fileName: `${TAG}-${Math.random().toString(36).slice(2, 8)}.csv`,
    csvContent,
    ...extra,
  });
}

afterAll(async () => {
  const angelegt = await db.select({ id: paymentAdvices.id })
    .from(paymentAdvices).where(like(paymentAdvices.fileName, `${TAG}%`));
  const ids = angelegt.map((a) => a.id);
  if (ids.length) {
    await db.delete(paymentAdviceItems).where(inArray(paymentAdviceItems.paymentAdviceId, ids));
    await db.delete(paymentAdvices).where(inArray(paymentAdvices.id, ids));
  }
});

describe("Avis-Import — Vorschau und Prüfsummen-Riegel", () => {
  it("AV-1 – die Vorschau parst und schreibt NICHTS", async () => {
    const vorher = await db.select({ id: paymentAdvices.id }).from(paymentAdvices);

    const res = await sende(STIMMIG, { dryRun: true });

    expect(res.status).toBe(200);
    expect(res.data.dryRun).toBe(true);
    expect(res.data.itemCount, "die Vorschau zeigt keine Posten").toBe(2);

    const nachher = await db.select({ id: paymentAdvices.id }).from(paymentAdvices);
    expect(nachher.length, "die Vorschau hat einen Avis angelegt").toBe(vorher.length);
  });

  it("AV-2 – die Vorschau zeigt die Prüfsumme, nicht nur die Posten", async () => {
    // Der Zweck der Vorschau ist die ZWEITE Zahl. Ohne sie wäre sie eine
    // hübsche Liste, die genau das verschweigt, weswegen es sie gibt.
    const res = await sende(STIMMIG, { dryRun: true });
    const p = res.data.pruefsumme as Record<string, unknown>;
    expect(p.ausPostenCents).toBe(138490);
    expect(p.ausgewiesenCents).toBe(138490);
    expect(p.abweichungCents).toBe(0);
    expect(String(p.quelle).length, "ohne Quelle ist die Zahl nicht nachprüfbar").toBeGreaterThan(3);
  });

  it("AV-3 – eine unstimmige Datei wird ABGELEHNT, nicht gewarnt", async () => {
    // Genau dieser Riegel hätte beide Fehler vom 21.09. am ersten Tag gezeigt.
    const res = await sende(UNSTIMMIG);
    expect(res.status).toBe(400);
    expect(res.data.code).toBe("AVIS_PRUEFSUMME");
    expect(String(res.data.message)).toMatch(/-1,00|-1\.00/);
  });

  it("AV-4 – „keine zweite Zahl“ wird ebenfalls abgelehnt", async () => {
    // „Nicht vergleichbar" ist kein bestandener Vergleich — dieselbe Regel wie
    // beim Publish-Preflight, der seinen eigenen Ausfall als „nichts gefunden"
    // ausgab.
    const res = await sende(OHNE_SUMME);
    expect(res.status).toBe(400);
    expect(res.data.code).toBe("AVIS_PRUEFSUMME");
    expect(String(res.data.message)).toMatch(/keine zweite Summe/);
  });

  it("AV-5 – der Riegel gilt für die Vorschau GENAUSO", async () => {
    // Eine Vorschau, die durchwinkt, was der Import ablehnt, wäre schlimmer
    // als keine: sie verspräche einen Import, der dann scheitert.
    const res = await sende(UNSTIMMIG, { dryRun: true });
    expect(res.status).toBe(400);
    expect(res.data.code).toBe("AVIS_PRUEFSUMME");
  });

  it("AV-6 – Vorschau und echter Import sehen DASSELBE", async () => {
    // Die tragende Zusage: ein Pfad, ein Schalter. Erst die Vorschau, dann der
    // Import derselben Datei — Kopf und Posten müssen übereinstimmen.
    const csv = STIMMIG;
    const dateiname = `${TAG}-paar.csv`;

    const vorschau = await apiPost<Record<string, unknown>>(
      "/api/admin/qonto/payment-advices", { fileName: dateiname, csvContent: csv, dryRun: true },
    );
    expect(vorschau.status).toBe(200);

    const echt = await apiPost<Record<string, unknown>>(
      "/api/admin/qonto/payment-advices", { fileName: dateiname, csvContent: csv },
    );
    expect(echt.status, JSON.stringify(echt.data)).toBe(200);

    const adviceId = Number((echt.data.advice as { id: number })?.id ?? echt.data.id);
    const [gespeichert] = await db.select().from(paymentAdvices).where(eq(paymentAdvices.id, adviceId));
    const posten = await db.select().from(paymentAdviceItems)
      .where(eq(paymentAdviceItems.paymentAdviceId, adviceId));

    const kopf = vorschau.data.header as Record<string, unknown>;
    expect(gespeichert.gesamtBetragCents, "Vorschau und Import nennen verschiedene Summen")
      .toBe(kopf.gesamtBetragCents);
    expect(posten.length).toBe(vorschau.data.itemCount);
    expect(posten.map((p) => p.betragCents).sort((a, b) => a - b))
      .toEqual((vorschau.data.items as Array<{ betragCents: number }>)
        .map((i) => i.betragCents).sort((a, b) => a - b));
  });
});
