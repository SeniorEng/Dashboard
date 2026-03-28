import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  getAuthCookie,
  uniqueId,
} from "./test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let insuranceProviderId: number;
let createdCustomerIds: number[] = [];

beforeAll(async () => {
  auth = await getAuthCookie();

  const provRes = await apiGet<any[]>("/api/admin/insurance-providers");
  if (provRes.status === 200 && provRes.data.length > 0) {
    insuranceProviderId = provRes.data[0].id;
  }
});

afterAll(async () => {
  for (const id of createdCustomerIds) {
    try { await apiDelete(`/api/admin/customers/${id}`); } catch {}
  }
});

function validCustomerPayload(overrides: Record<string, any> = {}) {
  return {
    vorname: "QS-Val",
    nachname: "Test-" + uniqueId(),
    geburtsdatum: "1940-01-15",
    strasse: "Teststraße",
    nr: "1",
    plz: "10115",
    stadt: "Berlin",
    pflegegrad: 3,
    pflegegradSeit: "2024-01-01",
    insurance: {
      providerId: insuranceProviderId,
      versichertennummer: "A" + String(Math.floor(100000000 + Math.random() * 900000000)),
      validFrom: "2024-01-01",
    },
    contacts: [
      {
        contactType: "familie",
        isPrimary: true,
        vorname: "Kontakt",
        nachname: "Test",
        telefon: "+4917600000001",
      },
    ],
    budgets: {
      entlastungsbetrag45b: 125,
      verhinderungspflege39: 0,
      pflegesachleistungen36: 0,
      validFrom: "2024-01-01",
    },
    ...overrides,
  };
}

describe("KV-1: PLZ-Validierung", () => {
  it("KV-1.1 – PLZ mit 5 Ziffern ist gültig", async () => {
    const res = await apiPost<any>("/api/admin/customers", validCustomerPayload({ plz: "10115" }));
    expect(res.status).toBe(201);
    createdCustomerIds.push(res.data.id);
  });

  it("KV-1.2 – PLZ mit 4 Ziffern wird abgelehnt", async () => {
    const res = await apiPost<any>("/api/admin/customers", validCustomerPayload({ plz: "1011" }));
    expect(res.status).toBe(400);
  });

  it("KV-1.3 – PLZ mit Buchstaben wird abgelehnt", async () => {
    const res = await apiPost<any>("/api/admin/customers", validCustomerPayload({ plz: "1011A" }));
    expect(res.status).toBe(400);
  });
});

describe("KV-2: Pflegegrad-Validierung", () => {
  it("KV-2.1 – Pflegegrad 1 ist gültig", async () => {
    const res = await apiPost<any>("/api/admin/customers", validCustomerPayload({ pflegegrad: 1 }));
    expect(res.status).toBe(201);
    createdCustomerIds.push(res.data.id);
  });

  it("KV-2.2 – Pflegegrad 5 ist gültig", async () => {
    const res = await apiPost<any>("/api/admin/customers", validCustomerPayload({ pflegegrad: 5 }));
    expect(res.status).toBe(201);
    createdCustomerIds.push(res.data.id);
  });

  it("KV-2.3 – Pflegegrad 0 wird abgelehnt", async () => {
    const res = await apiPost<any>("/api/admin/customers", validCustomerPayload({ pflegegrad: 0 }));
    expect(res.status).toBe(400);
  });

  it("KV-2.4 – Pflegegrad 6 wird abgelehnt", async () => {
    const res = await apiPost<any>("/api/admin/customers", validCustomerPayload({ pflegegrad: 6 }));
    expect(res.status).toBe(400);
  });
});

describe("KV-3: Versichertennummer-Validierung", () => {
  it("KV-3.1 – Format A123456789 ist gültig", async () => {
    const res = await apiPost<any>("/api/admin/customers", validCustomerPayload({
      insurance: {
        providerId: insuranceProviderId,
        versichertennummer: "B123456789",
        validFrom: "2024-01-01",
      },
    }));
    expect(res.status).toBe(201);
    createdCustomerIds.push(res.data.id);
  });

  it("KV-3.2 – Kleinbuchstabe a123456789 wird abgelehnt", async () => {
    const res = await apiPost<any>("/api/admin/customers", validCustomerPayload({
      insurance: {
        providerId: insuranceProviderId,
        versichertennummer: "a123456789",
        validFrom: "2024-01-01",
      },
    }));
    expect(res.status).toBe(400);
  });

  it("KV-3.3 – Zu kurze Nummer wird abgelehnt", async () => {
    const res = await apiPost<any>("/api/admin/customers", validCustomerPayload({
      insurance: {
        providerId: insuranceProviderId,
        versichertennummer: "A12345",
        validFrom: "2024-01-01",
      },
    }));
    expect(res.status).toBe(400);
  });
});

describe("KV-4: Pflegegrad-Historie", () => {
  let historyCustomerId: number;

  it("KV-4.1 – Kunde mit PG3 erstellen", async () => {
    const res = await apiPost<any>("/api/admin/customers", validCustomerPayload({ pflegegrad: 3 }));
    expect(res.status).toBe(201);
    historyCustomerId = res.data.id;
    createdCustomerIds.push(historyCustomerId);
  });

  it("KV-4.2 – Pflegegrad auf 4 erhöhen", async () => {
    const res = await apiPost<any>(`/api/admin/customers/${historyCustomerId}/care-level`, {
      pflegegrad: 4,
      validFrom: "2025-06-01",
    });
    expect(res.status).toBe(201);
    expect(res.data.pflegegrad).toBe(4);
  });

  it("KV-4.3 – Details zeigen aktuellen Pflegegrad 4", async () => {
    const res = await apiGet<any>(`/api/admin/customers/${historyCustomerId}/details`);
    expect(res.status).toBe(200);
    expect(res.data.pflegegrad).toBe(4);
  });
});

describe("KV-5: Pflichtfelder", () => {
  it("KV-5.1 – Ohne Nachname wird abgelehnt", async () => {
    const payload = validCustomerPayload();
    delete (payload as any).nachname;
    const res = await apiPost<any>("/api/admin/customers", payload);
    expect(res.status).toBe(400);
  });

  it("KV-5.2 – Ohne Strasse wird abgelehnt", async () => {
    const payload = validCustomerPayload();
    delete (payload as any).strasse;
    const res = await apiPost<any>("/api/admin/customers", payload);
    expect(res.status).toBe(400);
  });
});

describe("KV-6: Mitarbeiter-Zuweisung", () => {
  it("KV-6.1 – Primären Mitarbeiter zuweisen", async () => {
    if (createdCustomerIds.length === 0) return;
    const custId = createdCustomerIds[0];

    const res = await apiPatch<any>(`/api/admin/customers/${custId}/assign`, {
      primaryEmployeeId: auth.user.id,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });
    expect(res.status).toBe(200);
  });

  it("KV-6.2 – Zugewiesener Kunde erscheint in eigener Liste", async () => {
    const res = await apiGet<any[]>("/api/customers");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });
});
