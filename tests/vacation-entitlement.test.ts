import { describe, it, expect, afterAll } from "vitest";
import { db } from "../server/lib/db";
import { eq, and } from "drizzle-orm";
import {
  vacationEntitlementHistory,
  employeeVacationAllowance,
} from "@shared/schema";
import { calculateAnnualEntitlementWithHistory } from "@shared/domain/vacation";
import {
  apiPatch,
  apiGet,
  createTestEmployee,
  runCleanup,
} from "./test-utils";
import {
  computeAnnualEntitlement,
  getVacationEntitlementHistoryForUser,
  getVacationAllowance,
} from "../server/storage/time-tracking/vacation";

// ---------- Pure helper tests (VAC-PRO-1 .. VAC-PRO-5) ----------

describe("VAC-PRO Helper: calculateAnnualEntitlementWithHistory", () => {
  it("VAC-PRO-1 — Keine History → Fallback auf bisherige Logik (ganze Tage)", () => {
    // Eintritt im Vorjahr, kein History-Eintrag → fallback auf
    // getVacationEntitlement(30, eintritt, year) → 30 (volles Jahr).
    const result = calculateAnnualEntitlementWithHistory(
      [],
      "2023-01-01",
      2026,
      30,
    );
    expect(result).toBe(30);
  });

  it("VAC-PRO-2 — Jan 10 → Mai 12 ergibt 11,33", () => {
    const result = calculateAnnualEntitlementWithHistory(
      [
        { validFromYear: 2026, validFromMonth: 1, daysPerYear: 10 },
        { validFromYear: 2026, validFromMonth: 5, daysPerYear: 12 },
      ],
      null,
      2026,
      10,
    );
    // Jan-Apr (4) @ 10 + Mai-Dez (8) @ 12 = 4*10/12 + 8*12/12 = 3.333 + 8 = 11.33
    expect(result).toBe(11.33);
  });

  it("VAC-PRO-3 — Senkung Jan 30 → Aug 24 ergibt 27,5", () => {
    const result = calculateAnnualEntitlementWithHistory(
      [
        { validFromYear: 2026, validFromMonth: 1, daysPerYear: 30 },
        { validFromYear: 2026, validFromMonth: 8, daysPerYear: 24 },
      ],
      null,
      2026,
      30,
    );
    // Jan-Jul (7) @ 30 + Aug-Dez (5) @ 24 = 17.5 + 10 = 27.5
    expect(result).toBe(27.5);
  });

  it("VAC-PRO-4 — Mehrfachänderung Jan 10, Mai 12, Sep 14 ergibt 12", () => {
    const result = calculateAnnualEntitlementWithHistory(
      [
        { validFromYear: 2026, validFromMonth: 1, daysPerYear: 10 },
        { validFromYear: 2026, validFromMonth: 5, daysPerYear: 12 },
        { validFromYear: 2026, validFromMonth: 9, daysPerYear: 14 },
      ],
      null,
      2026,
      10,
    );
    // 4*10/12 + 4*12/12 + 4*14/12 = 144/12 = 12
    expect(result).toBe(12);
  });

  it("VAC-PRO-5 — Eintritt im März + Änderung im Juli", () => {
    // Eintritt 1.3.2026 → Jan/Feb = 0
    // Mar-Jun (4) @ 10 + Jul-Dez (6) @ 20 = 3.333 + 10 = 13.33
    const result = calculateAnnualEntitlementWithHistory(
      [
        { validFromYear: 2026, validFromMonth: 3, daysPerYear: 10 },
        { validFromYear: 2026, validFromMonth: 7, daysPerYear: 20 },
      ],
      "2026-03-15",
      2026,
      10,
    );
    expect(result).toBe(13.33);
  });
});

// ---------- API/DB tests (VAC-PRO-6 .. VAC-PRO-8) ----------

describe("VAC-PRO API: Patch + Vacation Summary + Carryover Sync", () => {
  afterAll(async () => {
    await runCleanup();
  });

  it("VAC-PRO-6 — Patch im laufenden Monat liefert anteiligen Anspruch in Vacation Summary", async () => {
    const emp = await createTestEmployee({ nachnamePrefix: "VacPro6" });
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    // 1) Setze initial 10 Tage als Basiswert (zählt als gleicher-Wert-Pfad,
    //    erzeugt keinen History-Eintrag, weil das Initial-Seed bereits 30
    //    eingetragen haben kann; deshalb erst seed bereinigen).
    await db.delete(vacationEntitlementHistory)
      .where(eq(vacationEntitlementHistory.userId, emp.id));
    await db.delete(employeeVacationAllowance)
      .where(eq(employeeVacationAllowance.userId, emp.id));
    // Setze einen "alten" History-Eintrag für Januar (oder Eintrittsmonat).
    await db.insert(vacationEntitlementHistory).values({
      userId: emp.id,
      validFromYear: currentYear,
      validFromMonth: 1,
      daysPerYear: 10,
      createdBy: null,
    });

    // Patch auf 14 Tage → erzeugt History (currentYear, currentMonth, 14)
    const patchRes = await apiPatch(`/api/admin/users/${emp.id}`, {
      vacationDaysPerYear: 14,
    });
    expect(patchRes.status).toBe(200);

    // Erwarteter Jahresanspruch: (currentMonth-1)*10/12 + (12-currentMonth+1)*14/12
    const monthsOld = currentMonth - 1;
    const monthsNew = 12 - monthsOld;
    const expected = Math.round((monthsOld * 10 / 12 + monthsNew * 14 / 12) * 100) / 100;

    const summaryRes = await apiGet<any>(
      `/api/admin/time-entries/vacation-summary/${emp.id}/${currentYear}`,
    );
    expect(summaryRes.status).toBe(200);
    expect(summaryRes.data.totalDays).toBe(expected);

    // remainingDays = entitlement + carryOver - used - planned (used/planned hier 0)
    const carryOver = summaryRes.data.carryOverDays ?? 0;
    const expectedRemaining = Math.round((expected + carryOver) * 100) / 100;
    expect(summaryRes.data.remainingDays).toBe(expectedRemaining);
  });

  it("VAC-PRO-7 — Carryover-Sync nutzt History des Vorjahres", async () => {
    const emp = await createTestEmployee({ nachnamePrefix: "VacPro7" });
    const now = new Date();
    const currentYear = now.getFullYear();
    const prevYear = currentYear - 1;

    // Reset: Stelle sicher, dass History/Allowance kontrolliert sind.
    await db.delete(vacationEntitlementHistory)
      .where(eq(vacationEntitlementHistory.userId, emp.id));
    await db.delete(employeeVacationAllowance)
      .where(eq(employeeVacationAllowance.userId, emp.id));

    // History: ganzes Vorjahr 12 Tage gültig (Jan).
    await db.insert(vacationEntitlementHistory).values({
      userId: emp.id,
      validFromYear: prevYear,
      validFromMonth: 1,
      daysPerYear: 12,
      createdBy: null,
    });

    const { syncVacationCarryover } = await import(
      "../server/startup/sync-vacation-carryover"
    );
    await syncVacationCarryover();

    const allowances = await db.select()
      .from(employeeVacationAllowance)
      .where(
        and(
          eq(employeeVacationAllowance.userId, emp.id),
          eq(employeeVacationAllowance.year, currentYear),
        ),
      );
    expect(allowances.length).toBe(1);
    const a = allowances[0];
    // totalDays für aktuelles Jahr aus History = 12 (gleicher Wert ganzes
    // aktuelles Jahr, weil History-Eintrag aus prevYear weiterläuft).
    expect(Number(a.totalDays)).toBe(12);
    // Carryover: Vorjahres-Anspruch (12) - 0 verbraucht = 12 (vor 1. April).
    // Falls Test nach 1. April läuft, wird Carry-Over auf 0 gesetzt.
    const today = new Date();
    const expiry = new Date(currentYear, 3, 1);
    if (today < expiry) {
      expect(a.carryOverDays).toBe(12);
    } else {
      expect(a.carryOverDays).toBe(0);
    }
  });

  it("VAC-PRO-9 — Vacation Summary liefert configuredAnnualDays + entitlementHistory + monthlyBreakdown getrennt vom anteiligen totalDays", async () => {
    const emp = await createTestEmployee({ nachnamePrefix: "VacPro9" });
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    // Reset
    await db.delete(vacationEntitlementHistory)
      .where(eq(vacationEntitlementHistory.userId, emp.id));
    await db.delete(employeeVacationAllowance)
      .where(eq(employeeVacationAllowance.userId, emp.id));

    // Alter Wert ab Januar: 12 Tage/Jahr
    await db.insert(vacationEntitlementHistory).values({
      userId: emp.id,
      validFromYear: currentYear,
      validFromMonth: 1,
      daysPerYear: 12,
      createdBy: null,
    });

    // Patch auf 8 Tage → erzeugt History-Eintrag (currentYear, currentMonth, 8)
    const patchRes = await apiPatch(`/api/admin/users/${emp.id}`, {
      vacationDaysPerYear: 8,
    });
    expect(patchRes.status).toBe(200);

    const summaryRes = await apiGet<any>(
      `/api/admin/time-entries/vacation-summary/${emp.id}/${currentYear}`,
    );
    expect(summaryRes.status).toBe(200);

    // configuredAnnualDays MUSS dem aktuellen users.vacationDaysPerYear (=8)
    // entsprechen, NICHT dem berechneten anteiligen totalDays.
    expect(summaryRes.data.configuredAnnualDays).toBe(8);

    // Erwarteter anteiliger Anspruch
    const monthsOld = currentMonth - 1;
    const monthsNew = 12 - monthsOld;
    const expected = Math.round((monthsOld * 12 / 12 + monthsNew * 8 / 12) * 100) / 100;
    expect(summaryRes.data.totalDays).toBe(expected);

    // entitlementHistory enthält beide Einträge
    expect(Array.isArray(summaryRes.data.entitlementHistory)).toBe(true);
    expect(summaryRes.data.entitlementHistory.length).toBeGreaterThanOrEqual(2);
    const lastEntry = summaryRes.data.entitlementHistory.find(
      (h: any) => h.validFromYear === currentYear && h.validFromMonth === currentMonth,
    );
    expect(lastEntry?.daysPerYear).toBe(8);

    // monthlyBreakdown: vor currentMonth = 12, ab currentMonth = 8.
    // Wenn der Patch im Januar passiert, gibt es nur ein Segment.
    const breakdown = summaryRes.data.monthlyBreakdown as Array<{
      fromMonth: number;
      toMonth: number;
      daysPerYear: number;
    }>;
    expect(Array.isArray(breakdown)).toBe(true);
    if (currentMonth === 1) {
      expect(breakdown.length).toBe(1);
      expect(breakdown[0].daysPerYear).toBe(8);
    } else {
      expect(breakdown.length).toBe(2);
      expect(breakdown[0].fromMonth).toBe(1);
      expect(breakdown[0].toMonth).toBe(currentMonth - 1);
      expect(breakdown[0].daysPerYear).toBe(12);
      expect(breakdown[1].fromMonth).toBe(currentMonth);
      expect(breakdown[1].toMonth).toBe(12);
      expect(breakdown[1].daysPerYear).toBe(8);
    }

    // eintrittsdatum-Feld ist im Response vorhanden (kann null sein).
    expect("eintrittsdatum" in summaryRes.data).toBe(true);
  });

  it("VAC-PRO-8 — Zwei Patches im selben Monat erzeugen nur einen History-Eintrag (letzter Wert gewinnt)", async () => {
    const emp = await createTestEmployee({ nachnamePrefix: "VacPro8" });
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    // Reset
    await db.delete(vacationEntitlementHistory)
      .where(eq(vacationEntitlementHistory.userId, emp.id));

    // Patch 1: 30 → 18
    const r1 = await apiPatch(`/api/admin/users/${emp.id}`, {
      vacationDaysPerYear: 18,
    });
    expect(r1.status).toBe(200);

    // Patch 2: 18 → 22 im selben Monat
    const r2 = await apiPatch(`/api/admin/users/${emp.id}`, {
      vacationDaysPerYear: 22,
    });
    expect(r2.status).toBe(200);

    const rows = await db.select()
      .from(vacationEntitlementHistory)
      .where(
        and(
          eq(vacationEntitlementHistory.userId, emp.id),
          eq(vacationEntitlementHistory.validFromYear, currentYear),
          eq(vacationEntitlementHistory.validFromMonth, currentMonth),
        ),
      );
    expect(rows.length).toBe(1);
    expect(rows[0].daysPerYear).toBe(22);
  });
});

// ---------- Allowance-First Refactor Snapshot-/Vergleichstests (Task #413) ----------
//
// Diese Tests verriegeln das beobachtbare Verhalten von `getVacationSummary`
// für die Refactor-Matrix:
//   (a) Allowance-Eintrag für aktuelles Jahr vorhanden
//   (b) Kein Allowance-Eintrag → Fallback auf Default/History
//   (c) Carry-Over aus Vorjahr (über Allowance) wird gelesen
//   (d) Unterjähriger Eintritt (pro-rata)
//
// Sie wurden VOR der Umstellung geschrieben (siehe Task-Spec) und müssen
// nach der Umstellung unverändert grün bleiben.

describe("VAC-PRO Allowance-First Snapshot (Task #413)", () => {
  afterAll(async () => {
    await runCleanup();
  });

  it("(a) Allowance-Eintrag für aktuelles Jahr ist autoritativ", async () => {
    const emp = await createTestEmployee({ nachnamePrefix: "VacAllowA" });
    const currentYear = new Date().getFullYear();

    // Sauberer Zustand: weder History noch Allowance.
    await db.delete(vacationEntitlementHistory)
      .where(eq(vacationEntitlementHistory.userId, emp.id));
    await db.delete(employeeVacationAllowance)
      .where(eq(employeeVacationAllowance.userId, emp.id));

    // Allowance setzen — bewusst von users.vacationDaysPerYear (30) abweichend.
    await db.insert(employeeVacationAllowance).values({
      userId: emp.id,
      year: currentYear,
      totalDays: "21.50",
      carryOverDays: 4,
      notes: null,
    });

    const res = await apiGet<any>(
      `/api/admin/time-entries/vacation-summary/${emp.id}/${currentYear}`,
    );
    expect(res.status).toBe(200);
    expect(res.data.totalDays).toBe(21.5);
    // calculateCarryOverDays setzt nach 1.4. auf 0; vorher bleibt 4.
    const today = new Date();
    const expiry = new Date(currentYear, 3, 1);
    expect(res.data.carryOverDays).toBe(today < expiry ? 4 : 0);
    // configuredAnnualDays bleibt der users-Wert (Spec VAC-PRO-9).
    expect(res.data.configuredAnnualDays).toBe(30);
  });

  it("(b) Kein Allowance-Eintrag → Fallback auf users.vacationDaysPerYear", async () => {
    const emp = await createTestEmployee({ nachnamePrefix: "VacAllowB" });
    const currentYear = new Date().getFullYear();

    await db.delete(vacationEntitlementHistory)
      .where(eq(vacationEntitlementHistory.userId, emp.id));
    await db.delete(employeeVacationAllowance)
      .where(eq(employeeVacationAllowance.userId, emp.id));

    const res = await apiGet<any>(
      `/api/admin/time-entries/vacation-summary/${emp.id}/${currentYear}`,
    );
    expect(res.status).toBe(200);
    // Eintritt 2024-01-01 → ganzes Jahr → voller Anspruch (30 default).
    expect(res.data.totalDays).toBe(30);
    expect(res.data.carryOverDays).toBe(0);
    expect(res.data.configuredAnnualDays).toBe(30);
  });

  it("(c) Carry-Over aus Vorjahres-Allowance wird übernommen (vor 1.4.)", async () => {
    const emp = await createTestEmployee({ nachnamePrefix: "VacAllowC" });
    const currentYear = new Date().getFullYear();

    await db.delete(vacationEntitlementHistory)
      .where(eq(vacationEntitlementHistory.userId, emp.id));
    await db.delete(employeeVacationAllowance)
      .where(eq(employeeVacationAllowance.userId, emp.id));

    // Aktueller Jahres-Allowance enthält bereits den Carry-Over (so wie
    // sync-vacation-carryover das schreibt).
    await db.insert(employeeVacationAllowance).values({
      userId: emp.id,
      year: currentYear,
      totalDays: "30.00",
      carryOverDays: 7,
      notes: "Übertrag aus Vorjahr",
    });

    const res = await apiGet<any>(
      `/api/admin/time-entries/vacation-summary/${emp.id}/${currentYear}`,
    );
    expect(res.status).toBe(200);
    expect(res.data.totalDays).toBe(30);
    // Carry-Over wird nach 1.4. auf 0 gesetzt (calculateCarryOverDays).
    const today = new Date();
    const expiry = new Date(currentYear, 3, 1);
    if (today < expiry) {
      expect(res.data.carryOverDays).toBe(7);
      expect(res.data.remainingDays).toBe(37);
    } else {
      expect(res.data.carryOverDays).toBe(0);
      expect(res.data.remainingDays).toBe(30);
    }
  });

  it("VAC-CACHE-CONSISTENCY — Allowance-Cache und History-Berechnung laufen niemals auseinander", async () => {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    async function expectCacheMatchesHistory(
      userId: number,
      vacDays: number,
      eintritt: string | null,
      year: number,
      label: string,
    ) {
      const history = await getVacationEntitlementHistoryForUser(userId);
      const allowance = await getVacationAllowance(userId, year);
      const expected = computeAnnualEntitlement(history, vacDays, eintritt, year);
      const expectedRounded = Math.round(expected * 100) / 100;
      expect(allowance, `${label}: allowance fehlt`).toBeDefined();
      const cached = Number(allowance!.totalDays);
      const cachedRounded = Math.round(cached * 100) / 100;
      expect(cachedRounded, `${label}: cache≠history`).toBe(expectedRounded);
    }

    // --- Szenario 1: Patch im laufenden Monat ---
    const emp1 = await createTestEmployee({ nachnamePrefix: "VacCache1" });
    await db.delete(vacationEntitlementHistory)
      .where(eq(vacationEntitlementHistory.userId, emp1.id));
    await db.delete(employeeVacationAllowance)
      .where(eq(employeeVacationAllowance.userId, emp1.id));
    // Seed History: ganzes Jahr 30 Tage gültig.
    await db.insert(vacationEntitlementHistory).values({
      userId: emp1.id,
      validFromYear: currentYear,
      validFromMonth: 1,
      daysPerYear: 30,
      createdBy: null,
    });

    const patch1 = await apiPatch(`/api/admin/users/${emp1.id}`, {
      vacationDaysPerYear: 18,
    });
    expect(patch1.status).toBe(200);
    await expectCacheMatchesHistory(emp1.id, 18, "2024-01-01", currentYear, "Szenario 1 nach Patch");

    // --- Szenario 2: Mehrere Patches im selben Monat ---
    const emp2 = await createTestEmployee({ nachnamePrefix: "VacCache2" });
    await db.delete(vacationEntitlementHistory)
      .where(eq(vacationEntitlementHistory.userId, emp2.id));
    await db.delete(employeeVacationAllowance)
      .where(eq(employeeVacationAllowance.userId, emp2.id));
    await db.insert(vacationEntitlementHistory).values({
      userId: emp2.id,
      validFromYear: currentYear,
      validFromMonth: 1,
      daysPerYear: 24,
      createdBy: null,
    });

    for (const next of [20, 26, 12]) {
      const r = await apiPatch(`/api/admin/users/${emp2.id}`, { vacationDaysPerYear: next });
      expect(r.status).toBe(200);
      await expectCacheMatchesHistory(emp2.id, next, "2024-01-01", currentYear, `Szenario 2 nach Patch ${next}`);
    }

    // --- Szenario 3: Patch nach unterjährigem Eintritt ---
    const emp3 = await createTestEmployee({ nachnamePrefix: "VacCache3" });
    await db.delete(vacationEntitlementHistory)
      .where(eq(vacationEntitlementHistory.userId, emp3.id));
    await db.delete(employeeVacationAllowance)
      .where(eq(employeeVacationAllowance.userId, emp3.id));

    // Eintrittsdatum auf Mitte des aktuellen Jahres setzen (oder, falls wir
    // vor Juni laufen, auf den Folgemonat — Hauptsache `validFromMonth`
    // liegt nach dem aktuellen Monat ist nicht möglich, also wählen wir
    // einen Monat ≤ currentMonth).
    const eintrittMonth = Math.min(currentMonth, 7);
    const eintritt3 = `${currentYear}-${String(eintrittMonth).padStart(2, "0")}-01`;
    const patchEintritt = await apiPatch(`/api/admin/users/${emp3.id}`, {
      eintrittsdatum: eintritt3,
    });
    expect(patchEintritt.status).toBe(200);

    // History soll aus dem Eintrittsmonat heraus gepflegt sein.
    await db.delete(vacationEntitlementHistory)
      .where(eq(vacationEntitlementHistory.userId, emp3.id));
    await db.insert(vacationEntitlementHistory).values({
      userId: emp3.id,
      validFromYear: currentYear,
      validFromMonth: eintrittMonth,
      daysPerYear: 30,
      createdBy: null,
    });

    const patch3 = await apiPatch(`/api/admin/users/${emp3.id}`, { vacationDaysPerYear: 21 });
    expect(patch3.status).toBe(200);
    await expectCacheMatchesHistory(emp3.id, 21, eintritt3, currentYear, "Szenario 3 nach Patch");

    // --- Konsistenz nach syncVacationCarryover ---
    // Allowance für aktuelles Jahr löschen, Sync neu laufen lassen, dann
    // muss totalDays wieder dem History-Resultat entsprechen.
    const { syncVacationCarryover } = await import(
      "../server/startup/sync-vacation-carryover"
    );
    for (const emp of [
      { id: emp1.id, vac: 18, eintritt: "2024-01-01" as string | null },
      { id: emp2.id, vac: 12, eintritt: "2024-01-01" as string | null },
      { id: emp3.id, vac: 21, eintritt: eintritt3 as string | null },
    ]) {
      await db.delete(employeeVacationAllowance)
        .where(
          and(
            eq(employeeVacationAllowance.userId, emp.id),
            eq(employeeVacationAllowance.year, currentYear),
          ),
        );
    }
    await syncVacationCarryover();
    await expectCacheMatchesHistory(emp1.id, 18, "2024-01-01", currentYear, "Sync emp1");
    await expectCacheMatchesHistory(emp2.id, 12, "2024-01-01", currentYear, "Sync emp2");
    await expectCacheMatchesHistory(emp3.id, 21, eintritt3, currentYear, "Sync emp3");
  });

  it("(d) Unterjähriger Eintritt → pro-rata (kein Allowance-Eintrag)", async () => {
    const emp = await createTestEmployee({ nachnamePrefix: "VacAllowD" });
    const currentYear = new Date().getFullYear();

    // Eintrittsdatum auf 1. Juli des aktuellen Jahres setzen (6 Monate Anspruch).
    const julyEintritt = `${currentYear}-07-01`;
    const patchRes = await apiPatch(`/api/admin/users/${emp.id}`, {
      eintrittsdatum: julyEintritt,
    });
    expect(patchRes.status).toBe(200);

    // Sicherstellen, dass weder History noch Allowance bestehen, damit der
    // Fallback-Pfad messbar ist.
    await db.delete(vacationEntitlementHistory)
      .where(eq(vacationEntitlementHistory.userId, emp.id));
    await db.delete(employeeVacationAllowance)
      .where(eq(employeeVacationAllowance.userId, emp.id));

    const res = await apiGet<any>(
      `/api/admin/time-entries/vacation-summary/${emp.id}/${currentYear}`,
    );
    expect(res.status).toBe(200);
    // getVacationEntitlement: Math.ceil(30/12 * 6) = 15.
    expect(res.data.totalDays).toBe(15);
    expect(res.data.eintrittsdatum).toBe(julyEintritt);
  });
});

// ---------- Allowance-Anlage beim Erstellen neuer Mitarbeiter (Task #414) ----------

describe("VAC-PRO Allowance-Anlage beim Mitarbeiter-Create (Task #414)", () => {
  afterAll(async () => {
    await runCleanup();
  });

  it("Beim Erstellen eines aktiven Mitarbeiters wird automatisch ein Allowance-Eintrag für das aktuelle Jahr angelegt", async () => {
    const emp = await createTestEmployee({ nachnamePrefix: "VacAllowCreate" });
    const currentYear = new Date().getFullYear();

    const allowances = await db.select()
      .from(employeeVacationAllowance)
      .where(
        and(
          eq(employeeVacationAllowance.userId, emp.id),
          eq(employeeVacationAllowance.year, currentYear),
        ),
      );
    expect(allowances.length).toBe(1);
    const a = allowances[0];
    // createTestEmployee setzt eintrittsdatum=2024-01-01 → ganzes Jahr → 30
    // (default vacationDaysPerYear). Carry-Over startet bei 0.
    expect(Number(a.totalDays)).toBe(30);
    expect(a.carryOverDays).toBe(0);
  });
});
