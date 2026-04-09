const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

async function loginAndGetAuth() {
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

async function apiDelete(auth: { cookie: string; csrfToken: string }, path: string) {
  const cookieHeader = `${auth.cookie}; careconnect_csrf=${auth.csrfToken}`;
  return fetch(`${BASE_URL}${path}`, {
    method: "DELETE",
    headers: { Cookie: cookieHeader, "x-csrf-token": auth.csrfToken },
  });
}

async function apiGet(auth: { cookie: string; csrfToken: string }, path: string) {
  return fetch(`${BASE_URL}${path}`, {
    headers: { Cookie: auth.cookie },
  });
}

export async function setup() {
  console.log("[globalSetup] Cleaning stale test data...");

  let auth: { cookie: string; csrfToken: string };
  try {
    auth = await loginAndGetAuth();
  } catch (e) {
    console.warn("[globalSetup] Could not login, skipping cleanup:", (e as Error).message);
    return;
  }

  const custRes = await apiGet(auth, "/api/admin/customers?limit=500");
  if (!custRes.ok) {
    console.warn("[globalSetup] Could not fetch customers, skipping cleanup");
    return;
  }
  const custData = await custRes.json() as any;
  const customers = Array.isArray(custData) ? custData : custData.data || [];

  const testCustomers = customers.filter((c: any) => {
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
  });

  if (testCustomers.length > 0) {
    console.log(`[globalSetup] Found ${testCustomers.length} stale test customers, deleting...`);
    let deleted = 0;
    for (const c of testCustomers) {
      try {
        const res = await apiDelete(auth, `/api/admin/customers/${c.id}`);
        if (res.ok) deleted++;
      } catch {}
    }
    console.log(`[globalSetup] Deleted ${deleted}/${testCustomers.length} stale test customers`);
  }

  const prospRes = await apiGet(auth, "/api/admin/prospects");
  if (prospRes.ok) {
    const prospData = await prospRes.json() as any;
    const prospects = Array.isArray(prospData) ? prospData : prospData.data || [];
    const testProspects = prospects.filter((p: any) => {
      const v = (p.vorname || "").toLowerCase();
      const n = (p.nachname || "").toLowerCase();
      return v.includes("test") || n.includes("test") || v.startsWith("eb-") ||
        v.startsWith("status-") || n.startsWith("eb");
    });

    if (testProspects.length > 0) {
      console.log(`[globalSetup] Found ${testProspects.length} stale test prospects, deleting...`);
      let deleted = 0;
      for (const p of testProspects) {
        try {
          const res = await apiDelete(auth, `/api/prospects/${p.id}`);
          if (res.ok) deleted++;
        } catch {}
      }
      console.log(`[globalSetup] Deleted ${deleted}/${testProspects.length} stale test prospects`);
    }
  }

  console.log("[globalSetup] Cleanup complete");
}
