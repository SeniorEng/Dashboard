/**
 * Task #1898 — Erstzuordnung eines Kostenträgers wird auf den Monatsersten
 * normalisiert; ein WECHSEL wird es nicht.
 *
 * Hintergrund: #1893 erzwingt „Kassenwechsel nur zum Monatsersten" hart (400).
 * Die Regel ist für den Wechsel gedacht — ein Abrechnungsmonat soll eindeutig
 * unter genau eine Kasse fallen. Bei der ERSTEN Zuordnung gibt es nichts zu
 * wechseln, und der Wizard schickte `today`. Ein Kunde, der am 14. angelegt
 * wurde, lief damit in den 400: Kundenanlage unmöglich (Prod-Blocker).
 *
 * Dieser Test deckt BEIDE Richtungen ab — die Normalisierung UND ihre Grenze.
 * Ohne die zweite Hälfte wäre nicht unterscheidbar, ob die Änderung nur die
 * Erstzuordnung öffnet oder den Wechsel-Schutz insgesamt aufgeweicht hat.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { apiGet, apiPost, apiPatch, apiDelete, getAuthCookie, uniqueId } from "../test-utils";
import { runInParallel } from "../helpers/race";
import {
  isMonthStartISO,
  INSURANCE_WINDOW_MUST_START_ON_FIRST,
} from "@shared/domain/insurance-period";
import { todayISO } from "@shared/utils/datetime";

let insuranceProviderIds: number[] = [];
const createdCustomerIds: number[] = [];

/** Versichertennummer im geforderten Format: 1 Buchstabe + 9 Ziffern. */
function versNr(prefix: string): string {
  return `${prefix}${String(Math.floor(100000000 + Math.random() * 900000000))}`;
}

/** Ein Tag mitten im Monat — der Fall, der den Prod-Blocker ausgelöst hat. */
function midMonthISO(): string {
  return `${todayISO().slice(0, 7)}-14`;
}

/** Ein Tag mitten in einem Monat, der sicher IN DER ZUKUNFT liegt. */
function futureMidMonthISO(): string {
  const [y, m] = todayISO().split("-").map(Number);
  const monthsAhead = m + 5;
  const year = y + Math.floor((monthsAhead - 1) / 12);
  const month = ((monthsAhead - 1) % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}-15`;
}

beforeAll(async () => {
  await getAuthCookie();
  const provRes = await apiGet<Array<{ id: number }>>("/api/admin/insurance-providers");
  expect(provRes.status).toBe(200);
  expect(provRes.data.length).toBeGreaterThanOrEqual(2);
  insuranceProviderIds = provRes.data.slice(0, 2).map((p) => p.id);
});

afterAll(async () => {
  for (const id of createdCustomerIds) {
    try {
      await apiDelete(`/api/admin/customers/${id}`);
    } catch {
      /* best effort */
    }
  }
});

async function createCustomerWithoutInsurance(): Promise<number> {
  // Bewusst OHNE `insurance`: dieser Test will die Kassen-Zuordnung selbst
  // setzen, nicht die des Anlage-Endpoints.
  const res = await apiPost<{ id: number }>("/api/admin/customers", {
    vorname: "T1898",
    nachname: `Erstzuordnung-${uniqueId()}`,
    geburtsdatum: "1940-01-15",
    strasse: "Teststraße",
    nr: "1",
    plz: "10115",
    stadt: "Berlin",
    pflegegrad: 3,
    pflegegradSeit: "2024-01-01",
    billingType: "pflegekasse_gesetzlich",
  });
  expect(res.status, `Kundenanlage: ${JSON.stringify(res.data)}`).toBe(201);
  createdCustomerIds.push(res.data.id);
  return res.data.id;
}

describe("Task #1898 — Erstzuordnung vs. Kassenwechsel", () => {
  it("Erstzuordnung mitten im Monat wird akzeptiert und auf den 1. normalisiert", async () => {
    const customerId = await createCustomerWithoutInsurance();
    const requested = midMonthISO();

    const res = await apiPost<{ id: number; validFrom: string }>(
      `/api/admin/customers/${customerId}/insurance`,
      {
        insuranceProviderId: insuranceProviderIds[0],
        versichertennummer: versNr("A"),
        validFrom: requested,
      },
    );

    expect(res.status, `Erstzuordnung: ${JSON.stringify(res.data)}`).toBe(201);
    // Die ANTWORT trägt das normalisierte Datum — nicht das angefragte. Genau
    // das persistiert die Zeile, und genau das protokolliert das Audit
    // (`routes/admin/customers/details.ts` loggt `created.validFrom`).
    expect(isMonthStartISO(res.data.validFrom)).toBe(true);
    expect(res.data.validFrom).toBe(`${requested.slice(0, 7)}-01`);

    // Gegenprobe am Lesepfad: die gespeicherte Zeile zeigt dasselbe.
    const list = await apiGet<Array<{ validFrom: string }>>(
      `/api/admin/customers/${customerId}/insurance`,
    );
    expect(list.status).toBe(200);
    expect(list.data.map((r) => r.validFrom)).toContain(`${requested.slice(0, 7)}-01`);
  });

  it("echter Kassenwechsel mitten im Monat bleibt ein harter 400", async () => {
    const customerId = await createCustomerWithoutInsurance();

    // 1) Erstzuordnung sauber auf dem Monatsersten — hier wird nichts normalisiert.
    const first = await apiPost<{ validFrom: string }>(
      `/api/admin/customers/${customerId}/insurance`,
      {
        insuranceProviderId: insuranceProviderIds[0],
        versichertennummer: versNr("B"),
        validFrom: `${todayISO().slice(0, 7)}-01`,
      },
    );
    expect(first.status, `Erstzuordnung: ${JSON.stringify(first.data)}`).toBe(201);

    // 2) WECHSEL mitten im Monat -> muss abgelehnt werden.
    const change = await apiPost<{ message?: string }>(
      `/api/admin/customers/${customerId}/insurance`,
      {
        insuranceProviderId: insuranceProviderIds[1],
        versichertennummer: versNr("C"),
        validFrom: midMonthISO(),
      },
    );
    expect(
      change.status,
      `Wechsel mitten im Monat MUSS 400 sein, war ${change.status}: ${JSON.stringify(change.data)}`,
    ).toBe(400);
    expect(JSON.stringify(change.data)).toContain(INSURANCE_WINDOW_MUST_START_ON_FIRST);

    // Und er darf auch nichts geschrieben haben.
    const list = await apiGet<Array<unknown>>(`/api/admin/customers/${customerId}/insurance`);
    expect(list.data.length).toBe(1);
  });

  // Fachliche Entscheidung Alrik, 04.08.2026. Die erste Fassung nahm `heute`
  // als harten Startwert und zog ein zukuenftiges „Gültig ab" auf den
  // laufenden Monat zurueck — die Kasse bekam damit Monate zugeordnet, in
  // denen sie nicht zustaendig war.
  it("Erstzuordnung mit Zukunftsdatum wird honoriert, nicht auf heute zurueckgezogen", async () => {
    const customerId = await createCustomerWithoutInsurance();
    const requested = futureMidMonthISO();

    const res = await apiPost<{ validFrom: string }>(
      `/api/admin/customers/${customerId}/insurance`,
      {
        insuranceProviderId: insuranceProviderIds[0],
        versichertennummer: versNr("D"),
        validFrom: requested,
      },
    );

    expect(res.status, `Erstzuordnung Zukunft: ${JSON.stringify(res.data)}`).toBe(201);
    // Monatserster des ANGEFRAGTEN Monats — nicht des laufenden.
    expect(res.data.validFrom).toBe(`${requested.slice(0, 7)}-01`);
    expect(res.data.validFrom > todayISO()).toBe(true);

    // Bis dahin hat der Kunde bewusst keine AKTUELLE Kasse: das Fenster ist
    // noch nicht gueltig, der Stichtags-Leser darf es heute nicht liefern.
    const list = await apiGet<Array<{ validFrom: string }>>(
      `/api/admin/customers/${customerId}/insurance`,
    );
    expect(list.data.length).toBe(1);
    expect(list.data[0].validFrom).toBe(`${requested.slice(0, 7)}-01`);
  });

  // Der Advisory-Lock ist — mangels Unique-Constraint auf
  // `(customer_id, valid_from)` — der EINZIGE Schutz gegen zwei gleichzeitige
  // Erstzuordnungen. Ohne ihn sehen beide Requests eine leere Fenstermenge,
  // beide halten sich fuer die Erstzuordnung, beide normalisieren auf denselben
  // Monatsersten und beide inserten: der Kunde haette zwei gleichzeitig
  // gueltige Kassen, und `resolveCustomerInsuranceAt` entschiede per `.limit(1)`
  // zufaellig, welche die Rechnung bekommt. Die Mengenpruefung faengt das nicht,
  // weil unter READ COMMITTED keiner die uncommittete Zeile des anderen sieht.
  //
  // MEHRERE RUNDEN, mit Absicht: ein einzelner 4er-Wettlauf ist nur zu rund
  // zwei Dritteln ein Detektor. Gemessen mit deaktiviertem Lock fingen 6 von 9
  // Einzelläufen den Fehler — treffen die POSTs gestaffelt genug ein, hat der
  // Gewinner schon committet, bevor der zweite seine Fenstermenge liest, und
  // der Lauf sieht grün aus. Als Regressionswächter hiesse das: jeder dritte
  // CI-Lauf laesst einen wieder eingebauten Fehler durch. Drei Runden heben die
  // Erkennungsrate auf ~96% und kosten nichts (der Test braucht in CI ~72 ms).
  it("RACE — parallele Erstzuordnungen: genau eine gewinnt, der Rest ist ein 400-Wechsel", async () => {
    const N = 4;
    const ROUNDS = 3;
    const requested = midMonthISO();

    for (let round = 1; round <= ROUNDS; round++) {
      // Frischer Kunde je Runde — sonst waere ab Runde 2 bereits eine Zuordnung
      // vorhanden und es gaebe gar keine Erstzuordnung mehr zu gewinnen.
      const customerId = await createCustomerWithoutInsurance();

      // Barriere: jeder Worker meldet sich erst als bereit und tritt dann
      // gemeinsam mit allen anderen in den POST ein — sonst serialisiert die
      // Vorbereitung den Wettlauf und der Test uebersieht Regressionen.
      const results = await runInParallel(
        Array.from({ length: N }, (_, i) => async (arrive: () => Promise<void>) => {
          await arrive();
          return apiPost<{ id?: number; validFrom?: string; message?: string }>(
            `/api/admin/customers/${customerId}/insurance`,
            {
              insuranceProviderId: insuranceProviderIds[i % insuranceProviderIds.length],
              versichertennummer: versNr("R"),
              validFrom: requested,
            },
          );
        }),
      );

      // Alle Requests muessen durchlaufen (kein Timeout, kein 500 durch einen
      // haengenden Lock).
      const settled = results.map((r) => {
        expect(r.status, `Runde ${round}: Worker rejected: ${JSON.stringify(r)}`).toBe("fulfilled");
        return (r as PromiseFulfilledResult<{ status: number; data: { message?: string } }>).value;
      });
      const stati = settled.map((s) => s.status).join(",");

      const created = settled.filter((r) => r.status === 201);
      const rejected = settled.filter((r) => r.status === 400);

      expect(
        created.length,
        `Runde ${round}: Genau eine Erstzuordnung darf gewinnen, war ${created.length}. Stati: ${stati}`,
      ).toBe(1);
      expect(
        rejected.length,
        `Runde ${round}: Die uebrigen ${N - 1} muessen als Wechsel mitten im Monat abgelehnt werden. Stati: ${stati}`,
      ).toBe(N - 1);
      for (const r of rejected) {
        // Gegen die SSoT-Konstante statt gegen ein Textfragment — und diese
        // Assertion traegt: in einem der Mutations-Laeufe war die Zaehlung
        // korrekt (1x201, 3x400) und NUR die Meldung verriet den kaputten
        // Zustand („Zwei Zuordnungen beginnen am selben Tag").
        expect(
          JSON.stringify(r.data),
          `Runde ${round}: Verlierer muss der Monatsersten-400 sein, war: ${JSON.stringify(r.data)}`,
        ).toContain(INSURANCE_WINDOW_MUST_START_ON_FIRST);
      }

      // Der eigentliche Schaden waere die zweite Zeile — direkt am Lesepfad
      // gegengeprueft, nicht nur ueber die Antwort-Stati.
      const list = await apiGet<Array<{ validFrom: string; validTo: string | null }>>(
        `/api/admin/customers/${customerId}/insurance`,
      );
      expect(list.status).toBe(200);
      expect(
        list.data.length,
        `Runde ${round}: Genau eine Zeile erwartet, war ${JSON.stringify(list.data)}`,
      ).toBe(1);
      expect(list.data[0].validFrom).toBe(`${requested.slice(0, 7)}-01`);
      expect(list.data[0].validTo).toBeNull();
    }
  });

  // Gegenprobe zur PATCH-Lücke: der Anker gilt NUR beim Anlegen. Eine
  // Korrektur normalisiert nie — auch nicht auf der einzigen Zeile des Kunden.
  it("PATCH normalisiert nicht: Korrektur auf ein Nicht-Monatserstes bleibt 400", async () => {
    const customerId = await createCustomerWithoutInsurance();

    const first = await apiPost<{ id: number; validFrom: string }>(
      `/api/admin/customers/${customerId}/insurance`,
      {
        insuranceProviderId: insuranceProviderIds[0],
        versichertennummer: versNr("E"),
        validFrom: midMonthISO(),
      },
    );
    expect(first.status, `Erstzuordnung: ${JSON.stringify(first.data)}`).toBe(201);
    const normalized = first.data.validFrom;

    const patch = await apiPatch<{ message?: string }>(
      `/api/admin/customers/${customerId}/insurance/${first.data.id}`,
      { validFrom: midMonthISO() },
    );
    expect(
      patch.status,
      `PATCH auf Nicht-Monatserstes MUSS 400 sein, war ${patch.status}: ${JSON.stringify(patch.data)}`,
    ).toBe(400);
    expect(JSON.stringify(patch.data)).toContain(INSURANCE_WINDOW_MUST_START_ON_FIRST);

    // Die Zeile steht unveraendert auf dem normalisierten Wert.
    const list = await apiGet<Array<{ validFrom: string }>>(
      `/api/admin/customers/${customerId}/insurance`,
    );
    expect(list.data[0].validFrom).toBe(normalized);
  });
});
