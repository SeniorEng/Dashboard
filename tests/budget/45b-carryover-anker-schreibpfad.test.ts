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

/**
 * §45b-Übertrags-Anlage: der Anker kommt aus DERSELBEN Kette wie der Lesepfad.
 *
 * ── Der Defekt ───────────────────────────────────────────────────────────
 * `ensureYearlyCarryover45b` trug die Anker-Frage („ab wann läuft der
 * Anspruch?") ein zweites Mal, inline, und wich vom Lesepfad ab. Alle
 * Abweichungen zogen in dieselbe Richtung: der Schreibpfad ankerte SPÄTER,
 * rollte deshalb Jahre nicht, die der Lesepfad zählt — und ohne Übertrag bleibt
 * die Monatsaufstockung des Quelljahres im Topf stehen, statt zum 30.06. zu
 * verfallen. Verfügbarkeit zu hoch, in der permissiven Richtung.
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
