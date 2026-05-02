import { beforeAll, afterAll, afterEach } from "vitest";
import { thawTime } from "./helpers/frozen-clock";

if (!process.env.TEST_USER_PASSWORD && process.env.TEST_USER_PASSWORD_INTERNAL) {
  process.env.TEST_USER_PASSWORD = process.env.TEST_USER_PASSWORD_INTERNAL;
}

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
