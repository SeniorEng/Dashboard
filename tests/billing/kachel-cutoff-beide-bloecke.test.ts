import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { readBillingPipeline } from "../../server/storage/billing/pipeline-reader";
import { readBillingEconomics } from "../../server/storage/billing/economics-reader";
import { readBillingTermine } from "../../server/storage/billing/termine-reader";
import { computeCustomerAmounts } from "../../server/services/billing-customer-amounts";
import { computeMonthCloseCutoff } from "@shared/utils/month-close-cutoff";
import { uniqueId, createTestCustomer, cleanupCustomer } from "../test-utils";

/**
 * Ticket 6hWgVqw2C8442hcG — Weg A + Weg B, die gemeinsame Zusage.
 *
 * ── Warum dieser Test BEIDE Reader anfasst ───────────────────────────────
 * Weg B hat den unteren Block der Umsatz-Kachel dem Monats-Cutoff folgen
 * lassen: nach dem Cutoff faellt „Potenzial" auf „Ist". Der obere Block folgte
 * ihm zunaechst NICHT — er zaehlte denselben geplanten Termin unveraendert
 * unter „noch geplant" und in der Schlagzeile „Erwarteter Kontoeingang".
 *
 * **Eine Karte haette damit zwei Dinge ueber dasselbe Geld gesagt** — genau
 * das Problem, gegen das dieses Ticket angetreten ist, nur nach innen
 * gewendet. Alriks Entscheidung (Weg A): beide Bloecke folgen dem Cutoff.
 *
 * Ein Test je Reader haette das nicht festgenagelt. Zwei gruene Einzeltests
 * koennen zwei verschiedene Regeln beschreiben; die Zusage ist, dass es
 * DIESELBE ist. Deshalb misst dieser Test beide Seiten am selben Termin mit
 * demselben Stichtag — und die Gegenprobe faellt, sobald EINER von beiden ihn
 * wieder zaehlt.
 *
 * ── Warum der Stichtag ein Parameter ist ─────────────────────────────────
 * Beide Reader nehmen ihn entgegen. Ohne das waere der Test nur an bestimmten
 * Kalendertagen gruen — und die Zeit zu manipulieren waere der schlechtere
 * Tausch.
 */
/**
 * Jahr/Monat als eigenes Fenster — und zwar in der VERGANGENHEIT.
 *
 * ── Warum das die tragende Eigenschaft ist (Gate-2-Fund zu #152) ─────────
 * Das Fenster lag zuerst in der ZUKUNFT (2051-03). Fuer die zwei Geld-Sichten
 * war das gleichgueltig: sie nehmen einen Stichtag entgegen, CB-1/CB-2 setzen
 * ihn selbst. Fuer die zwei ARBEITSLISTEN war es fatal — die haben keinen
 * Stichtag-Parameter und lesen das implizite Heute. In einem Zukunftsmonat ist
 * „nach dem Cutoff" damit NIE wahr, und CB-6/CB-7 konnten fuer den Regress,
 * den sie im Namen tragen, gar nicht rot werden.
 *
 * Der Reviewer hat das nicht hergeleitet, sondern ausgefuehrt: eine Mutation,
 * die den Termine-Reader dem Cutoff folgen laesst (ueber
 * `computeMonthCloseCutoff(...) < todayBerlinIso()`, also OHNE den kanonischen
 * Aufruf, den ZW-9 sucht), lief mit dem Zukunftsfenster **18/18 gruen**. Die
 * Beschriftung „noch nicht Dokumentiertes bleibt auch nach dem Abschluss
 * stehen" waere zur Falschaussage geworden, ohne dass ein Test es meldet.
 *
 * Mit einem Vergangenheitsfenster ist „heute" unvermeidlich nach dem Cutoff.
 * Dieselbe Mutation laesst CB-6 dann fallen — vom Reviewer gegengeprueft.
 *
 * ── Warum 2017-03 ───────────────────────────────────────────────────────
 * `obenGeplantCents` und CB-3 messen ueber den GESAMTEN Monat (der
 * Pipeline-Reader kennt keinen Mitarbeiter-Filter), sind also
 * kontaminationsempfindlich; in CI teilen sich die Dateien eines Shard-Legs
 * eine DB. Geprueft: `grep -rn "2017-" tests/` findet nichts, und die einzige
 * Erwaehnung von „2017" ueberhaupt ist eine EN16931-URN, kein Datum.
 * 2021 waere NICHT frei gewesen (zwei Statistik-Dateien nutzen es).
 */
const YEAR = 2017;
const MONTH = 3;
const MINUTEN = 60;

let userId = 0;
let customerId = 0;

/** Der Cutoff des Monats und der Tag danach — die beiden Messpunkte. */
const CUTOFF = computeMonthCloseCutoff(YEAR, MONTH);
const NACH_CUTOFF = (() => {
  const [y, m, d] = CUTOFF.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
})();

beforeAll(async () => {
  const tag = uniqueId();
  const u = await db.execute(sql`
    INSERT INTO users (email, password_hash, display_name, vorname, nachname, is_active)
    VALUES (${`cutoff-${tag}@example.com`}, 'x', ${`Cutoff ${tag}`},
            'Cutoff', ${`Test-${tag}`}, true)
    RETURNING id
  `);
  userId = Number((u.rows[0] as Record<string, unknown>).id);

  const kunde = await createTestCustomer({ vorname: "CUTOFF", nachname: `Test_${tag}` });
  customerId = kunde.id as number;

  const svc = await db.execute(sql`
    SELECT id FROM services WHERE code = 'hauswirtschaft' LIMIT 1
  `);
  const serviceId = Number((svc.rows[0] as Record<string, unknown>).id);

  // EIN geplanter Termin. Mehr braucht die Zusage nicht — und weniger Fixture
  // heisst weniger, das den Befund erklaeren koennte.
  const termin = async (status: string, tagImMonat: string) => {
    const r = await db.execute(sql`
      INSERT INTO appointments (
        customer_id, created_by_user_id, assigned_employee_id, performed_by_employee_id,
        appointment_type, date, scheduled_start, scheduled_end, duration_promised,
        status, travel_origin_type, travel_kilometers, travel_minutes, customer_kilometers
      ) VALUES (
        ${customerId}, ${userId}, ${userId},
        ${status === "completed" ? userId : null},
        'Kundentermin', ${`${YEAR}-${String(MONTH).padStart(2, "0")}-${tagImMonat}`},
        '09:00', '10:00', ${MINUTEN}, ${status}, 'home', 0, 0, 0
      ) RETURNING id
    `);
    const apptId = Number((r.rows[0] as Record<string, unknown>).id);
    await db.execute(sql`
      INSERT INTO appointment_services
        (appointment_id, service_id, planned_duration_minutes, actual_duration_minutes)
      VALUES (${apptId}, ${serviceId}, ${MINUTEN},
        ${status === "completed" ? MINUTEN : null})
    `);
  };

  // Der GEPLANTE Termin — die Regel.
  await termin("scheduled", "15");
  // Der DOKUMENTIERTE — die Grenze der Regel. Ohne ihn vergleicht CB-5 nur
  // 0 mit 0 und bliebe auch dann gruen, wenn der Cutoff das Ist mitrisse.
  await termin("completed", "16");
});

afterAll(async () => {
  if (customerId) await cleanupCustomer(customerId);
  if (userId) await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
});

/** Der Betrag des geplanten Termins in der Stufe „noch geplant" (oberer Block). */
async function obenGeplantCents(asOf: string): Promise<number> {
  const b = await readBillingPipeline(YEAR, MONTH, asOf);
  return b.stages.find((s) => s.stage === "offen")!.totalCents;
}

/** Potenzial minus Ist in der Hauswirtschafts-Zeile (unterer Block). */
async function untenNochErwartetCents(asOf: string): Promise<number> {
  const e = await readBillingEconomics(YEAR, MONTH, { employeeId: userId, asOfDate: asOf });
  const hw = e.byService.find((r) => r.key === "hauswirtschaft")!;
  return (hw.potentialRevenueCents ?? 0) - hw.revenueCents;
}

describe("Umsatz-Kachel — beide Bloecke folgen dem Monats-Cutoff (Weg A + B)", () => {
  it("CB-0 – die Fixture steht (Vorbedingung der uebrigen Faelle)", async () => {
    const b = await readBillingPipeline(YEAR, MONTH, CUTOFF);
    const dok = b.stages.find((s) => s.stage === "dokumentiert")!;
    expect(dok.itemCount, "dokumentierter Termin fehlt").toBe(1);
    expect(dok.totalCents).toBeGreaterThan(0);
  });

  it("CB-1 – VOR dem Cutoff zaehlen BEIDE Bloecke den geplanten Termin", async () => {
    // Die Gegenrichtung, ohne die der Test auch dann gruen waere, wenn nie
    // etwas gezaehlt wuerde.
    expect(await obenGeplantCents(CUTOFF), "oberer Block: „noch geplant“ ist leer")
      .toBeGreaterThan(0);
    expect(await untenNochErwartetCents(CUTOFF), "unterer Block: Potenzial === Ist")
      .toBeGreaterThan(0);
  });

  it("CB-2 – NACH dem Cutoff zaehlt ihn KEINER von beiden mehr", async () => {
    // DIE Zusage. Faellt einer der beiden Werte auf 0 und der andere nicht,
    // sagt die Karte zwei Dinge ueber dasselbe Geld.
    const oben = await obenGeplantCents(NACH_CUTOFF);
    const unten = await untenNochErwartetCents(NACH_CUTOFF);

    expect(oben, "oberer Block zaehlt den geplanten Termin nach dem Cutoff weiter").toBe(0);
    expect(unten, "unterer Block zaehlt ihn nach dem Cutoff weiter").toBe(0);
  });

  it("CB-3 – sein Geld verschwindet nicht, es wandert in „Nicht abgerechnet“", async () => {
    // Weg A ist bewusst NICHT als Filter gebaut. Der Termin faellt aus dem
    // erwarteten Umsatz, bleibt aber sichtbar — er ist nicht weg, er kommt nur
    // nicht mehr. Ohne diese Zusage waere die Schlagzeile ehrlich und der
    // Betrag spurlos.
    const vorher = await readBillingPipeline(YEAR, MONTH, CUTOFF);
    const nachher = await readBillingPipeline(YEAR, MONTH, NACH_CUTOFF);

    const geplantVorher = vorher.stages.find((s) => s.stage === "offen")!.totalCents;
    const nichtAbgerechnet = nachher.sides.find((s) => s.state === "nicht_abgerechnet")!;

    expect(nichtAbgerechnet.totalCents, "der Betrag taucht im Verlust-Block auf")
      .toBe(geplantVorher);
    expect(nichtAbgerechnet.itemCount).toBe(1);
  });

  it("CB-4 – die Schlagzeile sinkt um genau diesen Betrag", async () => {
    // „Erwarteter Kontoeingang" ist die Zahl, auf die es Alrik ankommt. Sie
    // MUSS sich um den geplanten Termin verringern — nicht um mehr (dann
    // waere noch etwas anderes herausgefallen) und nicht um weniger.
    const vorher = await readBillingPipeline(YEAR, MONTH, CUTOFF);
    const nachher = await readBillingPipeline(YEAR, MONTH, NACH_CUTOFF);
    const geplant = vorher.stages.find((s) => s.stage === "offen")!.totalCents;

    expect(
      vorher.totals.expectedRevenueTotalCents - nachher.totals.expectedRevenueTotalCents,
    ).toBe(geplant);
  });

  it("CB-5 – ein DOKUMENTIERTER Termin bleibt vom Cutoff unberuehrt", async () => {
    // Die Grenze der Regel, und der teuerste Mutationsfall: faellt sie, verliert
    // die Kachel dokumentierte, abrechnungsreife Arbeit aus dem erwarteten
    // Umsatz.
    //
    // Eine erste Fassung dieses Tests hatte KEINEN dokumentierten Termin in der
    // Fixture — er verglich 0 mit 0 und trug trotzdem die Garantie im Namen.
    // Geprueft wird jetzt die PIPELINE-Seite: der dokumentierte Termin bleibt
    // nach dem Cutoff in seiner Stufe und faellt NICHT in „Nicht abgerechnet".
    // Beide Messpunkte selbst holen — keine Variable, die ein anderer Test
    // fuellen muesste. Eine Reihenfolge-Kopplung waere hier unnoetig.
    const vorCutoff = await readBillingPipeline(YEAR, MONTH, CUTOFF);
    const nachher = await readBillingPipeline(YEAR, MONTH, NACH_CUTOFF);
    const dokVorher = vorCutoff.stages.find((s) => s.stage === "dokumentiert")!;

    const dokumentiert = nachher.stages.find((s) => s.stage === "dokumentiert")!;
    expect(
      dokumentiert.itemCount,
      "der dokumentierte Termin ist aus seiner Stufe gefallen",
    ).toBe(1);
    expect(dokumentiert.totalCents).toBe(dokVorher.totalCents);

    // Und er ist NICHT zusaetzlich im Verlust-Block gelandet: dort steht nur
    // der geplante.
    const nichtAbgerechnet = nachher.sides.find((s) => s.state === "nicht_abgerechnet")!;
    expect(nichtAbgerechnet.itemCount, "der dokumentierte Termin wurde mitgerissen").toBe(1);

    // Gegenrichtung ueber den unteren Block: das Ist ist nach dem Cutoff
    // dasselbe wie davor.
    const vorher = await readBillingEconomics(YEAR, MONTH, {
      employeeId: userId, asOfDate: CUTOFF,
    });
    const danach = await readBillingEconomics(YEAR, MONTH, {
      employeeId: userId, asOfDate: NACH_CUTOFF,
    });
    const hwVor = vorher.byService.find((r) => r.key === "hauswirtschaft")!;
    const hwNach = danach.byService.find((r) => r.key === "hauswirtschaft")!;
    expect(hwNach.revenueCents, "das Ist muss > 0 sein, sonst misst der Test nichts")
      .toBeGreaterThan(0);
    expect(hwNach.revenueCents).toBe(hwVor.revenueCents);
    expect(hwNach.costCents).toBe(hwVor.costCents);
  });

  /**
   * ── S-1 (Alrik, 18.09.2026): die andere Hälfte der Zusage ────────────────
   *
   * Weg A gilt für die zwei KACHEL-Blöcke. Die zwei ARBEITSLISTEN folgen dem
   * Cutoff ausdrücklich NICHT — sonst verschwände die Arbeit eines
   * Mitarbeiters, der ausschließlich geplante Termine hat, aus genau der
   * Ansicht, in der sie noch zu erledigen ist. (Der Auto-Abschluss läuft nur
   * am Cutoff-Tag und nur bei Aktivität; diese Person wird nie abgeschlossen
   * und darf weiter dokumentieren.)
   *
   * Beschriftet ist das über `ZAEHLWEISE` (`art: "arbeitsliste"`). Die
   * Beschriftung ist aber nur so viel wert wie das Verhalten dahinter —
   * deshalb messen CB-6/CB-7 es an DEMSELBEN geplanten Termin, den CB-2 in den
   * Geld-Sichten verschwinden sieht.
   *
   * **Was diese zwei Fälle NICHT zeigen können:** die Listen-Reader nehmen
   * keinen Stichtag entgegen — es gibt für sie kein „vorher/nachher". Dass sie
   * den Cutoff nicht anwenden KÖNNEN, ist deshalb eine Struktur-Aussage und
   * steht als ZW-9 in `tests/unit/billing-zaehlweise.test.ts`. Hier steht die
   * Verhaltens-Hälfte: der Termin ist wirklich da. Beide zusammen tragen die
   * Beschriftung, eine allein nicht.
   */
  it("CB-6 – der geplante Termin steht in der Termine-Liste (Arbeitsliste, kein Cutoff)", async () => {
    const t = await readBillingTermine(YEAR, MONTH, { employeeId: userId });
    const gruppe = t.employees.find((e) => e.employeeId === userId);
    expect(gruppe, "die Mitarbeiter-Gruppe fehlt ganz").toBeDefined();

    const geplante = gruppe!.appointments.filter((a) => a.stage === "offen");
    expect(geplante.length, "der geplante Termin fehlt in der Arbeitsliste").toBe(1);
    expect(gruppe!.countsByStage.offen).toBe(1);

    // Gegenrichtung am selben Datensatz: die Geld-Sicht zählt ihn nach dem
    // Cutoff nicht mehr. Ohne diese Zeile wäre CB-6 auch dann grün, wenn gar
    // kein Cutoff existierte — und die zwei Beschriftungen sagten dasselbe.
    expect(await obenGeplantCents(NACH_CUTOFF), "die Geld-Sicht zählt ihn doch noch")
      .toBe(0);
  });

  it("CB-7 – und er steckt im PLAN-Anteil der Rechnungen-Liste", async () => {
    const betraege = await computeCustomerAmounts([customerId], { year: YEAR, month: MONTH });
    const kunde = betraege.get(customerId);
    expect(kunde, "der Kunde fehlt in den Listen-Beträgen").toBeDefined();

    // `null` hiesse „nicht berechenbar" (fehlender Katalogpreis) — das wäre ein
    // Fixture-Problem und keine Aussage über den Cutoff. Deshalb getrennt
    // geprüft, bevor der Betrag beurteilt wird.
    expect(kunde!.plannedAmountCents, "PLAN-Anteil nicht berechenbar — Fixture prüfen")
      .not.toBeNull();
    expect(
      kunde!.plannedAmountCents!,
      "der geplante Termin ist aus dem PLAN-Anteil der Arbeitsliste gefallen",
    ).toBeGreaterThan(0);
  });
});
