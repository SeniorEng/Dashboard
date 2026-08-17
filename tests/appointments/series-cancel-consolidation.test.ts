import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { appointments, auditLog, budgetTransactions } from "@shared/schema";
import { createConsumptionTransaction } from "../../server/storage/budget/consumption-engine";
import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  createTestCustomer,
  createTestEmployee,
  cleanupCustomer,
  deactivateTestEmployee,
  getAuthCookie,
} from "../test-utils";

/**
 * Absage-Konsolidierung: `single` und Bulk laufen über EINE Routine
 * (`server/services/appointment-cancellation.ts`), und eine begonnene
 * Dokumentation wird nicht mehr still vernichtet.
 *
 * ── Der Defekt, gemessen vor dem Fix ────────────────────────────────────
 * Ein Serien-Termin im Status `documenting` — Arbeit geleistet, Dokumentation
 * begonnen — wurde vom `single`-Zweig anstandslos storniert (HTTP 200), und
 * danach verweigerte `canDocumentAppointment` dauerhaft. Die Leistung war weder
 * dokumentierbar noch abrechenbar, ohne Widerspruch, ohne Audit-Eintrag, ohne
 * Budget-Rückabwicklung.
 *
 * Der `single`-Zweig prüfte als EINZIGE Schranke `status === "completed"`. Der
 * Bulk-Zweig prüfte zusätzlich Sperre und Monatsabschluss — aber ebenfalls kein
 * `documenting`, und rückabgewickelt hat keiner von beiden.
 *
 * ── Was hier geprüft wird ───────────────────────────────────────────────
 *  1. `documenting`-Absage OHNE Flag → 409, Termin unverändert
 *  2. mit Flag → ausgeführt, Audit-Eintrag vorhanden
 *  3. `single` prüft die Sperre (unterschriebener LN) wie der Bulk-Pfad
 *  4. `single` meldet eine Ablehnung als Fehler, nicht als stillen Teilerfolg
 *
 * Gegenprobe gegen `main`: 1, 2 und 4 müssen dort ROT sein — sonst messen sie
 * nichts. (3 ist auf `main` grün, weil `completed` den Fall ohnehin abfängt;
 * die Sperr-Lücke im `single`-Zweig war real, aber über `completed`
 * unerreichbar — deshalb steht sie hier als Regressionsschutz, nicht als
 * Defekt-Nachweis.)
 */

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let customerId: number;
let employeeId: number;
let hwServiceId: number;
const cleanupSeriesIds: number[] = [];

async function serieAnlegen(offsetTage: number) {
  const start = new Date();
  start.setDate(start.getDate() + offsetTage);
  const end = new Date(start);
  end.setDate(end.getDate() + 28);

  const res = await apiPost<{ series: { id: number } }>("/api/appointment-series", {
    customerId,
    startDate: start.toISOString().split("T")[0],
    endDate: end.toISOString().split("T")[0],
    weekdays: ["mi"],
    frequency: "weekly",
    scheduledStart: "09:00",
    durationMinutes: 60,
    services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
    assignedEmployeeId: auth.user.id,
  });
  expect(res.status, `Serie anlegen: ${JSON.stringify(res.data)}`).toBe(201);
  const seriesId = res.data.series.id;
  cleanupSeriesIds.push(seriesId);

  const rows = await db.select().from(appointments).where(eq(appointments.seriesId, seriesId));
  expect(rows.length).toBeGreaterThan(0);
  return { seriesId, termine: rows };
}

function absage(seriesId: number, appointmentId: number, body: Record<string, unknown>) {
  return apiPost<{ cancelled?: number; code?: string; details?: { appointments?: unknown[] }; message?: string }>(
    `/api/appointment-series/${seriesId}/appointments/${appointmentId}/cancel`,
    body,
  );
}

async function statusVon(id: number): Promise<string> {
  const [row] = await db.select({ s: appointments.status }).from(appointments).where(eq(appointments.id, id));
  return row?.s ?? "WEG";
}

beforeAll(async () => {
  auth = await getAuthCookie();
  const services = await apiGet<Array<{ id: number; code: string }>>("/api/services/all");
  hwServiceId = services.data.find((s) => s.code === "hauswirtschaft")!.id;
  const emp = await createTestEmployee({ nachnamePrefix: "AbsageKons" });
  employeeId = emp.id;
  const cust = await createTestCustomer({ nachname: `AbsageKons_${Date.now()}` });
  customerId = cust.id as number;

  const zuweisung = await apiPatch(`/api/admin/customers/${customerId}/assign`, {
    primaryEmployeeId: auth.user.id,
    backupEmployeeId: employeeId,
    backupEmployeeId2: null,
  });
  expect(zuweisung.status).toBe(200);
});

afterAll(async () => {
  // Gate-2-Fund S7: Test 1 laesst den Termin bewusst in `documenting`. Solange
  // der DELETE-Pfad einen 409-Gate trug, scheiterte der Cleanup daran und liess
  // `documenting`-Termin UND aktive Serie in der geteilten Shard-DB liegen —
  // genau die Karteileichen, die in anderen Dateien Kontaminations-Flakes
  // erzeugen. Der Gate ist aus dem DELETE-Pfad wieder heraus (B1/B2), damit
  // raeumt `apiDelete` wie vorher vollstaendig auf. Die Zusicherung unten haelt
  // fest, dass das auch so bleibt.
  for (const sid of cleanupSeriesIds) {
    const rows = await db.select({ id: appointments.id }).from(appointments).where(eq(appointments.seriesId, sid));
    for (const r of rows) { try { await apiDelete(`/api/appointments/${r.id}`); } catch { /* egal */ } }
    try { await apiDelete(`/api/appointment-series/${sid}`); } catch { /* egal */ }
  }

  // Wenn der Cleanup nicht mehr durchkommt, sollen es die NAECHSTEN Dateien
  // nicht ausbaden. Lieber hier laut werden als dort still flaken.
  const reste = await db.select({ id: appointments.id })
    .from(appointments)
    .where(and(inArray(appointments.seriesId, cleanupSeriesIds), isNull(appointments.deletedAt)));
  if (reste.length > 0) {
    throw new Error(
      `Cleanup unvollstaendig: ${reste.length} Termin(e) blieben in der geteilten Shard-DB liegen ` +
        `(IDs ${reste.map(r => r.id).join(", ")}). Das erzeugt Kontaminations-Flakes in anderen Dateien.`,
    );
  }
  await cleanupCustomer(customerId);
  await deactivateTestEmployee(employeeId);
});

describe("Absage-Konsolidierung — begonnene Dokumentation wird nicht still vernichtet", () => {
  it("1 — documenting-Absage OHNE Bestätigung wird verweigert und weist die Termine aus", async () => {
    const { seriesId, termine } = await serieAnlegen(30);
    const ziel = termine[0];
    await db.update(appointments)
      .set({ status: "documenting", actualStart: "09:00:00", actualEnd: "10:00:00" })
      .where(and(eq(appointments.id, ziel.id), eq(appointments.seriesId, seriesId)));

    const res = await absage(seriesId, ziel.id, { mode: "single" });

    expect(
      res.status,
      "Ohne Bestätigung muss die Absage einer begonnenen Dokumentation mit 409 verweigert werden. " +
        "Ein 200 hier heißt: die Doku wird wieder still vernichtet.",
    ).toBe(409);
    expect(res.data.code).toBe("CANCEL_DISCARDS_DOCUMENTATION");
    expect(
      res.data.details?.appointments,
      "Der 409 muss AUSWEISEN, welche Termine betroffen sind — sonst kann die UI " +
        "keine sinnvolle Rückfrage stellen und der Mitarbeiter sieht nur eine Blockade.",
    ).toHaveLength(1);

    expect(await statusVon(ziel.id), "Der Termin darf unverändert bleiben").toBe("documenting");
  });

  it("2 — mit Bestätigung wird ausgeführt, mit Audit-Eintrag", async () => {
    const { seriesId, termine } = await serieAnlegen(60);
    const ziel = termine[0];
    await db.update(appointments)
      .set({ status: "documenting", actualStart: "09:00:00", actualEnd: "10:00:00" })
      .where(eq(appointments.id, ziel.id));

    const res = await absage(seriesId, ziel.id, { mode: "single", confirmDiscardDocumentation: true });
    expect(res.status).toBe(200);
    expect(res.data.cancelled).toBe(1);
    expect(await statusVon(ziel.id)).toBe("cancelled");

    const audit = await db.select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.action, "appointment_cancelled"), eq(auditLog.entityId, ziel.id)));
    expect(
      audit.length,
      "Die Absage muss eine Spur hinterlassen. Ohne Audit-Eintrag ist der Verlust " +
        "der Dokumentation nachträglich nicht mehr nachvollziehbar (GoBD).",
    ).toBeGreaterThan(0);
  });

  it("3 — single prüft die LN-Sperre wie der Bulk-Pfad", async () => {
    const { seriesId, termine } = await serieAnlegen(90);
    const ziel = termine[0];
    await db.update(appointments).set({ status: "completed" }).where(eq(appointments.id, ziel.id));

    const res = await absage(seriesId, ziel.id, { mode: "single" });
    expect(res.status, "Storno-first: abgeschlossene Termine bleiben gesperrt").toBe(400);
    expect(await statusVon(ziel.id)).toBe("completed");
  });

  /**
   * Gate-2-Fund S4 — der GELDTEIL. Die vorherigen Tests belegten 409/Flag/Audit,
   * aber nicht, dass die Rückabwicklung tatsächlich stattfindet. Genau die ist
   * die Begründung dafür, dass die Routine auf Delete-Niveau gehoben wurde.
   *
   * GRENZE, ehrlich benannt: die Hold-Freigabe (`releaseHolds`) ist hier NICHT
   * prüfbar — der Orchestrator entfernt `BUDGET_HARD_HOLDS` aus dem Test-Env
   * (`scripts/with-ephemeral-db.ts:307`), Holds werden also gar nicht erst
   * geschrieben. Geprüft wird der zweite, flag-unabhängige Weg: der Storno der
   * Budget-Transaktionen. Für die Hold-Seite ist der Beleg die Messung an
   * `engeldesk_ref` (57,00 € auf einem stornierten Termin, von
   * `sweepOrphanHolds` als Waise gemeldet) plus die Tatsache, dass beide Wege
   * denselben Code teilen wie der Löschpfad.
   */
  it("5 — die Absage storniert die Budget-Buchungen des Termins", async () => {
    const { seriesId, termine } = await serieAnlegen(150);
    const ziel = termine[0];

    // §45b-Topf mit Startguthaben, damit überhaupt gebucht werden kann.
    const setup = await apiPost(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentMonthAmountCents: 13100,
      carryoverAmountCents: 0,
      budgetStartDate: `${new Date().getFullYear()}-01-01`,
    });
    expect([200, 201]).toContain(setup.status);

    const txn = await createConsumptionTransaction({
      customerId,
      appointmentId: ziel.id,
      transactionDate: ziel.date,
      hauswirtschaftMinutes: 30,
      alltagsbegleitungMinutes: 0,
      travelKilometers: 0,
      customerKilometers: 0,
      userId: auth.user.id,
    });
    expect(txn, "Vorbedingung: es muss eine Buchung geben, sonst misst der Test nichts").toBeDefined();

    const vorher = await db.select({ id: budgetTransactions.id, typ: budgetTransactions.transactionType })
      .from(budgetTransactions).where(eq(budgetTransactions.appointmentId, ziel.id));
    expect(vorher.filter(t => t.typ === "consumption").length).toBeGreaterThan(0);
    expect(vorher.filter(t => t.typ === "reversal").length).toBe(0);

    await db.update(appointments)
      .set({ status: "documenting", actualStart: "09:00:00", actualEnd: "10:00:00" })
      .where(eq(appointments.id, ziel.id));

    const res = await absage(seriesId, ziel.id, { mode: "single", confirmDiscardDocumentation: true });
    expect(res.status).toBe(200);

    const nachher = await db.select({ typ: budgetTransactions.transactionType })
      .from(budgetTransactions).where(eq(budgetTransactions.appointmentId, ziel.id));
    expect(
      nachher.filter(t => t.typ === "reversal").length,
      "Nach der Absage muss die Buchung storniert sein. Ohne Rückabwicklung bliebe " +
        "Budget verbraucht für eine Leistung, die nie erbracht wird — genau der " +
        "Zustand, den `sweepOrphanHolds` an der Hold-Seite als Waise meldet.",
    ).toBeGreaterThan(0);
  });

  it("4 — eine abgelehnte single-Absage meldet einen Fehler, keinen stillen Teilerfolg", async () => {
    const { seriesId, termine } = await serieAnlegen(120);
    const ziel = termine[0];
    await db.update(appointments).set({ status: "cancelled" }).where(eq(appointments.id, ziel.id));

    const res = await absage(seriesId, ziel.id, { mode: "single" });
    expect(
      res.status,
      "Bei `single` geht es um GENAU EINEN Termin. Eine Ablehnung als 200 mit " +
        "`cancelled: 0` zu melden wäre dieselbe Klasse stiller Meldung, die dieser " +
        "PR beseitigt — der Aufrufer glaubte an Erfolg, obwohl nichts geschah.",
    ).toBe(400);
  });
});
