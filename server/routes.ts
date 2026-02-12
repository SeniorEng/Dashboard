import type { Express } from "express";
import { type Server } from "http";
import apiRouter from "./routes/index";
import { registerObjectStorageRoutes } from "./replit_integrations/object_storage";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
  // Mount all API routes under /api prefix
  app.use("/api", apiRouter);

  registerObjectStorageRoutes(app);

  return httpServer;
}
