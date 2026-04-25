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

interface User {
  id: number;
  email: string;
  nachname: string;
}

interface Service {
  id: number;
  name: string;
}

async function loginAndGetAuth(): Promise<AuthInfo> {
  const email = process.env.TEST_USER_EMAIL || "alrikdegenkolb@seniorenengel-alltagsbegleitung.de";
  const password = process.env.TEST_USER_PASSWORD || process.env.TEST_USER_PASSWORD_INTERNAL;
  if (!password) throw new Error("TEST_USER_PASSWORD not set");

  let res: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (res.status !== 429) break;
    const delay = 1500 * Math.pow(2, attempt);
    console.warn(`[globalSetup] 429 on login, retry in ${delay}ms`);
    await new Promise((r) => setTimeout(r, delay));
  }
  if (!res || !res.ok) throw new Error(`Login failed: ${res?.status ?? "no response"}`);

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

function isTestUser(u: User): boolean {
  const e = (u.email || "").toLowerCase();
  const n = (u.nachname || "").toLowerCase();
  return e.endsWith("@test.local") || e.startsWith("testemp-") || n.startsWith("testemp_");
}

function isTestService(s: Service): boolean {
  const n = (s.name || "").toLowerCase();
  return n.includes("_test_") || n.includes("test") ||
    n.startsWith("auto-") || n.startsWith("integ-") ||
    n.startsWith("fd-") || n.startsWith("pv-") || n.startsWith("sz-") ||
    n.startsWith("eb-") || n.startsWith("pg1-") || n.startsWith("qs-") ||
    n.startsWith("status-");
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

  // Step 3: Purge stale time-entries and admin-assigned appointments in the
  // far-future test pollution window. Tests like TE-BIZ-3 (offset 260+) and
  // EB-5.2 (offset 280) need a clean calendar window for the test admin.
  // The near future (next 30 days) is preserved so any near-term planning data
  // is not wiped. The window extends to ~2.5 years out which covers all
  // far-future offsets used by the test suite (max ~680 + buffer).
  try {
    const calRes = await apiPost(auth, "/api/admin/test-cleanup/purge-admin-calendar-range", {
      startOffsetDays: 30,
      endOffsetDays: 900,
    });
    if (calRes.ok) {
      const result = await calRes.json() as {
        timeEntriesDeleted: number;
        appointmentsDeleted: number;
        startDate: string;
        endDate: string;
      };
      console.log(`[globalSetup] Purged ${result.timeEntriesDeleted} stale time-entries and ${result.appointmentsDeleted} stale admin appointments in [${result.startDate}, ${result.endDate}]`);
    } else {
      console.warn(`[globalSetup] Calendar purge failed: ${calRes.status} ${await calRes.text()}`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[globalSetup] Calendar purge errored: ${msg}`);
  }

  // Schritt 4: Test-User aufräumen (Domain @test.local oder testemp- Prefix)
  try {
    const userRes = await apiGet(auth, "/api/admin/users?limit=1000");
    if (userRes.ok) {
      const userData: unknown = await userRes.json();
      const allUsers: User[] = Array.isArray(userData)
        ? userData
        : (userData as Record<string, unknown>).data as User[] || [];
      const testUsers = allUsers.filter(isTestUser);
      if (testUsers.length > 0) {
        console.log(`[globalSetup] Found ${testUsers.length} stale test users, purging...`);
        const ids = testUsers.map((u) => u.id);
        for (let i = 0; i < ids.length; i += 100) {
          const batch = ids.slice(i, i + 100);
          const res = await apiPost(auth, "/api/admin/test-cleanup/purge-test-users", { ids: batch });
          if (!res.ok) {
            console.warn(`[globalSetup] User purge batch failed: ${res.status} ${await res.text()}`);
            break;
          }
        }
        console.log(`[globalSetup] Test-User-Cleanup abgeschlossen`);
      }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[globalSetup] User purge errored: ${msg}`);
  }

  // Schritt 5: Test-Services aufräumen (Name enthält _test_ etc.)
  try {
    const svcRes = await apiGet(auth, "/api/services");
    if (svcRes.ok) {
      const svcData: unknown = await svcRes.json();
      const allServices: Service[] = Array.isArray(svcData)
        ? svcData
        : (svcData as Record<string, unknown>).data as Service[] || [];
      const testServices = allServices.filter(isTestService);
      if (testServices.length > 0) {
        console.log(`[globalSetup] Found ${testServices.length} stale test services, purging unreferenced...`);
        const ids = testServices.map((s) => s.id);
        for (let i = 0; i < ids.length; i += 100) {
          const batch = ids.slice(i, i + 100);
          const res = await apiPost(auth, "/api/admin/test-cleanup/purge-test-services", { ids: batch });
          if (!res.ok) {
            console.warn(`[globalSetup] Service purge batch failed: ${res.status} ${await res.text()}`);
            break;
          }
        }
        console.log(`[globalSetup] Test-Service-Cleanup abgeschlossen`);
      }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[globalSetup] Service purge errored: ${msg}`);
  }

  console.log("[globalSetup] Cleanup complete");
}
