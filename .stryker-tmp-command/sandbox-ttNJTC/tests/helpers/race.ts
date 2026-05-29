// @ts-nocheck
// Race-Helper für Concurrency-Tests: drückt "echte" parallele Calls über
// Promise.allSettled aus und prüft "genau ein Sieger".
//
// Warum Barrier statt nur Promise.all()?
// Promise.all()/allSettled() startet alle Worker zwar in derselben Mikrotask,
// garantiert aber NICHT, dass jeder Worker erst dann in seine kritische
// Operation (DB-Insert, HTTP-Call) eintritt, wenn auch alle anderen so weit
// sind. Setup-Arbeit innerhalb eines Workers (z.B. ein vorgelagerter
// `apiGet`/`await`) kann den eigentlichen Wettlauf serialisieren — der Test
// reproduziert die Race-Condition dann nur noch zufällig und wird als
// *Detektor* flaky (er übersieht Regressionen, statt sie zu fangen).
//
// Das Barrier-Pattern löst das: jeder Worker erledigt seine Vorbereitung,
// meldet sich an der Schranke ("arrive") als bereit und blockiert dort, bis
// ALLE Worker angekommen sind. Erst dann werden sie gemeinsam freigegeben und
// treten praktisch gleichzeitig in die kritische Operation ein — das maximiert
// das Race-Fenster und macht den Test deterministisch.
//
// Audit-Begründung (Doppler-Engineering, 2024): "Promise.all() ist zur
// Reproduktion gut, aber als Detektor flaky ohne Barrier-Synchronisation."
// https://www.doppler.com/blog/reliably-testing-race-conditions

import { expect } from "vitest";

export type SettledResult<T> = PromiseSettledResult<T>;

/**
 * Schranke, an der ein Worker sich als "bereit" meldet und blockiert, bis alle
 * Worker angekommen sind. Anschließend werden alle gemeinsam freigegeben.
 */
export type Barrier = () => Promise<void>;

/**
 * Erzeugt eine Barriere für `count` Teilnehmer. Der zurückgegebene
 * `arrive`-Callback resolved erst, wenn er exakt `count`-mal aufgerufen wurde —
 * dann gehen alle wartenden Worker gemeinsam weiter.
 */
export function createBarrier(count: number): Barrier {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived === count) {
      release();
    }
    await gate;
  };
}

/**
 * Ruft alle übergebenen Worker auf und wartet via Promise.allSettled auf alle.
 *
 * Jeder Worker erhält eine `arrive`-Barriere als Argument. Worker, die einen
 * echten Wettlauf prüfen wollen, MÜSSEN `await arrive()` unmittelbar vor ihrer
 * kritischen Operation aufrufen — so treten alle Worker gleichzeitig in den
 * konkurrierenden Abschnitt ein (siehe Datei-Header).
 *
 * Die Barriere wird auf `fns.length` Teilnehmer dimensioniert; ruft ein Worker
 * `arrive()` nicht auf, würde die Schranke nie auslösen — jeder Worker muss
 * also genau einmal anmelden.
 */
export async function runInParallel<T>(
  fns: ReadonlyArray<(arrive: Barrier) => Promise<T>>,
): Promise<SettledResult<T>[]> {
  const arrive = createBarrier(fns.length);
  const promises = fns.map((fn) => {
    try {
      return Promise.resolve(fn(arrive));
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
