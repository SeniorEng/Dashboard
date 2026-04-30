import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL ist nicht gesetzt. Bitte die Umgebungsvariable konfigurieren.");
}

export const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export const db = drizzle(pool);

export type DbOrTx = Pick<typeof db, "select" | "insert" | "update" | "delete" | "execute">;

// Strikt: nur das Transaktions-Argument aus db.transaction(async (tx) => ...).
// Wer pg_advisory_xact_lock o.ä. nutzt, MUSS diesen Typ erzwingen — sonst würde
// der Lock am Statement-Ende freigegeben und der nachfolgende MAX/Insert wäre
// race-anfällig.
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
