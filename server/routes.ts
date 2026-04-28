import type { Express } from "express";
import { type Server } from "http";
import apiRouter from "./routes/index";
import publicSigningRouter from "./routes/public-signing";
import webhookRouter from "./routes/webhook";
import twilioWebhookRouter from "./routes/webhook-twilio";
import { registerObjectStorageRoutes } from "./replit_integrations/object_storage";
import { db } from "./lib/db";
import { sql } from "drizzle-orm";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
  app.get("/api/health", async (_req, res) => {
    try {
      await db.execute(sql`SELECT 1`);
      res.json({ status: "ok", timestamp: new Date().toISOString(), uptime: process.uptime() });
    } catch (error) {
      res.status(503).json({ status: "error", message: "Database unavailable", timestamp: new Date().toISOString(), uptime: process.uptime() });
    }
  });

  app.use("/api/public", publicSigningRouter);

  app.use("/api/webhook", webhookRouter);
  app.use("/api/webhook/twilio", twilioWebhookRouter);

  // Test-only Postausgangs-Endpoint: ausschließlich unter NODE_ENV=test
  // verfügbar, damit Integrationstests den Mail-Stub abfragen/leeren können.
  // In Dev/Production ist diese Route nicht eingehängt.
  if (process.env.NODE_ENV === "test") {
    const { default: testOutboxRouter } = await import("./routes/test-outbox");
    app.use("/api/test", testOutboxRouter);
  }

  app.use("/api", apiRouter);

  registerObjectStorageRoutes(app);

  return httpServer;
}
