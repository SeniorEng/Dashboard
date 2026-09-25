import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  budgetAllocations, budgetTransactions, customerBudgetTypeSettings, customerCareLevelHistory,
} from "@shared/schema";
import { createTestCustomer, cleanupCustomer, getAuthCookie } from "../test-utils";
import { readUnifiedBudgetAvailability } from "../../server/storage/budget/unified-reader";

/**
 * Abnahmefälle E1–E4 aus Alriks eigenen Tabellen (Schritt E des Standards
 * `6hcQPmcrvfj5ghfp` — echte Fälle mit Euro-Erwartung, VOR dem Code).
 *
 * ── Warum diese Datei getrennt von `KL-*` steht ─────────────────────────
 * `KL-1`…`KL-5` prüfen die **Regel**: wann greift die Verdrängung, wann nicht.
 * Hier stehen **Fälle**: konkrete Beträge, die Alrik von Hand gerechnet hat.
 * Ein Regel-Test kann grün sein, während die Zahl, die der Anwender sieht,
 * falsch ist — deshalb beides.
 *
 * ── Die gemeinsame Lage ─────────────────────────────────────────────────
 * §45b, Monatsrate 131,00 €, Übertrag verfällt 30.06. Verbrauch in allen
 * Fällen identisch, damit die Fälle sich nur in einer Größe unterscheiden:
 *
 *     Jan 145,00 · Feb 275,60 · Mär 145,80 · Apr 155,00 · Mai 280,00
 *
 * „Verfügbar zum Monatsende" heißt: Anspruch bis zu diesem Tag minus der bis
 * dahin gebuchte Verbrauch — dieselbe Größe, die die Kundenkarte zeigt.
 *
 * ── E5 fehlt bewusst ────────────────────────────────────────────────────
 * „Stichtag ab Juli → nur laufendes Jahr, kein Übertragsfeld" ist eine Aussage
 * über das FORMULAR. Er wird Abnahmekriterium des Formular-PRs; ihn hier als
 * Validierungs-Test vorzuziehen würde weniger zusichern, als sein Name
 * verspricht.
 */

const J = 2026;
const RATE = 131_00;
const KLAMMER = 80_001;

const VERBRAUCH: Array<[string, number]> = [
  [`${J}-01-15`, 145_00],
  [`${J}-02-15`, 275_60],
  [`${J}-03-15`, 145_80],
  [`${J}-04-15`, 155_00],
  [`${J}-05-15`, 280_00],
];

async function kunde(): Promise<number> {
  await getAuthCookie();
  const id = (await createTestCustomer({
    pflegegrad: 3, billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: false,
  })).id as number;
  await db.delete(customerCareLevelHistory).where(eq(customerCareLevelHistory.customerId, id));
  await db.insert(customerCareLevelHistory).values({
    customerId: id, pflegegrad: 3, validFrom: `${J - 2}-01-01`, validTo: null,
  });
  await db.insert(customerBudgetTypeSettings).values({
    customerId: id, budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1,
    monthlyLimitCents: null, yearlyLimitCents: null, validFrom: `${J}-01-01`, validTo: null,
  });
  return id;
}

/** Der automatisch angenommene Übertrag — ohne Klammer, kein Vorgang. */
async function uebertrag(id: number, cents: number): Promise<void> {
  await db.insert(budgetAllocations).values({
    customerId: id, budgetType: "entlastungsbetrag_45b", year: J, month: null,
    amountCents: cents, source: "carryover",
    validFrom: `${J}-01-01`, expiresAt: `${J}-06-30`, notes: "E-uebertrag-automatisch",
  });
}

async function verbrauchBuchen(id: number, bis?: string): Promise<void> {
  const zeilen = VERBRAUCH.filter(([d]) => bis == null || d <= bis);
  await db.insert(budgetTransactions).values(zeilen.map(([d, a]) => ({
    customerId: id, budgetType: "entlastungsbetrag_45b", transactionType: "consumption",
    amountCents: -a, transactionDate: d, allocationId: null, description: "E-verbrauch",
  })) as never);
}

/**
 * `verdraengt` schaltet die Verdrängung ein.
 *
 * Sie hängt weiter am Flag `RESET_DISPLACES_ALL_SOURCES_DEFAULT`, das auf
 * `main` `false` ist. `E1`/`E2` brauchen es nicht (keine Kassenauskunft),
 * `E3`/`E4` schon — ohne das Flag tut der Vorgang nichts, und dann wäre das
 * Formular wirkungslos.
 *
 * Das ist ein offener Punkt und keine Nebensache: **wann der Default umgelegt
 * wird, ist nicht Teil dieses Tests.** Er wird hier ausdrücklich übergeben,
 * damit sichtbar bleibt, dass die Zusage am Flag hängt.
 */
async function verfuegbar(
  id: number, stichtag: string, verdraengt = false,
): Promise<number> {
  const uni = await readUnifiedBudgetAvailability(
    id, stichtag, undefined,
    verdraengt ? { resetDisplacesAllSources: true } : undefined,
  );
  const t = uni.pots.entlastungsbetrag_45b;
  return t.allocatedCents - t.consumedNetCents;
}

describe("§45b — Abnahmefälle E1–E4 (Alriks Tabellen)", () => {
  it("E1 – Standard ohne Kassenauskunft: 486,00 / 341,40 / 326,60 / 302,60 / 153,60", async () => {
    /**
     * Übertrag 500,00 €, keine Auskunft. Alriks eigene Tabelle hatte im März
     * 314 — ein Rechenfehler; richtig ist **326,60 €** (von ihm bestätigt).
     * Hier steht die richtige Zahl.
     *
     * Rechenweg Monatsende:
     *   Jan  500 + 131 − 145,00                      = 486,00
     *   Feb  500 + 262 − 420,60                      = 341,40
     *   Mär  500 + 393 − 566,40                      = 326,60
     *   Apr  500 + 524 − 721,40                      = 302,60
     *   Mai  500 + 655 − 1.001,40                    = 153,60
     */
    const id = await kunde();
    try {
      await uebertrag(id, 500_00);
      await verbrauchBuchen(id);

      const soll: Array<[string, number]> = [
        [`${J}-01-31`, 486_00],
        [`${J}-02-28`, 341_40],
        [`${J}-03-31`, 326_60],
        [`${J}-04-30`, 302_60],
        [`${J}-05-31`, 153_60],
      ];
      for (const [datum, erwartet] of soll) {
        expect(
          await verfuegbar(id, datum),
          `verfügbar zum ${datum} weicht ab`,
        ).toBe(erwartet);
      }
    } finally {
      await cleanupCustomer(id);
    }
  }, 180_000);

  it("E2 – Übertrag in Wahrheit nur 180,00 €: der Topf läuft im April ins Minus", async () => {
    /**
     * Derselbe Verbrauch, aber der automatisch angenommene Übertrag ist zu
     * hoch. Alriks Tabelle: 166,00 / 21,40 / 6,60 / **−17,40**.
     *
     * Die negative Zahl ist der Punkt: sie zeigt, dass der Bestand nicht
     * gereicht hat. **Der Test sichert sie als LESEWERT**, nicht als erlaubte
     * Buchung — dass eine April-Buchung am harten Stopp scheitern bzw. in die
     * Kaskade gehen muss, ist eine Aussage über den BUCHUNGS-Pfad und gehört
     * nicht hierher. Sie steht als offener Punkt im Ticket.
     *
     * Hier wird bewusst nur gemessen, was der Leser zeigt — sonst behauptet
     * der Test etwas über eine Schicht, die er nicht anfasst.
     */
    const id = await kunde();
    try {
      await uebertrag(id, 180_00);
      await verbrauchBuchen(id);

      const soll: Array<[string, number]> = [
        [`${J}-01-31`, 166_00],
        [`${J}-02-28`, 21_40],
        [`${J}-03-31`, 6_60],
        [`${J}-04-30`, -17_40],
      ];
      for (const [datum, erwartet] of soll) {
        expect(
          await verfuegbar(id, datum),
          `verfügbar zum ${datum} weicht ab`,
        ).toBe(erwartet);
      }
    } finally {
      await cleanupCustomer(id);
    }
  }, 180_000);

  it("E3 – Kassenauskunft im März: ab März stimmt der Stand, Jan/Feb bleiben unberührt", async () => {
    /**
     * Wie E2, aber im März kommt die Auskunft: **Übertrag 0,00 €** („aus dem
     * Vorjahr ist nichts mehr übrig") und **laufendes Jahr = der gemeldete
     * Rest**.
     *
     * Nach R4 (Alrik, 24.09.2026): der für Monat M eingetragene Betrag ist
     * das, was für M **und danach** zur Verfügung steht; alle Buchungen ab dem
     * 1. von M werden davon abgezogen, alles davor ist ersetzt.
     *
     * Gemeldet wird hier `6,60 €` — genau der Stand, den E2 zum 31.03. zeigt.
     * Das ist die realistische Auskunft: die Kasse bestätigt, was das System
     * ohnehin rechnet.
     *
     * Erwartung zum 31.03.: 6,60 (gemeldet) − 145,80 (März-Buchung, liegt im
     * Stichtagsmonat und zählt) = **−139,20**.
     *
     * **Jan/Feb werden NICHT umgebucht.** Beide liegen vor dem Stichtag und
     * sind ersetzt — der Test prüft das über den Februar-Stichtag, der
     * unverändert die E2-Zahl zeigt.
     */
    const id = await kunde();
    try {
      await uebertrag(id, 180_00);
      await verbrauchBuchen(id);

      // Der Vorgang: beide Zeilen, beide mit derselben Klammer.
      await db.insert(budgetAllocations).values([
        {
          customerId: id, budgetType: "entlastungsbetrag_45b", year: J, month: 3,
          amountCents: 6_60, source: "initial_balance",
          kassenauskunftId: KLAMMER,
          validFrom: `${J}-03-01`, expiresAt: null, notes: "E3-laufendes-jahr",
        },
        {
          customerId: id, budgetType: "entlastungsbetrag_45b", year: J, month: null,
          amountCents: 0, source: "carryover",
          kassenauskunftId: KLAMMER,
          validFrom: `${J}-03-01`, expiresAt: `${J}-06-30`, notes: "E3-uebertrag-aufgebraucht",
        },
      ]);

      expect(
        await verfuegbar(id, `${J}-02-28`, true),
        "der Februar-Stand hat sich geändert — Jan/Feb wurden umgebucht",
      ).toBe(21_40);

      expect(
        await verfuegbar(id, `${J}-03-31`, true),
        "der gemeldete Stand ab März stimmt nicht",
      ).toBe(6_60 - 145_80);
    } finally {
      await cleanupCustomer(id);
    }
  }, 180_000);

  it("E4 – Funke: Kürzung im Juni, Übertrag 0, laufend 184,60", async () => {
    /**
     * Der Fall, der den ganzen Vorgang ausgelöst hat (Kunde 89). Die Kasse
     * kürzt eine Juni-Rechnung; damit ist klar, dass für diesen Monat weder
     * Übertrag noch laufendes Budget gereicht haben. Die Baseline wird per
     * Kassenauskunft neu gesetzt: **Übertrag 0, laufendes Jahr 184,60 €**.
     *
     * Erwartung: verfügbar im Juni = 184,60 minus der Juni-Buchungen. Hier
     * eine Buchung über 77,40 € (der real bezahlte Betrag aus dem Fall) →
     * **107,20 €**.
     *
     * Der ursprüngliche Übertrag von 1.179,00 € ist ersetzt und zählt nicht
     * mehr mit — genau das, was vorher fehlte und die Rechnung über 194,20 €
     * durchlaufen ließ.
     */
    const id = await kunde();
    try {
      await uebertrag(id, 1_179_00);
      await db.insert(budgetTransactions).values({
        customerId: id, budgetType: "entlastungsbetrag_45b", transactionType: "consumption",
        amountCents: -77_40, transactionDate: `${J}-06-10`, allocationId: null,
        description: "E4-juni-bezahlt",
      } as never);

      await db.insert(budgetAllocations).values([
        {
          customerId: id, budgetType: "entlastungsbetrag_45b", year: J, month: 6,
          amountCents: 184_60, source: "initial_balance",
          kassenauskunftId: KLAMMER,
          validFrom: `${J}-06-01`, expiresAt: null, notes: "E4-laufendes-jahr",
        },
        {
          customerId: id, budgetType: "entlastungsbetrag_45b", year: J, month: null,
          amountCents: 0, source: "carryover",
          kassenauskunftId: KLAMMER,
          validFrom: `${J}-06-01`, expiresAt: `${J}-06-30`, notes: "E4-uebertrag-aufgebraucht",
        },
      ]);

      expect(
        await verfuegbar(id, `${J}-06-30`, true),
        "der Juni-Topf zeigt nicht 184,60 minus der Juni-Buchung — der ersetzte "
        + "Übertrag von 1.179,00 € zählt noch mit",
      ).toBe(184_60 - 77_40);
    } finally {
      await cleanupCustomer(id);
    }
  }, 180_000);
});
