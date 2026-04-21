import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiDelete,
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

async function deleteCustomerWithBody(id: number, body: { reason: string; confirmName: string }) {
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

  it("KV-25.5 – Erfolgsfall: leerer Kunde wird gelöscht und Audit-Eintrag geschrieben", async () => {
    const c = await createTestCustomer({
      vorname: "Karteileiche",
      nachname: "Success-" + uniqueId(),
    }) as { id: number; name: string };

    const res = await deleteCustomerWithBody(c.id, {
      reason: "Doppel-Anlage, nie genutzt",
      confirmName: c.name,
    });
    expect(res.status).toBe(200);
    expect(res.data?.success).toBe(true);

    const after = await apiGet(`/api/admin/customers/${c.id}/hard-delete-readiness`);
    expect(after.status).toBe(404);

    const auditRes = await apiGet<{ entries: Array<{ action: string; entityId: number; metadata: Record<string, unknown> }> }>(
      `/api/admin/audit-log?action=customer_hard_deleted&entityType=customer`
    );
    expect(auditRes.status).toBe(200);
    const entry = auditRes.data.entries.find((e) => e.entityId === c.id);
    expect(entry).toBeTruthy();
    expect(entry?.metadata?.customerName).toBe(c.name);
    expect(entry?.metadata?.reason).toBe("Doppel-Anlage, nie genutzt");
  });
});
