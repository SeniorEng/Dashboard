import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPatch,
  getAuthCookie,
  createTestEmployee,
  createTestCustomer,
  assignEmployeeToCustomer,
} from "./test-utils";

// ---------------------------------------------------------------------------
// Task #796: Guard-Test für die Sicherheits-Filter des Test-Daten-Cleanups.
//
// Die Bulk-Purge-Routen in server/routes/admin/test-cleanup.ts verlassen sich
// auf server-seitige SQL-Pattern-Filter (PROSPECT_TEST_FILTER, der
// Test-User-Email/Nachname-Filter, CUSTOMER_TEST_C), damit ausschließlich
// Test-Pattern-Datensätze je gelöscht werden können. Wird einer dieser Filter
// versehentlich gelockert (sodass er echte Kunden/Interessenten/User trifft),
// drohen echte Daten gelöscht zu werden. Dieser Test pinnt die Filter-Semantik:
// echte Datensätze MÜSSEN jeden Purge überleben, Test-Datensätze MÜSSEN fallen.
// ---------------------------------------------------------------------------

// Nicht-Test-Suffix: bewusst OHNE "test", ohne "eb"/"status"-Präfix, damit die
// erzeugten "echten" Datensätze von keinem Pattern getroffen werden. uniqueId()
// aus test-utils enthält "test_" und ist hier daher unbrauchbar.
function realSuffix(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

interface ProspectRow {
  id: number;
  vorname: string;
  nachname: string;
}

interface UserRow {
  id: number;
  email: string;
  nachname: string;
}

function toArray<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  const d = (data as Record<string, unknown> | null)?.data;
  return Array.isArray(d) ? (d as T[]) : [];
}

let auth: Awaited<ReturnType<typeof getAuthCookie>>;

// Best-effort cleanup falls eine Assertion vorzeitig abbricht.
const leftoverCustomerIds: number[] = [];
const leftoverUserIds: number[] = [];
const leftoverProspectIds: number[] = [];

beforeAll(async () => {
  auth = await getAuthCookie();
});

afterAll(async () => {
  for (const id of leftoverCustomerIds) {
    try { await apiPost(`/api/admin/test-cleanup/purge-customers`, { ids: [id] }); } catch {}
  }
  for (const id of leftoverUserIds) {
    try {
      await apiPatch(`/api/admin/users/${id}`, { nachname: `testemp_cleanup_${realSuffix()}` });
      await apiPost(`/api/admin/test-cleanup/purge-test-users`, { ids: [id] });
    } catch {}
  }
  for (const id of leftoverProspectIds) {
    try {
      await apiPatch(`/api/prospects/${id}`, { vorname: "Test Cleanup" });
      await apiPost(`/api/admin/test-cleanup/purge-prospects`, { ids: [id] });
    } catch {}
  }
});

describe("CLEAN-1: Test-Cleanup-Filter löschen niemals echte Datensätze", () => {
  it("CLEAN-1.1 – purge-prospects löscht nur Test-Interessenten, echte überleben", async () => {
    const sfx = realSuffix();

    // Echter Interessent: Name trifft KEIN Test-Pattern.
    const realRes = await apiPost<ProspectRow>("/api/prospects/inline", {
      vorname: "Maximilian",
      nachname: `Reallead${sfx}`,
    });
    expect(realRes.status).toBe(201);
    const realId = realRes.data.id;
    leftoverProspectIds.push(realId);

    // Test-Interessent: Name trifft das Test-Pattern (enthält "test").
    const testRes = await apiPost<ProspectRow>("/api/prospects/inline", {
      vorname: "Test",
      nachname: `Auto${sfx}`,
    });
    expect(testRes.status).toBe(201);
    const testId = testRes.data.id;

    // Beide IDs an den Purge geben — der server-seitige Filter MUSS den echten
    // Interessenten ablehnen und nur den Test-Interessenten entfernen.
    const purge = await apiPost<{ deleted: number[] }>(
      "/api/admin/test-cleanup/purge-prospects",
      { ids: [realId, testId] },
    );
    expect(purge.status).toBe(200);
    expect(purge.data.deleted).toContain(testId);
    expect(purge.data.deleted).not.toContain(realId);

    // Gegenprobe über die Liste: echter Interessent noch da, Test-Lead weg.
    const list = await apiGet("/api/admin/prospects");
    const ids = new Set(toArray<ProspectRow>(list.data).map((p) => p.id));
    expect(ids.has(realId)).toBe(true);
    expect(ids.has(testId)).toBe(false);

    // Beweis, dass der FILTER (nicht die Route) entscheidet: sobald der echte
    // Interessent das Test-Pattern erfüllt, wird er sehr wohl gelöscht.
    await apiPatch(`/api/prospects/${realId}`, { vorname: "Test Cleanup" });
    const purge2 = await apiPost<{ deleted: number[] }>(
      "/api/admin/test-cleanup/purge-prospects",
      { ids: [realId] },
    );
    expect(purge2.data.deleted).toContain(realId);
    leftoverProspectIds.length = 0;
  });

  it("CLEAN-1.2 – purge-test-users löscht nur Test-User, echte werden abgelehnt", async () => {
    const sfx = realSuffix();

    // Echter User: Email + Nachname treffen KEIN Test-Pattern.
    const phone = `+49170${String(Date.now()).slice(-9).padStart(9, "0")}`;
    const realUserRes = await apiPost<{ id: number }>("/api/admin/users", {
      email: `realmitarbeiter-${sfx}@seniorenengel-echt.de`,
      password: "EchtPasswort123!",
      vorname: "Echt",
      nachname: `Mitarbeiter${sfx}`,
      geburtsdatum: "1985-05-05",
      eintrittsdatum: "2024-01-01",
      isAdmin: false,
      telefon: phone,
    });
    expect(realUserRes.status).toBe(201);
    const realUserId = realUserRes.data.id;
    leftoverUserIds.push(realUserId);

    // Test-User: Email @test.local trifft das Test-Pattern.
    const testEmp = await createTestEmployee({ nachnamePrefix: "CleanGuard" });

    const purge = await apiPost<{ deleted: number[]; rejected: number[] }>(
      "/api/admin/test-cleanup/purge-test-users",
      { ids: [realUserId, testEmp.id] },
    );
    expect(purge.status).toBe(200);
    expect(purge.data.deleted).toContain(testEmp.id);
    expect(purge.data.deleted).not.toContain(realUserId);
    expect(purge.data.rejected).toContain(realUserId);

    // Gegenprobe: echter User noch da, Test-User weg.
    const list = await apiGet("/api/admin/users?limit=1000");
    const ids = new Set(toArray<UserRow>(list.data).map((u) => u.id));
    expect(ids.has(realUserId)).toBe(true);
    expect(ids.has(testEmp.id)).toBe(false);

    // Filter-Beweis: nach Umbenennung auf das Test-Pattern wird er gelöscht.
    await apiPatch(`/api/admin/users/${realUserId}`, {
      nachname: `testemp_cleanup_${sfx}`,
    });
    const purge2 = await apiPost<{ deleted: number[] }>(
      "/api/admin/test-cleanup/purge-test-users",
      { ids: [realUserId] },
    );
    expect(purge2.data.deleted).toContain(realUserId);
    leftoverUserIds.length = 0;
  });

  it("CLEAN-1.3 – purge-test-users tastet einen mit dem Test-User verflochtenen echten Kunden nicht an", async () => {
    const sfx = realSuffix();

    // Echter Kunde: Name trifft KEIN Test-Pattern (isTestCustomer = false).
    const realCustomer = await createTestCustomer({
      vorname: "Maximilian",
      nachname: `Echtkunde${sfx}`,
    });
    const realCustomerId = realCustomer.id as number;
    leftoverCustomerIds.push(realCustomerId);

    // Test-User, der dem echten Kunden zugewiesen wird → erzeugt
    // customer_assignment_history + primary_employee_id-Verflechtung.
    const testEmp = await createTestEmployee({ nachnamePrefix: "EntangleGuard" });
    await assignEmployeeToCustomer(realCustomerId, testEmp.id);

    const purge = await apiPost<{ deleted: number[] }>(
      "/api/admin/test-cleanup/purge-test-users",
      { ids: [testEmp.id] },
    );
    expect(purge.status).toBe(200);
    expect(purge.data.deleted).toContain(testEmp.id);

    // Der CUSTOMER_TEST_C-Filter + Detach-Pass MÜSSEN den echten Kunden
    // erhalten — gelöscht/genullt wird nur die Test-User-Spur. Die Kunden-Detail-
    // Route liegt unter /:id/details (ein blankes /:id existiert nicht und würde
    // für JEDEN Kunden 404 liefern); ein 200 hier beweist, dass die Kunden-Zeile
    // den Purge überlebt hat.
    const cust = await apiGet<{ id: number }>(`/api/admin/customers/${realCustomerId}/details`);
    expect(cust.status).toBe(200);
    expect(cust.data.id).toBe(realCustomerId);

    // Aufräumen des echten Kunden über die (ungefilterte) Kunden-Purge-Route.
    await apiPost(`/api/admin/test-cleanup/purge-customers`, { ids: [realCustomerId] });
    leftoverCustomerIds.length = 0;
  });
});
