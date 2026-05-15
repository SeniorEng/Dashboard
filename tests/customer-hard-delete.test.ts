import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiDelete,
  apiPatch,
  getAuthCookie,
  uniqueId,
  createTestCustomer,
} from "./test-utils";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
const trackedIds: number[] = [];

beforeAll(async () => {
  auth = await getAuthCookie();
});

afterAll(async () => {
  for (const id of trackedIds) {
    try {
      await apiDelete(`/api/admin/customers/${id}`);
    } catch {}
  }
});

async function deleteCustomerWithBody(
  id: number,
  body: {
    reason: string;
    confirmName: string;
    hardDelete?: boolean;
    complianceOfficerSignoff?: string;
  },
) {
  const cookieHeader = `${auth.cookie}; careconnect_csrf=${auth.csrfToken}`;
  const response = await fetch(`${BASE_URL}/api/admin/customers/${id}`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader,
      "x-csrf-token": auth.csrfToken,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

describe("KV-25: Hard-Delete Karteileichen (SuperAdmin)", () => {
  it("KV-25.1 – Readiness liefert ready=true für leeren neuen Kunden", async () => {
    const c = await createTestCustomer({
      vorname: "Karteileiche",
      nachname: "Empty-" + uniqueId(),
    });
    trackedIds.push(c.id as number);

    const res = await apiGet<{ ready: boolean; checks: Array<{ key: string; met: boolean; count: number }> }>(
      `/api/admin/customers/${c.id}/hard-delete-readiness`
    );
    expect(res.status).toBe(200);
    expect(res.data.ready).toBe(true);
    expect(res.data.checks.length).toBeGreaterThanOrEqual(6);
    for (const check of res.data.checks) {
      expect(check.met).toBe(true);
      expect(check.count).toBe(0);
    }
  });

  it("KV-25.2 – Readiness gibt 404 für unbekannten Kunden", async () => {
    const res = await apiGet<{ message: string }>(`/api/admin/customers/99999999/hard-delete-readiness`);
    expect(res.status).toBe(404);
  });

  it("KV-25.3 – DELETE ohne Grund/Name wird mit 400 abgelehnt", async () => {
    const c = await createTestCustomer({
      vorname: "Karteileiche",
      nachname: "NoReason-" + uniqueId(),
    });
    trackedIds.push(c.id as number);

    const res = await deleteCustomerWithBody(c.id as number, { reason: "", confirmName: "" });
    expect(res.status).toBe(400);
  });

  it("KV-25.4 – DELETE mit falschem Bestätigungsnamen wird mit 400 abgelehnt", async () => {
    const c = await createTestCustomer({
      vorname: "Karteileiche",
      nachname: "WrongName-" + uniqueId(),
    });
    trackedIds.push(c.id as number);

    const res = await deleteCustomerWithBody(c.id as number, {
      reason: "Test-Löschung wegen Dublette",
      confirmName: "Falscher Name",
    });
    expect(res.status).toBe(400);
    expect(res.data?.message).toContain("Name");
  });

  it("KV-25.6 – hardDelete=true mit vorhandener Aufgabe wird mit 409 (Readiness) blockiert", async () => {
    const c = await createTestCustomer({
      vorname: "Karteileiche",
      nachname: "WithTask-" + uniqueId(),
    }) as { id: number; name: string };
    trackedIds.push(c.id);

    const taskRes = await apiPost<{ id: number }>("/api/tasks", {
      title: `Hard-Delete-Block-Test ${uniqueId()}`,
      priority: "low",
      customerId: c.id,
    });
    expect(taskRes.status).toBe(201);

    const readiness = await apiGet<{ ready: boolean; checks: Array<{ key: string; met: boolean; count: number }> }>(
      `/api/admin/customers/${c.id}/hard-delete-readiness`
    );
    expect(readiness.status).toBe(200);
    expect(readiness.data.ready).toBe(false);

    const delRes = await deleteCustomerWithBody(c.id, {
      reason: "Versuch trotz offener Aufgabe",
      confirmName: c.name,
      hardDelete: true,
      complianceOfficerSignoff: "Compliance-Freigabe für Audit-Test #448",
    });
    expect(delRes.status).toBe(409);
    expect(delRes.data?.details?.checks?.find((x: { key: string }) => x.key === "noTasks")?.met).toBe(false);

    // Cleanup task
    await apiDelete(`/api/tasks/${taskRes.data.id}`);
  });

  it("KV-25.7 – Race (hardDelete=true): Aufgabe wird zwischen Readiness und DELETE angelegt → 409", async () => {
    const c = await createTestCustomer({
      vorname: "Karteileiche",
      nachname: "Race-" + uniqueId(),
    }) as { id: number; name: string };
    trackedIds.push(c.id);

    const readiness = await apiGet<{ ready: boolean }>(
      `/api/admin/customers/${c.id}/hard-delete-readiness`
    );
    expect(readiness.data.ready).toBe(true);

    const taskRes = await apiPost<{ id: number }>("/api/tasks", {
      title: `Race-Insert ${uniqueId()}`,
      priority: "low",
      customerId: c.id,
    });
    expect(taskRes.status).toBe(201);

    const delRes = await deleteCustomerWithBody(c.id, {
      reason: "Race-Test",
      confirmName: c.name,
      hardDelete: true,
      complianceOfficerSignoff: "Compliance-Freigabe für Audit-Test #448",
    });
    expect(delRes.status).toBe(409);

    const stillThere = await apiGet(`/api/admin/customers/${c.id}/hard-delete-readiness`);
    expect(stillThere.status).toBe(200);

    await apiDelete(`/api/tasks/${taskRes.data.id}`);
  });

  it("KV-25.5 – Default-Pfad (soft): leerer Kunde wird gelöscht und Audit-Eintrag geschrieben", async () => {
    const c = await createTestCustomer({
      vorname: "Karteileiche",
      nachname: "Success-" + uniqueId(),
    }) as { id: number; name: string };
    trackedIds.push(c.id);

    const res = await deleteCustomerWithBody(c.id, {
      reason: "Doppel-Anlage, nie genutzt",
      confirmName: c.name,
    });
    expect(res.status).toBe(200);
    expect(res.data?.success).toBe(true);
    expect(res.data?.audit?.parentDeletionId).toBeGreaterThan(0);

    const auditRes = await apiGet<{ entries: Array<{ action: string; entityId: number; metadata: Record<string, unknown> }> }>(
      `/api/admin/audit-log?action=customer_soft_deleted&entityType=customer`
    );
    expect(auditRes.status).toBe(200);
    const entry = auditRes.data.entries.find((e) => e.entityId === c.id);
    expect(entry).toBeTruthy();
    expect(entry?.metadata?.customerName).toBe(c.name);
    expect(entry?.metadata?.reason).toBe("Doppel-Anlage, nie genutzt");
    expect(entry?.metadata?.hardDelete).toBe(false);
  });

  it("KV-25.8 – Default-Pfad: Kunde mit Aufgabe wird soft-gelöscht und schreibt Per-Child-Audit mit parentDeletionId", async () => {
    const c = await createTestCustomer({
      vorname: "Karteileiche",
      nachname: "Cascade-" + uniqueId(),
    }) as { id: number; name: string };

    const taskRes = await apiPost<{ id: number }>("/api/tasks", {
      title: `Cascade-Audit-Test ${uniqueId()}`,
      priority: "low",
      customerId: c.id,
    });
    expect(taskRes.status).toBe(201);

    const res = await deleteCustomerWithBody(c.id, {
      reason: "Soft-Cascade-Audit-Test",
      confirmName: c.name,
    });
    expect(res.status).toBe(200);
    expect(res.data?.success).toBe(true);
    expect(res.data?.audit?.parentDeletionId).toBeGreaterThan(0);
    expect(res.data?.audit?.childAudits).toBeGreaterThanOrEqual(1);
    expect(res.data?.audit?.perTable?.tasks).toBeGreaterThanOrEqual(1);

    const parentDeletionId = res.data?.audit?.parentDeletionId as number;

    // Pro Child muss ein Audit-Eintrag mit parentDeletionId existieren.
    const childAuditRes = await apiGet<{ entries: Array<{ id: number; action: string; entityType: string; entityId: number; metadata: Record<string, unknown> }> }>(
      `/api/admin/audit-log?action=customer_child_soft_deleted`
    );
    expect(childAuditRes.status).toBe(200);
    const childEntries = childAuditRes.data.entries.filter(
      (e) => (e.metadata?.customerId as number | undefined) === c.id,
    );
    expect(childEntries.length).toBeGreaterThanOrEqual(1);
    const taskChildAudit = childEntries.find((e) => e.metadata?.childTable === "tasks");
    expect(taskChildAudit).toBeTruthy();
    expect(taskChildAudit?.entityId).toBe(taskRes.data.id);
  });

  it("KV-25.9 – Hard-Delete erfordert Compliance-Officer-Signoff (≥10 Zeichen)", async () => {
    const c = await createTestCustomer({
      vorname: "Karteileiche",
      nachname: "Signoff-" + uniqueId(),
    }) as { id: number; name: string };
    trackedIds.push(c.id);

    const tooShort = await deleteCustomerWithBody(c.id, {
      reason: "Hard-Delete-Eskalation",
      confirmName: c.name,
      hardDelete: true,
      complianceOfficerSignoff: "kurz",
    });
    expect(tooShort.status).toBe(400);

    const missing = await deleteCustomerWithBody(c.id, {
      reason: "Hard-Delete-Eskalation",
      confirmName: c.name,
      hardDelete: true,
    });
    expect(missing.status).toBe(400);
  });
});
