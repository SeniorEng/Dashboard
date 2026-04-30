import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiPut,
  getAuthCookie,
} from "./test-utils";

beforeAll(async () => {
  await getAuthCookie();
});

describe("DOC-1: Dokumententypen", () => {
  it("DOC-1.1 – GET /api/admin/document-types liefert Typen", async () => {
    const res = await apiGet<any[]>("/api/admin/document-types");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });

  it("DOC-1.2 – Dokumententypen haben Pflichtfelder", async () => {
    const res = await apiGet<any[]>("/api/admin/document-types");
    expect(res.status).toBe(200);
    if (res.data.length > 0) {
      const type = res.data[0];
      expect(type).toHaveProperty("id");
      expect(type).toHaveProperty("name");
      expect(type).toHaveProperty("targetType");
    }
  });
});

describe("DOC-2: Mitarbeiterdokumente über Profil", () => {
  it("DOC-2.1 – GET /api/profile/documents liefert eigene Dokumente", async () => {
    const res = await apiGet<any>("/api/profile/documents");
    expect(res.status).toBe(200);
  });

  it("DOC-2.2 – GET grouped Dokumente liefert Gruppenstruktur", async () => {
    const res = await apiGet<any>("/api/profile/documents?grouped=true");
    expect(res.status).toBe(200);
  });
});

describe("DOC-3: Dokument-Upload Validierung", () => {
  it("DOC-3.1 – Upload ohne Pflichtfelder wird abgelehnt", async () => {
    const res = await apiPost<any>("/api/profile/documents", {});
    expect(res.status).toBe(400);
  });

  it("DOC-3.2 – Upload mit ungültigem Dokumententyp wird abgelehnt", async () => {
    const res = await apiPost<any>("/api/profile/documents", {
      documentTypeId: 999999,
      fileName: "test.pdf",
      objectPath: "/test/path.pdf",
    });
    expect(res.status).toBe(400);
  });
});

describe("DOC-4: Fällige Dokumente und Nachweise", () => {
  it("DOC-4.1 – GET /api/profile/proofs liefert Nachweisliste", async () => {
    const res = await apiGet<any[]>("/api/profile/proofs");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });

  it("DOC-4.2 – GET pending-count liefert ausstehende Zahl", async () => {
    const res = await apiGet<any>("/api/profile/proofs/pending-count");
    expect(res.status).toBe(200);
    expect(typeof res.data.count).toBe("number");
  });
});

describe("DOC-6: Vertragsabschluss-Kontext im Anforderungs-Motor", () => {
  const createdTypeIds: number[] = [];

  async function createCustomerDocType(overrides: Record<string, unknown>): Promise<{ id: number; [key: string]: unknown }> {
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 7);
    const payload = {
      name: `DOC6_${ts}_${rand}`,
      targetType: "customer",
      inputMethod: "upload",
      isMandatory: false,
      isActive: true,
      ...overrides,
    };
    const res = await apiPost<any>("/api/admin/document-types", payload);
    expect(res.status).toBe(201);
    createdTypeIds.push(res.data.id);
    return res.data;
  }

  afterAll(async () => {
    for (const id of createdTypeIds) {
      try {
        await apiPatch(`/api/admin/document-types/${id}`, { isActive: false });
      } catch {}
    }
  });

  it("DOC-6.1 – Vertragsabschluss-Dokument ohne Trigger erscheint als optionale Anforderung", async () => {
    const docType = await createCustomerDocType({ context: "vertragsabschluss" });

    const res = await apiGet<any[]>("/api/customers/document-requirements/pflegekasse_gesetzlich");
    expect(res.status).toBe(200);

    const found = res.data.find((r) => r.documentType.id === docType.id);
    expect(found).toBeDefined();
    expect(found.requirement).toBe("optional");
    expect(found.triggeredBy).toBe("Vertragsabschluss-Dokument");
  });

  it("DOC-6.2 – Bestandskunden-Dokument erscheint nicht in Vertragsabschluss-Anforderungen", async () => {
    const docType = await createCustomerDocType({ context: "bestandskunde" });

    const res = await apiGet<any[]>("/api/customers/document-requirements/privat");
    expect(res.status).toBe(200);

    const found = res.data.find((r) => r.documentType.id === docType.id);
    expect(found).toBeUndefined();
  });

  it("DOC-6.3 – Mitarbeiter-Anforderungen sind vom Kunden-Kontext nicht betroffen", async () => {
    const docType = await createCustomerDocType({ context: "vertragsabschluss" });

    const auth = await getAuthCookie();
    const res = await apiGet<any[]>(`/api/admin/document-requirements/employee/${auth.user.id}`);
    expect(res.status).toBe(200);

    const found = res.data.find((r) => r.documentType.id === docType.id);
    expect(found).toBeUndefined();
  });

  it("DOC-6.4 – Dokumententyp mit Trigger UND passendem Kontext erscheint nur einmal", async () => {
    const docType = await createCustomerDocType({ context: "vertragsabschluss" });

    const triggerRes = await apiPut<any>(`/api/admin/document-types/${docType.id}/triggers`, {
      triggers: [{
        entityType: "customer",
        triggerType: "field_match",
        conditionField: "billingType",
        conditionOperator: "equals",
        conditionValue: "pflegekasse_gesetzlich",
        requirement: "pflicht",
        sortOrder: 0,
        isActive: true,
      }],
    });
    expect(triggerRes.status).toBe(200);

    const res = await apiGet<any[]>("/api/customers/document-requirements/pflegekasse_gesetzlich");
    expect(res.status).toBe(200);

    const matches = res.data.filter((r) => r.documentType.id === docType.id);
    expect(matches.length).toBe(1);
    expect(matches[0].requirement).toBe("pflicht");
    expect(matches[0].triggeredBy).not.toBe("Vertragsabschluss-Dokument");
  });

  it("DOC-6.5 – Kontext 'beide' erscheint ebenfalls als optionale Anforderung im Wizard", async () => {
    const docType = await createCustomerDocType({ context: "beide" });

    const res = await apiGet<any[]>("/api/customers/document-requirements/privat");
    expect(res.status).toBe(200);

    const found = res.data.find((r) => r.documentType.id === docType.id);
    expect(found).toBeDefined();
    expect(found.requirement).toBe("optional");
    expect(found.triggeredBy).toBe("Allgemein verfügbar");
  });
});

describe("DOC-5: Dokumentenhistorie", () => {
  it("DOC-5.1 – Dokumentenhistorie für existierenden Typ", async () => {
    const typesRes = await apiGet<any[]>("/api/admin/document-types");
    if (typesRes.data.length > 0) {
      const typeId = typesRes.data[0].id;
      const res = await apiGet<any[]>(`/api/profile/documents/${typeId}/history`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data)).toBe(true);
    }
  });
});
