import { describe, it, expect, beforeAll } from "vitest";
import {
  apiGet,
  apiPost,
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
