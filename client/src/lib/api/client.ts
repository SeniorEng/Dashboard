/**
 * Centralized API Client
 * 
 * Provides type-safe API calls with consistent error handling and retry logic.
 * All API responses are wrapped in a standard envelope for predictable error handling.
 * Includes CSRF protection for all state-changing requests.
 */

import { transformSignatureFields } from "@shared/utils/signature-transport";

// CSRF Token handling
const CSRF_COOKIE_NAME = "careconnect_csrf";
const CSRF_HEADER_NAME = "x-csrf-token";

function getCsrfToken(): string | null {
  const cookies = document.cookie.split(";");
  for (const cookie of cookies) {
    const trimmed = cookie.trim();
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const name = trimmed.substring(0, eqIndex);
    const value = trimmed.substring(eqIndex + 1);
    if (name === CSRF_COOKIE_NAME && value) {
      return decodeURIComponent(value);
    }
  }
  return null;
}

async function ensureCsrfToken(): Promise<string | null> {
  let token = getCsrfToken();
  if (!token) {
    try {
      const res = await fetch("/api/csrf-token", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        token = data.csrfToken;
      }
    } catch (e) {
      console.error("Failed to fetch CSRF token:", e);
    }
  }
  return token;
}

/**
 * Holt unbedingt einen frischen CSRF-Token vom Server (ignoriert den evtl.
 * abgelaufenen/fehlenden Cookie). Wird für die einmalige Auto-Heilung nach einem
 * CSRF-403 genutzt: Der Server setzt dabei einen neuen `careconnect_csrf`-Cookie
 * und liefert denselben Token im JSON zurück, sodass Header und Cookie für den
 * Retry wieder zusammenpassen.
 */
async function forceRefreshCsrfToken(): Promise<string | null> {
  try {
    const res = await fetch("/api/csrf-token", { credentials: "include", cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      if (typeof data?.csrfToken === "string" && data.csrfToken) {
        return data.csrfToken;
      }
    }
  } catch (e) {
    console.error("Failed to refresh CSRF token:", e);
  }
  // Fallback: evtl. wurde der Cookie trotzdem gesetzt.
  return getCsrfToken();
}

/**
 * Erkennt eine CSRF-bedingte Ablehnung (fehlender oder ungültiger Token). Der
 * Server sendet `{ error: "CSRF_TOKEN_MISSING" | "CSRF_TOKEN_INVALID" }`; nach
 * `parseErrorResponse` landet das in `code` bzw. `details.errorCode`.
 */
function isCsrfError(error: ApiErrorInfo): boolean {
  const codes = ["CSRF_TOKEN_MISSING", "CSRF_TOKEN_INVALID"];
  const errorCode = typeof error.details?.errorCode === "string" ? error.details.errorCode : "";
  return codes.includes(error.code) || codes.includes(errorCode);
}

// Standard API error structure
export interface ApiErrorInfo {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  // HTTP-Status der fehlgeschlagenen Antwort. Wird von `parseErrorResponse`
  // gesetzt und ist im Frontend nötig, um z.B. 5xx-spezifische Hinweise
  // anzuzeigen (Task #376 Schritt 4).
  status?: number;
}

// Custom error class that preserves full error info
export class ApiError extends Error {
  code: string;
  details?: Record<string, unknown>;
  status?: number;

  constructor(info: ApiErrorInfo) {
    super(info.message);
    this.name = 'ApiError';
    this.code = info.code;
    this.details = info.details;
    this.status = info.status;
  }
}

// API response envelope
export type ApiResult<T> = 
  | { success: true; data: T }
  | { success: false; error: ApiErrorInfo };

// HTTP method types
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// Request options
interface RequestOptions<TBody = unknown> {
  method?: HttpMethod;
  body?: TBody;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  retries?: number;
}

// Retry configuration
const DEFAULT_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const RETRYABLE_STATUS_CODES = [408, 429, 500, 502, 503, 504];

/**
 * Check if an error should trigger a retry
 */
function isRetryableError(response: Response | null, error: Error | null): boolean {
  if (error) {
    // Retry on network errors (not abort)
    return error.name !== 'AbortError';
  }
  if (response) {
    return RETRYABLE_STATUS_CODES.includes(response.status);
  }
  return false;
}

/**
 * Wait for specified milliseconds
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Parse error response from API
 *
 * Exportiert für den Unit-Test (tests/unit/api-client-error-parsing.test.ts).
 */
export async function parseErrorResponse(response: Response): Promise<ApiErrorInfo> {
  // Body genau einmal als Text lesen, dann JSON parsen. So bleibt der Rohtext
  // für den Fallback verfügbar, falls die Antwort kein JSON ist (z.B. ein
  // Proxy-/Plain-Text-403), statt nur ein nacktes "HTTP 403:" zu zeigen.
  const rawBody = await response.text().catch(() => '');
  try {
    const data = JSON.parse(rawBody);
    let message = 'Ein unbekannter Fehler ist aufgetreten';
    if (typeof data.message === 'string' && data.message) {
      message = data.message;
    } else if (typeof data.error === 'string' && data.error) {
      message = data.error;
    } else if (typeof data.error?.message === 'string' && data.error.message) {
      message = data.error.message;
    }
    const details: Record<string, unknown> = { ...(data.details || {}) };
    if (data.conflicts) details.conflicts = data.conflicts;
    if (data.dates) details.dates = data.dates;
    // Preserve the more specific sub-error code (e.g. "ALREADY_COMPLETED",
    // "SIGNATURE_LOCKED") next to the umbrella `code` ("FORBIDDEN"). The
    // server sends both, but historically only `code` was exposed, which
    // hid the actionable specifics from the client.
    if (typeof data.error === 'string' && data.error && data.error !== data.code) {
      details.errorCode = data.error;
    }
    return {
      code: data.code || data.error || 'API_ERROR',
      message,
      details: Object.keys(details).length > 0 ? details : undefined,
      status: response.status,
    };
  } catch {
    // Kein JSON-Body: kurze, nicht-HTML Plain-Text-Meldung des Servers anzeigen,
    // sonst auf den generischen HTTP-Status zurückfallen.
    const trimmed = rawBody.trim();
    const usableText = trimmed && trimmed.length <= 300 && !trimmed.startsWith('<')
      ? trimmed
      : null;
    return {
      code: 'NETWORK_ERROR',
      message: usableText ?? `HTTP ${response.status}: ${response.statusText}`,
      status: response.status,
    };
  }
}

/**
 * Core fetch wrapper with error handling and retry logic
 */
async function apiRequest<TResponse, TBody = unknown>(
  endpoint: string,
  options: RequestOptions<TBody> = {}
): Promise<ApiResult<TResponse>> {
  const { 
    method = 'GET', 
    body, 
    headers = {}, 
    signal,
    retries = DEFAULT_RETRIES 
  } = options;

  // Build headers with CSRF token for state-changing requests
  const requestHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...headers,
  };

  // Add CSRF token for non-safe methods
  const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
  if (!safeMethods.includes(method)) {
    const csrfToken = await ensureCsrfToken();
    if (csrfToken) {
      requestHeaders[CSRF_HEADER_NAME] = csrfToken;
    }
  }

  let lastError: ApiErrorInfo | null = null;
  // Einmalige Auto-Heilung bei CSRF-403: Ein abgelaufener/fehlender Token darf
  // einen sonst gültigen Schreibvorgang (z.B. Leistungsnachweis unterschreiben)
  // nicht hart scheitern lassen. Wir holen genau EINMAL einen frischen Token und
  // wiederholen die Anfrage. Sicher, weil ein Cross-Site-Angreifer weder
  // /api/csrf-token lesen noch den Cookie setzen kann.
  let csrfRetried = false;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // Skip retry for non-idempotent methods after first attempt
    if (attempt > 0 && method === 'POST') {
      break;
    }

    try {
      const fetchOptions: RequestInit = {
        method,
        credentials: 'include',
        signal,
        headers: requestHeaders,
        cache: 'no-store',
      };

      if (body !== undefined) {
        // Strip the `data:image/...;base64,` prefix from signature fields so the
        // request body never contains a `data:` URI — the published edge WAF
        // hard-blocks such bodies with a 403 before they reach the server. The
        // server rebuilds the full data URL at ingestion.
        fetchOptions.body = JSON.stringify(transformSignatureFields(body, "strip"));
      }

      let response = await fetch(`/api${endpoint}`, fetchOptions);

      if (!response.ok) {
        let error = await parseErrorResponse(response);

        // One-time CSRF auto-heal: frischen Token holen und Anfrage wiederholen.
        if (
          response.status === 403 &&
          !safeMethods.includes(method) &&
          !csrfRetried &&
          isCsrfError(error)
        ) {
          csrfRetried = true;
          const fresh = await forceRefreshCsrfToken();
          if (fresh) {
            requestHeaders[CSRF_HEADER_NAME] = fresh;
            response = await fetch(`/api${endpoint}`, fetchOptions);
            if (response.ok) {
              if (response.status === 204) {
                return { success: true, data: undefined as TResponse };
              }
              const data = await response.json();
              return { success: true, data };
            }
            error = await parseErrorResponse(response);
          }
        }

        // Check if we should retry
        if (attempt < retries && isRetryableError(response, null)) {
          lastError = error;
          await delay(RETRY_DELAY_MS * Math.pow(2, attempt)); // Exponential backoff
          continue;
        }
        
        return { success: false, error };
      }

      // Handle 204 No Content
      if (response.status === 204) {
        return { success: true, data: undefined as TResponse };
      }

      const data = await response.json();
      return { success: true, data };
    } catch (error) {
      // Handle network errors and aborts
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          return {
            success: false,
            error: {
              code: 'ABORTED',
              message: 'Anfrage wurde abgebrochen',
            },
          };
        }

        // Check if we should retry
        if (attempt < retries && isRetryableError(null, error)) {
          lastError = {
            code: 'NETWORK_ERROR',
            message: 'Netzwerkfehler. Bitte Internetverbindung prüfen und erneut versuchen.',
          };
          await delay(RETRY_DELAY_MS * Math.pow(2, attempt));
          continue;
        }

        return {
          success: false,
          error: {
            code: 'NETWORK_ERROR',
            message: 'Netzwerkfehler. Bitte Internetverbindung prüfen und erneut versuchen.',
          },
        };
      }

      return {
        success: false,
        error: {
          code: 'UNKNOWN_ERROR',
          message: 'Ein unbekannter Fehler ist aufgetreten',
        },
      };
    }
  }

  // Return last error if all retries failed
  return {
    success: false,
    error: lastError || {
      code: 'RETRY_EXHAUSTED',
      message: 'Maximale Anzahl von Versuchen erreicht',
    },
  };
}

/**
 * Convenience methods for common HTTP operations
 */
export const api = {
  get: <T>(endpoint: string, signal?: AbortSignal) =>
    apiRequest<T>(endpoint, { method: 'GET', signal }),

  post: <T, B = unknown>(
    endpoint: string,
    body: B,
    opts?: AbortSignal | { signal?: AbortSignal; headers?: Record<string, string> },
  ) => {
    if (opts && typeof (opts as AbortSignal).aborted === 'boolean') {
      return apiRequest<T, B>(endpoint, { method: 'POST', body, signal: opts as AbortSignal });
    }
    const o = (opts as { signal?: AbortSignal; headers?: Record<string, string> } | undefined) || {};
    return apiRequest<T, B>(endpoint, { method: 'POST', body, signal: o.signal, headers: o.headers });
  },

  postFormData: async <T>(endpoint: string, formData: FormData, signal?: AbortSignal): Promise<ApiResult<T>> => {
    const csrfToken = await ensureCsrfToken();
    const headers: Record<string, string> = {};
    if (csrfToken) headers[CSRF_HEADER_NAME] = csrfToken;

    try {
      const response = await fetch(`/api${endpoint}`, {
        method: 'POST',
        body: formData,
        credentials: 'include',
        signal,
        headers,
      });

      if (!response.ok) {
        const error = await parseErrorResponse(response);
        return { success: false, error };
      }

      if (response.status === 204) {
        return { success: true, data: undefined as T };
      }

      const data = await response.json();
      return { success: true, data };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { success: false, error: { code: 'ABORTED', message: 'Anfrage wurde abgebrochen' } };
      }
      return { success: false, error: { code: 'NETWORK_ERROR', message: 'Netzwerkfehler: Bitte prüfen Sie Ihre Internetverbindung' } };
    }
  },

  /**
   * POST mit binärer Antwort (PDF/ZIP-Download). Liefert den `Blob`, den aus
   * `Content-Disposition` geparsten Dateinamen und — falls ein Summary-Header
   * angegeben ist — das daraus dekodierte JSON (URL-encodiert gesetzt vom
   * Server, damit Umlaute headersicher transportiert werden). Behandelt CSRF
   * wie `postFormData` (kein Auto-Retry — POST ist nicht idempotent).
   */
  postBlob: async <S = unknown>(
    endpoint: string,
    body: unknown,
    summaryHeader?: string,
    signal?: AbortSignal,
  ): Promise<ApiResult<{ blob: Blob; fileName: string; summary: S | null }>> => {
    const csrfToken = await ensureCsrfToken();
    const requestHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (csrfToken) requestHeaders[CSRF_HEADER_NAME] = csrfToken;

    try {
      const response = await fetch(`/api${endpoint}`, {
        method: 'POST',
        credentials: 'include',
        signal,
        headers: requestHeaders,
        cache: 'no-store',
        body: JSON.stringify(transformSignatureFields(body, 'strip')),
      });

      if (!response.ok) {
        const error = await parseErrorResponse(response);
        return { success: false, error };
      }

      const blob = await response.blob();
      const cd = response.headers.get('Content-Disposition') || '';
      const match = /filename="?([^"]+)"?/i.exec(cd);
      const fileName = match ? match[1] : 'download';

      let summary: S | null = null;
      if (summaryHeader) {
        const raw = response.headers.get(summaryHeader);
        if (raw) {
          try {
            summary = JSON.parse(decodeURIComponent(raw)) as S;
          } catch {
            summary = null;
          }
        }
      }

      return { success: true, data: { blob, fileName, summary } };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { success: false, error: { code: 'ABORTED', message: 'Anfrage wurde abgebrochen' } };
      }
      return { success: false, error: { code: 'NETWORK_ERROR', message: 'Netzwerkfehler: Bitte prüfen Sie Ihre Internetverbindung' } };
    }
  },

  put: <T, B = unknown>(endpoint: string, body: B, signal?: AbortSignal) =>
    apiRequest<T, B>(endpoint, { method: 'PUT', body, signal }),

  patch: <T, B = unknown>(endpoint: string, body: B, signal?: AbortSignal) =>
    apiRequest<T, B>(endpoint, { method: 'PATCH', body, signal }),

  delete: <T = void, B = unknown>(
    endpoint: string,
    opts?: AbortSignal | { body?: B; signal?: AbortSignal },
  ) => {
    if (opts && typeof (opts as AbortSignal).aborted === 'boolean') {
      return apiRequest<T, B>(endpoint, { method: 'DELETE', signal: opts as AbortSignal });
    }
    const o = (opts as { body?: B; signal?: AbortSignal } | undefined) || {};
    return apiRequest<T, B>(endpoint, { method: 'DELETE', body: o.body, signal: o.signal });
  },
};

/**
 * Helper to throw error from ApiResult (for react-query compatibility)
 * Throws ApiError with full error info preserved
 */
export function unwrapResult<T>(result: ApiResult<T>): T {
  if (!result.success) {
    throw new ApiError(result.error);
  }
  return result.data;
}

/**
 * Type guard to check if an error is an ApiError
 */
function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/**
 * Create a query function that unwraps results for react-query
 */
function createQueryFn<T>(
  fetcher: (signal?: AbortSignal) => Promise<ApiResult<T>>
) {
  return async ({ signal }: { signal?: AbortSignal }): Promise<T> => {
    const result = await fetcher(signal);
    return unwrapResult(result);
  };
}
