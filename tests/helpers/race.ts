// Race-Helper für Concurrency-Tests: drückt "echte" parallele Calls über
// Promise.allSettled aus und prüft "genau ein Sieger".

import { expect } from "vitest";

export type SettledResult<T> = PromiseSettledResult<T>;

/**
 * Ruft alle übergebenen Funktionen auf und wartet via Promise.allSettled
 * auf alle. Die Funktionen werden alle synchron in derselben Mikrotask
 * gestartet, damit keine künstliche Serialisierung entsteht.
 */
export async function runInParallel<T>(
  fns: ReadonlyArray<() => Promise<T>>,
): Promise<SettledResult<T>[]> {
  const promises = fns.map((fn) => {
    try {
      return Promise.resolve(fn());
    } catch (err) {
      return Promise.reject(err);
    }
  });
  return Promise.allSettled(promises);
}

function describeResults<T>(results: ReadonlyArray<SettledResult<T>>): string {
  return results
    .map((r, i) => {
      if (r.status === "fulfilled") {
        return `#${i}=fulfilled(${safeStringify(r.value)})`;
      }
      return `#${i}=rejected(${reasonString(r.reason)})`;
    })
    .join(" | ");
}

function safeStringify(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s;
  } catch {
    return String(v);
  }
}

function reasonString(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  return safeStringify(reason);
}

/**
 * Erwartet genau ein 'fulfilled' und ansonsten ausschließlich 'rejected'.
 * Optional kann ein RegExp-Pattern angegeben werden, das jede
 * Rejection-Reason matchen muss (per `String(reason)` / `reason.message`).
 *
 * Gibt den value des Siegers zurück.
 */
export function expectExactlyOneSuccess<T>(
  results: ReadonlyArray<SettledResult<T>>,
  expectedRejectionPattern?: RegExp,
): T {
  const fulfilledIdx: number[] = [];
  const rejectedIdx: number[] = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === "fulfilled") fulfilledIdx.push(i);
    else rejectedIdx.push(i);
  }

  expect(
    fulfilledIdx.length,
    `Genau 1 Sieger erwartet, bekam ${fulfilledIdx.length} fulfilled / ${rejectedIdx.length} rejected. Details: ${describeResults(results)}`,
  ).toBe(1);

  expect(
    fulfilledIdx.length + rejectedIdx.length,
    `Alle Promises müssen settled sein. Details: ${describeResults(results)}`,
  ).toBe(results.length);

  if (expectedRejectionPattern) {
    for (const i of rejectedIdx) {
      const r = results[i] as PromiseRejectedResult;
      const text = reasonString(r.reason);
      expect(
        expectedRejectionPattern.test(text),
        `Rejection #${i} sollte Pattern ${expectedRejectionPattern} matchen, war: ${text}`,
      ).toBe(true);
    }
  }

  const winner = results[fulfilledIdx[0]] as PromiseFulfilledResult<T>;
  return winner.value;
}
