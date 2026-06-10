/**
 * Task #1139 — Firmenlogo als Inline-`cid:`-Anhang in den ÜBRIGEN
 * transaktionalen E-Mail-Pfaden (Regression-Schutz).
 *
 * Schwestertest zu `tests/email-logo-inline-attachment.test.ts` (Lead-/Dokument-
 * E-Mails, Task #1107) und `tests/billing/invoice-email-logo-attachment.test.ts`
 * (Abrechnungs-E-Mails, Task #1104). Hier sind die noch UNGETESTETEN produktiven
 * Versand-Pfade abgedeckt, die dasselbe Logo-Wiring
 * (`buildLogoInlineAttachment` + `EMAIL_LOGO_SRC`) nutzen:
 *
 *   - Passwort-Zurücksetzen          (`POST /password-reset/request`, auth-Router)
 *   - Mitarbeiter-Willkommen erneut  (`POST /users/:id/resend-welcome`, employee-users-Router)
 *   - Monatsabschluss-Reminder T-3/T-1/T-0 (`sendMonthCloseReminders`)
 *
 * Vertrag (Regression-Schutz): Das Firmenlogo MUSS als echter Inline-Anhang
 * (`contentDisposition: "inline"`, `cid: "company-logo"`) mitgeschickt und im
 * HTML über `src="cid:company-logo"` referenziert werden — NIE als eingebettete
 * `data:`-URI (die GMX/Outlook/Gmail teils blocken). Ohne konfiguriertes Logo
 * darf KEIN Anhang und KEIN kaputtes `<img>` entstehen.
 *
 * Die schweren Ränder (Object Storage, DB, Repos, Auth-Service) sind gemockt;
 * der ECHTE `email-service` (Stub-Outbox) und die ECHTEN HTML-Renderer laufen,
 * damit der tatsächlich versandte Anhang + das HTML geprüft werden.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import express, { type Request, type Response, type NextFunction, type Router } from "express";
import type { AddressInfo } from "net";

const LOGO_CID = "company-logo";

// Kleinste gültige PNG (1×1, transparent) — echtes, ladbares Logo.
const LOGO_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

// Geteilter, hoist-sicherer Mock-State (vi.hoisted läuft VOR den Factories).
const h = vi.hoisted(() => {
  const state = {
    settings: null as Record<string, unknown> | null,
    logoBytes: null as { content: Buffer; contentType: string } | null,
    user: null as Record<string, unknown> | null,
    token: "reset-token-abc",
    // Sequenz-Ergebnisse für die gemockte DB / Repos (in Await-Reihenfolge).
    dbResults: [] as unknown[],
    dbIdx: 0,
    apptResults: [] as unknown[],
    apptIdx: 0,
  };

  // Chainable, thenable Proxy: jede Methode (.from/.where/.innerJoin/.groupBy/
  // .limit …) gibt sich selbst zurück; das `await` löst mit `result` auf.
  function chain(result: unknown) {
    const p: unknown = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve(result);
        return () => p;
      },
    });
    return p;
  }

  return { state, chain };
});

// --- Daten-/IO-Ränder: NUR Storage/DB/Service-Layer wird gemockt ---------

vi.mock("../../server/services/logo-resolver", () => ({
  loadLogoBytes: vi.fn(async () => h.state.logoBytes),
}));

vi.mock("../../server/lib/db", () => ({
  db: { select: () => h.chain(h.state.dbResults[h.state.dbIdx++]) },
  pool: {},
  logPoolStats: () => {},
  withDbRetry: async (fn: () => unknown) => fn(),
}));

vi.mock("../../server/repos", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    appointmentsRepo: {
      selectColumnsFrom: () => h.chain(h.state.apptResults[h.state.apptIdx++]),
    },
    employeeTimeEntriesRepo: {
      selectColumnsFrom: () => h.chain([]),
    },
  };
});

vi.mock("../../server/storage", () => ({
  storage: {
    getCompanySettings: vi.fn(async () => h.state.settings),
  },
}));

vi.mock("../../server/services/cache", () => ({
  getCachedCompanySettings: vi.fn(async () => h.state.settings),
  birthdaysCache: { get: () => undefined, set: () => {}, clear: () => {} },
  usersCache: { get: () => undefined, set: () => {}, clear: () => {} },
}));

vi.mock("../../server/services/auth", () => ({
  authService: {
    createPasswordResetToken: vi.fn(async () => h.state.token),
    getUserByEmail: vi.fn(async () => h.state.user),
    getUser: vi.fn(async () => h.state.user),
    createWelcomeToken: vi.fn(async () => h.state.token),
  },
}));

// CSRF auf Passthrough — wir testen das Logo-Wiring, nicht den CSRF-Schutz.
vi.mock("../../server/middleware/csrf", () => ({
  csrfProtection: (_req: Request, _res: Response, next: NextFunction) => next(),
  generateCsrfToken: () => "csrf-token",
  setCsrfCookie: () => {},
}));

vi.mock("../../server/services/geocoding", () => ({
  ensureEmployeeGeocoded: async () => {},
  geocodeEmployee: async () => {},
}));

vi.mock("../../server/storage/tasks", () => ({
  getOpenTaskCount: async () => 0,
  ensureMonthClosingTask: async () => {},
  completeMonthClosingTask: async () => {},
}));

vi.mock("../../server/storage/time-tracking", () => ({
  timeTrackingStorage: {},
}));

vi.mock("../../server/storage/notifications", () => ({
  createNotification: vi.fn(async () => {}),
}));

vi.mock("../../server/services/notification-service", () => ({
  notificationService: { dispatchWhatsApp: vi.fn(async () => {}) },
}));

vi.mock("../../server/services/audit", () => ({
  auditService: { log: vi.fn(async () => {}) },
}));

// --- ECHTE Module unter Test --------------------------------------------

import authRouter from "../../server/routes/auth";
import employeeUsersRouter from "../../server/routes/admin/employee-users";
import { sendMonthCloseReminders } from "../../server/services/month-close-scheduler";
import {
  computeMonthCloseCutoff,
} from "../../shared/utils/month-close-cutoff";
import {
  getTestOutbox,
  clearTestOutbox,
  type TestOutboxEntry,
} from "../../server/services/email-service";

const SMTP_SETTINGS = {
  smtpHost: "smtp.test.local",
  smtpPort: "587",
  smtpUser: "outbox@test.local",
  smtpPass: "stub-secret",
  smtpFromEmail: "absender@test.local",
  smtpFromName: "CareConnect Test",
};

function baseSettings(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    companyName: "CareConnect Test",
    logoUrl: "/objects/test-logos/logo.png",
    ...SMTP_SETTINGS,
    ...extra,
  };
}

function expectInlineLogo(msg: TestOutboxEntry, label: string): void {
  const att = msg.attachments.find((a) => a.cid === LOGO_CID);
  expect(att, `${label}: Inline-Logo-Anhang (cid=${LOGO_CID}) muss vorhanden sein`).toBeTruthy();
  expect(att!.contentDisposition, `${label}: Logo-Anhang muss "inline" sein`).toBe("inline");
  expect(att!.contentType, `${label}: Logo-Anhang ist ein Bild`).toContain("image/");
  expect(att!.contentBase64.length, `${label}: Logo-Anhang trägt Bytes`).toBeGreaterThan(0);
  expect(msg.html, `${label}: HTML referenziert das Logo über cid:`).toContain(`src="cid:${LOGO_CID}"`);
  expect(msg.html, `${label}: HTML enthält KEINE data:-URI (Regression)`).not.toContain("data:image");
}

function expectNoLogo(msg: TestOutboxEntry, label: string): void {
  expect(
    msg.attachments.find((a) => a.cid === LOGO_CID),
    `${label}: KEIN Logo-Anhang ohne konfiguriertes Logo`,
  ).toBeUndefined();
  expect(msg.html, `${label}: HTML referenziert KEIN cid:-Logo`).not.toContain(`cid:${LOGO_CID}`);
  expect(msg.html, `${label}: HTML enthält KEINE data:-URI`).not.toContain("data:image");
}

// Mountet einen Router in einer minimalen Express-App, schickt einen Request
// und gibt die Response zurück (echte Handler-Ausführung, keine DB).
async function requestViaRouter(
  router: Router,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number }> {
  const app = express();
  app.use(express.json());
  // Fake-Auth: die router-internen Mount-Middlewares (requireAdmin etc.) werden
  // beim direkten Router-Mount umgangen; ein User-Stub deckt evtl. Zugriffe ab.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: unknown }).user = {
      id: 1,
      isAdmin: true,
      isSuperAdmin: true,
      roles: [],
    };
    next();
  });
  app.use(router);
  app.use((err: { statusCode?: number; status?: number; message?: string }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err?.statusCode ?? err?.status ?? 500).json({ error: err?.message ?? String(err) });
  });

  const server = await new Promise<import("http").Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

let prevEmailTransport: string | undefined;

beforeAll(() => {
  prevEmailTransport = process.env.EMAIL_TRANSPORT;
  process.env.EMAIL_TRANSPORT = "stub";
});

afterAll(() => {
  if (prevEmailTransport === undefined) delete process.env.EMAIL_TRANSPORT;
  else process.env.EMAIL_TRANSPORT = prevEmailTransport;
});

beforeEach(() => {
  clearTestOutbox();
  h.state.logoBytes = { content: LOGO_PNG, contentType: "image/png" };
  h.state.settings = baseSettings();
  h.state.user = {
    id: 7,
    vorname: "Erika",
    nachname: "Beispiel",
    email: "erika@example.com",
  };
  h.state.dbResults = [];
  h.state.dbIdx = 0;
  h.state.apptResults = [];
  h.state.apptIdx = 0;
});

describe("Task #1139 — Firmenlogo als Inline-cid-Anhang in transaktionalen E-Mails", () => {
  describe("Passwort-Zurücksetzen (POST /password-reset/request)", () => {
    it("hängt das Logo als Inline-cid-Anhang an", async () => {
      const { status } = await requestViaRouter(authRouter, "POST", "/password-reset/request", {
        email: "erika@example.com",
      });
      expect(status).toBe(200);

      const msg = getTestOutbox().find((m) => m.to === "erika@example.com");
      expect(msg, "Passwort-Reset-Mail muss im Postausgang liegen").toBeTruthy();
      expectInlineLogo(msg!, "Passwort-Reset");
    });

    it("Fallback ohne Logo: kein Anhang, kein kaputtes Bild", async () => {
      h.state.logoBytes = null;

      const { status } = await requestViaRouter(authRouter, "POST", "/password-reset/request", {
        email: "erika@example.com",
      });
      expect(status).toBe(200);

      const msg = getTestOutbox().find((m) => m.to === "erika@example.com");
      expect(msg, "Passwort-Reset-Mail muss im Postausgang liegen").toBeTruthy();
      expectNoLogo(msg!, "Passwort-Reset Fallback");
    });
  });

  describe("Mitarbeiter-Willkommen erneut (POST /users/:id/resend-welcome)", () => {
    it("hängt das Logo als Inline-cid-Anhang an", async () => {
      const { status } = await requestViaRouter(employeeUsersRouter, "POST", "/users/7/resend-welcome");
      expect(status).toBe(200);

      const msg = getTestOutbox().find((m) => m.to === "erika@example.com");
      expect(msg, "Willkommens-Mail muss im Postausgang liegen").toBeTruthy();
      expectInlineLogo(msg!, "Willkommens-Mail");
    });

    it("Fallback ohne Logo: kein Anhang, kein kaputtes Bild", async () => {
      h.state.logoBytes = null;

      const { status } = await requestViaRouter(employeeUsersRouter, "POST", "/users/7/resend-welcome");
      expect(status).toBe(200);

      const msg = getTestOutbox().find((m) => m.to === "erika@example.com");
      expect(msg, "Willkommens-Mail muss im Postausgang liegen").toBeTruthy();
      expectNoLogo(msg!, "Willkommens-Mail Fallback");
    });
  });

  describe("Monatsabschluss-Reminder (sendMonthCloseReminders)", () => {
    const EMP_EMAIL = "mitarbeiter@test.local";

    // `today` = Cutoff-Tag des Vormonats ⇒ Welle T-0 feuert.
    function reminderToday(): string {
      const closingYear = 2026;
      const closingMonth = 1; // Januar 2026
      return computeMonthCloseCutoff(closingYear, closingMonth);
    }

    // DB-/Repo-Ergebnisse in Await-Reihenfolge bereitstellen:
    //   db.select  #1 → aktive Mitarbeiter
    //   appt-repo  #1 → offene (nicht dokumentierte) Termine
    //   appt-repo  #2 → unterschriebene-fehlt Termine
    //   db.select  #2 → reminderAlreadySent → leer (noch nicht versendet)
    function seedReminderQueries(): void {
      h.state.dbResults = [
        [{ id: 1, displayName: "Test Mitarbeiter", email: EMP_EMAIL }],
        [],
      ];
      h.state.apptResults = [
        [{ employeeId: 1, count: 2 }],
        [],
      ];
    }

    it("hängt das Logo als Inline-cid-Anhang an", async () => {
      seedReminderQueries();

      const result = await sendMonthCloseReminders(reminderToday());
      expect(result.sent, "genau ein Reminder versendet").toBe(1);

      const msg = getTestOutbox().find((m) => m.to === EMP_EMAIL);
      expect(msg, "Reminder-Mail muss im Postausgang liegen").toBeTruthy();
      expectInlineLogo(msg!, "Monatsabschluss-Reminder");
    });

    it("Fallback ohne Logo: kein Anhang, kein kaputtes Bild", async () => {
      h.state.logoBytes = null;
      seedReminderQueries();

      const result = await sendMonthCloseReminders(reminderToday());
      expect(result.sent, "genau ein Reminder versendet").toBe(1);

      const msg = getTestOutbox().find((m) => m.to === EMP_EMAIL);
      expect(msg, "Reminder-Mail muss im Postausgang liegen").toBeTruthy();
      expectNoLogo(msg!, "Monatsabschluss-Reminder Fallback");
    });
  });
});
