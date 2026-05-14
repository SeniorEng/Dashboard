import { type APIRequestContext, type BrowserContext, request } from "@playwright/test";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

export interface AdminCreds {
  email: string;
  password: string;
}

export function getAdminCreds(): AdminCreds | null {
  const email = process.env.TEST_USER_EMAIL;
  const password =
    process.env.TEST_USER_PASSWORD || process.env.TEST_USER_PASSWORD_INTERNAL;
  if (!email || !password) return null;
  return { email, password };
}

export interface ApiSession {
  api: APIRequestContext;
  csrfToken: string;
  cookieHeader: string;
}

/**
 * Logs in via the JSON API and returns an APIRequestContext that carries the
 * session + CSRF cookies. Call `dispose()` on the returned `api` when done.
 */
export async function loginApiSession(creds: AdminCreds): Promise<ApiSession> {
  const api = await request.newContext({ baseURL: BASE_URL });
  const res = await api.post("/api/auth/login", {
    data: { email: creds.email, password: creds.password },
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok()) {
    await api.dispose();
    throw new Error(
      `Login failed for ${creds.email}: ${res.status()} ${await res.text()}`,
    );
  }
  // Extract CSRF token from set-cookie + storage state.
  const state = await api.storageState();
  const cookies = state.cookies;
  const csrfCookie = cookies.find((c) => c.name === "careconnect_csrf");
  if (!csrfCookie) {
    await api.dispose();
    throw new Error("careconnect_csrf cookie not found after login");
  }
  const cookieHeader = cookies
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  return { api, csrfToken: csrfCookie.value, cookieHeader };
}

/**
 * Copies the API session's cookies onto a Playwright BrowserContext so the
 * UI runs as the same authenticated user.
 */
export async function applyAuthToBrowser(
  ctx: BrowserContext,
  session: ApiSession,
): Promise<void> {
  const state = await session.api.storageState();
  await ctx.addCookies(state.cookies);
}

export async function apiPost<T = unknown>(
  session: ApiSession,
  path: string,
  body: unknown,
): Promise<{ status: number; data: T }> {
  const res = await session.api.post(path, {
    data: body,
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": session.csrfToken,
    },
  });
  return { status: res.status(), data: (await readBody(res)) as T };
}

export async function apiPatch<T = unknown>(
  session: ApiSession,
  path: string,
  body: unknown,
): Promise<{ status: number; data: T }> {
  const res = await session.api.patch(path, {
    data: body,
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": session.csrfToken,
    },
  });
  return { status: res.status(), data: (await readBody(res)) as T };
}

export async function apiPut<T = unknown>(
  session: ApiSession,
  path: string,
  body: unknown,
): Promise<{ status: number; data: T }> {
  const res = await session.api.put(path, {
    data: body,
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": session.csrfToken,
    },
  });
  return { status: res.status(), data: (await readBody(res)) as T };
}

async function readBody(
  res: { json: () => Promise<unknown>; text: () => Promise<string> },
): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return await res.text();
  }
}
