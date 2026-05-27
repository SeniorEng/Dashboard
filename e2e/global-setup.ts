import { request } from "@playwright/test";

/**
 * Wartet, bis `Start application` auf Port 5000 antwortet, bevor die
 * Smoke-/E2E-Suite startet. Der „Project"-Workflow startet `Start
 * application` und `e2e-smoke` parallel — ohne diesen Health-Wait
 * laufen die ersten Smoke-Tests in ECONNREFUSED 127.0.0.1:5000 und
 * scheitern teilweise hart (Task #655).
 */
export default async function globalSetup(): Promise<void> {
  const baseURL = process.env.TEST_BASE_URL || "http://localhost:5000";
  const timeoutMs = Number(process.env.E2E_HEALTH_TIMEOUT_MS || 120_000);
  const intervalMs = 500;
  const deadline = Date.now() + timeoutMs;

  const api = await request.newContext({ baseURL });
  try {
    let lastErr: unknown = null;
    while (Date.now() < deadline) {
      try {
        const res = await api.get("/api/health", { timeout: 5_000 });
        if (res.ok()) {
          const elapsed = ((timeoutMs - (deadline - Date.now())) / 1000).toFixed(1);
          // eslint-disable-next-line no-console
          console.log(`[e2e:globalSetup] App ist healthy nach ${elapsed}s.`);
          return;
        }
        lastErr = new Error(`/api/health → HTTP ${res.status()}`);
      } catch (err) {
        lastErr = err;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(
      `[e2e:globalSetup] App auf ${baseURL} nicht erreichbar nach ${timeoutMs}ms — ` +
        `letzter Fehler: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
  } finally {
    await api.dispose();
  }
}
