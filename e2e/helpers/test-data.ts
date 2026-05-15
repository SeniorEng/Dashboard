import { apiPost, type ApiSession } from "./auth";

interface ServiceCatalogEntry {
  id: number;
  code?: string;
  lohnartKategorie?: string;
  isActive?: boolean;
}

let serviceCache: ServiceCatalogEntry[] | null = null;

export async function getServiceIdByCode(
  session: ApiSession,
  code: string,
): Promise<number> {
  if (!serviceCache) {
    const r = await session.api.get("/api/services");
    if (!r.ok()) throw new Error(`GET /api/services failed: ${r.status()}`);
    serviceCache = (await r.json()) as ServiceCatalogEntry[];
  }
  // WICHTIG: nur exakt nach `code` matchen — `lohnartKategorie` würde auch
  // Auto-Test-Services (`auto_test_xxx` mit Kategorie `hauswirtschaft`) zurück-
  // liefern, deren `serviceCode` dann nicht "hauswirtschaft" ist und in
  // `useDocumentationForm` durch den Default-Branch fällt → der Locator
  // `input-details-hauswirtschaft` existiert dann nicht.
  const match = serviceCache.find((s) => s.code === code);
  if (!match) {
    throw new Error(
      `getServiceIdByCode("${code}"): not found in service catalog`,
    );
  }
  return match.id;
}

const ts = () => Date.now();
const rand = () => Math.random().toString(36).slice(2, 7);

interface IdResponse {
  id: number;
}

function idFrom(data: unknown, label: string): number {
  if (
    data &&
    typeof data === "object" &&
    "id" in data &&
    typeof (data as { id: unknown }).id === "number"
  ) {
    return (data as IdResponse).id;
  }
  throw new Error(`${label}: response missing numeric id (${JSON.stringify(data)})`);
}

export interface TestCustomer {
  id: number;
  vorname: string;
  nachname: string;
}

export async function createCustomer(
  session: ApiSession,
  overrides: Record<string, unknown> = {},
): Promise<TestCustomer> {
  const t = ts();
  const r = rand();
  const payload = {
    vorname: "Test",
    nachname: `Auto_${t}_${r}`,
    geburtsdatum: "1940-01-15",
    email: `test-${t}-${r}@test.local`,
    strasse: "Teststraße",
    nr: "1",
    plz: "10115",
    stadt: "Berlin",
    telefon: "+4917600000000",
    pflegegrad: 3,
    pflegegradSeit: "2024-01-01",
    acceptsPrivatePayment: true,
    ...overrides,
  };
  const { status, data } = await apiPost<unknown>(
    session,
    "/api/admin/customers",
    payload,
  );
  if (status !== 201) {
    throw new Error(
      `createCustomer failed: ${status} ${JSON.stringify(data)}`,
    );
  }
  return {
    id: idFrom(data, "createCustomer"),
    vorname: payload.vorname,
    nachname: payload.nachname,
  };
}

export interface TestEmployee {
  id: number;
  email: string;
  password: string;
  vorname: string;
  nachname: string;
}

export async function createEmployee(
  session: ApiSession,
  opts: { isAdmin?: boolean } = {},
): Promise<TestEmployee> {
  const t = ts();
  const r = rand();
  const email = `testemp-${t}-${r}@test.local`;
  const password = "TestPasswort123!";
  const phoneSuffix = String(t).slice(-9).padStart(9, "0");
  const vorname = "Test";
  const nachname = `TestEmp_${t}_${r}`;
  const { status, data } = await apiPost<unknown>(session, "/api/admin/users", {
    email,
    password,
    vorname,
    nachname,
    geburtsdatum: "1990-01-01",
    eintrittsdatum: "2024-01-01",
    isAdmin: opts.isAdmin ?? false,
    telefon: `+49170${phoneSuffix}`,
  });
  if (status !== 201) {
    throw new Error(`createEmployee failed: ${status} ${JSON.stringify(data)}`);
  }
  return { id: idFrom(data, "createEmployee"), email, password, vorname, nachname };
}

export async function deactivateEmployee(
  session: ApiSession,
  id: number,
): Promise<void> {
  try {
    await apiPost(session, `/api/admin/users/${id}/deactivate`, {});
  } catch {
    /* best-effort */
  }
}

export async function assignEmployee(
  session: ApiSession,
  customerId: number,
  employeeId: number,
): Promise<void> {
  const { status, data } = await apiPost<unknown>(
    session,
    `/api/admin/customers/${customerId}/employees`,
    { employeeId, isPrimary: true },
  );
  if (status >= 300) {
    throw new Error(
      `assignEmployee failed: ${status} ${JSON.stringify(data)}`,
    );
  }
}

/**
 * Returns the next weekday (Mon-Fri) at least `minDaysAhead` days from today
 * as YYYY-MM-DD, since appointments cannot fall on Sa/So.
 */
export function nextWeekday(minDaysAhead = 7): string {
  const d = new Date();
  d.setDate(d.getDate() + minDaysAhead);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

export interface TestAppointment {
  id: number;
  customerId: number;
  employeeId: number;
  date: string;
}

export async function createAppointment(
  session: ApiSession,
  opts: { customerId: number; employeeId: number },
): Promise<TestAppointment> {
  const date = nextWeekday(7);
  const serviceId = await getServiceIdByCode(session, "hauswirtschaft");
  const { status, data } = await apiPost<unknown>(
    session,
    "/api/appointments/kundentermin",
    {
      customerId: opts.customerId,
      assignedEmployeeId: opts.employeeId,
      date,
      scheduledStart: "10:00",
      services: [{ serviceId, durationMinutes: 60 }],
      notes: "",
    },
  );
  if (status !== 201) {
    throw new Error(
      `createAppointment failed: ${status} ${JSON.stringify(data)}`,
    );
  }
  return {
    id: idFrom(data, "createAppointment"),
    customerId: opts.customerId,
    employeeId: opts.employeeId,
    date,
  };
}

export interface TestProspect {
  id: number;
  vorname: string;
  nachname: string;
}

export async function createProspect(
  session: ApiSession,
): Promise<TestProspect> {
  const t = ts();
  const r = rand();
  const vorname = "Eb";
  const nachname = `Test_${t}_${r}`;
  const { status, data } = await apiPost<unknown>(
    session,
    "/api/prospects/inline",
    {
      vorname,
      nachname,
      telefon: "+4917612345678",
      email: `prospect-${t}-${r}@test.local`,
    },
  );
  if (status !== 201 && status !== 200) {
    throw new Error(
      `createProspect failed: ${status} ${JSON.stringify(data)}`,
    );
  }
  return { id: idFrom(data, "createProspect"), vorname, nachname };
}
