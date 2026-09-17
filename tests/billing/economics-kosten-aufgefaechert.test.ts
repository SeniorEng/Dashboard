/**
 * Ticket 6hWgVqw2C8442hcG — unterer Block der Umsatz-Kachel („was es mich kostet").
 *
 * ── Was hier geprüft wird ────────────────────────────────────────────────
 * Zwei Sammelzeilen sind aufgefächert worden:
 *   - EINE `kilometer`-Zeile über alle drei km-Arten → berechenbare km
 *     (Anfahrt + Kunden-km) UND `kilometer_zeiterfassung` getrennt.
 *   - EINE `gemeinkosten`-Restzeile → sechs `overhead_*`-Zeilen.
 *
 * Es ist eine Änderung der SICHT, kein neuer Rechenweg. Genau das muss der
 * Test belegen: **dieselben Beträge, feiner geschnitten.** Deshalb prüft er
 * durchgehend Summen-Identitäten, nicht Einzelwerte — ein Test, der die
 * Einzelbeträge festschriebe, würde die Fixture messen und nicht die Zusage.
 *
 * ── Warum eine eigene Fixture MIT Zeiterfassungs-km ──────────────────────
 * Die km-Zweiteilung ist nur an einem Monat sichtbar, in dem es überhaupt
 * Zeiterfassungs-km gibt. `tests/economics-effective-rate-drift.test.ts` legt
 * keine an — dort sind alte und neue Fassung zahlengleich, ein Regress bliebe
 * dort unentdeckt. Diese Datei schließt die Lücke.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { readBillingEconomics } from "../../server/storage/billing/economics-reader";
import { uniqueId } from "../test-utils";

/**
 * Eigenes Jahr/Monat-Fenster. Der Reader liest alles im Abrechnungsmonat, also
 * ist das Paar maßgeblich — nicht das Jahr allein (geprüft:
 * `grep -rn "YEAR = 2049" tests/` ist leer).
 */
const YEAR = 2049;
const MONTH = 4;

/** Zeiterfassungs-km: werden dem Kunden NIE berechnet, kosten aber Lohn. */
const TE_KM = 12.5;
/** Overhead-Zeit in zwei verschiedenen Kategorien — die Auffächerung braucht ≥2. */
const BUERO_MIN = 90;
const VERTRIEB_MIN = 45;

let userId = 0;

async function insertTimeEntry(opts: {
  entryType: string;
  minutes: number | null;
  km: number;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO employee_time_entries
      (user_id, entry_type, entry_date, duration_minutes, kilometers, is_full_day)
    VALUES (
      ${userId}, ${opts.entryType}, ${`${YEAR}-${String(MONTH).padStart(2, "0")}-12`},
      ${opts.minutes}, ${opts.km}, false
    )
  `);
}

beforeAll(async () => {
  const tag = uniqueId();
  const u = await db.execute(sql`
    INSERT INTO users (email, password_hash, display_name, vorname, nachname, is_active)
    VALUES (
      ${`kosten-${tag}@example.com`}, 'x', ${`Kosten Fixture ${tag}`},
      'Kosten', ${`Fixture-${tag}`}, true
    )
    RETURNING id
  `);
  userId = Number((u.rows[0] as Record<string, unknown>).id);

  await insertTimeEntry({ entryType: "bueroarbeit", minutes: BUERO_MIN, km: 0 });
  await insertTimeEntry({ entryType: "vertrieb", minutes: VERTRIEB_MIN, km: TE_KM });
});

afterAll(async () => {
  // Über den Benutzer aufräumen, nicht über eine ID-Liste: `sql` expandiert ein
  // Array als Tupel, nicht als Array-Literal — `ANY(...)` liefe auf 42809.
  if (userId) {
    await db.execute(sql`DELETE FROM employee_time_entries WHERE user_id = ${userId}`);
  }
  if (userId) await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
});

const read = () => readBillingEconomics(YEAR, MONTH);

describe("Umsatz-Kachel, unterer Block — Kosten aufgefächert", () => {
  it("KO-1 – die Zusage hält: Σ(Zeilen-Kosten) === Lohnkosten der Kopfzeile", async () => {
    // DIE Invariante des Vertrags. Sie galt für vier Zeilen und muss für zehn
    // genauso gelten — eine Auffächerung, die sie bricht, hätte Geld verloren
    // oder doppelt gezählt.
    const e = await read();
    const summe = e.byService.reduce((s, r) => s + r.costCents, 0);
    expect(summe).toBe(e.totals.laborCostCents);
  });

  it("KO-2 – jede Zeile gehört genau einem Block an", async () => {
    const e = await read();
    expect(e.byService.length).toBeGreaterThan(0);
    for (const r of e.byService) {
      expect(["leistung", "kosten_ohne_umsatz"], `Zeile ${r.key}`).toContain(r.group);
    }
  });

  it("KO-3 – `kosten_ohne_umsatz` heisst genau das: kein Erlös, keine Marge", async () => {
    // Die Eigenschaft, auf der die Darstellung beruht (Gedankenstrich statt
    // „0,00 €" / „0 %"). Stünde hier je ein Erlös, wäre die Zeile im falschen
    // Block — und die Kachel zeigte einen Strich, wo Geld ist.
    const e = await read();
    const ohne = e.byService.filter((r) => r.group === "kosten_ohne_umsatz");
    expect(ohne.length).toBeGreaterThan(0);
    for (const r of ohne) {
      expect(r.revenueCents, `Zeile ${r.key}`).toBe(0);
      // `0 - x` statt `-x`: bei x = 0 liefert die Negation -0, und `toBe`
      // vergleicht mit Object.is, wo -0 !== +0 gilt.
      expect(r.marginCents, `Zeile ${r.key}`).toBe(0 - r.costCents);
    }
  });

  it("KO-4 – die km-Zeile trägt NUR berechenbare km, die Zeiterfassung steht daneben", async () => {
    // Der Kern der km-Zweiteilung. Vorher steckten die 12,5 Zeiterfassungs-km
    // in derselben Zeile wie die Termin-km und verdünnten deren Marge; ihre
    // Kosten standen einem Erlös gegenüber, zu dem sie nichts beigetragen
    // hatten.
    const e = await read();
    const termin = e.byService.find((r) => r.key === "kilometer")!;
    const zeiterfassung = e.byService.find((r) => r.key === "kilometer_zeiterfassung")!;

    expect(termin).toBeDefined();
    expect(zeiterfassung).toBeDefined();
    expect(termin.group).toBe("leistung");
    expect(zeiterfassung.group).toBe("kosten_ohne_umsatz");

    // In diesem Monat gibt es KEINE Termine, also auch keine Termin-km.
    // Die Zeiterfassungs-km dürfen deshalb NICHT in der Termin-Zeile landen.
    expect(termin.quantity, "Zeiterfassungs-km sind in die Termin-Zeile geraten").toBe(0);
    expect(zeiterfassung.quantity).toBeCloseTo(TE_KM, 2);
    expect(zeiterfassung.costCents, "gefahrene km kosten Lohn").toBeGreaterThan(0);
    expect(zeiterfassung.revenueCents, "und werden nie berechnet").toBe(0);
  });

  it("KO-5 – die Marge der km-Zeile ist nicht mehr verdünnt", async () => {
    // Die Folge von KO-4, als eigene Aussage: die Termin-km-Zeile behauptet
    // keine Marge, die sie nicht hat. Ohne Termin-km ist sie schlicht leer —
    // vorher trug sie die Zeiterfassungs-Kosten und wies dafür eine negative
    // Marge aus, die keiner Leistung zuzuordnen war.
    const e = await read();
    const termin = e.byService.find((r) => r.key === "kilometer")!;
    expect(termin.costCents, "fremde km-Kosten in der Leistungs-Zeile").toBe(0);
    expect(termin.marginCents).toBe(0);
  });

  it("KO-6 – die Overhead-Kategorien stehen EINZELN und benannt", async () => {
    const e = await read();
    const overhead = e.byService.filter((r) => r.key.startsWith("overhead_"));

    // Sechs Kategorien: fünf Zeiterfassungs-Typen + Erstberatung.
    expect(overhead.length).toBe(6);
    expect(overhead.map((r) => r.key)).toContain("overhead_bueroarbeit");
    expect(overhead.map((r) => r.key)).toContain("overhead_vertrieb");
    expect(overhead.map((r) => r.key)).toContain("overhead_erstberatung");

    // Keine Zeile trägt den Rohschlüssel als Beschriftung. `erstberatung` ist
    // der Fall, der das verletzen würde: es ist kein Zeiterfassungs-Typ, also
    // kennt `getEntryTypeLabel` ihn nicht.
    for (const r of overhead) {
      expect(r.label, `Zeile ${r.key} zeigt den Rohschlüssel`).not.toBe(
        r.key.replace("overhead_", ""),
      );
      expect(r.label.length).toBeGreaterThan(0);
    }
  });

  it("KO-7 – die beiden gebuchten Kategorien tragen ihre Kosten getrennt", async () => {
    // Die eigentliche Frage des Blocks: wofür zahle ich, ohne Geld dafür zu
    // bekommen? Eine Sammelzeile konnte sie nicht beantworten.
    const e = await read();
    const buero = e.byService.find((r) => r.key === "overhead_bueroarbeit")!;
    const vertrieb = e.byService.find((r) => r.key === "overhead_vertrieb")!;

    expect(buero.costCents).toBeGreaterThan(0);
    expect(vertrieb.costCents).toBeGreaterThan(0);
    // 90 min Büro gegen 45 min Vertrieb, gleicher Satz ⇒ doppelt so teuer.
    expect(buero.costCents).toBe(vertrieb.costCents * 2);

    // Gegenrichtung: die nicht gebuchten Kategorien bleiben bei 0 — sonst
    // hätte die Auffächerung Kosten irgendwohin verteilt.
    const unbenutzt = e.byService.filter(
      (r) =>
        r.key.startsWith("overhead_") &&
        r.key !== "overhead_bueroarbeit" &&
        r.key !== "overhead_vertrieb",
    );
    expect(unbenutzt.reduce((s, r) => s + r.costCents, 0)).toBe(0);
  });

  it("KO-8 – der Mitarbeiter-Drilldown hat dieselbe Form wie die Gesamt-Sicht", async () => {
    // Beide kommen aus derselben Funktion; driften sie auseinander, zeigt das
    // Aufklappen einer Zeile eine andere Gliederung als die Tabelle darüber.
    const e = await read();
    const emp = e.byEmployee.find((x) => x.employeeId === userId);
    expect(emp, "die Fixture muss als Mitarbeiter-Zeile auftauchen").toBeDefined();
    expect(emp!.services.map((r) => r.key).sort()).toEqual(
      e.byService.map((r) => r.key).sort(),
    );
    expect(emp!.services.reduce((s, r) => s + r.costCents, 0)).toBe(emp!.costCents);
  });
});
