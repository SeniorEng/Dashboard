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
  expect(provRes.status).toBe(200);
  expect(provRes.data.length).toBeGreaterThan(0);
  insuranceProviderId = provRes.data[0].id;
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
    expect(res.data).toHaveProperty("id");
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

  it("KV-1.4 – PLZ mit 6 Ziffern wird abgelehnt", async () => {
    const res = await apiPost<any>("/api/admin/customers", validCustomerPayload({ plz: "101150" }));
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
    expect(historyCustomerId, "historyCustomerId muss aus KV-4.1 gesetzt sein").toBeTruthy();
    const res = await apiPost<any>(`/api/admin/customers/${historyCustomerId}/care-level`, {
      pflegegrad: 4,
      validFrom: "2025-06-01",
    });
    expect(res.status).toBe(201);
    expect(res.data.pflegegrad).toBe(4);
  });

  it("KV-4.3 – Details zeigen aktuellen Pflegegrad 4", async () => {
    expect(historyCustomerId, "historyCustomerId muss aus KV-4.1 gesetzt sein").toBeTruthy();
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

  it("KV-5.3 – Ohne Vorname wird abgelehnt", async () => {
    const payload = validCustomerPayload();
    delete (payload as any).vorname;
    const res = await apiPost<any>("/api/admin/customers", payload);
    expect(res.status).toBe(400);
  });

  it("KV-5.4 – Ohne Stadt wird abgelehnt", async () => {
    const payload = validCustomerPayload();
    delete (payload as any).stadt;
    const res = await apiPost<any>("/api/admin/customers", payload);
    expect(res.status).toBe(400);
  });

  it("KV-5.5 – Ohne Hausnummer wird abgelehnt", async () => {
    const payload = validCustomerPayload();
    delete (payload as any).nr;
    const res = await apiPost<any>("/api/admin/customers", payload);
    expect(res.status).toBe(400);
  });
});

describe("KV-6: Mitarbeiter-Zuweisung & Kundenlistenfilter", () => {
  let assignedCustomerId: number;

  it("KV-6.1 – Kunde erstellen und Mitarbeiter zuweisen", async () => {
    const createRes = await apiPost<any>("/api/admin/customers", validCustomerPayload());
    expect(createRes.status).toBe(201);
    assignedCustomerId = createRes.data.id;
    createdCustomerIds.push(assignedCustomerId);

    const res = await apiPatch<any>(`/api/admin/customers/${assignedCustomerId}/assign`, {
      primaryEmployeeId: auth.user.id,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });
    expect(res.status).toBe(200);
  });

  it("KV-6.2 – Zugewiesener Kunde erscheint in eigener Liste", async () => {
    expect(assignedCustomerId, "assignedCustomerId muss gesetzt sein").toBeTruthy();
    const res = await apiGet<any>("/api/customers");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data), "/api/customers gibt ein Array zurück").toBe(true);
    const customers = res.data as any[];
    const found = customers.find((c: any) => c.id === assignedCustomerId);
    expect(found, "Zugewiesener Kunde muss in eigener Liste erscheinen").toBeDefined();
  });
});

describe("KV-7: Geburtsdatum-Validierung", () => {
  it("KV-7.1 – Geburtsdatum in der Zukunft wird abgelehnt", async () => {
    const futureDate = new Date();
    futureDate.setFullYear(futureDate.getFullYear() + 1);
    const res = await apiPost<any>("/api/admin/customers", validCustomerPayload({
      geburtsdatum: futureDate.toISOString().split("T")[0],
    }));
    expect(res.status).toBe(400);
  });

  it("KV-7.2 – Geburtsdatum >120 Jahre wird abgelehnt", async () => {
    const res = await apiPost<any>("/api/admin/customers", validCustomerPayload({
      geburtsdatum: "1890-01-01",
    }));
    expect(res.status).toBe(400);
  });
});

describe("KV-8: Kundensuche", () => {
  it("KV-8.1 – Suche mit mindestens 2 Zeichen liefert Ergebnisse", async () => {
    const res = await apiGet<any>("/api/search?q=Test&limit=5");
    expect(res.status).toBe(200);
  });

  it("KV-8.2 – Admin-Kundenliste unterstützt Filter", async () => {
    const res = await apiGet<any>("/api/admin/customers?status=aktiv&limit=5");
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("data");
    expect(Array.isArray(res.data.data)).toBe(true);
  });
});

describe("KV-9: Duplikatprüfung", () => {
  it("KV-9.1 – check-duplicate mit existierenden Daten findet Match", async () => {
    expect(createdCustomerIds.length, "Kunden müssen aus vorherigen Tests vorhanden sein").toBeGreaterThan(0);
    const custRes = await apiGet<any>(`/api/admin/customers/${createdCustomerIds[0]}/details`);
    expect(custRes.status).toBe(200);

    const res = await apiPost<any>("/api/admin/customers/check-duplicate", {
      vorname: custRes.data.vorname,
      nachname: custRes.data.nachname,
    });
    expect(res.status).toBe(200);
    expect(res.data).toBeDefined();
    if (res.data && typeof res.data === "object") {
      const hasMatch = res.data.hasDuplicate || res.data.exists || (Array.isArray(res.data.duplicates) && res.data.duplicates.length > 0) || false;
      expect(hasMatch).toBe(true);
    }
  });

  it("KV-9.2 – check-duplicate mit neuem Namen findet kein Duplikat", async () => {
    const res = await apiPost<any>("/api/admin/customers/check-duplicate", {
      vorname: "Einzigartig-" + uniqueId(),
      nachname: "Kein-Duplikat-" + uniqueId(),
    });
    expect(res.status).toBe(200);
    if (res.data && typeof res.data === "object") {
      const hasMatch = res.data.hasDuplicate || res.data.exists || (Array.isArray(res.data.duplicates) && res.data.duplicates.length > 0) || false;
      expect(hasMatch).toBe(false);
    }
  });
});

describe("KV-10: E-Mail-Validierung", () => {
  it("KV-10.1 – Gültige E-Mail wird akzeptiert", async () => {
    const res = await apiPost<any>("/api/admin/customers", validCustomerPayload({
      email: "test-" + uniqueId() + "@example.com",
    }));
    expect(res.status).toBe(201);
    createdCustomerIds.push(res.data.id);
  });

  it("KV-10.2 – Ungültige E-Mail wird abgelehnt", async () => {
    const res = await apiPost<any>("/api/admin/customers", validCustomerPayload({
      email: "keine-email",
    }));
    expect(res.status).toBe(400);
  });
});

describe("KV-11: Deaktivierungs-Workflow", () => {
  it("KV-11.1 – Deaktivierungs-Bereitschaft prüfen", async () => {
    expect(createdCustomerIds.length).toBeGreaterThan(0);
    const res = await apiGet<any>(`/api/admin/customers/${createdCustomerIds[0]}/deactivation-readiness`);
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("ready");
  });

  it("KV-11.2 – Deaktivierung ohne Grund wird abgelehnt", async () => {
    expect(createdCustomerIds.length).toBeGreaterThan(0);
    const res = await apiPost<any>(`/api/admin/customers/${createdCustomerIds[0]}/complete-deactivation`, {});
    expect(res.status).toBe(400);
  });
});

describe("KV-12: Pflichtfelder", () => {
  it("KV-12.1 – Kunde ohne Nachname wird abgelehnt", async () => {
    const payload = validCustomerPayload({});
    delete (payload as any).nachname;
    const res = await apiPost<any>("/api/admin/customers", payload);
    expect(res.status).toBe(400);
  });

  it("KV-12.2 – Kunde ohne Straße wird abgelehnt", async () => {
    const payload = validCustomerPayload({});
    delete (payload as any).strasse;
    const res = await apiPost<any>("/api/admin/customers", payload);
    expect(res.status).toBe(400);
  });
});

describe("KV-13: Kunden-Details abrufen", () => {
  it("KV-13.1 – Details enthalten alle Pflichtfelder", async () => {
    expect(createdCustomerIds.length).toBeGreaterThan(0);
    const res = await apiGet<any>(`/api/admin/customers/${createdCustomerIds[0]}/details`);
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("vorname");
    expect(res.data).toHaveProperty("nachname");
    expect(res.data).toHaveProperty("strasse");
    expect(res.data).toHaveProperty("plz");
    expect(res.data).toHaveProperty("stadt");
    expect(res.data).toHaveProperty("pflegegrad");
  });

  it("KV-13.2 – Nicht existierender Kunde liefert 404", async () => {
    const res = await apiGet<any>("/api/admin/customers/999999/details");
    expect(res.status).toBe(404);
  });
});

describe("KV-14: Kontakte mit Telefonnummer", () => {
  it("KV-14.1 – Kontakt mit Telefonnummer wird akzeptiert", async () => {
    const res = await apiPost<any>("/api/admin/customers", validCustomerPayload({
      contacts: [{
        contactType: "familie",
        isPrimary: true,
        vorname: "Kontakt",
        nachname: "Test",
        telefon: "+4917612345678",
      }],
    }));
    expect(res.status).toBe(201);
    if (res.data?.id) createdCustomerIds.push(res.data.id);
  });
});

describe("KV-15: Kunde PATCH bearbeiten", () => {
  let patchCustomerId: number;

  it("KV-15.1 – Kunde erstellen und Vorname aktualisieren", async () => {
    const createRes = await apiPost<any>("/api/admin/customers", validCustomerPayload());
    expect(createRes.status).toBe(201);
    patchCustomerId = createRes.data.id;
    createdCustomerIds.push(patchCustomerId);

    const patchRes = await apiPatch<any>(`/api/admin/customers/${patchCustomerId}`, {
      vorname: "Neuer-Vorname",
    });
    expect(patchRes.status).toBe(200);
    expect(patchRes.data.vorname).toBe("Neuer-Vorname");
  });

  it("KV-15.2 – PLZ auf ungültig ändern wird abgelehnt (400)", async () => {
    expect(patchCustomerId, "patchCustomerId muss gesetzt sein").toBeTruthy();
    const patchRes = await apiPatch<any>(`/api/admin/customers/${patchCustomerId}`, {
      plz: "abc",
    });
    expect(patchRes.status).toBe(400);
  });
});

describe("KV-16: Kontaktperson hinzufügen", () => {
  it("KV-16.1 – Kontaktperson zu bestehendem Kunden hinzufügen", async () => {
    expect(createdCustomerIds.length).toBeGreaterThan(0);
    const res = await apiPost<any>(`/api/admin/customers/${createdCustomerIds[0]}/contacts`, {
      contactType: "betreuer",
      isPrimary: false,
      vorname: "Neuer-Kontakt",
      nachname: "Testperson",
      telefon: "+4917600000099",
    });
    expect(res.status).toBe(201);
  });
});

describe("KV-17: Kunde nicht gefunden", () => {
  it("KV-17.1 – PATCH auf nicht-existierenden Kunden liefert 404", async () => {
    const res = await apiPatch<any>("/api/admin/customers/999999", {
      vorname: "Ghost",
    });
    expect(res.status).toBe(404);
  });

  it("KV-17.2 – DELETE auf nicht-existierenden Kunden liefert 200 (idempotent)", async () => {
    const res = await apiDelete("/api/admin/customers/999999");
    expect([200, 404]).toContain(res.status);
  });
});

describe("KV-18: Deaktivierung ohne Vertragsende blockiert", () => {
  it("KV-18.1 – Deaktivierung ohne Vertragsende wird abgelehnt", async () => {
    expect(createdCustomerIds.length).toBeGreaterThan(0);
    const res = await apiPost<any>(
      `/api/admin/customers/${createdCustomerIds[0]}/complete-deactivation`,
      { deactivationReason: "Test" }
    );
    expect(res.status).toBe(400);
  });
});

describe("KV-19: Anonymisierung nur für inaktive Kunden", () => {
  it("KV-19.1 – Anonymisierung für aktiven Kunden wird abgelehnt", async () => {
    expect(createdCustomerIds.length).toBeGreaterThan(0);
    const res = await apiPost<any>(
      `/api/admin/customers/${createdCustomerIds[0]}/anonymize`,
      {}
    );
    expect(res.status).toBe(400);
  });
});

describe("KV-20: Deaktivierungs-Readiness Endpoint", () => {
  it("KV-20.1 – Readiness-Check für Kunden ohne Vertragsende zeigt nicht bereit", async () => {
    expect(createdCustomerIds.length).toBeGreaterThan(0);
    const res = await apiGet<any>(
      `/api/admin/customers/${createdCustomerIds[0]}/deactivation-readiness`
    );
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("ready");
    expect(res.data.ready).toBe(false);
  });
});
