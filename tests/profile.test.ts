import { describe, it, expect, beforeAll } from "vitest";
import {
  apiGet,
  apiPatch,
  getAuthCookie,
} from "./test-utils";

beforeAll(async () => {
  await getAuthCookie();
});

describe("PROF-1: Profil laden", () => {
  it("PROF-1.1 – GET /api/profile liefert aktuelle Benutzerdaten", async () => {
    const res = await apiGet<any>("/api/profile");
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("id");
    expect(res.data).toHaveProperty("email");
    expect(res.data).toHaveProperty("displayName");
    expect(res.data).toHaveProperty("roles");
    expect(Array.isArray(res.data.roles)).toBe(true);
  });

  it("PROF-1.2 – Profil enthält keine sensiblen Felder (Passwort)", async () => {
    const res = await apiGet<any>("/api/profile");
    expect(res.status).toBe(200);
    expect(res.data).not.toHaveProperty("password");
    expect(res.data).not.toHaveProperty("passwordHash");
  });
});

describe("PROF-2: Profil bearbeiten", () => {
  it("PROF-2.1 – PATCH aktualisiert Adressfelder", async () => {
    const res = await apiPatch<any>("/api/profile", {
      stadt: "Berlin",
    });
    expect(res.status).toBe(200);
    expect(res.data.stadt).toBe("Berlin");
  });

  it("PROF-2.2 – Ungültige E-Mail wird abgelehnt", async () => {
    const res = await apiPatch<any>("/api/profile", {
      email: "keine-email",
    });
    expect(res.status).toBe(400);
  });

  it("PROF-2.3 – Leere Felder werden akzeptiert", async () => {
    const res = await apiPatch<any>("/api/profile", {
      notfallkontaktName: "",
    });
    expect(res.status).toBe(200);
  });
});

describe("PROF-3: Dokumententypen und Dokumente", () => {
  it("PROF-3.1 – GET document-types liefert Array", async () => {
    const res = await apiGet<any[]>("/api/profile/document-types");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });

  it("PROF-3.2 – GET documents liefert Dokumente", async () => {
    const res = await apiGet<any>("/api/profile/documents");
    expect(res.status).toBe(200);
  });

  it("PROF-3.3 – GET grouped documents liefert Gruppenstruktur", async () => {
    const res = await apiGet<any>("/api/profile/documents?grouped=true");
    expect(res.status).toBe(200);
  });
});

describe("PROF-4: Nachweise", () => {
  it("PROF-4.1 – GET proofs liefert Nachweise", async () => {
    const res = await apiGet<any[]>("/api/profile/proofs");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });

  it("PROF-4.2 – GET pending-count liefert Zahl", async () => {
    const res = await apiGet<any>("/api/profile/proofs/pending-count");
    expect(res.status).toBe(200);
    expect(typeof res.data.count).toBe("number");
  });
});
