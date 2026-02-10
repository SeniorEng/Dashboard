import { describe, it, expect, beforeAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  getAuthCookie,
  uniqueId,
} from "./test-utils";

describe("Kunden (Customers) CRUD", () => {
  let testCustomerId: number;
  let testContactId: number;
  let testInsuranceProviderId: number;
  const testNachname = uniqueId();

  beforeAll(async () => {
    await getAuthCookie();

    const randomIk = String(100000000 + Math.floor(Math.random() * 899999999));
    const providerRes = await apiPost<{ id: number }>("/api/admin/insurance-providers", {
      name: `QS-Testkasse-${testNachname}`,
      ikNummer: randomIk,
    });
    if (providerRes.status === 201) {
      testInsuranceProviderId = providerRes.data.id;
    } else {
      const existingRes = await apiGet<any[]>("/api/admin/insurance-providers");
      if (existingRes.status === 200 && existingRes.data.length > 0) {
        testInsuranceProviderId = existingRes.data[0].id;
      }
    }
  });

  it("GET /api/customers liefert ein Array mit Kunden", async () => {
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

  it("GET /api/customers/:id liefert einzelne Kundendetails", async () => {
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

  it("POST /api/admin/customers erstellt einen neuen Testkunden", async () => {
    const res = await apiPost<any>("/api/admin/customers", {
      vorname: "QS-Test",
      nachname: testNachname,
      geburtsdatum: "1940-01-15",
      strasse: "Teststraße",
      hausnummer: "42",
      plz: "10115",
      stadt: "Berlin",
      mobiltelefon: "+4917612345678",
      insuranceProviderId: testInsuranceProviderId,
      versichertennummer: "A123456789",
      primaryContact: {
        contactType: "familie",
        vorname: "QS-Kontakt",
        nachname: "Test",
        telefon: "+4917699887766",
      },
      pflegegrad: 3,
      pflegegradSeit: "2024-01-01",
      householdSize: 1,
      contractHours: 4,
      contractPeriod: "week",
      hauswirtschaftRate: 30,
      alltagsbegleitungRate: 35,
      kilometerRate: 0.30,
      entlastungsbetrag45b: 125,
      verhinderungspflege39: 0,
      pflegesachleistungen36: 0,
    });
    expect(res.status).toBe(201);
    expect(res.data).toHaveProperty("id");
    expect(res.data.vorname).toBe("QS-Test");
    testCustomerId = res.data.id;
  });

  it("PATCH /api/admin/customers/:id aktualisiert den Kunden", async () => {
    const res = await apiPatch<any>(`/api/admin/customers/${testCustomerId}`, {
      stadt: "München",
    });
    expect(res.status).toBe(200);
    expect(res.data.stadt).toBe("München");
  });

  it("POST /api/admin/customers/:id/care-level aktualisiert den Pflegegrad auf 4", async () => {
    const res = await apiPost<any>(`/api/admin/customers/${testCustomerId}/care-level`, {
      pflegegrad: 4,
      validFrom: "2025-01-01",
    });
    expect(res.status).toBe(201);
    expect(res.data).toHaveProperty("id");
    expect(res.data.pflegegrad).toBe(4);
  });

  it("GET /api/admin/customers/:id/details liefert Detailansicht", async () => {
    const res = await apiGet<any>(`/api/admin/customers/${testCustomerId}/details`);
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("id");
    expect(res.data.id).toBe(testCustomerId);
    expect(res.data.vorname).toBe("QS-Test");
    expect(res.data).toHaveProperty("currentInsurance");
    expect(res.data).toHaveProperty("currentBudgets");
  });

  it("POST /api/admin/customers/:id/contacts fügt eine Kontaktperson hinzu", async () => {
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

  it("GET /api/admin/customers/:id/contacts liefert Kontaktpersonen", async () => {
    const res = await apiGet<any[]>(`/api/admin/customers/${testCustomerId}/contacts`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
    const found = res.data.find((c: any) => c.id === testContactId);
    expect(found).toBeDefined();
    expect(found.vorname).toBe("QS-Kontakt");
  });

  it("DELETE /api/admin/customers/:customerId/contacts/:contactId entfernt die Kontaktperson", async () => {
    const res = await apiDelete(`/api/admin/customers/${testCustomerId}/contacts/${testContactId}`);
    expect(res.status).toBe(200);

    const checkRes = await apiGet<any[]>(`/api/admin/customers/${testCustomerId}/contacts`);
    const found = checkRes.data.find((c: any) => c.id === testContactId);
    expect(found).toBeUndefined();
  });

  describe("Validierung", () => {
    it("POST /api/admin/customers mit fehlenden Pflichtfeldern liefert 400", async () => {
      const res = await apiPost<any>("/api/admin/customers", {
        vorname: "Unvollständig",
      });
      expect(res.status).toBe(400);
    });

    it("POST /api/admin/customers mit pflegegrad 0 liefert 400", async () => {
      const res = await apiPost<any>("/api/admin/customers", {
        vorname: "QS-Test",
        nachname: uniqueId(),
        geburtsdatum: "1940-01-15",
        strasse: "Teststraße",
        hausnummer: "42",
        plz: "10115",
        stadt: "Berlin",
        mobiltelefon: "+4917612345678",
        insuranceProviderId: testInsuranceProviderId,
        versichertennummer: "B123456789",
        primaryContact: {
          contactType: "familie",
          vorname: "Test",
          nachname: "Kontakt",
          telefon: "+4917600000001",
        },
        pflegegrad: 0,
        pflegegradSeit: "2024-01-01",
        householdSize: 1,
        contractHours: 4,
        contractPeriod: "week",
        hauswirtschaftRate: 30,
        alltagsbegleitungRate: 35,
        kilometerRate: 0.30,
        entlastungsbetrag45b: 125,
        verhinderungspflege39: 0,
        pflegesachleistungen36: 0,
      });
      expect(res.status).toBe(400);
    });

    it("POST /api/admin/customers mit pflegegrad 6 liefert 400", async () => {
      const res = await apiPost<any>("/api/admin/customers", {
        vorname: "QS-Test",
        nachname: uniqueId(),
        geburtsdatum: "1940-01-15",
        strasse: "Teststraße",
        hausnummer: "42",
        plz: "10115",
        stadt: "Berlin",
        mobiltelefon: "+4917612345678",
        insuranceProviderId: testInsuranceProviderId,
        versichertennummer: "C123456789",
        primaryContact: {
          contactType: "familie",
          vorname: "Test",
          nachname: "Kontakt",
          telefon: "+4917600000002",
        },
        pflegegrad: 6,
        pflegegradSeit: "2024-01-01",
        householdSize: 1,
        contractHours: 4,
        contractPeriod: "week",
        hauswirtschaftRate: 30,
        alltagsbegleitungRate: 35,
        kilometerRate: 0.30,
        entlastungsbetrag45b: 125,
        verhinderungspflege39: 0,
        pflegesachleistungen36: 0,
      });
      expect(res.status).toBe(400);
    });
  });
});
