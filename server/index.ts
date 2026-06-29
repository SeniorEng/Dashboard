import { installGermanZodErrors } from "@shared/utils/zod-german";
installGermanZodErrors();

import { transformSignatureFields } from "@shared/utils/signature-transport";

import express from "express";
import cookieParser from "cookie-parser";
import compression from "compression";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { errorMiddleware } from "./lib/errors";
import { pool, db, logPoolStats } from "./lib/db";
import { sql as sqlBuilder } from "drizzle-orm";
import { closeBrowser } from "./services/pdf-generator";
import { startMemoryWatchdog } from "./lib/memory-watchdog";
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

// Restore the `data:image/...;base64,` prefix on signature fields. The browser
// strips it before sending (the edge WAF blocks request bodies containing a
// `data:` URI), so we rebuild the full data URL here — before any validation,
// hashing, storage or PDF rendering — keeping the persisted format unchanged.
app.use((req, _res, next) => {
  if (req.path.startsWith("/api") && req.body && typeof req.body === "object") {
    req.body = transformSignatureFields(req.body, "restore");
  }
  next();
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test") ? 50000 : 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.startsWith("/api/auth/") || req.path.startsWith("/auth/"),
  message: { message: "Zu viele Anfragen, bitte später erneut versuchen." },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test") ? 1000 : 10,
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
  // Task #1429 — Boot-Guard: In NODE_ENV=test darf der Server NUR gegen eine
  // Wegwerf-/Ephemeral-DB hochfahren, nie gegen die Dev-/Prod-DB. Muss VOR jeder
  // DB-Arbeit (Migrationen/Seeds) laufen. Bewusst NICHT fault-isoliert: ein
  // Fehlschlag MUSS den Prozess beenden (kein Test-Server gegen die Dev-DB).
  try {
    const { assertTestModeUsesEphemeralDb } = await import(
      "./startup/assert-ephemeral-test-db"
    );
    assertTestModeUsesEphemeralDb();
  } catch (err) {
    log(`[FATAL] Test-Mode-DB-Guard: ${err}`, "startup");
    process.exit(1);
  }

  // Task #1339 (Reihenfolge-Fix) — Die `prices`-SSoT MUSS befüllt/wiederhergestellt
  // sein, BEVOR der Critical-SSoT-Boot-Gate sie prüft. Vorher liefen die Befüll-
  // (#1329) und Recovery-Migration (#1334) erst in `runStartupTasks`, also NACH
  // `httpServer.listen` — und damit NACH dem Gate. In Produktion fand der Gate
  // dadurch die leere `prices`-Tabelle vor und beendete den Prozess
  // (`process.exit(1)`), BEVOR die Wiederherstellung je laufen konnte: ein Boot-
  // Deadlock, der jeden Publish scheitern ließ. Diese Migrationen sind
  // ledger-gegated + idempotent und laufen daher hier (vor dem Serving). Sie sind
  // fault-isoliert: bleibt `prices` trotzdem leer, entscheidet der nachfolgende
  // Gate hart (Prod-Abbruch / Dev-Warnung). Der Ledger wird vorab sichergestellt,
  // da der Guarded-Runner ihn liest.
  try {
    const { ensureMigrationLedger } = await import(
      "./startup/ensure-migration-ledger"
    );
    await ensureMigrationLedger();
  } catch (err) {
    log(`[startup] Migrations-Ledger sicherstellen fehlgeschlagen: ${err}`, "startup");
  }
  try {
    const { runPopulatePricesFromLegacy } = await import(
      "./startup/populate-prices-from-legacy"
    );
    await runPopulatePricesFromLegacy();
  } catch (err) {
    log(`Prices-Befüllung aus Alt-Tabellen fehlgeschlagen: ${err}`, "startup");
  }
  try {
    const { runRecoverPricesFromBackup } = await import(
      "./startup/recover-prices-from-backup"
    );
    await runRecoverPricesFromBackup();
  } catch (err) {
    log(`Prices-Wiederherstellung aus Backup fehlgeschlagen: ${err}`, "startup");
  }

  // Task #1339 — Critical-SSoT-Boot-Gate VOR dem Serving. Bricht den Boot in
  // Produktion hart ab, wenn eine kritische SSoT (z.B. `prices`) leer ist, ihre
  // Quell-Tabellen fehlen und Leser davon abhängen (der stille #1334-No-Op-
  // Datenverlust). In Dev/Test wird nur laut gewarnt (Dev-DB läuft legitim mit
  // leerer prices-Tabelle). Bewusst NICHT fault-isoliert: ein Fehlschlag MUSS
  // den Prozess beenden (Exit≠0 ⇒ Deploy schlägt fehl ⇒ alte Version bleibt).
  try {
    const { runCriticalSsotBootGate } = await import(
      "./startup/critical-ssot-boot-gate"
    );
    await runCriticalSsotBootGate();
  } catch (err) {
    log(`[FATAL] Critical-SSoT-Boot-Gate: ${err}`, "startup");
    process.exit(1);
  }

  await registerRoutes(httpServer, app);

  // Task #705 — API-Catch-All vor Vite/Static-Fallback. Vor diesem Handler
  // sind sämtliche registrierten /api/*-Routen montiert; alles, was hier
  // landet, ist ein echter 404 (oder 405, wenn dieselbe Pfad-Variante mit
  // anderer Methode existiert). Ohne diesen Handler würde der Vite-
  // Wildcard die /api/*-Request als HTML-Index ausliefern (Bug-Report
  // 2026-05-27, "POST/PUT/DELETE auf unbekannte /api/*-Endpoints liefern
  // HTML"). Erzwingt JSON-Antwort und blockiert das Durchreichen an Vite.
  app.use("/api", (req, res) => {
    res.status(404).json({
      error: "NOT_FOUND",
      code: "NOT_FOUND",
      message: `API-Endpunkt nicht gefunden: ${req.method} ${req.originalUrl}`,
    });
  });

  app.use(errorMiddleware);

  // Task #903: API-only-Test-Server (Vitest-Integrationslauf) brauchen weder
  // den Vite-Dev-Server noch die statischen Client-Assets — die Tests rufen
  // ausschließlich /api/*-Endpunkte. `createViteServer()` ist beim Boot teuer
  // (mehrere Sekunden Modul-Optimierung pro Worker-Server). Wenn der
  // Ephemeral-DB-Orchestrator `TEST_SKIP_CLIENT=1` setzt (nur für den
  // Vitest-Pfad, NICHT für Playwright/e2e, das die SPA wirklich rendert),
  // überspringen wir das Client-Serving komplett und sparen pro Worker-Boot die
  // Vite-Setup-Zeit. In Dev (`Start application`) und Prod bleibt alles wie bisher.
  const skipClient = process.env.TEST_SKIP_CLIENT === "1";
  // Task #908: Der e2e-Test-Server bootet aus dem esbuild-Bundle mit plain
  // `node` (statt `tsx server/index.ts`) und liefert einen vorgebauten Vite-
  // Client statisch aus — wie der Prod-Pfad, aber ohne `NODE_ENV=production`
  // (der Server soll seine Test-Semantik behalten, nur das teure Vite-Dev-
  // Setup entfällt). `TEST_SERVE_STATIC_CLIENT=1` erzwingt daher den
  // serveStatic-Pfad; `CLIENT_STATIC_DIR` zeigt auf das Pro-Lauf-Build.
  const serveStaticClient = process.env.TEST_SERVE_STATIC_CLIENT === "1";
  if (skipClient) {
    log("TEST_SKIP_CLIENT=1 — Client-Serving (Vite/Static) übersprungen (API-only Test-Server)", "startup");
  } else if (serveStaticClient || process.env.NODE_ENV === "production") {
    if (serveStaticClient) {
      log("TEST_SERVE_STATIC_CLIENT=1 — vorgebauten Vite-Client statisch ausliefern (e2e Test-Server)", "startup");
    }
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
      logPoolStats("db");
      // Task #541: Memory-Watchdog früh starten, damit Boot-Spitzen erfasst
      // werden. unref()'d, daher kein Block beim Graceful-Shutdown.
      intervals.push(startMemoryWatchdog(log));
      runStartupTasks();
    },
  );
})();

async function runStartupTasks() {
  try {
    const { fixColumnTypes } = await import("./startup/fix-invoice-line-item-types");
    try {
      await fixColumnTypes();
    } catch (err) {
      log(`Spaltentyp-Migration fehlgeschlagen: ${err}`, "startup");
    }

    // Stellt Idempotency-Tabelle und setup_*_pending-Spalten in jeder Umgebung
    // sicher (auch wenn `drizzle-kit push` nicht gelaufen ist). Idempotente DDL.
    const { ensureCustomerIdempotencySchema } = await import("./startup/ensure-customer-idempotency-schema");
    try {
      await ensureCustomerIdempotencySchema();
    } catch (err) {
      log(`Idempotency-Schema-Migration fehlgeschlagen: ${err}`, "startup");
    }

    const { ensureAuditParentDeletionColumn } = await import("./startup/ensure-audit-parent-deletion");
    try {
      await ensureAuditParentDeletionColumn();
    } catch (err) {
      log(`Audit-ParentDeletion-Migration fehlgeschlagen: ${err}`, "startup");
    }

    // Task #824: GoBD-technische Unveränderbarkeit von audit_log erzwingen
    // (BEFORE-UPDATE/DELETE/TRUNCATE-Trigger, die fehlschlagen statt still zu
    // schlucken). Ersetzt die alten DO-INSTEAD-NOTHING-RULEs.
    const { ensureAuditLogImmutable, assertAuditLogImmutable } = await import("./startup/ensure-audit-log-immutable");
    try {
      await ensureAuditLogImmutable();
    } catch (err) {
      log(`Audit-Log-Immutability-Migration fehlgeschlagen: ${err}`, "startup");
    }
    // Task #829: Self-Check gegen die LAUFENDE DB, dass die Trigger wirklich
    // aktiv sind und die Alt-RULEs weg sind (z.B. nach DB-Restore oder wenn die
    // Migration oben übersprungen/fehlgeschlagen ist). Ergebnis landet im
    // /api/health-Endpoint; eine Lücke wird laut ins Log gewarnt.
    try {
      await assertAuditLogImmutable();
    } catch (err) {
      log(`Audit-Log-Immutability-Self-Check fehlgeschlagen: ${err}`, "startup");
    }

    // Task #828: GoBD-technische Absicherung weiterer integritäts-/
    // historisierungskritischer Tabellen (budget_allocations no-resurrect/
    // no-delete, customer_budget_type_settings append-only, invoices/
    // invoice_line_items für finalisierte Rechnungen) via BEFORE-Trigger mit
    // transaktions-lokalem Bypass-GUC `app.allow_gobd_mutation`. Läuft VOR den
    // Budget-Daten-Migrationen, damit deren legitime Hard-Deletes den Bypass
    // bereits gegen aktive Trigger nutzen.
    const { ensureGobdTableImmutability } = await import("./startup/ensure-gobd-table-immutability");
    try {
      await ensureGobdTableImmutability();
    } catch (err) {
      log(`GoBD-Tabellen-Immutability-Migration fehlgeschlagen: ${err}`, "startup");
    }

    // Budget-Ledger Stufe B (Task #1273): die GoBD-Immutability ist von der
    // früheren Spiegel-Tabelle auf budget_transactions UMGEZOGEN (append-only).
    // Trigger lehnen UPDATE/DELETE/TRUNCATE ab (Bypass-GUC
    // app.allow_gobd_mutation). budget_reservations bleibt bewusst mutierbar.
    const { ensureBudgetTransactionsImmutability, assertBudgetTransactionsImmutable } = await import("./startup/ensure-budget-transactions-immutability");
    try {
      await ensureBudgetTransactionsImmutability();
    } catch (err) {
      log(`Budget-Transactions-Immutability-Migration fehlgeschlagen: ${err}`, "startup");
    }
    // Self-Check gegen die LAUFENDE DB, dass die Trigger wirklich aktiv sind
    // (z.B. nach DB-Restore oder wenn die Migration oben übersprungen/
    // fehlgeschlagen ist). Ergebnis landet im /api/health-Endpoint; eine Lücke
    // wird laut ins Log gewarnt.
    try {
      await assertBudgetTransactionsImmutable();
    } catch (err) {
      log(`Budget-Transactions-Immutability-Self-Check fehlgeschlagen: ${err}`, "startup");
    }

    // Task #1272 (Stufe A) — zweiter Capture-Link
    // budget_reservations.captured_transaction_id → budget_transactions.id
    // idempotent anlegen (nullable FK + Index). Muss laufen, bevor der
    // Capture-Pfad die Spalte schreibt. GoBD-Bestandsmuster: Startup-Schritt,
    // kein drizzle-kit push.
    const { ensureReservationCapturedTransactionLink } = await import("./startup/ensure-reservation-captured-transaction-link");
    try {
      await ensureReservationCapturedTransactionLink();
    } catch (err) {
      log(`Reservation-capturedTransactionId-Migration fehlgeschlagen: ${err}`, "startup");
    }

    const { ensureQontoMatchIdempotency } = await import("./startup/ensure-qonto-match-idempotency");
    try {
      await ensureQontoMatchIdempotency();
    } catch (err) {
      log(`Qonto-Match-Idempotenz-Migration fehlgeschlagen: ${err}`, "startup");
    }

    const { serviceCatalogStorage } = await import("./storage/service-catalog");
    try {
      await serviceCatalogStorage.syncServiceCatalog();
    } catch (err) {
      log(`Service-Katalog-Sync fehlgeschlagen (Startfehler): ${err}`, "startup");
    }

    const { documentStorage } = await import("./storage/documents");
    try {
      await documentStorage.ensureCustomerDocumentTypes();
    } catch (err) {
      log(`Kunden-Dokumenttypen-Seed fehlgeschlagen: ${err}`, "startup");
    }

    // Entfernt die deprecated Spalte appointments.service_type endgültig.
    // Idempotent (DROP COLUMN IF EXISTS) — beim nächsten Boot ein No-Op.
    const { dropAppointmentsServiceTypeColumn } = await import("./startup/drop-appointments-service-type");
    try {
      await dropAppointmentsServiceTypeColumn();
    } catch (err) {
      log(`Drop-appointments.service_type-Migration fehlgeschlagen: ${err}`, "startup");
    }

    // Task #861: leftover Legacy-Spalten customers.aua_approval_ref /
    // aua_approval_date entfernen. Idempotent (DROP COLUMN IF EXISTS) mit
    // Nicht-NULL-Guard pro Spalte — beim nächsten Boot ein No-Op.
    const { dropAuaApprovalColumns } = await import("./startup/drop-aua-approval-columns");
    try {
      await dropAuaApprovalColumns();
    } catch (err) {
      log(`Drop-customers.aua_approval_*-Migration fehlgeschlagen: ${err}`, "startup");
    }

    const { encryptExistingSecrets } = await import("./startup/encrypt-company-secrets");
    try {
      await encryptExistingSecrets();
    } catch (err) {
      log(`Secrets-Verschlüsselung fehlgeschlagen: ${err}`, "startup");
    }

    const { importPflegekassen } = await import("./startup/import-pflegekassen");
    try {
      await importPflegekassen();
    } catch (err) {
      log(`Pflegekassen-Import fehlgeschlagen: ${err}`, "startup");
    }

    const { seedPkvProviders } = await import("./startup/seed-pkv-providers");
    try {
      await seedPkvProviders();
    } catch (err) {
      log(`PKV-Provider-Seed fehlgeschlagen: ${err}`, "startup");
    }

    // Task #895 / #896: Verlässliches Budget-Migrations-Framework. Der Ledger
    // (`budget_migrations`) gatet einmalige Budget-Daten-Migrationen auf
    // exactly-once und wird HIER (früh) angelegt. Der eigentliche
    // Guarded-Runner (`runBudgetDataMigrations`) läuft weiter unten — NACH
    // `backfillBudgetHistorization` —, weil die dort registrierten
    // Carryover-Backfills (#601/#684/#685) den partiellen Unique-Index auf
    // budget_allocations voraussetzen.
    const { ensureMigrationLedger } = await import("./startup/ensure-migration-ledger");
    try {
      await ensureMigrationLedger();
    } catch (err) {
      log(`Migrations-Ledger-Setup fehlgeschlagen: ${err}`, "startup");
    }

    // Task #1262: Unbenutzte Pflegekassen in PRODUKTION GENAU EINMAL aufräumen
    // (Ledger-gegated, exactly-once). In Dev/Test ein No-Op — dort bleibt das
    // manuelle "Aufräumen" über die Superadmin-Route erhalten. Gelöschte Kassen
    // tauchen beim täglichen EDIFACT-Reimport NICHT wieder auf (Insert-Guard in
    // import-pflegekassen.ts). Läuft NACH importPflegekassen/seedPkvProviders
    // und NACH ensureMigrationLedger (Ledger-Tabelle muss existieren).
    const { cleanupUnusedInsuranceProvidersOnStartup } = await import(
      "./startup/cleanup-unused-insurance-providers"
    );
    try {
      await cleanupUnusedInsuranceProvidersOnStartup();
    } catch (err) {
      log(`Unbenutzte-Pflegekassen-Cleanup fehlgeschlagen: ${err}`, "startup");
    }

    const { migrateInvoiceStornoRefs } = await import("./startup/migrate-invoice-storno-refs");
    try {
      await migrateInvoiceStornoRefs();
    } catch (err) {
      log(`Invoice-Storno-Refs-Migration fehlgeschlagen: ${err}`, "startup");
    }

    const { migrateInvoiceZugferdXml } = await import("./startup/migrate-invoice-zugferd-xml");
    try {
      await migrateInvoiceZugferdXml();
    } catch (err) {
      log(`Invoice-ZUGFeRD-XML-Migration fehlgeschlagen: ${err}`, "startup");
    }

    // Task #521: stellt die LN-Cache-Spalten (`leistungsnachweis_path` /
    // `leistungsnachweis_hash`) sicher, bevor der Backfill versucht zu schreiben.
    const { ensureInvoiceLeistungsnachweisColumns } = await import("./startup/ensure-invoice-leistungsnachweis-columns");
    try {
      await ensureInvoiceLeistungsnachweisColumns();
    } catch (err) {
      log(`Invoice-LN-Spalten-Migration fehlgeschlagen: ${err}`, "startup");
    }

    // Task #522: Drift-Fingerprint-Spalten sicherstellen.
    const { ensureInvoiceFingerprintColumns } = await import("./startup/ensure-invoice-fingerprint-columns");
    try {
      await ensureInvoiceFingerprintColumns();
    } catch (err) {
      log(`Invoice-Fingerprint-Spalten-Migration fehlgeschlagen: ${err}`, "startup");
    }

    // Task #561: explizite Menge + Einheit auf invoice_line_items.
    const { ensureInvoiceLineItemQuantityColumns } = await import("./startup/ensure-invoice-line-item-quantity-columns");
    try {
      await ensureInvoiceLineItemQuantityColumns();
    } catch (err) {
      log(`Invoice-Line-Item-Quantity-Migration fehlgeschlagen: ${err}`, "startup");
    }

    // Task #1428 — Einmalige, NICHT-Budget Daten-Migrationen, PHASE pre-budget.
    // Ledger-gegated (exactly-once über `budget_migrations`): auf frischer DB
    // läuft jede genau einmal + protokolliert eine Ledger-Zeile, jeder spätere
    // Boot macht nur einen billigen indizierten `SELECT 1`-Skip (kein Scan).
    // ERSETZT die zuvor einzeln verdrahteten `await import(...)`-Blöcke für:
    // migrate-km-geo-to-numeric (#678, läuft wie bisher direkt NACH
    // `ensureInvoiceLineItemQuantityColumns` und VOR
    // `reconcileDriftedColumnTypes`), migrate-monthly-work-hours-to-numeric
    // (#833), backfill-orphan-reversal-appointment-id (#819),
    // backfill-storno-transaction-date (#963), backfill-avis-received-status
    // (#1284), clear-45b-monthly-limits (#603), migrate-in-progress-appointments,
    // migrate-task-status-in-progress, migrate-expired-unsigned-appointments —
    // allesamt VOR dem Budget-Migrations-Block (`backfillBudgetHistorization` +
    // `runBudgetDataMigrations`). Reihenfolge bewahrt; fault-isoliert pro
    // Migration. Registry: `server/startup/data-migration-runner.ts`.
    const { runOneTimeDataMigrations } = await import("./startup/data-migration-runner");
    try {
      await runOneTimeDataMigrations("pre-budget");
    } catch (err) {
      log(`Einmalige Daten-Migrationen (pre-budget) fehlgeschlagen: ${err}`, "startup");
    }

    // Task #593: Render-Snapshot-Spalte (companySettings + Kunden-Snapshot) für
    // deterministische Integrity-Verifier-Re-Renders sicherstellen.
    const { ensureInvoiceRenderSnapshotColumn } = await import("./startup/ensure-invoice-render-snapshot");
    try {
      await ensureInvoiceRenderSnapshotColumn();
    } catch (err) {
      log(`Invoice-Render-Snapshot-Migration fehlgeschlagen: ${err}`, "startup");
    }

    // Task #1066 — Bestands-PDF-Pfade aus dem nackten Produktions-Key-Space
    // (`invoices/…`) in den umgebungs-isolierten Key-Space
    // (`_nonprod/<NODE_ENV>/…`) umschreiben, damit Dev/Test nicht mehr auf
    // dieselben Object-Keys wie die Produktion zeigen (RE-2026-0001/0002/0004/
    // 0036-Kollisionen). Nur Nicht-Produktion; läuft NACH den LN-/Render-
    // Snapshot-Spalten-Migrationen. Der Self-Heal-Pfad rendert das frische
    // Objekt beim nächsten Abruf aus dem eingefrorenen Snapshot neu.
    const { migrateLegacyInvoicePdfPaths } = await import("./startup/migrate-legacy-invoice-pdf-paths");
    try {
      await migrateLegacyInvoicePdfPaths();
    } catch (err) {
      log(`Legacy-Invoice-PDF-Pfad-Migration fehlgeschlagen: ${err}`, "startup");
    }

    // Task #759 — Variant C: invoices.budget_type / invoices.billing_run_id
    // + customer_budget_recipients sicherstellen (Rechnungs-Split pro Topf).
    const { ensureInvoicePerPotColumns } = await import("./startup/ensure-invoice-per-pot-columns");
    try {
      await ensureInvoicePerPotColumns();
    } catch (err) {
      log(`Invoice-Per-Pot-Spalten-Migration fehlgeschlagen: ${err}`, "startup");
    }

    // Task #924 — Bereits-provisionierte Prod-DBs versöhnen, deren Spalten von
    // alten (falschen) DDL-Pfaden mit dem falschen Typ angelegt wurden. Läuft
    // NACH allen ensure-*-Migrationen, die die Ziel-Tabellen anlegen. Idempotent:
    // ALTER nur, wenn der Ist-Typ vom Drizzle-Soll-Typ abweicht.
    const { reconcileDriftedColumnTypes } = await import("./startup/reconcile-drifted-column-types");
    try {
      await reconcileDriftedColumnTypes();
    } catch (err) {
      log(`Drift-Spaltentyp-Reconciliation fehlgeschlagen: ${err}`, "startup");
    }

    // Task #1204 — customer_budget_preferences.budget_start_date(_origin)
    // entfernt: der Anker wird zur Laufzeit pro Topf aus der Pflegegrad-Historie
    // abgeleitet, nicht mehr persistiert.
    const { dropBudgetStartDateColumns } = await import("./startup/drop-budget-start-date-columns");
    try {
      await dropBudgetStartDateColumns();
    } catch (err) {
      log(`Budget-Start-Date-Spalten-Drop fehlgeschlagen: ${err}`, "startup");
    }

    // Task #819 — Import-Batch-Tabelle + import_batch_id-Spalten.
    const { ensureImportBatch } = await import("./startup/ensure-import-batch");
    try {
      await ensureImportBatch();
    } catch (err) {
      log(`Import-Batch-Migration fehlgeschlagen: ${err}`, "startup");
    }

    // INTERIM (Publish-Fenster) — Die GoBD-CHECK-Constraint
    // `budget_transactions_appointment_required_check` wird VORÜBERGEHEND NICHT
    // mehr beim Startup angelegt. Grund: Der automatische Replit-Publish-Diff
    // vergleicht Dev-DB ↔ Prod-DB direkt und wendet die Constraint HART (ohne
    // den Skip-Schutz dieses Hooks) im Migrations-Schritt VOR dem App-Start an.
    // Die Prod-DB enthält 99 legitime Alt-Import-Zeilen (51 consumption +
    // 48 reversal ohne appointment_id), die die Constraint verletzen → der
    // Publish bricht ab. Da der Backfill erst beim App-Start (nach dem
    // Migrations-Schritt) liefe, kann die Constraint im selben Publish nicht
    // greifen. Für ein rein additives, datensicheres Publish-Fenster hält dev
    // die Constraint daher NICHT mehr vor (Drop in der Dev-DB). Die Datei
    // server/startup/ensure-budget-tx-appointment-constraint.ts (SQL-Konstante +
    // Funktion + Drift-Wächter) bleibt erhalten und wird im dedizierten
    // Folge-Task (Orphan-Backfill der 99 Zeilen → DANN Constraint) wieder
    // scharfgeschaltet.

    // Task #1274 (Stufe C) / #1443 / #1446 / #1486 — Der frühere budget_ledger-
    // Spiegel (FK-Spalte budget_reservations.captured_ledger_id + Tabelle
    // budget_ledger) ist in Prod über die gegatete Guarded-Migration
    // `drop-budget-ledger-1443` entfernt; das Drop-Gerüst (Migration, Flag,
    // Schema-Marker) wurde danach in Task #1486 abgebaut. SoT der Buchungen ist
    // allein budget_transactions mit captured_transaction_id als Capture-Link.

    // Task #988/#993/#994 — Die einmalige Phantom-Storno-Import-Drift-Korrektur
    // (#987) lief beim Prod-(Re-)Deploy einmalig scharf durch und ist bestätigt
    // (0 offene Waisen, 28 Korrekturen, Audit-Batch in
    // docs/import-budget-drift-report-20260527.md §10.4). Der Startup-Hook wurde
    // daher in Task #994 ersatzlos entfernt; der manuelle CLI-Fallback
    // server/scripts/reconcile-phantom-stornos.ts bleibt als scharfes Werkzeug.

    // Task #757: Spalte für abweichenden Kontoinhaber in den Firmenstammdaten.
    const { ensureCompanyBankAccountHolderColumn } = await import("./startup/ensure-company-bank-account-holder");
    try {
      await ensureCompanyBankAccountHolderColumn();
    } catch (err) {
      log(`Company-Bank-Account-Holder-Migration fehlgeschlagen: ${err}`, "startup");
    }

    const { seedWhatsAppRules } = await import("./startup/seed-whatsapp-rules");
    try {
      await seedWhatsAppRules();
    } catch (err) {
      log(`WhatsApp-Regeln-Seed fehlgeschlagen: ${err}`, "startup");
    }

    const { migrateWhatsAppToTwilio } = await import("./startup/migrate-whatsapp-twilio");
    try {
      await migrateWhatsAppToTwilio();
    } catch (err) {
      log(`WhatsApp-Twilio-Migration fehlgeschlagen: ${err}`, "startup");
    }

    // Task #616: Termin-vs-Budget-km-Drift auditieren (Screenshot-Fall
    // 12.01./21.01./04.02.2026). Log-only, kein automatischer Schreibvorgang
    // auf GoBD-relevante Buchungen.
    const { auditAppointmentBudgetKmDrift } = await import(
      "./startup/audit-appointment-budget-km-drift"
    );
    try {
      await auditAppointmentBudgetKmDrift();
    } catch (err) {
      log(`Termin-km-Drift-Audit fehlgeschlagen: ${err}`, "startup");
    }

    const { backfillBudgetHistorization } = await import("./startup/backfill-budget-historization");
    try {
      await backfillBudgetHistorization();
    } catch (err) {
      log(`Budget-Historisierung-Backfill fehlgeschlagen: ${err}`, "startup");
    }

    // Task #743 / #748 — Eingefrorene Legacy-Tabelle `customer_budgets` endgültig
    // droppen. Vorbedingung (Task #728 Phase 2.1): Backfill nach
    // `customer_budget_type_settings` ist auf Production gelaufen und vom
    // Operator validiert (siehe `docs/deployment-log.md`-Eintrag 2026-05-28).
    // Idempotent: prüft Existenz vor DROP, mehrfacher Lauf = No-Op.
    const { dropCustomerBudgetsTable } = await import(
      "./startup/drop-customer-budgets-table"
    );
    try {
      await dropCustomerBudgetsTable();
    } catch (err) {
      log(`Customer-Budgets-Drop fehlgeschlagen: ${err}`, "startup");
    }

    // Task #1339 (Reihenfolge-Fix) — `runPopulatePricesFromLegacy` (#1329) und
    // `runRecoverPricesFromBackup` (#1334) laufen jetzt VOR dem Critical-SSoT-Boot-
    // Gate (oben in der Boot-IIFE, vor `httpServer.listen`), damit `prices` bereits
    // befüllt ist, wenn der Gate prüft. Beide sind ledger-gegated/idempotent und
    // damit hier bewusst NICHT mehr dupliziert. `dropLegacyPriceTables` bleibt hier
    // (kein Pre-Serving-Bedarf; läuft weiterhin NACH der Befüllung).

    // Task #1326 — Verwaiste Legacy-Preis-Tabellen (`customer_service_prices`,
    // `customer_contract_rates`, `service_rates`) endgültig droppen. Vorbedingung
    // (Task #1325): Preis-Konsolidierung nach `prices`-SSoT ist abgeschlossen, kein
    // Leser/Schreiber greift mehr auf die drei Tabellen zu. Idempotent +
    // datensicher: droppt nur, wenn die Zeilen bereits in `prices` (passende
    // `origin`) repräsentiert sind, sonst Skip + Warnung (kein Datenverlust).
    const { dropLegacyPriceTables } = await import(
      "./startup/drop-legacy-price-tables"
    );
    try {
      await dropLegacyPriceTables();
    } catch (err) {
      log(`Legacy-Preis-Tabellen-Drop fehlgeschlagen: ${err}`, "startup");
    }

    // Task #721 — Idempotenter Read-Only-Audit der Phasen-Kette in
    // customer_budget_type_settings. Schreibt nur Log, korrigiert nichts
    // (verlorene Phasen sind nicht rekonstruierbar; Überlappungen sind
    // GoBD-relevant und müssen manuell entschieden werden).
    const { auditBudgetTypeSettingsChain } = await import("./startup/audit-budget-type-settings-chain");
    try {
      await auditBudgetTypeSettingsChain();
    } catch (err) {
      log(`Budget-Settings-Chain-Audit fehlgeschlagen: ${err}`, "startup");
    }

    // Task #895 / #896 — Guarded Budget-Daten-Migrationen (Registry in
    // `server/startup/budget-migration-runner.ts`). Der Ledger
    // (`budget_migrations`) gatet jede einmalige Budget-Daten-Migration auf
    // exactly-once; der Guarded-Runner klammert jede Migration mit einem
    // Conservation-Pre-/Post-Check ein (Rollback bei NEU eingeführter
    // Überziehung) und ist fault-isoliert. Läuft hier — NACH
    // `backfillBudgetHistorization` (partieller Unique-Index auf
    // budget_allocations) und NACH den GoBD-Immutability-Triggern (oben) —,
    // weil die registrierten Carryover-Backfills (#601/#684/#685) genau diese
    // Vorbedingungen brauchen und der transaktions-lokale GoBD-Bypass gegen
    // aktive Trigger greifen muss. Der Ledger wurde bereits weiter oben
    // (ensureMigrationLedger) angelegt.
    // Task #1402 (TEIL B) — Read-only Preflight VOR der Migrations-Registry:
    // erkennt einen Flag-Scope-Mismatch einer gegateten destruktiven Cleanup-
    // Migration (Flag fehlt, aber pending Altlast-Zeilen + nicht im Ledger) und
    // WARNT LAUT. Der Ledger ist zu diesem Zeitpunkt bereits sichergestellt
    // (ensureMigrationLedger, oben). Bewusst VOR runBudgetDataMigrations, damit
    // der approved-Fall hier als `pending-approved` (keine Warnung) erscheint und
    // die anschließende Registry ihn regulär anwendet — keine Doppel-Warnung.
    const { assertNoPendingDestructiveMismatch } = await import(
      "./startup/pending-destructive-migrations-preflight"
    );
    try {
      await assertNoPendingDestructiveMismatch();
    } catch (err) {
      log(`Preflight ausstehende destruktive Migrationen fehlgeschlagen: ${err}`, "startup");
    }

    const { runBudgetDataMigrations } = await import("./startup/budget-migration-runner");
    try {
      await runBudgetDataMigrations();
    } catch (err) {
      log(`Budget-Daten-Migrationen fehlgeschlagen: ${err}`, "startup");
    }

    // Einmalige, NICHT-Budget Daten-Migrationen NACH dem Budget-Block
    // (`backfillBudgetHistorization` + `runBudgetDataMigrations`).
    // Ledger-gegated (exactly-once über `budget_migrations`): auf frischer DB
    // läuft jede genau einmal + protokolliert eine Ledger-Zeile, jeder spätere
    // Boot macht nur einen billigen indizierten `SELECT 1`-Skip (kein Scan).
    // ERSETZT die zuvor einzeln verdrahteten `await import(...)`-Blöcke für:
    // restore-storno-deleted-service-records (#576),
    // migrate-erstberatung-customers, cleanup-orphan-erstberatung-customers
    // (MUSS nach migrate-erstberatung-customers laufen — Waisen entstehen aus
    // der Migration), migrate-prospect-statuses (läuft VOR dem nicht-gegateten
    // `matchProspectsToCustomers`), migrate-schulung-besprechung-to-sonstiges,
    // cleanup-vacation-on-holidays. Reihenfolge bewahrt; fault-isoliert pro
    // Migration. Registry: `server/startup/data-migration-runner.ts`.
    try {
      await runOneTimeDataMigrations("post-budget");
    } catch (err) {
      log(`Einmalige Daten-Migrationen (post-budget) fehlgeschlagen: ${err}`, "startup");
    }

    // Task #510-Constraint per Startup-DDL deaktiviert: Die Skill
    // `database/references/database-migrations-on-publish.md` verbietet
    // Schema-DDL aus dem App-Startup heraus, weil Replit Publishing den
    // Dev-DB-Diff nach Prod überträgt und an noch-vorhandenen Bestands-
    // Waisen scheitert (siehe Deploy-Fehler 2026-05-18). Der Schutz vor
    // neuen Waisen erfolgt jetzt allein über den Storage-Layer-Guard
    // `assertErstberatungHasProspectLink` (Task #512). Bestehende Waisen
    // räumt cleanup-orphan-erstberatung-customers beim ersten Prod-Start
    // auf; das Constraint kann später deklarativ in shared/schema/
    // customers.ts ergänzt werden, sobald Prod sauber ist.

    const { matchProspectsToCustomers } = await import("./startup/prospect-customer-matching");
    try {
      const matched = await matchProspectsToCustomers();
      if (matched > 0) log(`Prospect-Kunden-Abgleich: ${matched} Interessenten als gewonnen markiert`, "startup");
    } catch (err) {
      log(`Prospect-Kunden-Abgleich fehlgeschlagen: ${err}`, "startup");
    }

    const { syncAppointmentServiceDurations } = await import("./startup/sync-appointment-service-durations");
    try {
      await syncAppointmentServiceDurations();
    } catch (err) {
      log(`Termin-Service-Drift-Korrektur fehlgeschlagen: ${err}`, "startup");
    }

    const { syncAllBudgetAllocations } = await import("./startup/sync-budget-allocations");
    try {
      const synced = await syncAllBudgetAllocations();
      if (synced > 0) log(`Budget-Zuweisungen synchronisiert für ${synced} Kunden`, "startup");
    } catch (err) {
      log(`Budget-Sync fehlgeschlagen: ${err}`, "startup");
    }

    const { seedInitialVacationHistory } = await import("./startup/seed-initial-vacation-history");
    try {
      const seeded = await seedInitialVacationHistory();
      if (seeded > 0) log(`Urlaubs-Historie initial gesetzt für ${seeded} Mitarbeiter`, "startup");
    } catch (err) {
      log(`Urlaubs-Historie-Seed fehlgeschlagen: ${err}`, "startup");
    }

    const { syncVacationCarryover } = await import("./startup/sync-vacation-carryover");
    try {
      const synced = await syncVacationCarryover();
      if (synced > 0) log(`Urlaubsübertrag synchronisiert für ${synced} Mitarbeiter`, "startup");
    } catch (err) {
      log(`Urlaubsübertrag-Sync fehlgeschlagen: ${err}`, "startup");
    }

    const { geocodeAllMissing } = await import("./services/geocoding");
    geocodeAllMissing().catch(err => log(`Batch-Geocoding-Fehler: ${err}`, "startup"));

    // Task #550: Chromium-Pre-Flight EINMAL beim Boot. Prüft Binary +
    // Ausführbarkeit, damit Backfill/Render nicht in N × 30s-Timeouts gegen
    // ein totes Binary laufen. Ergebnis landet im /api/health-Endpoint.
    try {
      const { runChromiumPreflight, prewarmBrowser } = await import("./services/pdf-generator");
      const result = runChromiumPreflight();
      if (result.ok) {
        log(`Chromium-Pre-Flight OK (${result.version}) @ ${result.path}`, "startup");
        // Task #1479: Chromium NACH dem Listener non-blocking vorwärmen, damit
        // der pathologisch langsame Cold-Launch einmal beim Boot bezahlt wird
        // und nicht auf dem kritischen Pfad der ersten PDF-Anfrage zuschlägt.
        // Kein `await` — Readiness/`/api/health` bleiben unabhängig vom Warm-up-
        // Status. `prewarmBrowser()` wirft nie; Fehler werden nur geloggt. Nur
        // anstoßen, wenn der Preflight Chromium als verfügbar meldet.
        //
        // Task #1494 (WURZEL): Das Boot-Pre-Warm NICHT mehr auf allen Autoscale-
        // Instanzen im selben Moment feuern. Mehrere Instanzen, die gleichzeitig
        // Chromium kalt aus /nix/store wärmen, konkurrieren um Disk-I/O → jeder
        // Launch wird so langsam, dass er den 60s-Timeout reißt (Cold-Start-
        // Stampede). Zwei Entzerrungs-Hebel, beide non-blocking & best-effort:
        //   (1) Jitter: zufällige, beschränkte Verzögerung vor dem Pre-Warm.
        //   (2) Advisory-Lock: die DB ist die EINZIGE geteilte Ressource der
        //       Autoscale-Instanzen — wer den Lock bekommt, wärmt sofort; die
        //       anderen warten ein beschränktes Fenster und wärmen dann verzögert.
        // Der Boot hängt NIE am Lock (pg_try_advisory_lock ist nicht-blockierend;
        // jeder Fehler/Engpass = leise weiter). In Dev/Test sind Jitter & Lock-
        // Wartefenster 0 → kein verzögerter Boot.
        const coordinateChromiumPrewarm = async (): Promise<void> => {
          const isProd = process.env.NODE_ENV === "production";
          const resolveEnvMs = (name: string, prodDefault: number): number => {
            const raw = process.env[name];
            if (raw !== undefined && raw !== "") {
              const parsed = Number.parseInt(raw, 10);
              if (Number.isFinite(parsed) && parsed >= 0) return parsed;
            }
            return isProd ? prodDefault : 0;
          };

          // (1) Jitter — alle Instanzen lesen NICHT gleichzeitig aus /nix/store.
          const maxJitterMs = resolveEnvMs("CHROMIUM_PREWARM_JITTER_MS", 8_000);
          if (maxJitterMs > 0) {
            const jitterMs = Math.floor(Math.random() * maxJitterMs);
            if (jitterMs > 0) {
              log(`Chromium-Vorwärmen wird um ${jitterMs}ms entzerrt (Jitter) …`, "startup");
              await new Promise((resolve) => setTimeout(resolve, jitterMs));
            }
          }

          // (2) Advisory-Lock — instanzübergreifende Serialisierung über die DB,
          // streng best-effort. pg_try_advisory_lock liefert sofort true/false;
          // wir blockieren NIE auf dem Lock selbst, sondern warten — falls eine
          // andere Instanz gerade wärmt — nur ein beschränktes, festes Fenster.
          const lockWaitMs = resolveEnvMs("CHROMIUM_PREWARM_LOCK_WAIT_MS", 6_000);
          // Fester 32-bit-Schlüssel für „Chromium-Boot-Pre-Warm" (CCPW =
          // CareConnect Pre-Warm). pg_try_advisory_lock erwartet bigint — als
          // String-Param übergeben, um Präzisionsverlust zu vermeiden.
          const CHROMIUM_PREWARM_LOCK_KEY = String(0x43435057); // "CCPW"
          let lockClient: import("@neondatabase/serverless").PoolClient | null = null;
          let gotLock = false;
          if (lockWaitMs > 0) {
            try {
              lockClient = await pool.connect();
              const res = await lockClient.query<{ locked: boolean }>(
                "SELECT pg_try_advisory_lock($1) AS locked",
                [CHROMIUM_PREWARM_LOCK_KEY],
              );
              gotLock = res.rows?.[0]?.locked === true;
              if (gotLock) {
                log("Chromium-Vorwärmen hält den Boot-Lock — wärmt sofort.", "startup");
              } else {
                log(
                  `Eine andere Instanz wärmt Chromium — warte ${lockWaitMs}ms (Entzerrung) …`,
                  "startup",
                );
                await new Promise((resolve) => setTimeout(resolve, lockWaitMs));
              }
            } catch (err) {
              // DB-Engpass/Fehler → Koordination überspringen, einfach wärmen.
              log(`Chromium-Pre-Warm-Lock übersprungen (best-effort): ${err}`, "startup");
            }
          }

          try {
            log("Chromium wird vorgewärmt …", "startup");
            const warm = await prewarmBrowser();
            if (warm.ok) {
              log(
                warm.skipped
                  ? "Chromium vorgewärmt — bereits verbunden, kein erneuter Launch."
                  : "Chromium vorgewärmt — Browser bereit für die erste PDF-Anfrage.",
                "startup",
              );
            } else {
              log(
                `Chromium-Vorwärmen fehlgeschlagen: ${warm.error}. ` +
                  "Die erste PDF-Anfrage trägt den Cold-Launch; das Retry-Sicherheitsnetz bleibt aktiv.",
                "startup",
              );
            }
          } finally {
            if (lockClient) {
              try {
                if (gotLock) {
                  await lockClient.query("SELECT pg_advisory_unlock($1)", [
                    CHROMIUM_PREWARM_LOCK_KEY.toString(),
                  ]);
                }
              } catch {
                /* Lock fällt spätestens mit dem Verbindungsende — best-effort */
              }
              try {
                lockClient.release();
              } catch {
                /* ignore */
              }
            }
          }
        };
        coordinateChromiumPrewarm().catch((err) =>
          log(`Chromium-Vorwärmen Fehler: ${err}`, "startup"),
        );
      } else {
        log(
          `Chromium-Pre-Flight FEHLGESCHLAGEN @ ${result.path ?? "—"}: ${result.error}. ` +
            "PDF-Generierung wird in dieser Boot-Phase fehlschlagen.",
          "startup",
        );
      }
    } catch (err) {
      log(`Chromium-Pre-Flight Fehler: ${err}`, "startup");
    }

    // Task #577: Storno-spezifischer Backfill MUSS vor dem generischen
    // `backfillInvoicePdfs` laufen, damit pro betroffener Storno-ID der
    // Audit-Eintrag `invoice_pdf_manually_regenerated` geschrieben wird
    // (Akzeptanzkriterium). Liefe der generische Job zuerst, würde er die
    // Storno-Rechnungen lautlos persistieren und der Storno-Job fände eine
    // leere Ergebnismenge.
    setTimeout(() => {
      import("./startup/backfill-storno-invoice-pdfs")
        .then(({ backfillStornoInvoicePdfs }) => backfillStornoInvoicePdfs())
        .catch((err) => log(`Backfill-Storno-Invoice-PDFs-Fehler: ${err}`, "startup"));
    }, 5_000);

    // Task #521: PDF-Backfill nicht blockierend, max. 20 Rechnungen pro Boot.
    // Läuft async, nachdem der Server bereits Requests bedient. Storno-
    // Rechnungen werden im generischen Job ausgeschlossen (siehe Task #577) —
    // dafür ist `backfillStornoInvoicePdfs` zuständig, das zusätzlich Audit-
    // Einträge schreibt.
    setTimeout(() => {
      import("./startup/backfill-invoice-pdfs")
        .then(({ backfillInvoicePdfs }) => backfillInvoicePdfs())
        .catch((err) => log(`Backfill-Invoice-PDFs-Fehler: ${err}`, "startup"));
    }, 20_000);

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
      log(`Fehler bei Superadmin-Promotion: ${e}`, "startup");
    }

    if (process.env.NODE_ENV === "test") {
      try {
        const { getCachedCompanySettings } = await import("./services/cache");
        const settings = await getCachedCompanySettings();
        if (settings && (settings.smtpHost || settings.smtpUser)) {
          log(
            "ACHTUNG: NODE_ENV=test aktiv — Mail-Versand läuft gegen den In-Memory-Stub-Postausgang, " +
              "obwohl in den Firmeneinstellungen SMTP-Daten konfiguriert sind. Es gehen KEINE echten Mails raus.",
            "email-stub",
          );
        } else {
          log("NODE_ENV=test aktiv — Mail-Versand läuft gegen den In-Memory-Stub-Postausgang.", "email-stub");
        }
      } catch (err) {
        log(`Stub-Hinweis konnte nicht geprüft werden: ${err}`, "email-stub");
      }
    }

    log("Alle Startup-Aufgaben abgeschlossen", "startup");
  } catch (err) {
    log(`Kritischer Fehler bei Startup-Aufgaben: ${err}`, "startup");
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

  const { startCallSchedulerPoller } = await import("./services/call-scheduler");
  startCallSchedulerPoller();

  const { startMonthCloseScheduler } = await import("./services/month-close-scheduler");
  const monthCloseScheduler = startMonthCloseScheduler();
  intervals.push(monthCloseScheduler.interval);

  // Task #894: Der periodische Test-Daten-Safety-Purge entfällt — seit jeder
  // Integrationslauf seine eigene wegwerf-DB nutzt (scripts/with-ephemeral-db.ts)
  // wächst kein Stale-Pool mehr an, der aufgeräumt werden müsste.

  // Tier-A3: Nächtlicher Integrity-Check der letzten 30 Tage Rechnungen.
  // Re-rendert PDF + XML und gleicht gegen persistierten pdfHash/zugferdXml
  // ab, dokumentiert Drift im Audit-Log.
  const { verifyRecentInvoiceIntegrity } = await import("./services/invoice-integrity-verifier");
  const runInvoiceIntegrityCheck = async () => {
    try {
      await verifyRecentInvoiceIntegrity(30);
    } catch (e) {
      console.error("Fehler bei Invoice-Integrity-Check:", e);
    }
  };
  timeouts.push(setTimeout(runInvoiceIntegrityCheck, 15 * 60 * 1000));
  intervals.push(setInterval(runInvoiceIntegrityCheck, 24 * 60 * 60 * 1000));

  // Task #953: Budget-Hard-Block-Scharfschaltung in Produktion verriegeln.
  // Der Overdraft-Hard-Block (422 BUDGET_HARD_BLOCK) ist hinter dem Feature-Flag
  // `BUDGET_HARD_HOLDS` gegated. In Produktion MUSS er aktiv sein — fehlt das
  // Flag dort (z.B. weil die `[userenv.production]`-Zeile aus `.replit` /
  // Deployment-Secrets verschwindet), läuft der Server still im Legacy-Modus
  // ohne Überziehungsschutz weiter. Das wäre eine lautlose Regression, daher
  // hier eine laute Warnung. Der Status wird zusätzlich unter
  // `/api/health → budgetHardHolds` exponiert (Monitoring).
  if (process.env.NODE_ENV === "production") {
    const { hardHoldsEnabled } = await import("./storage/budget/reservation-storage");
    if (!hardHoldsEnabled()) {
      log(
        "WARN Budget-Hard-Block (BUDGET_HARD_HOLDS) ist in PRODUKTION NICHT aktiv — " +
          "Overdraft-Schutz läuft im Legacy-Modus. Flag in `.replit` [userenv.production] " +
          "bzw. den Deployment-Secrets setzen ('1').",
        "startup",
      );
    } else {
      log("Budget-Hard-Block (BUDGET_HARD_HOLDS) aktiv in Produktion.", "startup");
    }
  }

  // Task #894: Alle Startup-Seeder/-Migrationen sind durch — Readiness-Flag
  // setzen, damit Test-Setups (die auf /api/health → startupComplete warten)
  // erst jetzt loslaufen und nicht in die Seed-Race-Condition rennen.
  const { markStartupComplete } = await import("./lib/startup-state");
  markStartupComplete();
}

async function gracefulShutdown(signal: string) {
  log(`${signal} received, shutting down gracefully...`);
  intervals.forEach(interval => clearInterval(interval));
  timeouts.forEach(timeout => clearTimeout(timeout));
  try {
    const { stopCallSchedulerPoller } = await import("./services/call-scheduler");
    stopCallSchedulerPoller();
  } catch {}

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
