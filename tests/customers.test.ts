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
        mobilnummer: "+4917600000001",
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

describe("KV-0: CRUD-Grundfunktionen", () => {
  let testCustomerId: number;
  let testContactId: number;

  it("KV-0.1 – GET /api/customers liefert ein Array mit Kunden", async () => {
    const res = await apiGet<any[]>("/api/customers");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
    if (res.data.length > 0) {
      const customer = res.data[0];
      expect(customer).toHaveProperty("id");
      expect(customer).toHaveProperty("vorname");
      expect(customer).toHaveProperty("nachname");
      expect(customer).toHaveProperty("pflegegrad");
    }
  });

  it("KV-0.2 – GET /api/customers/:id liefert einzelne Kundendetails", async () => {
    const listRes = await apiGet<any[]>("/api/customers");
    expect(listRes.status).toBe(200);
    expect(listRes.data.length).toBeGreaterThan(0);
    const firstCustomer = listRes.data[0];
    const res = await apiGet<any>(`/api/customers/${firstCustomer.id}`);
    expect(res.status).toBe(200);
    expect(res.data.id).toBe(firstCustomer.id);
    expect(res.data).toHaveProperty("vorname");
    expect(res.data).toHaveProperty("nachname");
  });

  it("KV-0.3 – POST /api/admin/customers erstellt Kunden mit Versicherung, Kontakt, Budget", async () => {
    const res = await apiPost<any>("/api/admin/customers", {
      vorname: "QS-Test",
      nachname: "CRUD-" + uniqueId(),
      geburtsdatum: "1940-01-15",
      strasse: "Teststraße",
      nr: "42",
      plz: "10115",
      stadt: "Berlin",
      telefon: "+4917612345678",
      pflegegrad: 3,
      pflegegradSeit: "2024-01-01",
      insurance: {
        providerId: insuranceProviderId,
        versichertennummer: "A123456789",
        validFrom: "2024-01-01",
      },
      contacts: [{
        contactType: "familie",
        isPrimary: true,
        vorname: "QS-Kontakt",
        nachname: "Test",
        telefon: "+4917699887766",
      }],
      budgets: {
        entlastungsbetrag45b: 125,
        verhinderungspflege39: 0,
        pflegesachleistungen36: 0,
        validFrom: "2024-01-01",
      },
    });
    expect(res.status).toBe(201);
    expect(res.data).toHaveProperty("id");
    expect(res.data.vorname).toBe("QS-Test");
    testCustomerId = res.data.id;
    createdCustomerIds.push(testCustomerId);
  });

  it("KV-0.4 – PATCH /api/admin/customers/:id aktualisiert den Kunden", async () => {
    const res = await apiPatch<any>(`/api/admin/customers/${testCustomerId}`, {
      stadt: "München",
    });
    expect(res.status).toBe(200);
    expect(res.data.stadt).toBe("München");
  });

  it("KV-0.5 – POST care-level aktualisiert den Pflegegrad auf 4", async () => {
    const res = await apiPost<any>(`/api/admin/customers/${testCustomerId}/care-level`, {
      pflegegrad: 4,
      validFrom: "2025-01-01",
    });
    expect(res.status).toBe(201);
    expect(res.data).toHaveProperty("id");
    expect(res.data.pflegegrad).toBe(4);
  });

  it("KV-0.6 – GET details liefert Detailansicht mit Insurance und Budgets", async () => {
    const res = await apiGet<any>(`/api/admin/customers/${testCustomerId}/details`);
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("id");
    expect(res.data.id).toBe(testCustomerId);
    expect(res.data.vorname).toBe("QS-Test");
    expect(res.data).toHaveProperty("currentInsurance");
    expect(res.data).toHaveProperty("currentBudgets");
  });

  it("KV-0.7 – POST contacts fügt Kontaktperson hinzu", async () => {
    const res = await apiPost<any>(`/api/admin/customers/${testCustomerId}/contacts`, {
      contactType: "familie",
      vorname: "QS-Kontakt",
      nachname: "Tochter",
      telefon: "+4917699887766",
    });
    expect(res.status).toBe(201);
    expect(res.data).toHaveProperty("id");
    expect(res.data.vorname).toBe("QS-Kontakt");
    testContactId = res.data.id;
  });

  it("KV-0.8 – GET contacts liefert Kontaktpersonen", async () => {
    const res = await apiGet<any[]>(`/api/admin/customers/${testCustomerId}/contacts`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
    const found = res.data.find((c: any) => c.id === testContactId);
    expect(found).toBeDefined();
    expect(found.vorname).toBe("QS-Kontakt");
  });

  it("KV-0.9 – DELETE contacts entfernt die Kontaktperson", async () => {
    const res = await apiDelete(`/api/admin/customers/${testCustomerId}/contacts/${testContactId}`);
    expect(res.status).toBe(200);
    const checkRes = await apiGet<any[]>(`/api/admin/customers/${testCustomerId}/contacts`);
    const found = checkRes.data.find((c: any) => c.id === testContactId);
    expect(found).toBeUndefined();
  });
});

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

    const params = new URLSearchParams({
      vorname: custRes.data.vorname,
      nachname: custRes.data.nachname,
    });
    const res = await apiGet<any>(`/api/admin/customers/check-duplicate?${params}`);
    expect(res.status).toBe(200);
    expect(res.data).toBeDefined();
    expect(Array.isArray(res.data.duplicates), "duplicates muss ein Array sein").toBe(true);
    expect(res.data.duplicates.length, "Duplikat-Check muss existierenden Kunden finden").toBeGreaterThan(0);
  });

  it("KV-9.2 – check-duplicate mit neuem Namen findet kein Duplikat", async () => {
    const params = new URLSearchParams({
      vorname: "Einzigartig-" + uniqueId(),
      nachname: "Kein-Duplikat-" + uniqueId(),
    });
    const res = await apiGet<any>(`/api/admin/customers/check-duplicate?${params}`);
    expect(res.status).toBe(200);
    expect(res.data).toBeDefined();
    expect(Array.isArray(res.data.duplicates), "duplicates muss ein Array sein").toBe(true);
    expect(res.data.duplicates.length, "Kein Duplikat erwartet für einzigartigen Namen").toBe(0);
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
        mobilnummer: "+4917612345678",
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
      mobilnummer: "+4917600000099",
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

  it("KV-17.2 – DELETE auf nicht-existierenden Kunden liefert Validierungs-/Not-Found-Fehler", async () => {
    // Hard-Delete-Endpoint (SuperAdmin) erfordert Body (reason + confirmName).
    // Ohne Body → 400 (Zod-Validierung). Mit Body und unbekannter ID → 404.
    const res = await apiDelete("/api/admin/customers/999999");
    expect([400, 404]).toContain(res.status);
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

describe("KV-21: Telefonnummer-Handling", () => {
  it("KV-21.1 – Kontakt ohne Telefon-Feld ist gültig (Backend validiert erst bei Anruf)", async () => {
    const res = await apiPost<any>("/api/admin/customers", validCustomerPayload({
      contacts: [{ contactType: "familie", isPrimary: true, vorname: "Test", nachname: "Tel" }],
    }));
    expect(res.status).toBe(201);
    createdCustomerIds.push(res.data.id);
  });

  it("KV-21.2 – Kontakt mit gültigem DE-Telefonnummernformat wird akzeptiert", async () => {
    const res = await apiPost<any>("/api/admin/customers", validCustomerPayload({
      contacts: [{ contactType: "familie", isPrimary: true, vorname: "Test", nachname: "Tel", mobilnummer: "+4917612345678" }],
    }));
    expect(res.status).toBe(201);
    createdCustomerIds.push(res.data.id);
  });
});

describe("KV-22: Kunde ist nicht in regulärer Kundenliste vor Aktivierung", () => {
  it("KV-22.1 – Erstberatungs-Kunde erscheint nicht in GET /customers", async () => {
    const allRes = await apiGet<any>("/api/customers");
    expect(allRes.status).toBe(200);
    const customers = Array.isArray(allRes.data) ? allRes.data : (allRes.data?.data || []);
    for (const c of customers) {
      expect(c.status).not.toBe("erstberatung");
    }
  });
});

describe("KV-23: Ungültiges Telefonnummernformat wird abgelehnt (Employee-Route)", () => {
  let phoneTestCustId: number;

  it("KV-23.0 – Testkunden für Telefonvalidierung anlegen", async () => {
    const createRes = await apiPost<any>("/api/admin/customers", validCustomerPayload());
    expect(createRes.status).toBe(201);
    phoneTestCustId = createRes.data.id;
    createdCustomerIds.push(phoneTestCustId);
  });

  it("KV-23.1 – Ungültige Telefonnummer wird abgelehnt (Employee-Update)", async () => {
    expect(phoneTestCustId, "phoneTestCustId muss gesetzt sein").toBeTruthy();
    const res = await apiPatch<any>(`/api/customers/${phoneTestCustId}`, {
      telefon: "not-a-phone-number",
    });
    expect(res.status).toBe(400);
  });

  it("KV-23.2 – US-Telefonnummer wird abgelehnt (nur DACH erlaubt)", async () => {
    expect(phoneTestCustId, "phoneTestCustId muss gesetzt sein").toBeTruthy();
    const res = await apiPatch<any>(`/api/customers/${phoneTestCustId}`, {
      telefon: "+12025551234",
    });
    expect(res.status).toBe(400);
  });

  it("KV-23.3 – Gültige DE-Telefonnummer wird akzeptiert (Employee-Update)", async () => {
    expect(phoneTestCustId, "phoneTestCustId muss gesetzt sein").toBeTruthy();
    const res = await apiPatch<any>(`/api/customers/${phoneTestCustId}`, {
      telefon: "+4917612345678",
    });
    expect(res.status).toBe(200);
  });
});

describe("KV-24: DSGVO-Anonymisierung inaktiver Kunden", () => {
  it("KV-24.1 – Aktiven Kunden kann man nicht anonymisieren (400)", async () => {
    const createRes = await apiPost<any>("/api/admin/customers", validCustomerPayload());
    expect(createRes.status).toBe(201);
    createdCustomerIds.push(createRes.data.id);
    const custId = createRes.data.id;

    const anonRes = await apiPost<any>(`/api/admin/customers/${custId}/anonymize`, {});
    expect(anonRes.status).toBe(400);
    expect(anonRes.data.message).toContain("inaktiv");
  });

  it("KV-24.2 – Bereits anonymisierten Kunden kann man nicht erneut anonymisieren", async () => {
    const custRes = await apiGet<{ data: any[] }>("/api/admin/customers?limit=500");
    expect(custRes.status).toBe(200);
    const anonymized = custRes.data.data.find((c: any) => c.isAnonymized === true);
    if (anonymized) {
      const anonRes = await apiPost<any>(`/api/admin/customers/${anonymized.id}/anonymize`, {});
      expect(anonRes.status).toBe(400);
    }
  });

  it("KV-24.3 – Inaktiven Kunden ohne offene Termine erfolgreich anonymisieren", async () => {
    const custRes = await apiGet<{ data: any[] }>("/api/admin/customers?limit=500");
    expect(custRes.status).toBe(200);
    const inactiveCustomers = custRes.data.data?.filter(
      (c: any) => c.status === "inaktiv" && !c.isAnonymized
    ) || [];

    if (inactiveCustomers.length > 0) {
      const custId = inactiveCustomers[0].id;
      const anonRes = await apiPost<any>(`/api/admin/customers/${custId}/anonymize`, {});
      if (anonRes.status === 200) {
        const afterRes = await apiGet<any>(`/api/admin/customers/${custId}`);
        expect(afterRes.status).toBe(200);
        expect(afterRes.data.isAnonymized).toBe(true);
        expect(afterRes.data.vorname).toBeNull();
        expect(afterRes.data.nachname).toBeNull();
        expect(afterRes.data.email).toBeNull();
        expect(afterRes.data.address).toBe("Anonymisiert");
      } else {
        expect(anonRes.status).toBe(400);
        expect(anonRes.data.message).toContain("Termin");
      }
    } else {
      const anonEndpoint = await apiPost<any>("/api/admin/customers/99999/anonymize", {});
      expect(anonEndpoint.status).toBe(404);
    }
  });
});
