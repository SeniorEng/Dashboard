import type { Express } from "express";
import { type Server } from "http";
import apiRouter from "./routes/index";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
  // Mount all API routes under /api prefix
  app.use("/api", apiRouter);

  return httpServer;
}
