import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  uniqueId,
} from "../test-utils";
import { customerManagementStorage } from "../../server/storage/customer-management";

/**
 * Task #835: GoBD-Audit-Logging für die Admin-Kunden-Stammdaten-Maske.
 *
 * Der Admin-Pfad (server/routes/admin/customers/details.ts + contracts.ts)
 * ist der primäre Weg, Pflegegrad, Verträge, Versicherung und Kontakte zu
 * bearbeiten — diese Mutationen MÜSSEN (wie der Mitarbeiter-Pfad) einen
 * audit_log-Eintrag mit Akteur, Zeitstempel, Entity-Id und Vorher/Nachher
 * schreiben. Verifiziert wird über den /timeline-Endpunkt, der die
 * audit_log-Einträge eines Kunden zurückliefert.
 */

interface TimelineEntry {
  id: number;
  action: string;
  userName: string;
  metadata: { changedFields?: string[]; oldValues?: Record<string, unknown>; newValues?: Record<string, unknown>; oldPflegegrad?: number | null; newPflegegrad?: number; seitDatum?: string } | null;
  createdAt: string;
}

let insuranceProviderId: number;
const createdCustomerIds: number[] = [];

async function getTimeline(customerId: number): Promise<TimelineEntry[]> {
  const res = await apiGet<TimelineEntry[]>(`/api/admin/customers/${customerId}/timeline`);
  expect(res.status).toBe(200);
  return res.data;
}

function findEntry(entries: TimelineEntry[], action: string, changedField: string): TimelineEntry | undefined {
  return entries.find(
    (e) => e.action === action && Array.isArray(e.metadata?.changedFields) && e.metadata!.changedFields!.includes(changedField),
  );
}

beforeAll(async () => {
  const provRes = await apiGet<Array<{ id: number }>>("/api/admin/insurance-providers");
  expect(provRes.status).toBe(200);
  expect(provRes.data.length).toBeGreaterThan(0);
  insuranceProviderId = provRes.data[0].id;
});

afterAll(async () => {
  for (const id of createdCustomerIds) {
    try { await apiDelete(`/api/admin/customers/${id}`); } catch { /* ignore */ }
  }
});

async function createCustomer(): Promise<number> {
  const res = await apiPost<{ id: number }>("/api/admin/customers", {
    vorname: "Audit-835",
    nachname: "Test-" + uniqueId(),
    geburtsdatum: "1940-01-15",
    strasse: "Teststraße",
    nr: "1",
    plz: "10115",
    stadt: "Berlin",
    pflegegrad: 2,
    pflegegradSeit: "2024-01-01",
    insurance: {
      providerId: insuranceProviderId,
      versichertennummer: "A" + String(Math.floor(100000000 + Math.random() * 900000000)),
      validFrom: "2024-01-01",
    },
    budgets: {
      entlastungsbetrag45b: 125,
      verhinderungspflege39: 0,
      pflegesachleistungen36: 0,
      validFrom: "2024-01-01",
    },
  });
  expect(res.status).toBe(201);
  const id = res.data.id;
  createdCustomerIds.push(id);
  return id;
}

describe("Task #835: Admin-Stammdaten-Mutationen schreiben Audit-Log", () => {
  it("Kontakt anlegen/ändern/löschen erzeugt customer_updated-Einträge", async () => {
    const customerId = await createCustomer();

    const createRes = await apiPost<{ id: number }>(`/api/admin/customers/${customerId}/contacts`, {
      contactType: "familie",
      isPrimary: true,
      vorname: "Notfall",
      nachname: "Kontakt",
      mobilnummer: "+4917600000001",
    });
    expect(createRes.status).toBe(201);
    const contactId = createRes.data.id;

    const patchRes = await apiPatch(`/api/admin/customers/${customerId}/contacts/${contactId}`, {
      vorname: "NotfallGeändert",
    });
    expect(patchRes.status).toBe(200);

    const deleteRes = await apiDelete(`/api/admin/customers/${customerId}/contacts/${contactId}`);
    expect(deleteRes.status).toBe(200);

    const timeline = await getTimeline(customerId);

    const added = findEntry(timeline, "customer_updated", "notfallkontakt_hinzugefügt");
    const updated = findEntry(timeline, "customer_updated", "notfallkontakt_aktualisiert");
    const deleted = findEntry(timeline, "customer_updated", "notfallkontakt_gelöscht");

    expect(added).toBeDefined();
    expect(added!.userName).toBeTruthy();
    expect(added!.createdAt).toBeTruthy();
    expect(added!.metadata?.newValues?.contactId).toBe(contactId);

    expect(updated).toBeDefined();
    expect(updated!.metadata?.newValues?.vorname).toBe("NotfallGeändert");

    expect(deleted).toBeDefined();
    expect(deleted!.metadata?.oldValues?.contactId).toBe(contactId);
  });

  it("Pflegegrad-Änderung erzeugt customer_care_level_changed mit Vorher/Nachher", async () => {
    const customerId = await createCustomer();

    const res = await apiPost(`/api/admin/customers/${customerId}/care-level`, {
      pflegegrad: 4,
      validFrom: "2025-06-01",
    });
    expect(res.status).toBe(201);

    const timeline = await getTimeline(customerId);
    const entry = timeline.find((e) => e.action === "customer_care_level_changed");

    expect(entry).toBeDefined();
    expect(entry!.userName).toBeTruthy();
    expect(entry!.metadata?.oldPflegegrad).toBe(2);
    expect(entry!.metadata?.newPflegegrad).toBe(4);
    expect(entry!.metadata?.seitDatum).toBe("2025-06-01");
  });

  it("Versicherung hinzufügen erzeugt customer_updated-Eintrag", async () => {
    const customerId = await createCustomer();

    const res = await apiPost<{ id: number }>(`/api/admin/customers/${customerId}/insurance`, {
      insuranceProviderId,
      versichertennummer: "B" + String(Math.floor(100000000 + Math.random() * 900000000)),
      validFrom: "2025-01-01",
    });
    expect(res.status).toBe(201);

    const timeline = await getTimeline(customerId);
    const entry = findEntry(timeline, "customer_updated", "versicherung_hinzugefügt");

    expect(entry).toBeDefined();
    expect(entry!.userName).toBeTruthy();
    expect(entry!.metadata?.newValues?.insuranceId).toBe(res.data.id);
  });

  it("Vertrag anlegen und aktualisieren erzeugt customer_contract_updated-Einträge", async () => {
    const customerId = await createCustomer();

    const createRes = await apiPost(`/api/admin/customers/${customerId}/contract`, {
      contractStart: "2025-01-01",
      hoursPerPeriod: 4,
      periodType: "week",
    });
    expect(createRes.status).toBe(201);

    const patchRes = await apiPatch(`/api/admin/customers/${customerId}/contract`, {
      hoursPerPeriod: 8,
    });
    expect(patchRes.status).toBe(200);

    const timeline = await getTimeline(customerId);
    const created = findEntry(timeline, "customer_contract_updated", "vertrag_angelegt");
    const updated = findEntry(timeline, "customer_contract_updated", "hoursPerPeriod");

    expect(created).toBeDefined();
    expect(created!.userName).toBeTruthy();

    expect(updated).toBeDefined();
    expect(updated!.metadata?.oldValues?.hoursPerPeriod).toBe(4);
    expect(updated!.metadata?.newValues?.hoursPerPeriod).toBe(8);
  });

  it("Bedarfserhebung aktualisieren erzeugt Audit-Eintrag mit Vorher/Nachher", async () => {
    const customerId = await createCustomer();

    // Der Kundenanlage-Wizard legt keine Bedarfserhebung an und es gibt keinen
    // API-Pfad dafür; daher seeden wir die Zeile direkt über den Storage-Layer,
    // damit das PATCH unten eine existierende Zeile aktualisiert (sonst 404).
    await customerManagementStorage.createNeedsAssessment({
      customerId,
      assessmentDate: "2024-01-01",
      serviceHaushaltHilfe: false,
    });

    const patchRes = await apiPatch(`/api/admin/customers/${customerId}/needs-assessment`, {
      serviceHaushaltHilfe: true,
    });
    expect(patchRes.status).toBe(200);

    const timeline = await getTimeline(customerId);
    const entry = findEntry(timeline, "customer_contract_updated", "bedarfserhebung_aktualisiert");

    expect(entry).toBeDefined();
    expect(entry!.userName).toBeTruthy();
    expect(entry!.createdAt).toBeTruthy();
    expect(entry!.metadata?.oldValues?.serviceHaushaltHilfe).toBe(false);
    expect(entry!.metadata?.newValues?.serviceHaushaltHilfe).toBe(true);
  });
});
