const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

interface AuthInfo {
  cookie: string;
  csrfToken: string;
}

interface Customer {
  id: number;
  vorname: string;
  nachname: string;
}

interface Prospect {
  id: number;
  vorname: string;
  nachname: string;
}

async function loginAndGetAuth(): Promise<AuthInfo> {
  const email = process.env.TEST_USER_EMAIL || "alrikdegenkolb@seniorenengel-alltagsbegleitung.de";
  const password = process.env.TEST_USER_PASSWORD || process.env.TEST_USER_PASSWORD_INTERNAL;
  if (!password) throw new Error("TEST_USER_PASSWORD not set");

  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);

  const cookies = res.headers.get("set-cookie") || "";
  const csrfMatch = cookies.match(/careconnect_csrf=([^;]+)/);
  return { cookie: cookies, csrfToken: csrfMatch ? csrfMatch[1] : "" };
}

async function apiDelete(auth: AuthInfo, path: string): Promise<Response> {
  const cookieHeader = `${auth.cookie}; careconnect_csrf=${auth.csrfToken}`;
  return fetch(`${BASE_URL}${path}`, {
    method: "DELETE",
    headers: { Cookie: cookieHeader, "x-csrf-token": auth.csrfToken },
  });
}

async function apiPost(auth: AuthInfo, path: string, body: unknown): Promise<Response> {
  const cookieHeader = `${auth.cookie}; careconnect_csrf=${auth.csrfToken}`;
  return fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Cookie: cookieHeader,
      "x-csrf-token": auth.csrfToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function apiGet(auth: AuthInfo, path: string): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    headers: { Cookie: auth.cookie },
  });
}

function isTestCustomer(c: Customer): boolean {
  const v = (c.vorname || "").toLowerCase();
  const n = (c.nachname || "").toLowerCase();
  return (
    v.includes("test") || n.includes("test") ||
    n.startsWith("auto_") ||
    v.startsWith("sz-") || v.startsWith("pv-") ||
    v.startsWith("fd-") || v.startsWith("eb-") ||
    v.startsWith("pg1-") || v.startsWith("qs-") ||
    n.startsWith("privat-") || n.startsWith("fahrtdienst-") ||
    n.startsWith("integ-")
  );
}

function isTestProspect(p: Prospect): boolean {
  const v = (p.vorname || "").toLowerCase();
  const n = (p.nachname || "").toLowerCase();
  return v.includes("test") || n.includes("test") || v.startsWith("eb-") ||
    v.startsWith("status-") || n.startsWith("eb");
}

export async function setup() {
  if (process.env.NODE_ENV === "production") {
    console.warn("[globalSetup] Skipping cleanup in production environment");
    return;
  }

  console.log("[globalSetup] Cleaning stale test data...");

  let auth: AuthInfo;
  try {
    auth = await loginAndGetAuth();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[globalSetup] Could not login, skipping cleanup:", msg);
    return;
  }

  const custRes = await apiGet(auth, "/api/admin/customers?limit=500");
  if (!custRes.ok) {
    console.warn("[globalSetup] Could not fetch customers, skipping cleanup");
    return;
  }
  const custData: unknown = await custRes.json();
  const customers: Customer[] = Array.isArray(custData)
    ? custData
    : (custData as Record<string, unknown>).data as Customer[] || [];

  const testCustomers = customers.filter(isTestCustomer);

  if (testCustomers.length > 0) {
    console.log(`[globalSetup] Found ${testCustomers.length} stale test customers, purging...`);
    const ids = testCustomers.map(c => c.id);
    const res = await apiPost(auth, "/api/admin/test-cleanup/purge-customers", { ids });
    if (!res.ok) {
      console.warn(`[globalSetup] Bulk purge failed: ${res.status} ${await res.text()}`);
    } else {
      const result = await res.json() as { deleted: number[]; failed: Array<{ id: number; error: string }> };
      console.log(`[globalSetup] Purged ${result.deleted.length}/${testCustomers.length} stale test customers`);
      if (result.failed.length > 0) {
        const sample = result.failed.slice(0, 3).map(f => `${f.id}:${f.error}`).join("; ");
        console.warn(`[globalSetup] ${result.failed.length} purge failures (first 3): ${sample}`);
      }
    }
  }

  const prospRes = await apiGet(auth, "/api/admin/prospects");
  if (prospRes.ok) {
    const prospData: unknown = await prospRes.json();
    const prospects: Prospect[] = Array.isArray(prospData)
      ? prospData
      : (prospData as Record<string, unknown>).data as Prospect[] || [];
    const testProspects = prospects.filter(isTestProspect);

    if (testProspects.length > 0) {
      console.log(`[globalSetup] Found ${testProspects.length} stale test prospects, deleting...`);
      let deleted = 0;
      for (const p of testProspects) {
        const res = await apiDelete(auth, `/api/prospects/${p.id}`);
        if (res.ok) {
          deleted++;
        } else {
          console.warn(`[globalSetup] Failed to delete prospect ${p.id}: ${res.status}`);
        }
      }
      console.log(`[globalSetup] Deleted ${deleted}/${testProspects.length} stale test prospects`);
    }
  }

  console.log("[globalSetup] Cleanup complete");
}
