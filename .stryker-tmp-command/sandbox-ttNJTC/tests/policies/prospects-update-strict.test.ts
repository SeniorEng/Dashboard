/**
 * Task #677 — Mass-Assignment-Schutz für PATCH /api/admin/prospects/:id.
 *
 * Das Update-Schema ist `.strict()`. Wenn ein Client Felder mitschickt, die
 * NICHT zur erlaubten Whitelist gehören (z.B. `id`, `createdAt`, `deletedAt`,
 * `updatedAt`), MUSS der Server mit 400 antworten und der Datensatz darf
 * NICHT mutiert werden.
 */
// @ts-nocheck


import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { apiPost, apiPatch, apiGet, apiDelete, uniqueId } from "../test-utils";

describe("PATCH /api/admin/prospects/:id — strict-Schema (Mass-Assignment)", () => {
  let prospectId: number;

  beforeAll(async () => {
    const created = await apiPost<{ id: number }>("/api/admin/prospects", {
      vorname: "MassAssign",
      nachname: `Test_${uniqueId()}`,
      telefon: null,
      email: null,
    });
    expect([200, 201], JSON.stringify(created.data)).toContain(created.status);
    prospectId = created.data.id;
  });

  afterAll(async () => {
    if (prospectId) {
      try { await apiDelete(`/api/admin/prospects/${prospectId}`); } catch {}
    }
  });

  it("Extra-Feld `id` → 400, kein Side-Effect", async () => {
    const before = await apiGet<any>(`/api/admin/prospects/${prospectId}`);
    expect(before.status).toBe(200);

    const res = await apiPatch(`/api/admin/prospects/${prospectId}`, {
      statusNotiz: "wird-nicht-gespeichert",
      id: 999999,
    });
    expect(res.status).toBe(400);

    const after = await apiGet<any>(`/api/admin/prospects/${prospectId}`);
    expect(after.status).toBe(200);
    expect(after.data.id).toBe(prospectId);
    expect(after.data.statusNotiz).toBe(before.data.statusNotiz);
  });

  it("Extra-Feld `deletedAt` → 400, Prospect bleibt aktiv", async () => {
    const res = await apiPatch(`/api/admin/prospects/${prospectId}`, {
      deletedAt: new Date().toISOString(),
    });
    expect(res.status).toBe(400);

    const after = await apiGet<any>(`/api/admin/prospects/${prospectId}`);
    expect(after.status).toBe(200);
    expect(after.data.deletedAt).toBeFalsy();
  });

  it("Extra-Feld `createdAt` → 400", async () => {
    const res = await apiPatch(`/api/admin/prospects/${prospectId}`, {
      createdAt: "2000-01-01T00:00:00.000Z",
    });
    expect(res.status).toBe(400);
  });

  it("Extra-Feld `convertedCustomerId` → 400 (Convert läuft nur über Convert-Route)", async () => {
    const res = await apiPatch(`/api/admin/prospects/${prospectId}`, {
      convertedCustomerId: 999999,
    });
    expect(res.status).toBe(400);

    const after = await apiGet<any>(`/api/admin/prospects/${prospectId}`);
    expect(after.status).toBe(200);
    expect(after.data.convertedCustomerId).toBeFalsy();
  });

  it("Extra-Feld `geoQualified` → 400 (Qualify läuft nur über /qualify)", async () => {
    const res = await apiPatch(`/api/admin/prospects/${prospectId}`, {
      geoQualified: true,
    });
    expect(res.status).toBe(400);
  });

  it("Extra-Feld `rawEmailContent` → 400 (nur Lead-Import schreibt das)", async () => {
    const res = await apiPatch(`/api/admin/prospects/${prospectId}`, {
      rawEmailContent: "injected",
    });
    expect(res.status).toBe(400);
  });

  it("Extra-Feld `assignedEmployeeId` → 400 (kein UI-Edit-Pfad)", async () => {
    const res = await apiPatch(`/api/admin/prospects/${prospectId}`, {
      assignedEmployeeId: 1,
    });
    expect(res.status).toBe(400);
  });

  it("Extra-Feld `isSuperAdmin` (Privilege-Escalation) → 400", async () => {
    const res = await apiPatch(`/api/admin/prospects/${prospectId}`, {
      isSuperAdmin: true,
    });
    expect(res.status).toBe(400);
  });

  it("Erlaubtes Feld (`statusNotiz`) alleine → 200", async () => {
    const note = `note-${uniqueId()}`;
    const res = await apiPatch<any>(`/api/admin/prospects/${prospectId}`, {
      statusNotiz: note,
    });
    expect(res.status).toBe(200);
    expect(res.data.statusNotiz).toBe(note);
  });
});
