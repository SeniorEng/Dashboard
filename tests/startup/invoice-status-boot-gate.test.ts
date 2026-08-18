import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { customers, invoices } from "@shared/schema";
import { uniqueId } from "../test-utils";
import { withGobdMutation } from "../helpers/gobd";
import {
  runInvoiceStatusBootGate,
  InvoiceStatusDomainError,
} from "../../server/startup/assert-invoice-status-domain";

/**
 * Die DATENBANK-Hälfte des Rechnungs-Status-Boot-Gates (6hHqw8c7).
 *
 * ── Was hier NICHT mehr steht ───────────────────────────────────────────
 * Die Entscheidungsfälle (welcher Wert bricht ab, wie sieht die Meldung aus,
 * leerer Bestand) liegen in `tests/unit/invoice-status-boot-gate.test.ts` und
 * laufen dort ohne Datenbank.
 *
 * Grund: die erste Fassung prüfte alles hier — und der Fall „leerer Bestand"
 * zählte die GANZE `invoices`-Tabelle. In CI teilen sich die Dateien eines
 * Shard-Legs eine Datenbank ohne Truncate; über 100 Rechnungen aus
 * `tests/billing/` liefen davor. Der Test war eine Wette auf die
 * Shard-Verteilung, keine Zusicherung.
 *
 * Übrig bleibt genau das, was ohne echte Datenbank nicht prüfbar ist: dass die
 * Abfrage die erwartete Form liefert und der Treiber sie so zurückgibt, wie das
 * Gate sie liest. Beide Fälle arbeiten NUR mit eigenen Zeilen und stellen keine
 * Annahme über den restlichen Bestand.
 */

const tag = uniqueId();
let customerId = 0;
const angelegt: number[] = [];

async function rechnungMitStatus(status: string, suffix: string): Promise<number> {
  const [row] = await db.insert(invoices).values({
    invoiceNumber: `GATE-${suffix}-${tag}`,
    customerId,
    billingType: "selbstzahler",
    invoiceType: "rechnung",
    billingMonth: 4,
    billingYear: 2026,
    recipientName: "Test",
    grossAmountCents: 1000,
    netAmountCents: 1000,
    // Bewusst am Typ vorbei: die Spalte ist `text`, und genau darum geht es —
    // die Datenbank kann Werte tragen, die der Code nicht kennt.
    status: status as never,
  }).returning({ id: invoices.id });
  angelegt.push(row.id);
  return row.id;
}

async function entferne(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await withGobdMutation(async (tx) => {
    await tx.delete(invoices).where(inArray(invoices.id, ids));
  });
}

beforeAll(async () => {
  const [c] = await db.insert(customers).values({
    name: `GATE-${tag}`,
    vorname: "Boot",
    nachname: `Gate-${tag}`,
    address: "Teststraße 1, 12345 Berlin",
    billingType: "selbstzahler",
    status: "aktiv",
  } as never).returning({ id: customers.id });
  customerId = c.id;
});

afterAll(async () => {
  await entferne(angelegt.splice(0));
  if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
});

describe("Rechnungs-Status-Boot-Gate — Datenbank-Verdrahtung (6hHqw8c7)", () => {
  it("liest Statuswerte und Anzahlen wirklich aus der Tabelle", async () => {
    // Der Fall, der ohne DB nicht geht: Feldnamen (`status`/`anzahl`), die
    // `.rows`-Form des Treibers und das `::int`-Parsing. Ein giftiger Wert
    // MUSS hier ankommen — mit genau der Anzahl, die eingefuegt wurde.
    const ids = [
      await rechnungMitStatus("avis_erhalten", "WIRE1"),
      await rechnungMitStatus("avis_erhalten", "WIRE2"),
    ];
    try {
      await runInvoiceStatusBootGate();
      throw new Error("Das Gate haette abbrechen muessen.");
    } catch (err) {
      expect(err).toBeInstanceOf(InvoiceStatusDomainError);
      const nachricht = (err as Error).message;
      expect(nachricht).toContain("avis_erhalten");
      // Mindestens die eigenen zwei. Bewusst `>=` statt `=`: Fremddaten
      // derselben Leg-DB duerfen den Fall nicht kippen — geprueft wird die
      // Verdrahtung, nicht der Gesamtbestand.
      const treffer = nachricht.match(/(\d+) Zeile/);
      expect(treffer, "Anzahl fehlt in der Meldung").not.toBeNull();
      expect(Number(treffer![1])).toBeGreaterThanOrEqual(2);
    } finally {
      await entferne(ids);
    }
  });

  it("sauberer eigener Bestand laesst das Gate durchlaufen", async () => {
    // Gegenprobe zur Verdrahtung: mit ausschliesslich gueltigen eigenen Zeilen
    // darf das Gate nicht werfen. Auch hier KEINE Annahme ueber Fremddaten —
    // scheitert es, liegt bereits etwas Giftiges in der Leg-DB, und das waere
    // ein eigener Befund.
    const ids = [
      await rechnungMitStatus("versendet", "CLEAN1"),
      await rechnungMitStatus("bezahlt", "CLEAN2"),
    ];
    try {
      await expect(runInvoiceStatusBootGate()).resolves.toBeUndefined();
    } finally {
      await entferne(ids);
    }
  });
});
