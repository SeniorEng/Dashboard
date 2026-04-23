import { describe, it, expect, beforeAll, afterAll } from "vitest";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const TEST_EMAIL = process.env.TEST_USER_EMAIL || "alrikdegenkolb@seniorenengel-alltagsbegleitung.de";
const TEST_PASSWORD = process.env.TEST_USER_PASSWORD || process.env.TEST_USER_PASSWORD_INTERNAL;

interface TestUser {
  id: number;
  email: string;
  isAdmin: boolean;
  displayName: string;
}

interface AuthCookie {
  cookie: string;
  user: TestUser;
  csrfToken: string;
}

let authCookie: AuthCookie | null = null;

export async function getAuthCookie(): Promise<AuthCookie> {
  if (authCookie) return authCookie;

  if (!TEST_PASSWORD) {
    throw new Error("TEST_USER_PASSWORD Umgebungsvariable muss gesetzt sein. Setze sie mit: export TEST_USER_PASSWORD='dein_passwort'");
  }

  const loginResponse = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    }),
  });

  if (!loginResponse.ok) {
    throw new Error(`Login failed: ${loginResponse.status}`);
  }

  const cookies = loginResponse.headers.get("set-cookie") || "";
  const csrfMatch = cookies.match(/careconnect_csrf=([^;]+)/);
  const csrfToken = csrfMatch ? csrfMatch[1] : "";
  
  if (!csrfToken) {
    throw new Error("CSRF-Token nicht in Cookies gefunden");
  }
  
  const userData = await loginResponse.json();

  authCookie = {
    cookie: cookies,
    user: userData.user,
    csrfToken,
  };

  return authCookie;
}

export function resetAuthCache(): void {
  authCookie = null;
}

export async function loginAs(email: string, password: string): Promise<AuthCookie> {
  const loginResponse = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!loginResponse.ok) {
    throw new Error(`Login as ${email} failed: ${loginResponse.status}`);
  }

  const cookies = loginResponse.headers.get("set-cookie") || "";
  const csrfMatch = cookies.match(/careconnect_csrf=([^;]+)/);
  const csrfToken = csrfMatch ? csrfMatch[1] : "";

  const userData = await loginResponse.json();

  return {
    cookie: cookies,
    user: userData.user,
    csrfToken,
  };
}

const MAX_RETRIES = 5;
const BACKOFF_BASE_MS = 1500;

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  const method = init.method || "GET";
  const path = url.replace(BASE_URL, "");
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url, init);
    if (response.status !== 429) {
      return response;
    }
    if (attempt === MAX_RETRIES) {
      throw new Error(`Rate limit exceeded after ${MAX_RETRIES} retries for ${method} ${path}`);
    }
    const delay = BACKOFF_BASE_MS * Math.pow(2, attempt);
    console.warn(`[test-utils] 429 on ${method} ${path}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
    await new Promise((r) => setTimeout(r, delay));
  }
  throw new Error(`Rate limit exceeded after ${MAX_RETRIES} retries for ${method} ${path}`);
}

export async function apiGetAs<T = unknown>(auth: AuthCookie, path: string): Promise<{ status: number; data: T }> {
  const response = await fetchWithRetry(`${BASE_URL}${path}`, {
    headers: { Cookie: auth.cookie },
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data: data as T };
}

export async function apiPostAs<T = unknown>(auth: AuthCookie, path: string, body: unknown): Promise<{ status: number; data: T }> {
  const cookieHeader = `${auth.cookie}; careconnect_csrf=${auth.csrfToken}`;
  const response = await fetchWithRetry(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader,
      "x-csrf-token": auth.csrfToken,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data: data as T };
}

export async function apiPatchAs<T = unknown>(auth: AuthCookie, path: string, body: unknown): Promise<{ status: number; data: T }> {
  const cookieHeader = `${auth.cookie}; careconnect_csrf=${auth.csrfToken}`;
  const response = await fetchWithRetry(`${BASE_URL}${path}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader,
      "x-csrf-token": auth.csrfToken,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data: data as T };
}

export async function apiPutAs<T = unknown>(auth: AuthCookie, path: string, body: unknown): Promise<{ status: number; data: T }> {
  const cookieHeader = `${auth.cookie}; careconnect_csrf=${auth.csrfToken}`;
  const response = await fetchWithRetry(`${BASE_URL}${path}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader,
      "x-csrf-token": auth.csrfToken,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data: data as T };
}

export async function apiDeleteAs(auth: AuthCookie, path: string): Promise<{ status: number; data: unknown }> {
  const cookieHeader = `${auth.cookie}; careconnect_csrf=${auth.csrfToken}`;
  const response = await fetchWithRetry(`${BASE_URL}${path}`, {
    method: "DELETE",
    headers: {
      Cookie: cookieHeader,
      "x-csrf-token": auth.csrfToken,
    },
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

export async function apiGet<T = unknown>(path: string): Promise<{ status: number; data: T }> {
  const auth = await getAuthCookie();
  return apiGetAs<T>(auth, path);
}

export async function apiPost<T = unknown>(
  path: string,
  body: unknown
): Promise<{ status: number; data: T }> {
  const auth = await getAuthCookie();
  return apiPostAs<T>(auth, path, body);
}

export async function apiPatch<T = unknown>(
  path: string,
  body: unknown
): Promise<{ status: number; data: T }> {
  const auth = await getAuthCookie();
  const cookieHeader = `${auth.cookie}; careconnect_csrf=${auth.csrfToken}`;
  const response = await fetchWithRetry(`${BASE_URL}${path}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader,
      "x-csrf-token": auth.csrfToken,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data: data as T };
}

export async function apiPut<T = unknown>(
  path: string,
  body: unknown
): Promise<{ status: number; data: T }> {
  const auth = await getAuthCookie();
  const cookieHeader = `${auth.cookie}; careconnect_csrf=${auth.csrfToken}`;
  const response = await fetchWithRetry(`${BASE_URL}${path}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader,
      "x-csrf-token": auth.csrfToken,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data: data as T };
}

export async function apiDelete(path: string): Promise<{ status: number; data: unknown }> {
  const auth = await getAuthCookie();
  const cookieHeader = `${auth.cookie}; careconnect_csrf=${auth.csrfToken}`;
  const response = await fetchWithRetry(`${BASE_URL}${path}`, {
    method: "DELETE",
    headers: {
      Cookie: cookieHeader,
      "x-csrf-token": auth.csrfToken,
    },
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

export function getFutureDate(daysFromNow: number = 7): string {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  const dayOfWeek = date.getDay();
  if (dayOfWeek === 0) date.setDate(date.getDate() + 1);
  else if (dayOfWeek === 6) date.setDate(date.getDate() + 2);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getPastDate(daysAgo: number = 1): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getTodayDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getTimeString(hoursFromNow: number = 0): string {
  const date = new Date();
  date.setHours(date.getHours() + hoursFromNow);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

export function uniqueId(): string {
  return `test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export async function createTestEmployee(opts: { isAdmin?: boolean; nachnamePrefix?: string } = {}): Promise<{ id: number; email: string; password: string }> {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 7);
  const email = `testemp-${ts}-${rand}@test.local`;
  const password = "TestPasswort123!";
  const phoneSuffix = String(ts).slice(-9).padStart(9, "0");
  const prefix = opts.nachnamePrefix || "TestEmp";
  const res = await apiPost<any>("/api/admin/users", {
    email,
    password,
    vorname: "Test",
    nachname: `${prefix}_${ts}_${rand}`,
    geburtsdatum: "1990-01-01",
    eintrittsdatum: "2024-01-01",
    isAdmin: opts.isAdmin ?? false,
    telefon: `+49170${phoneSuffix}`,
  });
  if (res.status !== 201) {
    throw new Error(`createTestEmployee failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return { id: res.data.id, email, password };
}

export async function deactivateTestEmployee(id: number | null | undefined): Promise<void> {
  if (!id) return;
  try {
    await apiPost(`/api/admin/users/${id}/deactivate`, {});
  } catch {}
}

export async function createTestCustomer(overrides: Record<string, unknown> = {}): Promise<{ id: number; [key: string]: unknown }> {
  const payload = {
    vorname: "Test",
    nachname: `Auto_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
    geburtsdatum: "1940-01-15",
    strasse: "Teststraße",
    nr: "1",
    plz: "10115",
    stadt: "Berlin",
    telefon: "+4917600000000",
    pflegegrad: 3,
    pflegegradSeit: "2024-01-01",
    acceptsPrivatePayment: true,
    ...overrides,
  };
  const res = await apiPost<any>("/api/admin/customers", payload);
  if (res.status !== 201) throw new Error(`createTestCustomer failed: ${res.status} ${JSON.stringify(res.data)}`);
  return res.data;
}

export async function assignEmployeeToCustomer(customerId: number, employeeId?: number): Promise<void> {
  const eid = employeeId ?? (await getAuthCookie()).user.id;
  const res = await apiPatch<any>(`/api/admin/customers/${customerId}/assign`, {
    primaryEmployeeId: eid,
    backupEmployeeId: null,
    backupEmployeeId2: null,
  });
  if (res.status !== 200) throw new Error(`assignEmployeeToCustomer failed: ${res.status}`);
}

export async function createAndDocumentAppointment(
  customerId: number,
  serviceId: number,
  options: { date?: string; startTime?: string; durationMinutes?: number; assignedEmployeeId?: number } = {}
): Promise<{ appointmentId: number; documentationId: number }> {
  const auth = await getAuthCookie();
  const date = options.date || getFutureDate(7);
  const startTime = options.startTime || "09:00";
  const duration = options.durationMinutes || 60;
  const employeeId = options.assignedEmployeeId || auth.user.id;

  const apptRes = await apiPost<any>("/api/appointments/kundentermin", {
    customerId,
    date,
    scheduledStart: startTime,
    services: [{ serviceId, durationMinutes: duration }],
    assignedEmployeeId: employeeId,
  });
  if (apptRes.status !== 201) throw new Error(`createAndDocumentAppointment: appointment failed: ${apptRes.status} ${JSON.stringify(apptRes.data)}`);

  const docRes = await apiPost<any>(`/api/appointments/${apptRes.data.id}/document`, {
    actualStart: startTime,
    travelOriginType: "home",
    travelKilometers: 5,
    services: [{ serviceId, actualDurationMinutes: duration, details: "Auto-Test" }],
  });
  if (docRes.status !== 200 && docRes.status !== 201) throw new Error(`createAndDocumentAppointment: documentation failed: ${docRes.status} ${JSON.stringify(docRes.data)}`);

  return { appointmentId: apptRes.data.id, documentationId: docRes.data?.id };
}

export async function createSignedServiceRecord(
  customerId: number,
  appointmentIds: number[]
): Promise<{ id: number; [key: string]: unknown }> {
  const res = await apiPost<any>("/api/service-records", {
    customerId,
    appointmentIds,
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`createSignedServiceRecord failed: ${res.status} ${JSON.stringify(res.data)}`);
  return res.data;
}

const cleanupQueue: Array<() => Promise<void>> = [];

export function trackCleanup(fn: () => Promise<void>): void {
  cleanupQueue.push(fn);
}

export async function runCleanup(): Promise<void> {
  while (cleanupQueue.length > 0) {
    const fn = cleanupQueue.pop();
    if (fn) {
      try {
        await fn();
      } catch (e) {
      }
    }
  }
}
