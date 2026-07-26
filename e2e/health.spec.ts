import { test, expect } from "@playwright/test";

test.describe("Health Check", () => {
  test("GET /api/health returns OK", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.status).toBe("ok");
  });

  // Replit-Exit (Task #1840): schlanker Top-Level-Endpoint für den Coolify-
  // Container-Healthcheck — ohne Auth, DB-Ping + Build-Version, keine PII.
  test("GET /health returns OK ohne Auth (Container-Healthcheck)", async ({ request }) => {
    const response = await request.get("/health");
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string"); // "dev" oder Quell-Hash
    expect(typeof body.timestamp).toBe("string");
    // Kein PII/Secret im schlanken Health-Payload.
    expect(body).not.toHaveProperty("startupComplete");
  });
});
