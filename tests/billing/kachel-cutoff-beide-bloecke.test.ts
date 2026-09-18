import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { readBillingPipeline } from "../../server/storage/billing/pipeline-reader";
import { readBillingEconomics } from "../../server/storage/billing/economics-reader";
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
 * Jahr/Monat als eigenes Fenster. `obenGeplantCents` und CB-3 messen ueber den
 * GESAMTEN Monat (der Pipeline-Reader kennt keinen Mitarbeiter-Filter), sind
 * also kontaminationsempfindlich.
 *
 * Geprueft: `grep -rn "2051" tests/` findet nichts ausser diesem Fenster.
 */
const YEAR = 2051;
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
});
