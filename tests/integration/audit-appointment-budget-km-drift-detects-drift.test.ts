/**
 * Task #628 — Gegenrichtung zu Task #623:
 *   Der Boot-Audit `auditAppointmentBudgetKmDrift()` MUSS gedriftete
 *   Termin/Budget-Buchungen tatsächlich finden und pro Termin eine Drift-
 *   Zeile loggen. Task #623 sichert nur die "leer nach Korrektur"-Richtung
 *   ab; wenn jemand versehentlich die 0.05 km-Toleranz im SQL hochzieht
 *   oder das WHERE umbaut, fällt der Drift-Alarm sonst still aus.
 *
 *   Vorgehen:
 *     1) 2 Termine mit künstlich gedrifteten Budget-Buchungen aufsetzen
 *        (analog zum Setup in `reconcile-km-drift-leaves-audit-empty.test.ts`).
 *     2) `auditAppointmentBudgetKmDrift()` direkt aufrufen, dabei
 *        `console.log` als Spy. Erwartung: pro Termin genau eine Drift-Zeile,
 *        die appt#, die Drift-Flags ([km]) und die quantisierten
 *        Termin-/Tx-km enthält.
 *     3) Korrektur via `reconcileKmDrift({ apply: true })`.
 *     4) 2. Audit-Aufruf — KEINE Drift-Zeilen mehr (kein "appt#…"-Log).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { quarantinedInCI } from "../helpers/known-failing";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { appointments, users } from "@shared/schema";
import { auditAppointmentBudgetKmDrift } from "../../server/startup/audit-appointment-budget-km-drift";
import { reconcileKmDrift } from "../../server/scripts/reconcile-km-drift";
import { formatKmQuantityDisplay } from "@shared/domain/invoice-line-items";
import {
  setupBudgetScenario,
  type BudgetScenarioHandle,
} from "../helpers/budget-scenarios";
import { getAuthCookie, runCleanup } from "../test-utils";

function lastNWeekdays(n: number): string[] {
  const out: string[] = [];
  const today = new Date();
  for (let offset = 1; offset <= 60 && out.length < n; offset++) {
    const d = new Date(today);
    d.setDate(today.getDate() - offset);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    out.push(d.toISOString().split("T")[0]);
  }
  if (out.length < n) {
    throw new Error(`Konnte nur ${out.length} vergangene Werktage finden (benötigt ${n})`);
  }
  return out;
}

describe("Task #628 — Boot-Audit meldet vorhandene km-Drift", () => {
  let scenario: BudgetScenarioHandle;
  let superadminUserId: number;
  let wasSuperadmin = false;

  beforeAll(async () => {
    const auth = await getAuthCookie();
    superadminUserId = auth.user.id;

    const [u] = await db
      .select({ isSuperAdmin: users.isSuperAdmin })
      .from(users)
      .where(eq(users.id, superadminUserId))
      .limit(1);
    wasSuperadmin = !!u?.isSuperAdmin;
    if (!wasSuperadmin) {
      await db
        .update(users)
        .set({ isSuperAdmin: true })
        .where(eq(users.id, superadminUserId));
    }

    const dates = lastNWeekdays(2);
    const earliestYear = Math.min(...dates.map((d) => parseInt(d.slice(0, 4), 10)));
    const budgetStart = `${earliestYear}-01-01`;

    scenario = await setupBudgetScenario({
      customerNamePrefix: "T628",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      pflegegradSeit: budgetStart,
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
        { type: "umwandlung_45a", priority: 2, enabled: false },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
      ],
      initialBalance: {
        type: "entlastungsbetrag_45b",
        amountCents: 200000,
        validFrom: budgetStart,
      },
      appointments: dates.map((date, i) => ({
        date,
        scheduledStart: `${String(8 + i).padStart(2, "0")}:00`,
        services: [{ code: "hauswirtschaft", durationMinutes: 60 }],
        document: true,
        travelKilometers: 7,
        customerKilometers: 3,
        notes: `T628-Drift-Setup-${i}`,
      })),
    });
  }, 120_000);

  afterAll(async () => {
    if (scenario) {
      await scenario.cleanup();
    }
    if (!wasSuperadmin) {
      await db
        .update(users)
        .set({ isSuperAdmin: false })
        .where(eq(users.id, superadminUserId));
    }
    await runCleanup();
  });

  it.skipIf(quarantinedInCI)("loggt pro gedriftetem Termin eine Drift-Zeile und ist nach Korrektur wieder still", async () => {
    const apptIds = [...scenario.appointmentIds];
    expect(apptIds.length).toBe(2);

    // 1) Drift künstlich erzeugen — Termin-km weit jenseits der 0.05-Toleranz
    //    von den bereits gebuchten budget_transactions weg.
    await db
      .update(appointments)
      .set({ travelKilometers: 70, customerKilometers: 30 })
      .where(inArray(appointments.id, apptIds));

    // 2) `console.log` direkt umbiegen — `vi.spyOn(console, "log")` greift in
    //    diesem Vitest-Setup nicht zuverlässig auf `console.log`-Aufrufe aus
    //    importierten Server-Modulen durch (Self-Test bestätigt: spy.calls=0
    //    trotz aktivem Spy). Direktes Re-Binding fängt alle Calls verlässlich.
    const capturedLines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      capturedLines.push(args.map((a) => String(a)).join(" "));
    };
    try {
      await auditAppointmentBudgetKmDrift();
    } finally {
      console.log = origLog;
    }

    const startupLines = capturedLines.filter((line) => line.includes("[startup]"));

    // Erwartung: 1 Header-Zeile + je 1 Drift-Zeile pro Termin. Die exakte
    // Termin-/km-/min-Zählung im Header hängt vom globalen DB-Zustand ab
    // (Test-DB enthält weitere Bestandsdaten mit Drift), daher nicht hart
    // gegen `apptIds.length` prüfen — der Header-Existenznachweis plus die
    // präzisen Per-Termin-Drift-Zeilen weiter unten sichern die Semantik ab.
    const headerLine = startupLines.find((l) =>
      l.includes("Termin-vs-Budget-Drift gefunden"),
    );
    expect(headerLine, `Kein Drift-Header in:\n${startupLines.join("\n")}`).toBeDefined();
    expect(headerLine).toMatch(/in \d+ Termin\(en\)/);
    expect(headerLine).toMatch(/km: \d+/);

    const apptDates = await db
      .select({ id: appointments.id, date: appointments.date })
      .from(appointments)
      .where(inArray(appointments.id, apptIds));
    const dateById = new Map(
      apptDates.map((a) => [
        a.id,
        typeof a.date === "string" ? a.date : String(a.date),
      ]),
    );

    for (const id of apptIds) {
      const driftLine = startupLines.find((l) => l.includes(`appt#${id}`));
      expect(
        driftLine,
        `Keine Drift-Zeile für appt#${id} in:\n${startupLines.join("\n")}`,
      ).toBeDefined();
      // Drift-Flag enthält "km".
      expect(driftLine).toMatch(/\[(?:[a-z+]*)km(?:[a-z+]*)\]/);
      // Quantisierte Soll-km (Termin-Wert nach DB-Mutation) tauchen auf.
      expect(driftLine).toContain(formatKmQuantityDisplay(70));
      expect(driftLine).toContain(formatKmQuantityDisplay(30));
      // Quantisierte Tx-km (Original-Buchung) tauchen ebenfalls auf.
      expect(driftLine).toContain(formatKmQuantityDisplay(7));
      expect(driftLine).toContain(formatKmQuantityDisplay(3));
      // Termin-Datum im Log.
      const expectedDate = dateById.get(id);
      expect(expectedDate).toBeTruthy();
      expect(driftLine).toContain(`@${expectedDate}`);
    }

    // 3) Korrektur scharf ausführen — danach darf der Boot-Audit für
    //    diese Termine nichts mehr loggen.
    const summary = await reconcileKmDrift({
      appointmentIds: apptIds,
      apply: true,
      toleranceKm: 0.05,
      userId: superadminUserId,
      reason: "Task #628 Regressionstest — Drift-Setup wieder aufräumen",
    });
    expect(summary.repaired).toBe(apptIds.length);
    expect(summary.errored).toBe(0);

    // 4) 2. Audit-Aufruf — keine Drift-Zeilen mehr für unsere Termine.
    const capturedLines2: string[] = [];
    const origLog2 = console.log;
    console.log = (...args: unknown[]) => {
      capturedLines2.push(args.map((a) => String(a)).join(" "));
    };
    try {
      await auditAppointmentBudgetKmDrift();
    } finally {
      console.log = origLog2;
    }

    const startupLines2 = capturedLines2.filter((line) => line.includes("[startup]"));

    for (const id of apptIds) {
      const stillThere = startupLines2.find((l) => l.includes(`appt#${id}`));
      expect(
        stillThere,
        `Drift für appt#${id} ist nach Korrektur immer noch im Log: ${stillThere}`,
      ).toBeUndefined();
    }
  }, 180_000);
});
