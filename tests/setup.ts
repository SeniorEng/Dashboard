import { beforeAll, afterAll, afterEach } from "vitest";
import fc from "fast-check";
import { thawTime } from "./helpers/frozen-clock";

if (!process.env.TEST_USER_PASSWORD && process.env.TEST_USER_PASSWORD_INTERNAL) {
  process.env.TEST_USER_PASSWORD = process.env.TEST_USER_PASSWORD_INTERNAL;
}

// Reproduzierbarkeit für fast-check: gepinnter Seed sorgt dafür, dass
// Property-Failures deterministisch reproduzierbar sind. Einzelne Tests dürfen
// `numRuns` lokal überschreiben (z.B. für API-lastige Setups).
fc.configureGlobal({ seed: 42, numRuns: 100 });

beforeAll(async () => {
  process.env.NODE_ENV = "test";
});

// Sicherheitsnetz: vergessenes `freezeTime` darf nachfolgende Tests nicht
// beeinflussen. `thawTime` ist idempotent (vi.useRealTimers).
afterEach(() => {
  thawTime();
});

afterAll(async () => {
});
