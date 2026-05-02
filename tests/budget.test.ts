// Task #291: Diese Suite konzentriert sich auf API-/Response-Shape-Tests,
// Edge-Cases und §45a-PG-Variationen. Cascade-Verbrauch über echte Termin-
// Dokumentationen und FIFO-/Storno-/Carryover-Verfall-Semantik werden in
// `tests/budget-e2e.test.ts` abgedeckt. Mapping der entfernten Tests:
//
//   BB-1.2  → INT-1.4   (virtuelle §45b Auto-Allokation)
//   BB-1.3  → INT-1.5   (Carryover-Felder im Overview)
//   BB-2.1  → INT-2.1   (§45a aktivieren)
//   BB-2.3  → INT-2.3   (§45a Monatsbegrenzung)
//   BB-3.1  → INT-3.1   (§39/42a aktivieren)
//   BB-3.3  → INT-3.3   (§39/42a Jahresbegrenzung)
//   BB-4.4  → INT-4.3   (Storno einer manuellen Korrektur)
//   BB-4.5  → INT-12    (mehrfache Reversals)
//   BB-5    → INT-10.3  (Prioritätsreihenfolge)
//   BB-8    → INT-1/2/3 (Summary mit allen drei Töpfen + Tx-Filter)
//   BB-9.2  → entfernt   (POST /budget/:id/settings existiert nicht; war
//                         no-op Test, der nur durch BB-2.x-Leck grün war)
//   BB-10   → INT-9 / INT-13.4 (Allokationsliste + Carryover-Ablauf)
//   BB-11   → INT-12.2  (Reversal-Semantik mit echtem Termin-Storno)
//   BB-12   → INT-6     (Verbrauch durch Termin-Dokumentation)
//   BB-13.2 → BB-13.1   (Konsolidierung, gleiche Felder)
//   BB-15.2 → INT-4.2   (manuelle Korrektur in Liste)
//   BB-16   → INT-10.3 / INT-6 (Prioritäten + transactionType-Werte)
//   BB-17   → INT-10.3 / INT-5 (Kaskaden-Konfiguration + Kostenschätzung)
//   BB-18.3 → INT-6.4   (allocationId-Verweis bei Verbrauch)
//   BB-18.4 → INT-14.3  (FIFO: ältestes Geld zuerst)
//
// BB-18.2 (Carryover-Ablaufdatum 30.06.) bleibt erhalten als reiner
// Response-Shape-Test (siehe describe "BB-18: Carryover Response-Shape").
// Verbrauchsabhängige Cascade-Tests dazu liegen in INT-13.3.
//
// Die per-Test-Kunden-Isolation (beforeEach/afterEach) verhindert, dass
// Folgetests durch Reststand aus einem fehlschlagenden Vorgänger-Test brechen.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPut,
  apiPatch,
  getAuthCookie,
  createTestCustomer,
  cleanupCustomer,
} from "./test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let hwServiceId: number;

beforeAll(async () => {
  auth = await getAuthCookie();
  const servicesRes = await apiGet<any[]>("/api/services/all");
  hwServiceId = servicesRes.data.find((s: any) => s.code === "hauswirtschaft")!.id;
});

// ---------------------------------------------------------------------------
// Tests die einen frischen, isolierten PG3-Kunden mit aktivem §45b benötigen.
// Die Per-Test-Kunden-Isolation stellt sicher, dass Verbrauch, manuelle
// Korrekturen oder Settings aus einem Test sich nicht auf Folgetests
// auswirken (Stichwort: Test-Reihenfolge unabhängig).
// ---------------------------------------------------------------------------
describe("BB – API-/Response-Shape-Tests (per-Test-Kunde)", () => {
  let testCustomerId: number;

  beforeEach(async () => {
    const created = await createTestCustomer({
      vorname: "Budget",
      nachname: `BB-PG3-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
    });
    testCustomerId = created.id as number;

    await apiPatch(`/api/admin/customers/${testCustomerId}/assign`, {
      primaryEmployeeId: auth.user.id,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });

    // Default-Konfiguration: §45b Prio 1 aktiv, §45a/§39/42a aus, Budget-Start
    // 2026-01-01. Tests, die andere Töpfe brauchen, überschreiben gezielt.
    await apiPut(`/api/budget/${testCustomerId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
        { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
    });
    await apiPut(`/api/budget/${testCustomerId}/preferences`, {
      customerId: testCustomerId,
      budgetStartDate: "2026-01-01",
    });
  });

  afterEach(async () => {
    await cleanupCustomer(testCustomerId);
  });

  describe("BB-1: §45b Entlastungsbetrag", () => {
    it("BB-1.1 – §45b Overview liefert kumulierten Anspruch (Vielfaches von 131,00 €)", async () => {
      const res = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
      expect(res.status).toBe(200);
      const s45b = res.data.entlastungsbetrag45b;
      expect(s45b).toBeDefined();
      expect(s45b.totalAllocatedCents).toBeGreaterThanOrEqual(13100);
      expect(s45b.totalAllocatedCents % 100).toBe(0);
    });
  });

  describe("BB-2: §45a Umwandlung", () => {
    it("BB-2.2 – §45a Overview zeigt monatliches Budget (PG3 = 598,80 €)", async () => {
      await apiPut(`/api/budget/${testCustomerId}/type-settings`, {
        settings: [
          { budgetType: "entlastungsbetrag_45b", priority: 2, enabled: true, monthlyLimitCents: null },
          { budgetType: "umwandlung_45a", priority: 1, enabled: true, monthlyLimitCents: 59880 },
          { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
        ],
      });

      const res = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
      expect(res.status).toBe(200);
      const s45a = res.data.umwandlung45a;
      expect(s45a).toBeDefined();
      expect(s45a.monthlyBudgetCents).toBe(59880);
      expect(s45a.currentMonthAllocatedCents).toBe(59880);
    });
  });

  describe("BB-3: §39/42a Ersatzpflege", () => {
    it("BB-3.2 – §39/42a Overview zeigt Jahresbudget (3.539,00 €)", async () => {
      await apiPut(`/api/budget/${testCustomerId}/type-settings`, {
        settings: [
          { budgetType: "entlastungsbetrag_45b", priority: 2, enabled: true, monthlyLimitCents: null },
          { budgetType: "umwandlung_45a", priority: 1, enabled: true, monthlyLimitCents: 59880 },
          { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: true, yearlyLimitCents: 353900 },
        ],
      });

      const res = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
      expect(res.status).toBe(200);
      const s42a = res.data.ersatzpflege39_42a;
      expect(s42a).toBeDefined();
      expect(s42a.yearlyBudgetCents).toBe(353900);
      expect(s42a.currentYearAllocatedCents).toBe(353900);
    });
  });

  describe("BB-4: Manuelle Korrektur", () => {
    it("BB-4.1 – Positive manuelle Korrektur erstellt Allocation (201)", async () => {
      const res = await apiPost<any>(`/api/budget/${testCustomerId}/manual-adjustment`, {
        budgetType: "entlastungsbetrag_45b",
        amountCents: 2500,
        notes: "BB-Test Korrektur positiv",
      });
      expect(res.status).toBe(201);
      expect(res.data.type).toBe("allocation");
      expect(res.data.data).toHaveProperty("id");
      expect(res.data.data.amountCents).toBe(2500);
      expect(res.data.data.source).toBe("manual_adjustment");
    });

    it("BB-4.2 – Negative manuelle Korrektur erstellt Transaction (201)", async () => {
      const res = await apiPost<any>(`/api/budget/${testCustomerId}/manual-adjustment`, {
        budgetType: "entlastungsbetrag_45b",
        amountCents: -500,
        notes: "BB-Test Korrektur negativ",
      });
      expect(res.status).toBe(201);
      expect(res.data.type).toBe("transaction");
      expect(res.data.data).toHaveProperty("id");
    });

    it("BB-4.3 – Manuelle Korrektur in Transaktionsliste sichtbar", async () => {
      const adjRes = await apiPost<any>(`/api/budget/${testCustomerId}/manual-adjustment`, {
        budgetType: "entlastungsbetrag_45b",
        amountCents: -750,
        notes: "BB-4.3 Listcheck",
      });
      expect(adjRes.status).toBe(201);
      expect(adjRes.data.type).toBe("transaction");
      const txId = adjRes.data.data.id as number;

      const res = await apiGet<any[]>(
        `/api/budget/${testCustomerId}/transactions?budgetType=entlastungsbetrag_45b&limit=10`
      );
      expect(res.status).toBe(200);
      const found = res.data.find((t: any) => t.id === txId);
      expect(found, "Korrektur-Transaktion muss in Liste sichtbar sein").toBeDefined();
      expect(found!.transactionType).toBe("manual_adjustment");
    });
  });

  describe("BB-6: Deaktivierter Topf (Edge-Case)", () => {
    it("BB-6.1 – Deaktivierter §45a-Topf zeigt 0 im Overview", async () => {
      const res = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
      expect(res.status).toBe(200);
      expect(res.data.umwandlung45a.monthlyBudgetCents).toBe(0);
    });
  });

  describe("BB-7: Kostenvoranschlag (cost-estimate)", () => {
    it("BB-7.1 – cost-estimate liefert Budget-Informationen", async () => {
      const res = await apiGet<any>(
        `/api/budget/${testCustomerId}/cost-estimate?serviceId=${hwServiceId}&durationMinutes=60`
      );
      expect(res.status).toBe(200);
      expect(res.data).toHaveProperty("totalCents");
      expect(res.data).toHaveProperty("availableCents");
      expect(typeof res.data.totalCents).toBe("number");
      expect(typeof res.data.availableCents).toBe("number");
    });
  });

  describe("BB-9: §45a PG3-Limits", () => {
    it("BB-9.1 – PG3 §45a Limit = 598,80 € (40 % von 1.497 €)", async () => {
      await apiPut(`/api/budget/${testCustomerId}/type-settings`, {
        settings: [
          { budgetType: "entlastungsbetrag_45b", priority: 2, enabled: true, monthlyLimitCents: null },
          { budgetType: "umwandlung_45a", priority: 1, enabled: true, monthlyLimitCents: 59880 },
          { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
        ],
      });

      const res = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
      expect(res.status).toBe(200);
      expect(res.data.umwandlung45a.monthlyBudgetCents).toBe(59880);
    });
  });

  describe("BB-13: Budget-Allokationen (Response-Shape)", () => {
    it("BB-13.1 – §45b Allokationen besitzen Pflichtfelder (id, customerId, amountCents, source)", async () => {
      // Monatliche §45b-Auto-Allokationen werden virtuell aus den Type-Settings
      // berechnet und nicht persistiert. Wir erzeugen eine manuelle Korrektur,
      // damit die Allokationsliste mindestens einen physischen Eintrag enthält
      // und der Response-Shape geprüft werden kann.
      const adj = await apiPost<any>(`/api/budget/${testCustomerId}/manual-adjustment`, {
        budgetType: "entlastungsbetrag_45b",
        amountCents: 1000,
        notes: "BB-13.1 Setup – physische Allokation",
      });
      expect(adj.status).toBe(201);
      expect(adj.data.type).toBe("allocation");

      const res = await apiGet<any[]>(
        `/api/budget/${testCustomerId}/allocations?budgetType=entlastungsbetrag_45b&year=2026`
      );
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data)).toBe(true);
      expect(res.data.length).toBeGreaterThan(0);
      const validSources = ["monthly_auto", "carryover", "manual_adjustment", "yearly_auto", "initial_balance"];
      for (const alloc of res.data) {
        expect(alloc).toHaveProperty("id");
        expect(alloc).toHaveProperty("customerId");
        expect(alloc).toHaveProperty("amountCents");
        expect(typeof alloc.amountCents).toBe("number");
        expect(alloc.amountCents).toBeGreaterThan(0);
        expect(validSources).toContain(alloc.source);
      }
    });
  });

  describe("BB-15: Transaktionsliste (Response-Shape)", () => {
    it("BB-15.1 – Transaktionsliste enthält Pflichtfelder", async () => {
      // Transaktion erzeugen, damit die Liste nicht leer ist (frischer Kunde)
      const adj = await apiPost<any>(`/api/budget/${testCustomerId}/manual-adjustment`, {
        budgetType: "entlastungsbetrag_45b",
        amountCents: -250,
        notes: "BB-15.1 Setup",
      });
      expect(adj.status).toBe(201);

      const res = await apiGet<any[]>(
        `/api/budget/${testCustomerId}/transactions?budgetType=entlastungsbetrag_45b&limit=5`
      );
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data)).toBe(true);
      expect(res.data.length).toBeGreaterThan(0);
      const tx = res.data[0];
      expect(tx).toHaveProperty("id");
      expect(tx).toHaveProperty("amountCents");
      expect(tx).toHaveProperty("transactionType");
      expect(tx).toHaveProperty("createdAt");
      const validTypes = ["consumption", "reversal", "manual_adjustment", "allocation", "carryover", "write_off"];
      expect(validTypes).toContain(tx.transactionType);
    });
  });
});

// ---------------------------------------------------------------------------
// PG-Variationen für §45a — jede Variante legt ihren eigenen Kunden mit
// passendem Pflegegrad an, weil §45a-Limits PG-abhängig sind und sich
// nachträglich nicht trivial in einen Bestandskunden patchen lassen.
// ---------------------------------------------------------------------------
describe("BB-14: PG1 – kein §45a Anspruch", () => {
  let pg1CustomerId: number | null = null;

  beforeAll(async () => {
    const provRes = await apiGet<any[]>("/api/admin/insurance-providers");
    const createRes = await apiPost<any>("/api/admin/customers", {
      vorname: "PG1-Test",
      nachname: "Budget-PG1-" + Date.now(),
      geburtsdatum: "1935-03-15",
      strasse: "Teststraße",
      nr: "1",
      plz: "12345",
      stadt: "Teststadt",
      pflegegrad: 1,
      pflegegradSeit: "2024-01-01",
      insurance: {
        providerId: provRes.data[0].id,
        versichertennummer: "P" + String(Math.floor(100000000 + Math.random() * 900000000)),
        validFrom: "2024-01-01",
      },
      contacts: [{
        contactType: "familie",
        isPrimary: true,
        vorname: "Kontakt",
        nachname: "PG1",
        telefon: "+4917600000001",
      }],
    });
    expect(createRes.status).toBe(201);
    pg1CustomerId = createRes.data.id;

    await apiPut(`/api/budget/${pg1CustomerId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
        { budgetType: "umwandlung_45a", priority: 2, enabled: true, monthlyLimitCents: 0 },
        { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
    });
  });

  afterAll(async () => {
    await cleanupCustomer(pg1CustomerId);
    pg1CustomerId = null;
  });

  it("BB-14.1 – PG1 Kunde hat keinen §45a Umwandlungsanspruch", async () => {
    const res = await apiGet<any>(`/api/budget/${pg1CustomerId}/overview`);
    expect(res.status).toBe(200);
    expect(res.data.umwandlung45a).toBeDefined();
    expect(res.data.umwandlung45a.monthlyBudgetCents).toBe(0);
  });
});

describe("BB-14B: §45a PG-abhängige Limits (PG2/PG4/PG5)", () => {
  const pgLimitsMap: Record<number, number> = {
    2: 31840,
    4: 74360,
    5: 91960,
  };

  for (const [pg, expectedCents] of Object.entries(pgLimitsMap)) {
    it(`BB-14B.${pg} – PG${pg} §45a Limit = ${expectedCents / 100} € via monthlyLimitCents`, async () => {
      const provRes = await apiGet<any[]>("/api/admin/insurance-providers");
      const createRes = await apiPost<any>("/api/admin/customers", {
        vorname: `PG${pg}-Test`,
        nachname: `Budget-PG${pg}-` + Date.now(),
        geburtsdatum: "1938-06-10",
        strasse: "Budgetstraße",
        nr: "2",
        plz: "54321",
        stadt: "Budgetstadt",
        pflegegrad: Number(pg),
        pflegegradSeit: "2024-01-01",
        insurance: {
          providerId: provRes.data[0].id,
          versichertennummer: "Q" + String(Math.floor(100000000 + Math.random() * 900000000)),
          validFrom: "2024-01-01",
        },
        contacts: [{
          contactType: "familie",
          isPrimary: true,
          vorname: "Kontakt",
          nachname: `PG${pg}`,
          telefon: "+491760000000" + pg,
        }],
      });
      expect(createRes.status).toBe(201);
      const custId = createRes.data.id;
      try {
        await apiPut(`/api/budget/${custId}/type-settings`, {
          settings: [
            { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
            { budgetType: "umwandlung_45a", priority: 2, enabled: true, monthlyLimitCents: expectedCents },
            { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
          ],
        });
        const res = await apiGet<any>(`/api/budget/${custId}/overview`);
        expect(res.status).toBe(200);
        expect(res.data.umwandlung45a).toBeDefined();
        expect(res.data.umwandlung45a.monthlyBudgetCents).toBe(expectedCents);
      } finally {
        await cleanupCustomer(custId);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Edge-Cases: Kunde ohne Pflegegrad-relevante Daten + 0-Beträge
// ---------------------------------------------------------------------------
describe("BUD-EDGE: Budget-Grenzfälle", () => {
  let edgeCustomerId: number | null = null;

  beforeAll(async () => {
    const created = await createTestCustomer({
      vorname: "BudgetEdge",
      nachname: `Edge-${Date.now()}`,
      pflegegrad: 1,
      billingType: "pflegekasse_gesetzlich",
    });
    edgeCustomerId = created.id as number;
  });

  it("BUD-EDGE-1 – Budgetstatus für Kunde mit niedrigem Pflegegrad ist abrufbar", async () => {
    const res = await apiGet<any>(`/api/budget/${edgeCustomerId}/status?year=${new Date().getFullYear()}`);
    expect(res.status).toBe(200);
  });

  it("BUD-EDGE-2 – Kostenschätzung mit 0 Minuten liefert Ergebnis", async () => {
    const year = new Date().getFullYear();
    const month = new Date().getMonth() + 1;
    const res = await apiGet<any>(
      `/api/budget/${edgeCustomerId}/cost-estimate?year=${year}&month=${month}&minutes=0`
    );
    expect(res.status).toBe(200);
  });

  afterAll(async () => {
    await cleanupCustomer(edgeCustomerId);
    edgeCustomerId = null;
  });
});

// ---------------------------------------------------------------------------
// Task #101: Doppelzählung & Mehrfach-Anzeige Startwert §45b
// (Initial-Balance-Deduplizierung). Nicht-trivial und nicht in
// budget-e2e.test.ts abgedeckt.
// ---------------------------------------------------------------------------
describe("BUD-IB-DEDUP: Startwert §45b – keine Doppelzählung mit Carryover", () => {
  let dedupCustomerId: number | null = null;
  let coCustomerId: number | null = null;
  const previousYear = new Date().getFullYear() - 1;
  const startMonth = 12;
  const ibAmountCents = 157200; // 1.572 €

  beforeAll(async () => {
    const created = await createTestCustomer({
      vorname: "IBDedup",
      nachname: `Dedup-${Date.now()}`,
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
    });
    dedupCustomerId = created.id as number;

    await apiPut<any>(`/api/budget/${dedupCustomerId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
        { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
    });

    // Startwert ab Dezember Vorjahr
    const ibRes = await apiPost<any>(`/api/budget/${dedupCustomerId}/initial-balance/entlastungsbetrag_45b`, {
      amountCents: ibAmountCents,
      validFrom: `${previousYear}-${String(startMonth).padStart(2, "0")}`,
    });
    expect(ibRes.status).toBe(200);
  });

  it("BUD-IB-DEDUP-1 – Startwert-Historie liefert ausschließlich initial_balance-Einträge", async () => {
    await apiGet<any>(`/api/budget/${dedupCustomerId}/overview`); // triggert syncCarryoverAndExpiry
    const res = await apiGet<any[]>(`/api/budget/${dedupCustomerId}/initial-balances/entlastungsbetrag_45b`);
    expect(res.status).toBe(200);
    expect(res.data.length).toBeGreaterThan(0);
    for (const a of res.data) {
      expect(a.source).toBe("initial_balance");
    }
  });

  it("BUD-IB-DEDUP-2 – Kein automatischer Carryover, wenn Vorjahres-Startwert existiert", async () => {
    await apiGet<any>(`/api/budget/${dedupCustomerId}/overview`);
    const allocRes = await apiGet<any[]>(`/api/budget/${dedupCustomerId}/allocations`);
    expect(allocRes.status).toBe(200);
    const autoCarryover = allocRes.data.filter(
      (a: any) => a.budgetType === "entlastungsbetrag_45b" && a.source === "carryover"
    );
    expect(autoCarryover.length).toBe(0);
  });

  it("BUD-IB-DEDUP-3 – totalAllocatedCents = Startwert + Auto-Allokationen ab Folgemonat", async () => {
    const overviewRes = await apiGet<any>(`/api/budget/${dedupCustomerId}/overview`);
    expect(overviewRes.status).toBe(200);
    const s45b = overviewRes.data.entlastungsbetrag45b;

    const now = new Date();
    const curYear = now.getFullYear();
    const curMonth = now.getMonth() + 1;
    const monthsSinceIB = (curYear - previousYear) * 12 + (curMonth - startMonth);
    const expected = ibAmountCents + Math.max(0, monthsSinceIB) * 13100;

    expect(s45b.totalAllocatedCents).toBe(expected);
  });

  it("BUD-IB-DEDUP-4 – Klassischer Carryover funktioniert ohne Vorjahres-Startwert", async () => {
    const created = await createTestCustomer({
      vorname: "IBDedupCO",
      nachname: `Carryover-${Date.now()}`,
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
    });
    coCustomerId = created.id as number;

    await apiPut<any>(`/api/budget/${coCustomerId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
        { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
    });
    await apiPut<any>(`/api/budget/${coCustomerId}/preferences`, {
      customerId: coCustomerId,
      budgetStartDate: `${previousYear}-01-01`,
    });

    await apiGet<any>(`/api/budget/${coCustomerId}/overview`);
    const allocRes = await apiGet<any[]>(`/api/budget/${coCustomerId}/allocations`);
    const carryovers = allocRes.data.filter(
      (a: any) => a.budgetType === "entlastungsbetrag_45b" && a.source === "carryover"
    );
    expect(carryovers.length).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await cleanupCustomer(dedupCustomerId);
    await cleanupCustomer(coCustomerId);
    dedupCustomerId = null;
    coCustomerId = null;
  });
});

// ---------------------------------------------------------------------------
// BB-18.2 – Carryover-Allokation hat Ablaufdatum 30.06.
// Reiner Response-Shape-Test: prüft, dass `expiresAt` für carryover-Allokationen
// gesetzt ist und auf den 30.06. des Folgejahres fällt. Verbrauchsabhängige
// FIFO-/Prioritäts-Cascade-Tests liegen in tests/budget-e2e.test.ts (INT-13.3).
// ---------------------------------------------------------------------------
describe("BB-18: Carryover Response-Shape", () => {
  let carryoverCustomerId: number | null = null;
  const previousYear = new Date().getFullYear() - 1;

  beforeAll(async () => {
    const created = await createTestCustomer({
      vorname: "BBCarryover",
      nachname: `BB18-${Date.now()}`,
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
    });
    carryoverCustomerId = created.id as number;

    await apiPut(`/api/budget/${carryoverCustomerId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
        { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
    });
    // Budget-Start im Vorjahr ⇒ syncCarryoverAndExpiry erzeugt Carryover-Allokation.
    await apiPut(`/api/budget/${carryoverCustomerId}/preferences`, {
      customerId: carryoverCustomerId,
      budgetStartDate: `${previousYear}-01-01`,
    });
    await apiGet<any>(`/api/budget/${carryoverCustomerId}/overview`); // triggert Sync
  });

  afterAll(async () => {
    await cleanupCustomer(carryoverCustomerId);
    carryoverCustomerId = null;
  });

  it("BB-18.2 – Carryover-Allokation hat Ablaufdatum 30.06.", async () => {
    const res = await apiGet<any[]>(
      `/api/budget/${carryoverCustomerId}/allocations?budgetType=entlastungsbetrag_45b`
    );
    expect(res.status).toBe(200);
    const carryovers = res.data.filter((a: any) => a.source === "carryover");
    expect(carryovers.length).toBeGreaterThan(0);
    for (const co of carryovers) {
      expect(co.expiresAt, "Carryover muss expiresAt haben").toBeDefined();
      const expiry = new Date(co.expiresAt);
      expect(expiry.getMonth()).toBe(5); // Juni (0-indexed)
      expect(expiry.getDate()).toBe(30);
    }
  });
});
