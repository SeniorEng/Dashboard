import { db } from "../lib/db";
import { customers } from "@shared/schema/customers";
import { companySettings } from "@shared/schema/company";
import { users } from "@shared/schema/users";
import { eq, isNull, and, or, isNotNull } from "drizzle-orm";
import { log } from "../lib/log";

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "CareConnect/1.0 (care-management-app)";
const RATE_LIMIT_MS = 1100;

let lastRequestTime = 0;
let rateLimitChain: Promise<void> = Promise.resolve();

interface GeocodingResult {
  latitude: number;
  longitude: number;
}

/**
 * Thread-safe wrapper around fetch that enforces Nominatim's
 * 1 request/second policy across concurrent callers by serialising
 * waits through a shared Promise chain. The actual HTTP call still
 * runs in parallel once the slot has been released, so latency for
 * an isolated request stays at network RTT.
 */
export async function rateLimitedFetch(url: string): Promise<Response> {
  const wait = rateLimitChain.then(async () => {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < RATE_LIMIT_MS) {
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS - elapsed));
    }
    lastRequestTime = Date.now();
  });
  rateLimitChain = wait.catch(() => undefined);
  await wait;
  return fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept": "application/json" },
    signal: AbortSignal.timeout(5000),
  });
}

export async function geocodeAddress(
  strasse: string | null | undefined,
  hausnummer: string | null | undefined,
  plz: string | null | undefined,
  stadt: string | null | undefined
): Promise<GeocodingResult | null> {
  if (!strasse || !plz || !stadt) return null;

  const street = hausnummer ? `${strasse} ${hausnummer}` : strasse;

  try {
    const params = new URLSearchParams({
      street,
      city: stadt,
      postalcode: plz,
      country: "Germany",
      format: "json",
      limit: "1",
    });
    const url = `${NOMINATIM_BASE}?${params}`;
    const response = await rateLimitedFetch(url);
    if (!response.ok) return null;

    const results = await response.json() as Array<{ lat: string; lon: string }>;
    if (!results || results.length === 0) return null;

    const lat = parseFloat(results[0].lat);
    const lon = parseFloat(results[0].lon);
    if (isNaN(lat) || isNaN(lon)) return null;

    return { latitude: lat, longitude: lon };
  } catch (error) {
    console.error("[geocoding] Error geocoding address:", `${street}, ${plz} ${stadt}`, error);
    return null;
  }
}

export async function geocodeCustomer(customerId: number): Promise<void> {
  const [customer] = await db.select().from(customers).where(eq(customers.id, customerId));
  if (!customer) return;

  const result = await geocodeAddress(customer.strasse, customer.nr, customer.plz, customer.stadt);
  if (result) {
    await db.update(customers)
      .set({ latitude: result.latitude, longitude: result.longitude })
      .where(eq(customers.id, customerId));
  }
}

export async function geocodeCompanySettings(): Promise<void> {
  const [settings] = await db.select().from(companySettings);
  if (!settings) return;

  const result = await geocodeAddress(settings.strasse, settings.hausnummer, settings.plz, settings.stadt);
  if (result) {
    await db.update(companySettings)
      .set({ latitude: result.latitude, longitude: result.longitude })
      .where(eq(companySettings.id, settings.id));
  }
}

export async function geocodeEmployee(userId: number): Promise<void> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) return;

  const result = await geocodeAddress(user.strasse, user.hausnummer, user.plz, user.stadt);
  if (result) {
    await db.update(users)
      .set({ latitude: result.latitude, longitude: result.longitude })
      .where(eq(users.id, userId));
  }
}

export async function geocodeAllMissing(): Promise<void> {
  log("Starting batch geocoding of addresses without coordinates...", "geocoding");

  const [settings] = await db.select().from(companySettings);
  if (settings && !settings.latitude && settings.strasse && settings.plz && settings.stadt) {
    await geocodeCompanySettings();
    log("Company address geocoded", "geocoding");
  }

  const customersWithoutCoords = await db.select({
    id: customers.id,
    strasse: customers.strasse,
    nr: customers.nr,
    plz: customers.plz,
    stadt: customers.stadt,
  }).from(customers).where(
    and(
      isNull(customers.latitude),
      isNotNull(customers.strasse),
      isNotNull(customers.plz),
      isNotNull(customers.stadt),
      eq(customers.status, "aktiv")
    )
  );

  let geocoded = 0;
  for (const customer of customersWithoutCoords) {
    const result = await geocodeAddress(customer.strasse, customer.nr, customer.plz, customer.stadt);
    if (result) {
      await db.update(customers)
        .set({ latitude: result.latitude, longitude: result.longitude })
        .where(eq(customers.id, customer.id));
      geocoded++;
    }
  }

  log(`Batch geocoding customers: ${geocoded}/${customersWithoutCoords.length} geocoded`, "geocoding");

  const employeesWithoutCoords = await db.select({
    id: users.id,
    strasse: users.strasse,
    hausnummer: users.hausnummer,
    plz: users.plz,
    stadt: users.stadt,
  }).from(users).where(
    and(
      isNull(users.latitude),
      eq(users.isActive, true),
      isNotNull(users.strasse),
      isNotNull(users.plz),
      isNotNull(users.stadt),
    )
  );

  let empGeocoded = 0;
  for (const emp of employeesWithoutCoords) {
    const result = await geocodeAddress(emp.strasse, emp.hausnummer, emp.plz, emp.stadt);
    if (result) {
      await db.update(users)
        .set({ latitude: result.latitude, longitude: result.longitude })
        .where(eq(users.id, emp.id));
      empGeocoded++;
    }
  }

  log(`Batch geocoding employees: ${empGeocoded}/${employeesWithoutCoords.length} geocoded`, "geocoding");
}
