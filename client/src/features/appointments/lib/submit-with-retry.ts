import { ApiError, type ApiResult } from "@/lib/api/client";

export interface RetryAttempt {
  attempt: number;
  reason: "network_error" | "server_error";
  status?: number;
  code?: string;
}

export interface SubmitWithRetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  onRetry?: (info: RetryAttempt) => void;
  delay?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_INITIAL_DELAY_MS = 800;
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set(["NETWORK_ERROR", "RETRY_EXHAUSTED"]);

/**
 * Decides whether a given API result error is transient and worth retrying.
 *
 * Transient = network hiccup or server-side 5xx/timeout. Business errors
 * (validation, FORBIDDEN with ALREADY_COMPLETED, SIGNATURE_LOCKED, etc.)
 * MUST NOT be retried — we'd just hammer the server with requests that
 * cannot succeed and would mask the real error from the user.
 */
export function isTransientApiError(err: {
  code?: string;
  status?: number;
}): boolean {
  if (err.status !== undefined && RETRYABLE_HTTP_STATUSES.has(err.status)) {
    return true;
  }
  if (err.code && RETRYABLE_ERROR_CODES.has(err.code)) {
    // Only treat network errors as retryable when no status is set
    // (status=4xx with code="NETWORK_ERROR" should not happen, but guard).
    if (err.status === undefined || err.status >= 500) return true;
  }
  return false;
}

/**
 * Calls `fn` and retries up to `maxRetries` times on transient errors using
 * exponential backoff. Resolves with the first successful `ApiResult.data`
 * or throws an `ApiError` for the last failure.
 *
 * Designed for the mobile documentation submit on flaky LTE/4G connections:
 *   - retries on network drops / 5xx (up to 2 retries → 3 attempts total)
 *   - never retries business-level 4xx errors
 *   - reports each retry via `onRetry` so the caller can log/announce it
 */
export async function submitWithRetry<T>(
  fn: (attempt: number) => Promise<ApiResult<T>>,
  options: SubmitWithRetryOptions = {},
): Promise<{ data: T; attempts: number }> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const initialDelay = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const sleep = options.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastError: ApiError | null = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const result = await fn(attempt);
    if (result.success) {
      return { data: result.data, attempts: attempt };
    }
    const err = result.error;
    lastError = new ApiError(err);

    const transient = isTransientApiError({ code: err.code, status: err.status });
    if (!transient || attempt > maxRetries) {
      throw lastError;
    }

    options.onRetry?.({
      attempt,
      reason: err.status && err.status >= 500 ? "server_error" : "network_error",
      status: err.status,
      code: err.code,
    });

    await sleep(initialDelay * Math.pow(2, attempt - 1));
  }

  throw lastError ?? new ApiError({ code: "RETRY_EXHAUSTED", message: "Maximale Anzahl von Versuchen erreicht" });
}
