import type { Express } from "express";
import { type Server } from "http";
import apiRouter from "./routes/index";
import publicSigningRouter from "./routes/public-signing";
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
      res.json({ status: "ok", timestamp: new Date().toISOString() });
    } catch (error) {
      res.status(503).json({ status: "error", message: "Database unavailable" });
    }
  });

  app.use("/api/public", publicSigningRouter);

  app.use("/api", apiRouter);

  registerObjectStorageRoutes(app);

  return httpServer;
}
