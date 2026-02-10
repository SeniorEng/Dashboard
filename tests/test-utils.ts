import { describe, it, expect, beforeAll, afterAll } from "vitest";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const TEST_EMAIL = process.env.TEST_USER_EMAIL || "alrikdegenkolb@seniorenengel-alltagsbegleitung.de";
const TEST_PASSWORD = process.env.TEST_USER_PASSWORD;

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

export async function apiGetAs<T = unknown>(auth: AuthCookie, path: string): Promise<{ status: number; data: T }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { Cookie: auth.cookie },
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data: data as T };
}

export async function apiPostAs<T = unknown>(auth: AuthCookie, path: string, body: unknown): Promise<{ status: number; data: T }> {
  const cookieHeader = `${auth.cookie}; careconnect_csrf=${auth.csrfToken}`;
  const response = await fetch(`${BASE_URL}${path}`, {
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
  const response = await fetch(`${BASE_URL}${path}`, {
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
  const response = await fetch(`${BASE_URL}${path}`, {
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
  const response = await fetch(`${BASE_URL}${path}`, {
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
