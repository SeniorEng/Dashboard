/**
 * Centralized API Client
 * 
 * Provides type-safe API calls with consistent error handling and retry logic.
 * All API responses are wrapped in a standard envelope for predictable error handling.
 * Includes CSRF protection for all state-changing requests.
 */

// CSRF Token handling
const CSRF_COOKIE_NAME = "careconnect_csrf";
const CSRF_HEADER_NAME = "x-csrf-token";

function getCsrfToken(): string | null {
  const cookies = document.cookie.split(";");
  for (const cookie of cookies) {
    const [name, value] = cookie.trim().split("=");
    if (name === CSRF_COOKIE_NAME) {
      return value;
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

// Standard API error structure
export interface ApiErrorInfo {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

// Custom error class that preserves full error info
export class ApiError extends Error {
  code: string;
  details?: Record<string, unknown>;

  constructor(info: ApiErrorInfo) {
    super(info.message);
    this.name = 'ApiError';
    this.code = info.code;
    this.details = info.details;
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
 */
async function parseErrorResponse(response: Response): Promise<ApiErrorInfo> {
  try {
    const data = await response.json();
    return {
      code: data.code || data.error || 'UNKNOWN_ERROR',
      message: data.message || 'Ein unbekannter Fehler ist aufgetreten',
      details: data.details,
    };
  } catch {
    return {
      code: 'NETWORK_ERROR',
      message: `HTTP ${response.status}: ${response.statusText}`,
    };
  }
}

/**
 * Core fetch wrapper with error handling and retry logic
 */
export async function apiRequest<TResponse, TBody = unknown>(
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
      };

      if (body !== undefined) {
        fetchOptions.body = JSON.stringify(body);
      }

      const response = await fetch(`/api${endpoint}`, fetchOptions);

      if (!response.ok) {
        const error = await parseErrorResponse(response);
        
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
            message: 'Netzwerkfehler: Bitte prüfen Sie Ihre Internetverbindung',
          };
          await delay(RETRY_DELAY_MS * Math.pow(2, attempt));
          continue;
        }

        return {
          success: false,
          error: {
            code: 'NETWORK_ERROR',
            message: 'Netzwerkfehler: Bitte prüfen Sie Ihre Internetverbindung',
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

  post: <T, B = unknown>(endpoint: string, body: B, signal?: AbortSignal) =>
    apiRequest<T, B>(endpoint, { method: 'POST', body, signal }),

  put: <T, B = unknown>(endpoint: string, body: B, signal?: AbortSignal) =>
    apiRequest<T, B>(endpoint, { method: 'PUT', body, signal }),

  patch: <T, B = unknown>(endpoint: string, body: B, signal?: AbortSignal) =>
    apiRequest<T, B>(endpoint, { method: 'PATCH', body, signal }),

  delete: <T = void>(endpoint: string, signal?: AbortSignal) =>
    apiRequest<T>(endpoint, { method: 'DELETE', signal }),
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
export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/**
 * Create a query function that unwraps results for react-query
 */
export function createQueryFn<T>(
  fetcher: (signal?: AbortSignal) => Promise<ApiResult<T>>
) {
  return async ({ signal }: { signal?: AbortSignal }): Promise<T> => {
    const result = await fetcher(signal);
    return unwrapResult(result);
  };
}
