import { beforeAll, afterAll } from "vitest";

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  if (!process.env.TEST_USER_PASSWORD && process.env.TEST_USER_PASSWORD_INTERNAL) {
    process.env.TEST_USER_PASSWORD = process.env.TEST_USER_PASSWORD_INTERNAL;
  }
});

afterAll(async () => {
});
