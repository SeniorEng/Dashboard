import express from "express";
import cookieParser from "cookie-parser";
import compression from "compression";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { errorMiddleware } from "./lib/errors";
import { pool, db } from "./lib/db";
import { sql as sqlBuilder } from "drizzle-orm";
import { closeBrowser } from "./services/pdf-generator";
const app = express();
app.set("trust proxy", 1);
const httpServer = createServer(app);

const intervals: NodeJS.Timeout[] = [];
const timeouts: NodeJS.Timeout[] = [];

const isDev = process.env.NODE_ENV !== "production";
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", ...(isDev ? ["'unsafe-inline'", "'unsafe-eval'"] : [])],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      connectSrc: ["'self'", "https://storage.googleapis.com", ...(isDev ? ["ws:", "wss:"] : [])],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(compression({
  filter: (req, res) => {
    if (req.path.startsWith("/api")) return false;
    return compression.filter(req, res);
  },
}));

app.use(express.json({ limit: "10mb" }));

app.use(express.urlencoded({ extended: false, limit: "10mb" }));
app.use(cookieParser());

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === "development" ? 5000 : 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.startsWith("/api/auth/") || req.path.startsWith("/auth/"),
  message: { message: "Zu viele Anfragen, bitte später erneut versuchen." },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === "development" ? 100 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Zu viele Anmeldeversuche, bitte später erneut versuchen." },
});

const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Zu viele Passwort-Zurücksetzungen, bitte in einer Stunde erneut versuchen." },
});

app.post("/api/auth/login", loginLimiter);
app.use("/api/auth/password-reset/", passwordResetLimiter);
app.use("/api/", apiLimiter);

import { log } from "./lib/log";
export { log };

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      log(`${req.method} ${path} ${res.statusCode} in ${duration}ms`);
    }
  });

  next();
});

process.on("unhandledRejection", (reason, promise) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  if (isNeonDriverBug(msg)) {
    console.warn("[neon-driver] Non-fatal WebSocket error suppressed:", msg);
    return;
  }
  console.error("[FATAL] Unhandled Promise Rejection:", reason);
  gracefulShutdown("unhandledRejection");
});

process.on("uncaughtException", (error) => {
  const msg = error instanceof Error ? error.message : String(error);
  if (isNeonDriverBug(msg)) {
    console.warn("[neon-driver] Non-fatal WebSocket error suppressed:", msg);
    return;
  }
  console.error("[FATAL] Uncaught Exception:", error);
  gracefulShutdown("uncaughtException");
});

function isNeonDriverBug(message: string): boolean {
  return (
    message.includes("Cannot set property message of") &&
    message.includes("which has only a getter")
  ) || (
    message.includes("ErrorEvent") &&
    message.includes("only a getter")
  );
}

(async () => {
  await registerRoutes(httpServer, app);

  app.use(errorMiddleware);

  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
      runStartupTasks();
    },
  );
})();

async function runStartupTasks() {
  try {
    const { serviceCatalogStorage } = await import("./storage/service-catalog");
    await serviceCatalogStorage.ensureSystemServices();

    const { documentStorage } = await import("./storage/documents");
    await documentStorage.ensureCustomerDocumentTypes();

    const { backfillAppointmentServices } = await import("./startup/backfill-appointment-services");
    await backfillAppointmentServices();

    const { importPflegekassen } = await import("./startup/import-pflegekassen");
    await importPflegekassen();

    const { migrateBudgetSources } = await import("./startup/migrate-budget-sources");
    try {
      await migrateBudgetSources();
    } catch (err) {
      console.error("[startup] Budget-Source-Migration fehlgeschlagen:", err);
    }

    const { seedWhatsAppRules } = await import("./startup/seed-whatsapp-rules");
    try {
      await seedWhatsAppRules();
    } catch (err) {
      console.error("[startup] WhatsApp-Regeln-Seed fehlgeschlagen:", err);
    }

    const { migrateErstberatungCustomers } = await import("./startup/migrate-erstberatung-customers");
    try {
      await migrateErstberatungCustomers();
    } catch (err) {
      console.error("[startup] Erstberatung-Kunden-Migration fehlgeschlagen:", err);
    }

    const { syncAllBudgetAllocations } = await import("./startup/sync-budget-allocations");
    try {
      const synced = await syncAllBudgetAllocations();
      if (synced > 0) log(`Budget-Zuweisungen synchronisiert für ${synced} Kunden`, "startup");
    } catch (err) {
      console.error("[startup] Budget-Sync fehlgeschlagen:", err);
    }

    const { syncVacationCarryover } = await import("./startup/sync-vacation-carryover");
    try {
      const synced = await syncVacationCarryover();
      if (synced > 0) log(`Urlaubsübertrag synchronisiert für ${synced} Mitarbeiter`, "startup");
    } catch (err) {
      console.error("[startup] Urlaubsübertrag-Sync fehlgeschlagen:", err);
    }

    const { geocodeAllMissing } = await import("./services/geocoding");
    geocodeAllMissing().catch(err => console.error("[geocoding] Batch geocoding error:", err));

    try {
      const superAdminEmail = process.env.SUPER_ADMIN_EMAIL;
      if (!superAdminEmail) {
        log("SUPER_ADMIN_EMAIL nicht gesetzt, Superadmin-Promotion übersprungen", "startup");
      } else {
        const promoteResult = await db.execute(sqlBuilder`
          UPDATE users SET is_super_admin = true 
          WHERE email = ${superAdminEmail} AND is_admin = true AND is_super_admin = false
        `);
        if (promoteResult.rowCount && promoteResult.rowCount > 0) {
          log(`Superadmin-Promotion: ${superAdminEmail}`);
        }
      }
    } catch (e) {
      console.error("Fehler bei Superadmin-Promotion:", e);
    }

    log("Alle Startup-Aufgaben abgeschlossen", "startup");
  } catch (err) {
    console.error("[startup] Kritischer Fehler bei Startup-Aufgaben:", err);
  }

  const { authService } = await import("./services/auth");
  const runSessionCleanup = async () => {
    try {
      const [sessionCount, tokenCount] = await Promise.all([
        authService.cleanupExpiredSessions(),
        authService.cleanupExpiredResetTokens(),
      ]);
      if (sessionCount > 0 || tokenCount > 0) {
        log(`Bereinigt: ${sessionCount} abgelaufene Sessions, ${tokenCount} abgelaufene Tokens`);
      }
    } catch (e) {
      console.error("Fehler bei Session-Bereinigung:", e);
    }
  };
  runSessionCleanup();
  intervals.push(setInterval(runSessionCleanup, 60 * 60 * 1000));

  const { generateDocumentReviewTasks, shouldRunDocumentReview } = await import("./services/document-review");
  const runDocumentReviewIfDue = async () => {
    try {
      if (await shouldRunDocumentReview()) {
        const created = await generateDocumentReviewTasks();
        if (created > 0) log(`${created} Dokumenten-Aufgaben erstellt`);
      }
    } catch (e) {
      console.error("Fehler bei Dokumenten-Prüfung:", e);
    }
  };
  runDocumentReviewIfDue();
  intervals.push(setInterval(runDocumentReviewIfDue, 6 * 60 * 60 * 1000));

  const { checkUpcomingBirthdays } = await import("./services/birthday-notification-checker");
  const runBirthdayCheck = async () => {
    try {
      const created = await checkUpcomingBirthdays();
      if (created > 0) log(`${created} Geburtstags-Benachrichtigungen erstellt`);
    } catch (e) {
      console.error("Fehler bei Geburtstags-Prüfung:", e);
    }
  };
  timeouts.push(setTimeout(runBirthdayCheck, 5 * 60 * 1000));
  intervals.push(setInterval(runBirthdayCheck, 6 * 60 * 60 * 1000));

  const { checkBudgetRenewals } = await import("./services/budget-renewal-checker");
  const runBudgetRenewalCheck = async () => {
    try {
      const created = await checkBudgetRenewals();
      if (created > 0) log(`${created} §39/42a Budget-Verlängerungs-Aufgaben erstellt`);
    } catch (e) {
      console.error("Fehler bei Budget-Verlängerungs-Prüfung:", e);
    }
  };
  timeouts.push(setTimeout(runBudgetRenewalCheck, 7 * 60 * 1000));
  intervals.push(setInterval(runBudgetRenewalCheck, 24 * 60 * 60 * 1000));

  const { startReminderScheduler } = await import("./services/whatsapp-reminder-scheduler");
  const reminderScheduler = startReminderScheduler();
  timeouts.push(reminderScheduler.timeout);
  if (reminderScheduler.interval) intervals.push(reminderScheduler.interval);
}

function gracefulShutdown(signal: string) {
  log(`${signal} received, shutting down gracefully...`);
  intervals.forEach(interval => clearInterval(interval));
  timeouts.forEach(timeout => clearTimeout(timeout));
  httpServer.close(async () => {
    try {
      await closeBrowser();
      log("Puppeteer browser closed");
    } catch (err) {
      console.error("Error closing browser:", err);
    }
    try {
      await pool.end();
      log("Database pool drained");
    } catch (err) {
      console.error("Error draining database pool:", err);
    }
    process.exit(0);
  });
  setTimeout(() => {
    log("Forced shutdown after timeout");
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
