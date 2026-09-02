import { describe, it, expect } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  budgetAllocations, customerBudgetTypeSettings, customerCareLevelHistory,
} from "@shared/schema";
import { createTestCustomer, cleanupCustomer } from "../test-utils";
import {
  syncCarryoverAndExpiry, calculateAllocatedCents,
} from "../../server/storage/budget/allocation-storage";
import { resolve45bAnchor } from "@shared/domain/budget/anchor-45b";
import { readUnifiedBudgetAvailability } from "../../server/storage/budget/unified-reader";
import { budgetTransactions } from "@shared/schema";

/**
 * §45b-Übertrags-Anlage: der Anker kommt aus DERSELBEN Kette wie der Lesepfad.
 *
 * ── Der Defekt ───────────────────────────────────────────────────────────
 * `ensureYearlyCarryover45b` trug die Anker-Frage („ab wann läuft der
 * Anspruch?") ein zweites Mal, inline, und wich vom Lesepfad ab. Der
 * Schreibpfad ankerte SPÄTER und rollte deshalb Jahre nicht, die der Lesepfad
 * zählt.
 *
 * ── Was das NICHT ist: ein Verfügbarkeits-Fehler ─────────────────────────
 * Eine frühere Fassung dieses Kommentars behauptete „ohne Übertrag bleibt die
 * Monatsaufstockung stehen → Verfügbarkeit zu hoch". GEMESSEN ist das falsch,
 * und AN-4 unten hält es fest: ohne materialisierten Übertrag kappt der
 * Verfalls-Boden (`expiry45bFloorDateFor`) den Topf auf GENAU dasselbe Fenster,
 * das der Übertrag abbildet. Beide Wege sind per Konstruktion gleich groß.
 *
 * Der Fix ist trotzdem richtig, nur aus zwei anderen Gründen: der Verfall wird
 * als `write_off` im Ledger SICHTBAR (GoBD-Nachvollziehbarkeit statt stiller
 * Kappung), und Lese- wie Schreibpfad beantworten die Anker-Frage nicht mehr
 * verschieden.
 *
 * ── Was hier gemessen wird ───────────────────────────────────────────────
 * Die zwei Abweichungen, die den Roll NACHWEISLICH bewegen. Die dritte (das
 * `todayISO()`-Gate) ist entfernt, aber für den Roll nicht isoliert messbar —
 * dazu steht die Begründung im PR, nicht ein Test, der etwas anderes behauptet.
 *
 * Beide Fälle prüfen dasselbe: nach dem Sync existiert ein Übertrag ins
 * Folgejahr, und sein Betrag ist der Jahresanspruch des Quelljahres. Der
 * Anspruch wird aus der Produktion gelesen (`calculateAllocatedCents({ year })`),
 * nicht im Test nachgerechnet.
 */

const curYear = new Date().getFullYear();
const quellJahr = curYear - 1;

async function kunde(): Promise<number> {
  const c = await createTestCustomer({
    pflegegrad: 3,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  const id = c.id as number;
  // Ohne Pflegegrad-Historie: der PG-Anker wird auf den 01.01. des LAUFENDEN
  // Jahres gebodet und könnte deshalb nie ein Quelljahr freigeben — er würde
  // beide Fälle unbeobachtbar machen.
  await db.delete(customerCareLevelHistory).where(eq(customerCareLevelHistory.customerId, id));
  return id;
}

async function settingsPhase(customerId: number, validFrom: string, validTo: string | null): Promise<void> {
  await db.insert(customerBudgetTypeSettings).values({
    customerId, budgetType: "entlastungsbetrag_45b",
    enabled: true, priority: 1,
    monthlyLimitCents: null, yearlyLimitCents: null,
    validFrom, validTo,
  });
}

/** Alle aktiven Übertragszeilen als vergleichbarer Fingerabdruck. */
async function uebertragsZeilen(
  customerId: number,
): Promise<Array<{ year: number; validFrom: string; expiresAt: string | null; amountCents: number }>> {
  const rows = await db.select().from(budgetAllocations).where(and(
    eq(budgetAllocations.customerId, customerId),
    eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
    eq(budgetAllocations.source, "carryover"),
    isNull(budgetAllocations.deletedAt),
  ));
  return rows
    .map(a => ({ year: a.year, validFrom: a.validFrom, expiresAt: a.expiresAt, amountCents: a.amountCents }))
    .sort((a, b) => a.validFrom.localeCompare(b.validFrom) || a.amountCents - b.amountCents);
}

async function gerollterUebertrag(customerId: number): Promise<number> {
  const rows = await db.select().from(budgetAllocations).where(and(
    eq(budgetAllocations.customerId, customerId),
    eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
    eq(budgetAllocations.source, "carryover"),
    eq(budgetAllocations.validFrom, `${curYear}-01-01`),
    isNull(budgetAllocations.deletedAt),
  ));
  return rows.reduce((s, a) => s + a.amountCents, 0);
}

describe("§45b-Übertrags-Anlage — Anker aus der Lesepfad-SSoT", () => {
  it("AN-1 – Stufe 4: ein SOFT-GELÖSCHTER Startwert ankert auch den Schreibpfad", async () => {
    // Task #1262: ein gelöschter Startwert bleibt Beleg dafür, dass §45b
    // eingerichtet war. Der Lesepfad kennt diese Stufe, die inline-Kette des
    // Schreibpfads kannte sie nicht — der Kunde fiel dort auf den
    // `${curYear}-01-01`-Fallback und hatte damit gar kein Quelljahr mehr.
    // Gemessen betrifft das 5 Kunden auf Prod.
    const id = await kunde();
    try {
      await settingsPhase(id, `${quellJahr}-01-01`, null);
      await db.insert(budgetAllocations).values({
        customerId: id, budgetType: "entlastungsbetrag_45b",
        year: quellJahr, month: 1, amountCents: 100_00, source: "initial_balance",
        validFrom: `${quellJahr}-01-01`, expiresAt: null,
        deletedAt: new Date(),           // ← soft-gelöscht: NUR Stufe 4 trägt
        notes: "AN-1 soft-geloeschter Startwert",
      });

      const anspruch = await calculateAllocatedCents(id, "entlastungsbetrag_45b", { year: quellJahr });
      expect(anspruch, "Vorbedingung: ohne Quelljahres-Anspruch misst der Test nichts")
        .toBeGreaterThan(0);

      await syncCarryoverAndExpiry(id);

      expect(
        await gerollterUebertrag(id),
        "Der über Stufe 4 verankerte Anspruch muss in den Folgejahres-Übertrag kondensieren",
      ).toBe(anspruch);

      // Stufe 4 liefert nur ein DATUM, keinen Betrag. Der gelöschte Startwert
      // darf nicht durch die Hintertür zurückkommen: der Roll ist reine
      // Monatsaufstockung (12 × 131 €), die 100,00 € stecken NICHT darin.
      // `sumInitialBalancesForYear` läuft über `existingAllocations`, und die
      // sind `deleted_at IS NULL`-gefiltert — dieser Test hält das fest.
      expect(
        await gerollterUebertrag(id),
        "Ein soft-gelöschter Startwert darf über den Anker nicht wiederbelebt werden",
      ).toBe(12 * 131_00);
    } finally {
      await cleanupCustomer(id);
    }
  });

  it("AN-3 – Idempotenz: ein zweiter Sync legt nichts nach und verschiebt nichts", async () => {
    // `ensureYearlyCarryover45b` SCHREIBT, und es läuft als Seiteneffekt aus
    // Lese- und Buchungspfaden — also oft. Die Anker-Konsolidierung bewegt,
    // WELCHE Jahre gerollt werden; eine Verschiebung zwischen zwei Aufrufen
    // wäre damit ein Doppel-Übertrag statt einer Korrektur.
    //
    // Der Fall ist nicht theoretisch: nach dem ersten Sync existiert eine
    // Übertragszeile, und die ist in `resolve45bAnchor` selbst eine
    // Anker-Quelle (Stufe 3). Der Anker des zweiten Aufrufs kann dadurch ein
    // anderer sein als der des ersten.
    const id = await kunde();
    try {
      await settingsPhase(id, `${quellJahr}-01-01`, null);
      // BEWUSST der Stufe-4-Aufbau (nur ein SOFT-GELÖSCHTER Startwert), nicht
      // ein aktiver: nur so wandert der Anker zwischen den Läufen wirklich.
      // Mit einem aktiven Startwert dominierte Stufe 2 in JEDEM Lauf, die
      // behauptete Drift träte gar nicht auf und der Test bewiese nichts.
      await db.insert(budgetAllocations).values({
        customerId: id, budgetType: "entlastungsbetrag_45b",
        year: quellJahr, month: 1, amountCents: 100_00, source: "initial_balance",
        validFrom: `${quellJahr}-01-01`, expiresAt: null,
        deletedAt: new Date(), notes: "AN-3 Anker (soft-geloescht)",
      });

      const ankerJetzt = async () => {
        const aktive = await db.select().from(budgetAllocations).where(and(
          eq(budgetAllocations.customerId, id),
          eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
          isNull(budgetAllocations.deletedAt),
        ));
        return resolve45bAnchor({
          pgStartIso: null,
          s45bEnabled: true,
          activeAllocations: aktive,
          deletedInitialBalanceValidFroms: [`${quellJahr}-01-01`],
          fallbackYear: curYear,
          floorPgAnchor: (iso: string) => iso,
        });
      };

      const vorher = await ankerJetzt();
      await syncCarryoverAndExpiry(id);
      const nachErstem = await uebertragsZeilen(id);
      expect(nachErstem.length, "Vorbedingung: der erste Sync muss überhaupt rollen").toBeGreaterThan(0);

      // Die Drift ist real und wird hier BELEGT, nicht behauptet: vor dem Sync
      // trägt Stufe 4 den Anker, danach die frisch angelegte Übertragszeile
      // (Stufe 3) — ein anderer Zweig derselben Kette, mit anderem Datum.
      const nachher = await ankerJetzt();
      expect(
        { via: vorher.kind === "anchor" ? vorher.via : vorher.kind },
        "Vorbedingung: vor dem Sync muss Stufe 4 ankern",
      ).toEqual({ via: "deleted_initial_balance" });
      expect(
        { via: nachher.kind === "anchor" ? nachher.via : nachher.kind },
        "Vorbedingung: nach dem Sync muss Stufe 3 ankern — sonst misst der Test keine Drift",
      ).toEqual({ via: "carryover" });

      await syncCarryoverAndExpiry(id);
      await syncCarryoverAndExpiry(id);

      expect(await uebertragsZeilen(id), "Wiederholter Sync darf weder anlegen noch verschieben")
        .toEqual(nachErstem);
    } finally {
      await cleanupCustomer(id);
    }
  });

  it("AN-4 – der Roll ist verfuegbarkeits-NEUTRAL (die Korrektur ist Sichtbarkeit, kein Geld)", async () => {
    // GEGEN DIE EIGENE BEGRÜNDUNG GEMESSEN (Gate-2-Fund S1).
    //
    // Der PR hatte behauptet, ein fehlender Übertrag lasse die Verfügbarkeit zu
    // hoch stehen. Das ist falsch, und dieser Test hält das Gegenteil fest:
    // ohne materialisierten Übertrag kappt der Verfalls-Boden den Topf auf
    // dasselbe Fenster (H1: Vorjahr + laufendes Jahr, ab Juli nur laufendes);
    // mit Übertrag ersetzt dessen Betrag die Aufstockung des Quelljahres.
    //
    // Der Test steht hier, damit der nächste PR im Cluster nicht wieder mit
    // einem Kassen-Risiko argumentiert, das an dieser Stelle nicht existiert —
    // und damit auffällt, falls die Anker-Erweiterung doch einmal Geld bewegt.
    const id = await kunde();
    try {
      await settingsPhase(id, `${quellJahr}-01-01`, null);
      await db.insert(budgetAllocations).values({
        customerId: id, budgetType: "entlastungsbetrag_45b",
        year: quellJahr, month: 1, amountCents: 100_00, source: "initial_balance",
        validFrom: `${quellJahr}-01-01`, expiresAt: null,
        deletedAt: new Date(), notes: "AN-4 Stufe-4-Anker",
      });
      await db.insert(budgetTransactions).values({
        customerId: id, budgetType: "entlastungsbetrag_45b",
        transactionDate: `${quellJahr}-05-15`, transactionType: "consumption",
        amountCents: -400_00, allocationId: null, notes: "AN-4 Verbrauch",
      });

      // Stichtage beiderseits der Frist — dort, wo ein Unterschied auftreten
      // müsste, wenn die Behauptung stimmte.
      const tage = [`${curYear}-02-15`, `${curYear}-06-30`, `${curYear}-07-01`];
      const avail = async () => {
        const out: number[] = [];
        for (const t of tage) {
          out.push((await readUnifiedBudgetAvailability(id, t)).pots.entlastungsbetrag_45b.availableCents);
        }
        return out;
      };

      const vorher = await avail();
      await syncCarryoverAndExpiry(id);
      const nachher = await avail();

      expect(
        (await uebertragsZeilen(id)).length,
        "Vorbedingung: der Sync muss überhaupt rollen, sonst misst der Test nichts",
      ).toBeGreaterThan(0);
      expect(nachher, "Der Roll darf die Verfügbarkeit an keinem Stichtag bewegen").toEqual(vorher);
    } finally {
      await cleanupCustomer(id);
    }
  });

  it("AN-5 – Mehrjahres-Anker: je Quelljahr genau EINE Zeile, ueber drei Laeufe stabil", async () => {
    // Alle übrigen Tests fahren EIN Quelljahr. Bei den auf Prod gemessenen
    // Stufe-4-Kunden ist der Mehrjahres-Fall der wahrscheinliche: der Anker
    // reicht mehrere Jahre zurück, die Schleife legt mehrere Zeilen an — und
    // erst dann kann sich zeigen, ob Dedup und Anker-Drift zusammen tragen.
    const id = await kunde();
    const ankerJahr = curYear - 3;
    try {
      await settingsPhase(id, `${ankerJahr}-01-01`, null);
      await db.insert(budgetAllocations).values({
        customerId: id, budgetType: "entlastungsbetrag_45b",
        year: ankerJahr, month: 1, amountCents: 100_00, source: "initial_balance",
        validFrom: `${ankerJahr}-01-01`, expiresAt: null,
        deletedAt: new Date(), notes: "AN-5 Stufe-4-Anker",
      });

      await syncCarryoverAndExpiry(id);
      const nachErstem = await uebertragsZeilen(id);

      // Ein Zieljahr je Quelljahr, keine Dubletten.
      const zieljahre = nachErstem.map(z => z.validFrom);
      expect(new Set(zieljahre).size, "je Zieljahr höchstens EINE Übertragszeile")
        .toBe(zieljahre.length);
      expect(nachErstem.length, "mehrjähriger Anker muss mehrere Jahre rollen").toBeGreaterThan(1);

      await syncCarryoverAndExpiry(id);
      await syncCarryoverAndExpiry(id);

      expect(await uebertragsZeilen(id), "auch mehrjährig: wiederholter Sync ändert nichts")
        .toEqual(nachErstem);
    } finally {
      await cleanupCustomer(id);
    }
  });

  it("AN-6 – geschlossenes Einrichtungs-Fenster begrenzt die Rolle auch nach HINTEN", async () => {
    // VERHALTENSÄNDERUNG, nicht nur Konsolidierung (Gate-2-Fund S3): die alte
    // Inline-Kette hatte gar keine `validTo`-Kappung und lief stur bis
    // `curYear`. Ein Jahr NACH dem Fensterende wurde gerollt, obwohl es dort
    // keinen Anspruch gibt, der kondensieren könnte.
    //
    // Die Richtung ist restriktiv — genau deshalb steht der Fall als Test da
    // und nicht nur als Kommentar: eine Kappung, die niemand misst, kappt
    // irgendwann zu viel.
    const id = await kunde();
    try {
      // Fenster endet im Quelljahr; der Startwert liegt DANACH.
      await settingsPhase(id, `${curYear - 3}-01-01`, `${curYear - 2}-12-31`);
      await db.insert(budgetAllocations).values({
        customerId: id, budgetType: "entlastungsbetrag_45b",
        year: quellJahr, month: 1, amountCents: 400_00, source: "initial_balance",
        validFrom: `${quellJahr}-01-01`, expiresAt: null,
        notes: "AN-6 Startwert nach Fensterende",
      });

      await syncCarryoverAndExpiry(id);

      expect(
        (await uebertragsZeilen(id)).filter(z => z.validFrom === `${curYear}-01-01`),
        "Ein Jahr nach dem Einrichtungs-Fenster darf nicht mehr gerollt werden",
      ).toEqual([]);
    } finally {
      await cleanupCustomer(id);
    }
  });

  it("AN-2 – Settings-Fenster: die FRÜHESTE Phase zählt, nicht die heute aktive", async () => {
    // Die alte Kette nahm `validFrom` der HEUTE wirksamen Zeile. Bei einer
    // Append-only-Transition ist das die letzte Phase — und alle Jahre davor
    // fielen aus der Rolle. Der Lesepfad nimmt die früheste über ALLE Phasen.
    const id = await kunde();
    try {
      await settingsPhase(id, `${quellJahr}-01-01`, `${quellJahr}-12-31`);
      await settingsPhase(id, `${curYear}-01-01`, null);   // heute wirksam
      await db.insert(budgetAllocations).values({
        customerId: id, budgetType: "entlastungsbetrag_45b",
        year: quellJahr, month: 1, amountCents: 100_00, source: "initial_balance",
        validFrom: `${quellJahr}-01-01`, expiresAt: null,
        notes: "AN-2 Anker",
      });

      const anspruch = await calculateAllocatedCents(id, "entlastungsbetrag_45b", { year: quellJahr });
      expect(anspruch).toBeGreaterThan(0);

      await syncCarryoverAndExpiry(id);

      expect(
        await gerollterUebertrag(id),
        "Ein Phasenwechsel zum Jahreswechsel darf das Quelljahr nicht aus der Rolle werfen",
      ).toBe(anspruch);
    } finally {
      await cleanupCustomer(id);
    }
  });
});
