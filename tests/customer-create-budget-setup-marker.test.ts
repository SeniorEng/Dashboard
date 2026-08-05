import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../server/lib/db";
import { customers } from "../shared/schema";
import { apiGet, apiPost, apiPut, uniqueId, getAuthCookie } from "./test-utils";

// Task #724 (BUG-4) / Task #1828 — Vertrag für den Setup-Marker.
//
// `POST /api/admin/customers` legt einen Pflegekasse-Kunden ohne `budgets`-Block
// an. Task #1828: `budgetSetupRequired` folgt nicht mehr „gibt es eine
// persistierte Topf-Zeile?", sondern der Aktivierungs-SSoT (`hasActiveBudgetPot`
// / `effectiveDefaultPots`). §45b ist für jeden Pflegekassen-Kunden default-aktiv
// (ohne persistierte Zeile), daher ist `budgetSetupRequired=false` — der Kunde
// hat bereits einen nutzbaren Topf, auch wenn `GET /overview` (Startwert = 0)
// noch leer ist. `budgetSetupRequired=true` gilt nur, wenn KEIN Topf aktiv ist
// (Selbstzahler ⇒ kein Anspruch ⇒ ebenfalls false, kein Setup nötig).
const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

let insuranceProviderId: number;
const createdCustomerIds: number[] = [];

beforeAll(async () => {
  const provRes = await apiGet<any[]>("/api/admin/insurance-providers");
  expect(provRes.status).toBe(200);
  insuranceProviderId = provRes.data[0].id;
});

afterAll(async () => {
  if (createdCustomerIds.length > 0) {
    try {
      await db.update(customers).set({ deletedAt: new Date() }).where(inArray(customers.id, createdCustomerIds));
    } catch {}
  }
});

function pflegekassePayload(pflegegrad: number, overrides: Record<string, any> = {}) {
  return {
    billingType: "pflegekasse_gesetzlich",
    vorname: "BudgetMarker",
    nachname: "Test-" + uniqueId(),
    geburtsdatum: "1942-03-04",
    strasse: "Marker-Straße",
    nr: "7",
    plz: "10115",
    stadt: "Berlin",
    pflegegrad,
    pflegegradSeit: "2024-01-01",
    insurance: {
      providerId: insuranceProviderId,
      versichertennummer: "A" + String(Math.floor(100000000 + Math.random() * 900000000)),
      validFrom: "2024-01-01",
    },
    ...overrides,
  };
}

describe("Task #724 — Customer-Create Budget-Setup-Marker", () => {
  it("Pflegekasse + PG4 ohne budgets → budgetSetupRequired=true & Overview leer", async () => {
    const res = await apiPost<any>("/api/admin/customers", pflegekassePayload(4));
    expect(res.status).toBe(201);
    createdCustomerIds.push(res.data.id);

    // Task #1828: §45b ist default-aktiv (Aktivierungs-SSoT) ⇒ es gibt bereits
    // einen nutzbaren Topf, auch ohne persistierte Zeile ⇒ KEIN Setup nötig.
    expect(res.data.budgetSetupRequired).toBe(false);
    expect(res.data.requiredBudgetTypes).toEqual([]);

    // Smoke-Anchor: Overview-Startwert ist 0 (noch kein Guthaben hinterlegt) —
    // das ist erlaubt und macht den Topf nicht „nicht eingerichtet".
    const overview = await apiGet<any>(`/api/budget/${res.data.id}/overview`);
    expect(overview.status).toBe(200);
    expect(overview.data.entlastungsbetrag45b.totalAllocatedCents).toBe(0);
    expect(overview.data.umwandlung45a.isCurrentlyActive).toBe(false);
  });

  it("Pflegekasse + PG4 mit budgets-Block → budgetSetupRequired=false", async () => {
    const res = await apiPost<any>(
      "/api/admin/customers",
      pflegekassePayload(4, {
        budgets: {
          entlastungsbetrag45b: 13100,
          verhinderungspflege39: 0,
          pflegesachleistungen36: 0,
          validFrom: "2024-01-01",
        },
      }),
    );
    expect(res.status).toBe(201);
    createdCustomerIds.push(res.data.id);

    expect(res.data.budgetSetupRequired).toBe(false);
    expect(res.data.requiredBudgetTypes).toEqual([]);
  });

  it("Pflegekasse_privat + PG4 ohne budgets → budgetSetupRequired=false (§45b default-aktiv, gleicher Vertrag wie gesetzlich)", async () => {
    const res = await apiPost<any>(
      "/api/admin/customers",
      pflegekassePayload(4, { billingType: "pflegekasse_privat" }),
    );
    expect(res.status).toBe(201);
    createdCustomerIds.push(res.data.id);

    // Task #1828: default-aktiver §45b ⇒ nutzbarer Topf vorhanden ⇒ kein Setup.
    expect(res.data.budgetSetupRequired).toBe(false);
    expect(res.data.requiredBudgetTypes).toEqual([]);
  });

  it("Pflegekasse + PG1 ohne budgets → budgetSetupRequired=false (§45b gilt ab PG1, default-aktiv)", async () => {
    const res = await apiPost<any>("/api/admin/customers", pflegekassePayload(1));
    expect(res.status).toBe(201);
    createdCustomerIds.push(res.data.id);

    expect(res.data.budgetSetupRequired).toBe(false);
    expect(res.data.requiredBudgetTypes).toEqual([]);
  });

  it("Idempotency-Replay (200 hit) liefert Marker auf Basis des IST-Zustands", async () => {
    // `apiPost` reicht keinen freien Header durch — Idempotency-Key muss
    // direkt über fetch gesetzt werden. Cookie/CSRF kommen aus dem
    // gemeinsamen Helper, damit die Auth-Logik nicht dupliziert wird.
    const auth = await getAuthCookie();
    const idempotencyKey = "task724-replay-" + uniqueId();
    const payload = pflegekassePayload(4);

    const post = async () => {
      const r = await fetch(`${BASE_URL}/api/admin/customers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${auth.cookie}; careconnect_csrf=${auth.csrfToken}`,
          "x-csrf-token": auth.csrfToken,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
      return { status: r.status, data: (await r.json().catch(() => null)) as any };
    };

    const first = await post();
    expect(first.status).toBe(201);
    createdCustomerIds.push(first.data.id);
    // Task #1828: §45b default-aktiv ⇒ false (nicht mehr true).
    expect(first.data.budgetSetupRequired).toBe(false);

    // Direkter Retry mit gleichem Key + Payload — Server antwortet 200 +
    // idempotent:true, MUSS aber laut Vertrag #724 die Marker-Felder
    // mitliefern (sonst sieht ein retry-fähiger Client die Vertragslücke
    // nicht). Der Marker wird auf Basis des IST-Zustands berechnet und ist
    // konsistent mit dem Erst-Response.
    const replay = await post();
    expect(replay.status).toBe(200);
    expect(replay.data.idempotent).toBe(true);
    expect(replay.data.id).toBe(first.data.id);
    expect(replay.data.budgetSetupRequired).toBe(false);
    expect(replay.data.requiredBudgetTypes).toEqual([]);
  });

  // Der `true`-ZWEIG. Ohne diesen Test pinnt keine Zeile mehr, dass der Marker
  // überhaupt jemals anschlägt — alle übrigen Assertions der Datei lauten
  // `false`, und `REQUIRED_STATUTORY_BUDGET_TYPES` wäre serverseitig ungetestet.
  //
  // Warum über den REPLAY und nicht über die Anlage: seit #1828 ist §45b für
  // jeden Nicht-Selbstzahler default-aktiv. Der Anlage-Pfad schreibt entweder
  // `enabled:true`-Zeilen (nur bei Betrag > 0) ODER — wie hier — gar keine;
  // eine `enabled=false`-Zeile kann dort nicht entstehen. Ein frisch angelegter
  // Kunde HAT damit immer einen aktiven Topf, hier über den DEFAULT und nicht
  // über eine geschriebene Zeile — `true` ist auf dem 201-Pfad per Konstruktion
  // unerreichbar. Erreichbar ist der Zustand nur durch ausdrückliches
  // Abschalten, und der Replay liest den IST-Zustand.
  //
  // BEWUSST NICHT ABGEDECKT: der Transitions-Schreibpfad. Weil dieser Kunde
  // Sekunden alt ist und noch keine persistierte Zeile hat, nimmt
  // `upsertBudgetTypeSettings` den Erstanlage-Zweig (`validFrom = NULL`). Bei
  // einem BESTANDSKUNDEN greift stattdessen der Transitions-Zweig: die alte
  // Zeile wird auf `validTo = heute` geschlossen, die neue deaktivierte bekommt
  // `validFrom = morgen`. `hasActiveBudgetPot` wertet `validFrom` nicht aus und
  // meldet dann schon heute `true`, obwohl der Topf heute fensterlogisch noch
  // wirksam ist. Das ist als FINDING [P3] am PR vermerkt, nicht hier gefixt.
  it("Replay NACH Abschalten aller Töpfe → budgetSetupRequired=true (der true-Zweig)", async () => {
    const auth = await getAuthCookie();
    const idempotencyKey = "task1828-truebranch-" + uniqueId();
    const payload = pflegekassePayload(4);

    const post = async () => {
      const r = await fetch(`${BASE_URL}/api/admin/customers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${auth.cookie}; careconnect_csrf=${auth.csrfToken}`,
          "x-csrf-token": auth.csrfToken,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
      return { status: r.status, data: (await r.json().catch(() => null)) as any };
    };

    const first = await post();
    expect(first.status).toBe(201);
    createdCustomerIds.push(first.data.id);
    // Ausgangslage: default-aktiver §45b ⇒ kein Setup nötig.
    expect(first.data.budgetSetupRequired).toBe(false);

    // §45b (und die beiden anderen) ausdrücklich abschalten. Ein reiner
    // Deaktivier-Payload ist erlaubt — `PUT type-settings` gated nur das
    // AKTIVIEREN gegen Selbstzahler/Pflegegrad.
    const disable = await apiPut(`/api/budget/${first.data.id}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: false, monthlyLimitCents: null },
        { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
    });
    expect(disable.status, `Abschalten: ${JSON.stringify(disable.data)}`).toBe(200);

    // Jetzt hat der Kunde KEINEN aktiven Topf mehr — der Marker muss anschlagen,
    // und zwar mit der vollständigen Liste der einzurichtenden Typen.
    const replay = await post();
    expect(replay.status).toBe(200);
    expect(replay.data.idempotent).toBe(true);
    expect(replay.data.id).toBe(first.data.id);
    expect(replay.data.budgetSetupRequired).toBe(true);
    expect(replay.data.requiredBudgetTypes).toEqual([
      "entlastungsbetrag_45b",
      "umwandlung_45a",
      "ersatzpflege_39_42a",
    ]);
  });

  it("Selbstzahler ohne budgets → budgetSetupRequired=false (kein Anspruch)", async () => {
    const res = await apiPost<any>("/api/admin/customers", {
      billingType: "selbstzahler",
      vorname: "BudgetMarker",
      nachname: "Selbst-" + uniqueId(),
      strasse: "Marker-Straße",
      nr: "9",
      plz: "10115",
      stadt: "Berlin",
      email: "selbst-" + uniqueId() + "@example.com",
      documentDeliveryMethod: "email",
    });
    expect(res.status).toBe(201);
    createdCustomerIds.push(res.data.id);

    expect(res.data.budgetSetupRequired).toBe(false);
    expect(res.data.requiredBudgetTypes).toEqual([]);
  });
});
