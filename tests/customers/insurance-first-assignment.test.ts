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
import { isMonthStartISO } from "@shared/domain/insurance-period";
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
    expect(JSON.stringify(change.data)).toContain("Monatsersten");

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
    expect(JSON.stringify(patch.data)).toContain("Monatsersten");

    // Die Zeile steht unveraendert auf dem normalisierten Wert.
    const list = await apiGet<Array<{ validFrom: string }>>(
      `/api/admin/customers/${customerId}/insurance`,
    );
    expect(list.data[0].validFrom).toBe(normalized);
  });
});
