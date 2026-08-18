import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { customers, invoices } from "@shared/schema";
import { uniqueId } from "../test-utils";
import { withGobdMutation } from "../helpers/gobd";
import {
  runInvoiceStatusBootGate,
  InvoiceStatusDomainError,
} from "../../server/startup/assert-invoice-status-domain";
import { INVOICE_STATUSES, LEGACY_INVOICE_STATUSES } from "@shared/schema/billing";

/**
 * Task 6hHqw8c7 — das Boot-Gate für den Rechnungs-Status.
 *
 * ── Wogegen es steht ────────────────────────────────────────────────────
 * Beim Status-Umbau lief der Publish 28 Minuten VOR der Datenmigration. 54
 * Zeilen trugen danach einen Wert, den der ausgelieferte Code nicht kennt —
 * `parseInvoiceStatus` warf, und der Wurf riss den ganzen Lesepfad mit:
 * Rechnungsliste und Cockpit-Board antworteten mit 500, rund eine Stunde lang.
 *
 * Die Reihenfolge stand vorher in Dokumenten. Das Gate macht sie zur Bedingung.
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
  await entferne(angelegt);
  if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
});

describe("Rechnungs-Status-Boot-Gate (6hHqw8c7)", () => {
  it("sauberer Bestand: jeder gültige Status passiert", async () => {
    // Erschöpfend über die Union — nicht über eine Auswahl. Fiele ein Wert aus
    // `INVOICE_STATUSES` heraus, ohne dass `parseInvoiceStatus` mitzieht, würde
    // das Gate den Boot bei völlig normalen Daten abbrechen. Das wäre schlimmer
    // als der Fehler, den es verhindert.
    const ids: number[] = [];
    for (const status of INVOICE_STATUSES) {
      ids.push(await rechnungMitStatus(status, `OK-${status}`));
    }
    await expect(runInvoiceStatusBootGate()).resolves.toBeUndefined();
    await entferne(ids);
  });

  it("ALTWERT im Bestand: Boot bricht ab, mit Wert und Anzahl in der Meldung", async () => {
    const ids = [
      await rechnungMitStatus("avis_erhalten", "ALT1"),
      await rechnungMitStatus("avis_erhalten", "ALT2"),
    ];
    try {
      await runInvoiceStatusBootGate();
      throw new Error("Das Gate haette abbrechen muessen.");
    } catch (err) {
      expect(err).toBeInstanceOf(InvoiceStatusDomainError);
      const nachricht = (err as Error).message;
      // Handlungsleitend heisst: WELCHER Wert, WIE VIELE Zeilen, und was zu tun ist.
      expect(nachricht, "Wert fehlt").toContain("avis_erhalten");
      expect(nachricht, "Anzahl fehlt").toMatch(/2 Zeile/);
      expect(nachricht, "Altwert-Hinweis fehlt").toContain("ALTWERT");
      expect(nachricht, "Migrations-Hinweis fehlt").toMatch(/Migration/i);
      // Und die Begruendung, warum der Abbruch die bessere Lage ist.
      expect(nachricht).toMatch(/alte Version online/);
    } finally {
      await entferne(ids);
    }
  });

  it("erkennt JEDEN dokumentierten Altwert, nicht nur den haeufigsten", async () => {
    // `teilweise_bezahlt` kam in Prod mit 0 Zeilen vor und waere beim Testen
    // leicht vergessen worden — genau die Sorte Wert, die dann durchrutscht.
    for (const alt of LEGACY_INVOICE_STATUSES) {
      const id = await rechnungMitStatus(alt, `EACH-${alt}`);
      await expect(runInvoiceStatusBootGate(), alt).rejects.toThrow(InvoiceStatusDomainError);
      await entferne([id]);
    }
  });

  it("ein völlig unbekannter Wert bricht ebenfalls ab — ohne Altwert-Hinweis", async () => {
    // Ein Tippfehler oder eine Handkorrektur ist kein Migrations-Fall. Die
    // Meldung darf dann nicht auf eine Migration verweisen, die es nicht gibt.
    const id = await rechnungMitStatus("voellig_unbekannt", "FREMD");
    try {
      await runInvoiceStatusBootGate();
      throw new Error("Das Gate haette abbrechen muessen.");
    } catch (err) {
      expect(err).toBeInstanceOf(InvoiceStatusDomainError);
      const nachricht = (err as Error).message;
      expect(nachricht).toContain("voellig_unbekannt");
      expect(nachricht, "ALTWERT darf hier NICHT stehen").not.toMatch(/ALTWERT/);
    } finally {
      await entferne([id]);
    }
  });

  it("leerer Bestand besteht", async () => {
    // Die Gegenprobe zum Abbruch: das Gate darf nicht einfach immer werfen.
    // Frische Datenbanken (CI, Wegwerf-DB, erster Boot) haben keine Rechnungen.
    await entferne(angelegt.splice(0));
    const [{ anzahl }] = (await db
      .select({ anzahl: sql<number>`count(*)::int` })
      .from(invoices)) as Array<{ anzahl: number }>;
    expect(anzahl, "Vorbedingung: Tabelle muss leer sein").toBe(0);

    await expect(runInvoiceStatusBootGate()).resolves.toBeUndefined();
  });
});
