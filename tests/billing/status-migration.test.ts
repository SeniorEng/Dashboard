import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { customers, invoices, auditLog } from "../../shared/schema";
import { uniqueId } from "../test-utils";
import { withGobdMutation } from "../helpers/gobd";
import { migriereStatusModell } from "../../server/scripts/migrate-invoice-status-model";

/**
 * Der Einmal-Lauf, der auf PRODUKTION schreibt.
 *
 * ── Warum es diese Datei gibt ───────────────────────────────────────────
 * Sie ging ohne einen einzigen Test in den Review. Das Ziel-Gate
 * (`--confirm-target`, NODE_ENV, Ablehnung von `cc_test_`-DBs) macht den
 * Schreibpfad von aussen unerreichbar — was richtig ist, aber zur Folge hatte,
 * dass das riskanteste Stück des PRs ungeprüft blieb. Deshalb liegt das Gate
 * im CLI-Pfad und die Migration in einer aufrufbaren Funktion.
 *
 * Geprüft wird, was ein Trockenlauf-Ergebnis nicht zeigen kann: dass der Lauf
 * die richtigen Zeilen trifft, die falschen in Ruhe lässt, seine Annahmen
 * wirklich nachrechnet und ein zweites Mal folgenlos bleibt.
 */

const tag = uniqueId();
let customerId = 0;
const angelegt: number[] = [];

async function rechnung(opts: {
  status: string;
  invoiceType?: string;
  suffix: string;
  paidAt?: Date | null;
  stornierteRechnungId?: number;
  sentAt?: Date | null;
}): Promise<number> {
  const [row] = await db.insert(invoices).values({
    invoiceNumber: `MIG-${opts.suffix}-${tag}`,
    customerId,
    billingType: "selbstzahler",
    invoiceType: (opts.invoiceType ?? "rechnung") as "rechnung" | "stornorechnung" | "nachberechnung",
    billingMonth: 4,
    billingYear: 2026,
    recipientName: "Test",
    grossAmountCents: 12_345,
    netAmountCents: 12_345,
    status: opts.status as "versendet",
    paidAt: opts.paidAt ?? null,
    stornierteRechnungId: opts.stornierteRechnungId ?? null,
    // Kandidaten nach `versendet` tragen in Produktion ausnahmslos ein
    // Versanddatum (Zaehlung: alle 54). Eine Fixture ohne waere unrealistisch —
    // und die Vorpruefung meldet sie zu Recht, weil die Zeile sonst nach der
    // Migration ohne Aging-Anker dastuende.
    sentAt: opts.sentAt !== undefined
      ? opts.sentAt
      : (opts.invoiceType === "stornorechnung" || opts.status === "entwurf" ? null : new Date("2026-04-01")),
  } as any).returning({ id: invoices.id });
  angelegt.push(row.id);
  return row.id;
}

async function statusVon(id: number): Promise<string> {
  const [row] = await db.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, id));
  return row.status;
}

beforeAll(async () => {
  const [c] = await db.insert(customers).values({
    name: `MIG-${tag}`,
    vorname: "Migration",
    nachname: `Test-${tag}`,
    address: "Teststraße 1, 12345 Berlin",
    billingType: "selbstzahler",
    status: "aktiv",
  } as any).returning({ id: customers.id });
  customerId = c.id;
});

afterAll(async () => {
  if (angelegt.length > 0) {
    await withGobdMutation(async (tx) => {
      await tx.delete(invoices).where(inArray(invoices.id, angelegt));
    });
  }
  if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
});

describe("Status-Migration — auditierter Einmal-Lauf", () => {
  it("1 — stellt die drei Abbildungen um und lässt alles andere in Ruhe", async () => {
    const avis = await rechnung({ status: "avis_erhalten", suffix: "AVIS" });
    const teil = await rechnung({ status: "teilweise_bezahlt", suffix: "TEIL" });
    // Ein Storno-Dokument braucht ein storniertes Original — sonst traegt die
    // Begruendung „der Vorgang ist am Original verbucht" nicht, und die
    // Vorpruefung bricht ab. (Das erste Fixture hatte keines und wurde prompt
    // gemeldet; der Check misst also.)
    const original = await rechnung({ status: "storniert", suffix: "ORIGINAL" });
    const storno = await rechnung({
      status: "entwurf", invoiceType: "stornorechnung", suffix: "STORNO",
      stornierteRechnungId: original,
    });
    // Kontrollgruppe — muss unangetastet bleiben. Ohne sie wäre der Test auch
    // dann grün, wenn der Lauf pauschal alles auf `versendet` setzte.
    const versendet = await rechnung({ status: "versendet", suffix: "BLEIBT" });
    const bezahlt = await rechnung({ status: "bezahlt", suffix: "BEZAHLT", paidAt: new Date() });
    const storniert = await rechnung({ status: "storniert", suffix: "STORNIERT" });
    const entwurf = await rechnung({ status: "entwurf", suffix: "ENTWURF" });

    await migriereStatusModell({ apply: true, userId: 1, reason: "Testlauf Status-Migration", still: true });

    expect(await statusVon(avis)).toBe("versendet");
    expect(await statusVon(teil)).toBe("versendet");
    expect(await statusVon(storno)).toBe("abgeschlossen");

    expect(await statusVon(versendet)).toBe("versendet");
    expect(await statusVon(bezahlt)).toBe("bezahlt");
    expect(await statusVon(storniert)).toBe("storniert");
    // Ein normaler Entwurf ist KEIN Storno-Dokument und bleibt Entwurf.
    expect(await statusVon(entwurf)).toBe("entwurf");
  });

  it("1b — ein Storno-Dokument mit Altwert geht nach `abgeschlossen`, NICHT nach `versendet`", async () => {
    // ── Warum dieser Fall existiert ────────────────────────────────────────
    // Die erste Abbildung (`avis_erhalten -> versendet`) trägt einen
    // Typ-Filter, den das Skript ausdrücklich begründet: ohne ihn liefe ein
    // Storno-Dokument mit Altwert nach `versendet` statt nach `abgeschlossen`
    // und widerspräche dem Zielmodell.
    //
    // Ein Mutationslauf hat gezeigt, dass die Begründung unbelegt war: entfernt
    // man den Filter, bleiben alle Fälle grün. Eine Regel, die man folgenlos
    // löschen kann, ist keine.
    const original = await rechnung({ status: "storniert", suffix: "T-ORIG" });
    const storno = await rechnung({
      status: "avis_erhalten", invoiceType: "stornorechnung", suffix: "T-STORNO",
      stornierteRechnungId: original,
    });

    await migriereStatusModell({ apply: true, userId: 1, reason: "Testlauf Typ-Filter", still: true });

    expect(await statusVon(storno)).toBe("abgeschlossen");
  });

  it("2 — schreibt einen Audit-Eintrag je Zeile mit dem Vorher-Wert", async () => {
    const id = await rechnung({ status: "avis_erhalten", suffix: "AUDIT" });

    await migriereStatusModell({ apply: true, userId: 1, reason: "Testlauf Audit-Spur", still: true });

    const spuren = await db.select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(
        eq(auditLog.action, "invoice_status_changed"),
        eq(auditLog.entityType, "invoice"),
        eq(auditLog.entityId, id),
      ));
    expect(spuren).toHaveLength(1);
    const md = spuren[0].metadata as Record<string, unknown>;
    // Der Vorher-Wert ist der ganze Punkt: aus ihm ist der alte Zustand
    // rekonstruierbar. Er ERSETZT die aufgegebene Umkehrbarkeit von map-on-read.
    expect(md.previousStatus).toBe("avis_erhalten");
    expect(md.newStatus).toBe("versendet");
    expect(md.reason).toBe("status_model_migration");
    expect(md.operatorReason).toBe("Testlauf Audit-Spur");
  });

  it("3 — ein zweiter Lauf ist folgenlos (idempotent)", async () => {
    await rechnung({ status: "avis_erhalten", suffix: "IDEM" });
    const erst = await migriereStatusModell({ apply: true, userId: 1, reason: "Erster Testlauf", still: true });
    expect(erst.umgestellt).toBeGreaterThan(0);

    // Trägt der Ablauf: nach dem Publish wird der Lauf WIEDERHOLT, um
    // Nachzügler aus dem Freeze-Fenster zu fangen. Findet er nichts, muss er
    // sauber enden statt etwas anzufassen.
    const zweit = await migriereStatusModell({ apply: true, userId: 1, reason: "Zweiter Testlauf", still: true });
    expect(zweit.umgestellt).toBe(0);
  });

  it("4 — der Trockenlauf schreibt nichts", async () => {
    const id = await rechnung({ status: "avis_erhalten", suffix: "DRY" });
    const ergebnis = await migriereStatusModell({ apply: false, still: true });
    expect(ergebnis.umgestellt).toBe(0);
    expect(await statusVon(id)).toBe("avis_erhalten");
    // Aufräumen, sonst stolpert die Vorprüfung der folgenden Fälle nicht —
    // aber die Zeile bliebe als Altwert liegen.
    await withGobdMutation(async (tx) => {
      await tx.update(invoices).set({ status: "versendet" }).where(eq(invoices.id, id));
    });
  });

  it("4b — der Operator-Pfad (mit Konsolen-Ausgabe) läuft überhaupt durch", async () => {
    // ── Warum dieser Fall existiert ────────────────────────────────────────
    // Alle anderen Fälle rufen mit `still: true` — und damit ausgerechnet den
    // Zweig NICHT, den ein Mensch fährt. Genau dort steckte ein Fehler, der
    // das Skript vollständig funktionslos machte: der Ausgabe-Helfer rief sich
    // selbst auf (`RangeError: Maximum call stack size exceeded`), sodass jeder
    // Trockenlauf und jeder Schreiblauf abbrach, bevor irgendetwas geschah.
    //
    // Sechs grüne Fälle und ein grünes CI haben ihn nicht gesehen. Ein Test,
    // der eine Option immer gleich setzt, prüft die andere Hälfte nie.
    const zeilen: string[] = [];
    const echt = console.log;
    console.log = (...args: unknown[]) => { zeilen.push(args.join(" ")); };
    try {
      const ergebnis = await migriereStatusModell({ apply: false });
      expect(ergebnis.umgestellt).toBe(0);
    } finally {
      console.log = echt;
    }

    // Und der Bericht muss auch etwas sagen — sonst wäre der Fall auch mit
    // einem stummen `log` grün.
    expect(zeilen.join("\n")).toMatch(/Vorpruefung/);
    expect(zeilen.join("\n")).toMatch(/Trockenlauf beendet/);
  });

  it("5 — die Vorprüfung bricht ab, wenn `abgeschlossen` auf einer normalen Rechnung steht", async () => {
    // Die einzige Status×Typ-Kombination, bei der `assignInvoiceStage` nach dem
    // Deploy wirft — und damit die ganze Rechnungsliste auf 500 legt. Vor der
    // Korrektur prüfte der Lauf genau diesen Fall NICHT: er stand als
    // bekannter Status in der Liste und lief stumm durch.
    const kaputt = await rechnung({ status: "abgeschlossen", suffix: "KAPUTT" });

    await expect(
      migriereStatusModell({ apply: true, userId: 1, reason: "Darf nicht laufen", still: true }),
    ).rejects.toThrow(/abgeschlossen/);

    await withGobdMutation(async (tx) => {
      await tx.update(invoices).set({ status: "storniert" }).where(eq(invoices.id, kaputt));
    });
  });

  it("7 — die gemeldete Zahl ist die GESCHRIEBENE, nicht die geplante", async () => {
    // Das Abnahmeprotokoll dieses Laufs ist ein GoBD-Nachweisstück. Der erste
    // Entwurf gab `ids.length` zurück — also die Planmenge — und hätte damit
    // Zeilen gemeldet, die nie geschrieben wurden.
    const a = await rechnung({ status: "avis_erhalten", suffix: "ZAHL1" });
    const b = await rechnung({ status: "avis_erhalten", suffix: "ZAHL2" });

    const ergebnis = await migriereStatusModell({ apply: true, userId: 1, reason: "Testlauf Zaehlung", still: true });
    expect(ergebnis.umgestellt).toBe(2);
    expect(await statusVon(a)).toBe("versendet");
    expect(await statusVon(b)).toBe("versendet");
  });

  it("6 — die Vorprüfung bricht ab, wenn ein Migrationskandidat ein Zahlungsdatum trägt", async () => {
    // Der Fall, den die Zähl-SQL als „ABWEICHUNG, muss überall 0 sein" führt.
    // Würde die Zeile auf `versendet` gehoben, behauptete sie „wartet auf
    // Zahlung" und trüge zugleich ein Zahlungsdatum — daraus entstehen
    // Doppelzuordnungen.
    const id = await rechnung({ status: "avis_erhalten", suffix: "PAID", paidAt: new Date() });

    await expect(
      migriereStatusModell({ apply: true, userId: 1, reason: "Darf nicht laufen", still: true }),
    ).rejects.toThrow(/paid_at/);

    await withGobdMutation(async (tx) => {
      await tx.update(invoices).set({ status: "bezahlt" }).where(eq(invoices.id, id));
    });
  });
});
