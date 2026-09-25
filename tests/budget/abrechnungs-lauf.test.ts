import { describe, expect, it, vi } from "vitest";
import { db } from "../../server/lib/db";
import { appointments, budgetTransactions } from "@shared/schema";
import { createTestCustomer, cleanupCustomer, getAuthCookie } from "../test-utils";
import { fensterSchluessel } from "../../server/storage/budget/abrechnungs-lauf";

/**
 * Die Fenster-Regel der kumulierten Vorschau (Tabelle D, Alrik 25.09.2026).
 *
 * Gate 2 zu #193, S-5: `fensterSchluessel` hatte keinen eigenen Test, und §45a
 * mit Monatsgrenze war nirgends geprüft. NB-1 läuft über einen einzigen Monat
 * und nur über §45b — dort wäre ein falsches §45a-Fenster unsichtbar.
 */

// Die Verfügbarkeit ist hier EINGABE, nicht Prüfgegenstand: geprüft wird,
// wie die Vorschau Beanspruchungen im Lauf gegeneinander aufrechnet. Deshalb
// liefert der Reader feste Kapazitäten — §45a 50,00 € je Aufruf, die übrigen
// Kassen-Töpfe leer. Die Zeilen im Ledger (Kosten, Netto-Null) sind echt.
vi.mock("../../server/storage/budget/unified-reader", async (orig) => {
  const echt = await orig<typeof import("../../server/storage/budget/unified-reader")>();
  const topf = (availableCents: number) => ({
    enabled: true, inRange: true, allocatedCents: availableCents, consumedNetCents: 0,
    holdsActiveCents: 0, capRemainingCents: Infinity, availableCents,
  });
  return {
    ...echt,
    readUnifiedBudgetAvailability: vi.fn(async (customerId: number, asOfDate: string) => ({
      customerId, asOfDate,
      pots: {
        entlastungsbetrag_45b: { budgetType: "entlastungsbetrag_45b", ...topf(0) },
        umwandlung_45a: { budgetType: "umwandlung_45a", ...topf(50_00) },
        ersatzpflege_39_42a: { budgetType: "ersatzpflege_39_42a", ...topf(0) },
      },
      total45b: 0, total45a: 50_00, total39_42a: 0, totalCents: 50_00, totalHoldsCents: 0,
    })),
  };
});

describe("Abrechnungs-Lauf — Fenster je Topf", () => {
  it("AL-1 – §45b teilt den ganzen Lauf, §45a nur den Kalendermonat, §39 das Jahr", () => {
    expect(fensterSchluessel("entlastungsbetrag_45b", "2026-06-03"))
      .toBe(fensterSchluessel("entlastungsbetrag_45b", "2026-11-20"));
    expect(fensterSchluessel("umwandlung_45a", "2026-06-03"))
      .toBe(fensterSchluessel("umwandlung_45a", "2026-06-30"));
    expect(fensterSchluessel("umwandlung_45a", "2026-06-30"))
      .not.toBe(fensterSchluessel("umwandlung_45a", "2026-07-01"));
    expect(fensterSchluessel("ersatzpflege_39_42a", "2026-01-02"))
      .toBe(fensterSchluessel("ersatzpflege_39_42a", "2026-12-31"));
    expect(fensterSchluessel("ersatzpflege_39_42a", "2026-12-31"))
      .not.toBe(fensterSchluessel("ersatzpflege_39_42a", "2027-01-01"));
  });

  it("AL-2 – ein unbekannter Topf wirft, statt still pro Tag zu kumulieren", () => {
    // Notiz aus Gate 2 zu #193: der frühere Default bildete einen Schlüssel
    // pro TAG. Ein neuer Topf wäre damit still als „jeder Tag ein eigenes
    // Budget" behandelt worden — eine fachliche Entscheidung, die niemand
    // getroffen hat.
    expect(() => fensterSchluessel("neuer_topf", "2026-06-03")).toThrow();
  });

  it("AL-3 – §45a in der Vorschau: im selben Monat kumuliert, über die Monatsgrenze nicht", async () => {
    /**
     * Drei netto-null belegte Termine (gebucht und storniert), je 40,00 €.
     * §45a hat 50,00 € je Monat.
     *
     *   03.06.  40,00 → §45a 40,00                       (Juni: 40 beansprucht)
     *   10.06.  40,00 → §45a 10,00 + privat 30,00        (Juni: 50 beansprucht)
     *   08.07.  40,00 → §45a 40,00                       (Juli: frisch)
     *
     * Mit dem §45b-Fenster („ganzer Lauf") bekäme der Juli-Termin nichts mehr
     * aus §45a — genau die Verwechslung, die dieser Test ausschließt.
     */
    const { getBudgetSplitForAppointments } = await import("../../server/services/invoice-data");
    await getAuthCookie();
    const id = (await createTestCustomer({
      pflegegrad: 3, billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: true,
    })).id as number;
    try {
      const termine: Record<string, number> = {};
      for (const [datum, zeit] of [["2026-06-03", "09:00"], ["2026-06-10", "09:00"], ["2026-07-08", "09:00"]] as const) {
        const [t] = await db.insert(appointments).values({
          customerId: id, date: datum, scheduledStart: zeit, durationPromised: 60,
          status: "completed", signatureData: "data:image/png;base64,AAA",
          appointmentType: "Betreuung",
        } as never).returning({ id: appointments.id });
        termine[datum] = t.id;
        const [v] = await db.insert(budgetTransactions).values({
          customerId: id, budgetType: "umwandlung_45a", transactionType: "consumption",
          amountCents: -40_00, transactionDate: datum, appointmentId: t.id,
          description: `AL3-${datum}`,
        } as never).returning({ id: budgetTransactions.id });
        await db.insert(budgetTransactions).values({
          customerId: id, budgetType: "umwandlung_45a", transactionType: "reversal",
          amountCents: 40_00, transactionDate: datum, appointmentId: t.id,
          reversedTransactionId: v.id, description: `AL3-storno-${datum}`,
        } as never);
      }

      const split = await getBudgetSplitForAppointments(id, Object.values(termine));
      const anteil = (datum: string) => split.get(termine[datum])?.cents ?? {};

      expect(anteil("2026-06-03"), "03.06.").toEqual({ umwandlung_45a: 40_00 });
      expect(anteil("2026-06-10"), "10.06. — im selben Monat kumuliert").toEqual({ umwandlung_45a: 10_00, private: 30_00 });
      expect(
        anteil("2026-07-08"),
        "08.07. — der Juli-Termin erbt die Juni-Beanspruchung (falsches Fenster)",
      ).toEqual({ umwandlung_45a: 40_00 });
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);
});
