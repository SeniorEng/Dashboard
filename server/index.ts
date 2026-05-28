import { installGermanZodErrors } from "@shared/utils/zod-german";
installGermanZodErrors();

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
      logPoolStats("db");
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

    const { ensureQontoMatchIdempotency } = await import("./startup/ensure-qonto-match-idempotency");
    try {
      await ensureQontoMatchIdempotency();
    } catch (err) {
      log(`Qonto-Match-Idempotenz-Migration fehlgeschlagen: ${err}`, "startup");
    }

    const { serviceCatalogStorage } = await import("./storage/service-catalog");
    await serviceCatalogStorage.ensureSystemServices();

    const { documentStorage } = await import("./storage/documents");
    await documentStorage.ensureCustomerDocumentTypes();

    // Entfernt die deprecated Spalte appointments.service_type endgültig.
    // Idempotent (DROP COLUMN IF EXISTS) — beim nächsten Boot ein No-Op.
    const { dropAppointmentsServiceTypeColumn } = await import("./startup/drop-appointments-service-type");
    await dropAppointmentsServiceTypeColumn();

    const { encryptExistingSecrets } = await import("./startup/encrypt-company-secrets");
    try {
      await encryptExistingSecrets();
    } catch (err) {
      log(`Secrets-Verschlüsselung fehlgeschlagen: ${err}`, "startup");
    }

    const { importPflegekassen } = await import("./startup/import-pflegekassen");
    await importPflegekassen();

    const { seedPkvProviders } = await import("./startup/seed-pkv-providers");
    try {
      await seedPkvProviders();
    } catch (err) {
      log(`PKV-Provider-Seed fehlgeschlagen: ${err}`, "startup");
    }

    const { migrateBudgetSources } = await import("./startup/migrate-budget-sources");
    try {
      await migrateBudgetSources();
    } catch (err) {
      log(`Budget-Source-Migration fehlgeschlagen: ${err}`, "startup");
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

    // Task #678: KM-/Geo-Spalten von `real` (float) auf präzises `numeric`
    // migrieren. Muss NACH `ensureInvoiceLineItemQuantityColumns` laufen,
    // weil dort u.a. `quantity_raw` als `real` angelegt wird (Bestand).
    const { migrateKmGeoToNumeric } = await import("./startup/migrate-km-geo-to-numeric");
    try {
      await migrateKmGeoToNumeric();
    } catch (err) {
      log(`KM/Geo-Numeric-Migration fehlgeschlagen: ${err}`, "startup");
    }

    // Task #593: Render-Snapshot-Spalte (companySettings + Kunden-Snapshot) für
    // deterministische Integrity-Verifier-Re-Renders sicherstellen.
    const { ensureInvoiceRenderSnapshotColumn } = await import("./startup/ensure-invoice-render-snapshot");
    try {
      await ensureInvoiceRenderSnapshotColumn();
    } catch (err) {
      log(`Invoice-Render-Snapshot-Migration fehlgeschlagen: ${err}`, "startup");
    }

    // Task #759 — Variant C: invoices.budget_type / invoices.billing_run_id
    // + customer_budget_recipients sicherstellen (Rechnungs-Split pro Topf).
    const { ensureInvoicePerPotColumns } = await import("./startup/ensure-invoice-per-pot-columns");
    try {
      await ensureInvoicePerPotColumns();
    } catch (err) {
      log(`Invoice-Per-Pot-Spalten-Migration fehlgeschlagen: ${err}`, "startup");
    }

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

    const { clear45bMonthlyLimits } = await import("./startup/clear-45b-monthly-limits");
    try {
      await clear45bMonthlyLimits();
    } catch (err) {
      log(`§45b-Monatslimit-Bereinigung fehlgeschlagen: ${err}`, "startup");
    }

    const { migrateInProgressAppointments } = await import("./startup/migrate-in-progress-appointments");
    try {
      await migrateInProgressAppointments();
    } catch (err) {
      log(`In-Progress-Termin-Migration fehlgeschlagen: ${err}`, "startup");
    }

    const { migrateTaskStatusInProgress } = await import("./startup/migrate-task-status-in-progress");
    try {
      await migrateTaskStatusInProgress();
    } catch (err) {
      log(`Task-Status-In-Progress-Migration fehlgeschlagen: ${err}`, "startup");
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

    // Task #643: Bestands-Termine, die per Import-Update editiert wurden,
    // haben einen gedrifteten Budget-Ledger (Schröder 12.01./21.01.2026).
    // Idempotenter Backfill — nach erfolgreichem Rebook findet `findDriftRows`
    // nichts mehr, weitere Läufe sind No-Op.
    const { backfillImportUpdateBudgetDrift } = await import(
      "./startup/backfill-import-update-budget-drift"
    );
    try {
      await backfillImportUpdateBudgetDrift();
    } catch (err) {
      log(`Import-Update-Drift-Backfill fehlgeschlagen: ${err}`, "startup");
    }

    // Task #601: Duplikate §45b-Carryover (Wizard-Pfad vs Auto-Pfad
    // `ensureYearlyCarryover45b`) aus Altdaten räumen. Muss NACH der
    // Historisierungs-Migration laufen, weil der partielle Unique-Index
    // auf budget_allocations bis dahin u.U. noch nicht steht.
    const { backfillDuplicateWizardCarryovers } = await import(
      "./startup/backfill-duplicate-wizard-carryovers"
    );
    try {
      await backfillDuplicateWizardCarryovers();
    } catch (err) {
      log(`Carryover-Duplikat-Backfill fehlgeschlagen: ${err}`, "startup");
    }

    // Task #684: Doppel-Carryovers (manuell + automatisch, gleiches Quelljahr)
    // bereinigen — der partielle Unique-Index greift bei `month IS NULL`
    // nicht, und vor dem Fix konnte der Auto-Pfad neben einer manuell
    // gesetzten Zeile eine zweite 131 €-Zeile anlegen.
    const { backfillTask684OrphanAutoCarryovers } = await import(
      "./startup/backfill-task-684-orphan-auto-carryovers"
    );
    try {
      await backfillTask684OrphanAutoCarryovers();
    } catch (err) {
      log(`Carryover-Doppelallokation-Backfill (#684) fehlgeschlagen: ${err}`, "startup");
    }

    // Task #685: vom #684-Backfill übersprungene Doppel-Carryovers, an
    // denen bereits Buchungen hängen, gezielt auflösen — Buchungen werden
    // auf die Keep-Zeile umgehängt und die Dupe-Zeile danach soft-gelöscht.
    const { backfillTask685RelinkOrphanCarryoverTx } = await import(
      "./startup/backfill-task-685-relink-orphan-carryover-tx"
    );
    try {
      await backfillTask685RelinkOrphanCarryoverTx();
    } catch (err) {
      log(`Carryover-Tx-Relink-Backfill (#685) fehlgeschlagen: ${err}`, "startup");
    }

    // Task #576: Idempotente Korrektur — durch den entfernten Storno-
    // Side-Effekt fälschlich soft-gelöschte Leistungsnachweise reaktivieren
    // (Prod-IDs 8 und 48, 22.05.2026). Greift nur, solange die Ziel-IDs
    // tatsächlich noch `deleted_at IS NOT NULL` haben.
    const { restoreStornoDeletedServiceRecords } = await import(
      "./startup/restore-storno-deleted-service-records"
    );
    try {
      await restoreStornoDeletedServiceRecords();
    } catch (err) {
      log(`Storno-LN-Reaktivierung fehlgeschlagen: ${err}`, "startup");
    }

    const { migrateErstberatungCustomers } = await import("./startup/migrate-erstberatung-customers");
    try {
      await migrateErstberatungCustomers();
    } catch (err) {
      log(`Erstberatung-Kunden-Migration fehlgeschlagen: ${err}`, "startup");
    }

    const { cleanupOrphanErstberatungCustomers } = await import("./startup/cleanup-orphan-erstberatung-customers");
    try {
      await cleanupOrphanErstberatungCustomers();
    } catch (err) {
      log(`Erstberatung-Waisen-Bereinigung fehlgeschlagen: ${err}`, "startup");
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

    const { migrateProspectStatuses } = await import("./startup/migrate-prospect-statuses");
    try {
      await migrateProspectStatuses();
    } catch (err) {
      log(`Prospect-Status-Migration fehlgeschlagen: ${err}`, "startup");
    }

    const { matchProspectsToCustomers } = await import("./startup/prospect-customer-matching");
    try {
      const matched = await matchProspectsToCustomers();
      if (matched > 0) log(`Prospect-Kunden-Abgleich: ${matched} Interessenten als gewonnen markiert`, "startup");
    } catch (err) {
      log(`Prospect-Kunden-Abgleich fehlgeschlagen: ${err}`, "startup");
    }

    const { migrateSchulungBesprechungToSonstiges } = await import("./startup/migrate-schulung-besprechung-to-sonstiges");
    try {
      await migrateSchulungBesprechungToSonstiges();
    } catch (err) {
      log(`Schulung/Besprechung-Migration fehlgeschlagen: ${err}`, "startup");
    }

    const { cleanupVacationOnHolidays } = await import("./startup/cleanup-vacation-on-holidays");
    try {
      await cleanupVacationOnHolidays();
    } catch (err) {
      log(`Urlaubs-Feiertags-Bereinigung fehlgeschlagen: ${err}`, "startup");
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
      const { runChromiumPreflight } = await import("./services/pdf-generator");
      const result = runChromiumPreflight();
      if (result.ok) {
        log(`Chromium-Pre-Flight OK (${result.version}) @ ${result.path}`, "startup");
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
