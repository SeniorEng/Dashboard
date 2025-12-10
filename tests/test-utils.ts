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
  const csrfMatch = cookies.match(/csrf_token=([^;]+)/);
  const csrfToken = csrfMatch ? csrfMatch[1] : "";
  
  const userData = await loginResponse.json();

  authCookie = {
    cookie: cookies,
    user: userData.user,
    csrfToken,
  };

  return authCookie;
}

export async function apiGet<T = unknown>(path: string): Promise<{ status: number; data: T }> {
  const auth = await getAuthCookie();
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: {
      Cookie: auth.cookie,
    },
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data: data as T };
}

export async function apiPost<T = unknown>(
  path: string,
  body: unknown
): Promise<{ status: number; data: T }> {
  const auth = await getAuthCookie();
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: auth.cookie,
      "X-CSRF-Token": auth.csrfToken,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data: data as T };
}

export async function apiPatch<T = unknown>(
  path: string,
  body: unknown
): Promise<{ status: number; data: T }> {
  const auth = await getAuthCookie();
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Cookie: auth.cookie,
      "X-CSRF-Token": auth.csrfToken,
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
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Cookie: auth.cookie,
      "X-CSRF-Token": auth.csrfToken,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data: data as T };
}

export async function apiDelete(path: string): Promise<{ status: number; data: unknown }> {
  const auth = await getAuthCookie();
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "DELETE",
    headers: {
      Cookie: auth.cookie,
      "X-CSRF-Token": auth.csrfToken,
    },
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

export function getFutureDate(daysFromNow: number = 7): string {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  return date.toISOString().split("T")[0];
}

export function getPastDate(daysAgo: number = 1): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().split("T")[0];
}

export function getTodayDate(): string {
  return new Date().toISOString().split("T")[0];
}

export function getTimeString(hoursFromNow: number = 0): string {
  const date = new Date();
  date.setHours(date.getHours() + hoursFromNow);
  return date.toTimeString().slice(0, 8);
}
