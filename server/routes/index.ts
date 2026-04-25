import { Router } from "express";
import appointmentsRouter from "./appointments";
import customersRouter from "./customers";
import authRouter from "./auth";
import adminRouter from "./admin";
import teamRouter from "./team";
import timeEntriesRouter from "./time-entries";
import birthdaysRouter from "./birthdays";
import birthdayCardsRouter from "./birthday-cards";
import budgetRouter from "./budget";
import tasksRouter from "./tasks";
import serviceRecordsRouter from "./service-records";
import servicesRouter from "./services";
import { searchRouter } from "./search";
import settingsRouter from "./settings";
import profileRouter from "./profile";
import companyRouter from "./company";
import billingRouter from "./billing";
import holidaysRouter from "./holidays";
import statisticsRouter from "./statistics";
import webhookRouter from "./webhook";
import notificationsRouter from "./notifications";
import whatsappRouter from "./whatsapp";
import prospectsRouter from "./prospects";
import appointmentSeriesRouter from "./appointment-series";
import { csrfProtection, csrfTokenHandler } from "../middleware/csrf";
import { authMiddleware, requireAuth } from "../middleware/auth";
import { cacheHeaders } from "../middleware/cache-headers";
import { customerManagementStorage } from "../storage/customer-management";
import { asyncHandler } from "../lib/errors";
import { requireIntParam } from "../lib/params";
import { getCachedCompanySettings } from "../services/cache";

const router = Router();

router.use("/webhook", webhookRouter);

router.get("/health", asyncHandler("Health check fehlgeschlagen", async (_req, res) => {
  const { pool } = await import("../lib/db");
  await pool.query("SELECT 1");
  res.json({ status: "ok", timestamp: new Date().toISOString() });
}));

router.get("/public/branding", asyncHandler("Branding konnte nicht geladen werden", async (_req, res) => {
  const settings = await getCachedCompanySettings();
  res.json({
    logoUrl: settings?.logoUrl ? "/api/public/logo/main" : null,
    pdfLogoUrl: settings?.pdfLogoUrl ? "/api/public/logo/pdf" : null,
    companyName: settings?.companyName || null,
  });
}));

router.get("/public/logo/:type", asyncHandler("Logo konnte nicht geladen werden", async (req, res) => {
  const settings = await getCachedCompanySettings();
  const logoPath = req.params.type === "pdf" ? settings?.pdfLogoUrl : settings?.logoUrl;
  if (!logoPath) {
    return res.status(404).json({ error: "Logo not found" });
  }
  res.setHeader("Cache-Control", "public, max-age=300");
  const { ObjectStorageService } = await import("../replit_integrations/object_storage/objectStorage");
  const objectStorageService = new ObjectStorageService();
  const objectFile = await objectStorageService.getObjectEntityFile(logoPath);
  await objectStorageService.downloadObject(objectFile, res);
}));

router.get("/public/plz/:plz", asyncHandler("PLZ-Lookup fehlgeschlagen", async (req, res) => {
  const plz = req.params.plz;
  if (!/^\d{5}$/.test(plz)) {
    return res.status(400).json({ error: "PLZ muss 5 Ziffern haben" });
  }
  try {
    const response = await fetch(`https://openplzapi.org/de/Localities?postalCode=${plz}&page=1&pageSize=5`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return res.json({ results: [] });
    }
    const data = await response.json() as Array<{ name: string; postalCode: string }>;
    const cities = [...new Set(data.map((d) => d.name))];
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.json({ results: cities });
  } catch {
    res.json({ results: [] });
  }
}));

router.use(authMiddleware);
router.use(cacheHeaders);

router.get("/csrf-token", csrfTokenHandler);

router.use("/auth", authRouter);

router.use(csrfProtection);

router.use("/admin", adminRouter);
router.use("/team", teamRouter);

router.get("/insurance-providers", requireAuth, asyncHandler("Pflegekassen konnten nicht geladen werden", async (req, res) => {
  const activeOnly = req.query.all !== "true";
  const providers = await customerManagementStorage.getInsuranceProviders(activeOnly);
  res.json(providers);
}));

router.use("/appointments", appointmentsRouter);
router.use("/customers", customersRouter);
router.use("/time-entries", timeEntriesRouter);
router.use("/birthdays", birthdaysRouter);
router.use("/birthday-cards", birthdayCardsRouter);
router.use("/budget", budgetRouter);
router.use("/tasks", tasksRouter);
router.use("/service-records", serviceRecordsRouter);
router.use("/services", servicesRouter);
router.use("/search", searchRouter);
router.use("/settings", settingsRouter);
router.use("/profile", profileRouter);
router.use("/company-settings", companyRouter);
router.use("/billing", billingRouter);
router.use("/holidays", holidaysRouter);
router.use("/statistics", statisticsRouter);
router.use("/notifications", notificationsRouter);
router.use("/whatsapp", whatsappRouter);
router.use("/prospects", prospectsRouter);
router.use("/appointment-series", appointmentSeriesRouter);

router.get("/travel-time", requireAuth, asyncHandler("Fahrtzeit konnte nicht berechnet werden", async (req, res) => {
  const fromLat = parseFloat(req.query.fromLat as string);
  const fromLng = parseFloat(req.query.fromLng as string);
  const doctorAppointmentTime = req.query.doctorAppointmentTime as string;

  if (isNaN(fromLat) || isNaN(fromLng)) {
    return res.status(400).json({ error: "Ungültige Kundenkoordinaten" });
  }
  if (!doctorAppointmentTime || !/^\d{2}:\d{2}$/.test(doctorAppointmentTime)) {
    return res.status(400).json({ error: "Ungültige Arzt-Terminzeit (HH:MM erwartet)" });
  }

  const { calculateTravelTimeFromCoords, calculateTravelTime } = await import("../services/travel-time");

  const toLat = parseFloat(req.query.toLat as string);
  const toLng = parseFloat(req.query.toLng as string);

  if (!isNaN(toLat) && !isNaN(toLng)) {
    const result = await calculateTravelTimeFromCoords({
      fromLat, fromLng, toLat, toLng, doctorAppointmentTime,
    });
    if (!result) {
      return res.status(422).json({ error: "Fahrtzeit konnte nicht berechnet werden" });
    }
    return res.json(result);
  }

  const toStrasse = req.query.toStrasse as string;
  const toNr = req.query.toNr as string | undefined;
  const toPlz = req.query.toPlz as string;
  const toStadt = req.query.toStadt as string;

  if (!toStrasse || !toPlz || !toStadt) {
    return res.status(400).json({ error: "Arzt-Adresse (Straße, PLZ, Ort) ist erforderlich" });
  }

  const result = await calculateTravelTime({
    fromLat, fromLng, toStrasse, toNr, toPlz, toStadt, doctorAppointmentTime,
  });
  if (!result) {
    return res.status(422).json({ error: "Fahrtzeit konnte nicht berechnet werden. Bitte prüfen Sie die Adressen." });
  }

  res.json(result);
}));

interface AddressSuggestion {
  displayName: string;
  strasse: string;
  hausnummer: string;
  plz: string;
  stadt: string;
  latitude: number;
  longitude: number;
}

const ADDRESS_CACHE_TTL_MS = 60_000;
const ADDRESS_CACHE_MAX_ENTRIES = 200;
const addressSearchCache = new Map<string, { expires: number; data: AddressSuggestion[] }>();

function getCachedAddressSearch(key: string): AddressSuggestion[] | null {
  const entry = addressSearchCache.get(key);
  if (!entry) return null;
  if (entry.expires <= Date.now()) {
    addressSearchCache.delete(key);
    return null;
  }
  addressSearchCache.delete(key);
  addressSearchCache.set(key, entry);
  return entry.data;
}

function setCachedAddressSearch(key: string, data: AddressSuggestion[]) {
  if (addressSearchCache.size >= ADDRESS_CACHE_MAX_ENTRIES) {
    const iterator = addressSearchCache.keys();
    for (let i = 0; i < 50; i++) {
      const next = iterator.next();
      if (next.done) break;
      addressSearchCache.delete(next.value);
    }
  }
  addressSearchCache.set(key, { expires: Date.now() + ADDRESS_CACHE_TTL_MS, data });
}

router.get("/address-search", requireAuth, asyncHandler("Adresssuche fehlgeschlagen", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (q.length < 3) {
    return res.json([]);
  }

  let biasLat: number | null = null;
  let biasLon: number | null = null;
  if (req.user && typeof req.user.latitude === "number" && typeof req.user.longitude === "number") {
    biasLat = req.user.latitude;
    biasLon = req.user.longitude;
  } else {
    if (req.user) {
      const { ensureEmployeeGeocoded } = await import("../services/geocoding");
      ensureEmployeeGeocoded(req.user);
    }
    const settings = await getCachedCompanySettings();
    if (settings && typeof settings.latitude === "number" && typeof settings.longitude === "number") {
      biasLat = settings.latitude;
      biasLon = settings.longitude;
    }
  }

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const cacheKey = `${q.toLowerCase()}|${biasLat !== null ? round2(biasLat) : ""}|${biasLon !== null ? round2(biasLon) : ""}`;
  const cached = getCachedAddressSearch(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  const { rateLimitedFetch } = await import("../services/geocoding");
  const params = new URLSearchParams({
    q,
    format: "jsonv2",
    addressdetails: "1",
    countrycodes: "de",
    limit: "8",
  });
  if (biasLat !== null && biasLon !== null) {
    const delta = 0.5;
    const left = biasLon - delta;
    const right = biasLon + delta;
    const top = biasLat + delta;
    const bottom = biasLat - delta;
    params.set("viewbox", `${left},${top},${right},${bottom}`);
  }
  const url = `https://nominatim.openstreetmap.org/search?${params}`;
  const response = await rateLimitedFetch(url);
  if (!response.ok) {
    return res.json([]);
  }

  const results = await response.json() as Array<{
    display_name: string;
    lat: string;
    lon: string;
    address: {
      road?: string;
      pedestrian?: string;
      residential?: string;
      footway?: string;
      path?: string;
      house_number?: string;
      postcode?: string;
      city?: string;
      town?: string;
      village?: string;
      municipality?: string;
    };
  }>;

  const mapped = results
    .map(r => {
      const street =
        r.address?.road
        || r.address?.pedestrian
        || r.address?.residential
        || r.address?.footway
        || r.address?.path
        || "";
      if (!street) return null;
      return {
        displayName: r.display_name,
        strasse: street,
        hausnummer: r.address.house_number || "",
        plz: r.address.postcode || "",
        stadt: r.address.city || r.address.town || r.address.village || r.address.municipality || "",
        latitude: parseFloat(r.lat),
        longitude: parseFloat(r.lon),
      };
    })
    .filter((s): s is AddressSuggestion => s !== null);

  const seen = new Set<string>();
  const deduped: AddressSuggestion[] = [];
  for (const s of mapped) {
    const key = [s.strasse, s.hausnummer, s.plz, s.stadt]
      .map(part => part.trim().toLowerCase())
      .join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(s);
  }

  let ordered = deduped;
  if (biasLat !== null && biasLon !== null) {
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const haversine = (lat: number, lon: number) => {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return Number.POSITIVE_INFINITY;
      const R = 6371;
      const dLat = toRad(lat - biasLat!);
      const dLon = toRad(lon - biasLon!);
      const a = Math.sin(dLat / 2) ** 2
        + Math.cos(toRad(biasLat!)) * Math.cos(toRad(lat)) * Math.sin(dLon / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(a));
    };
    ordered = deduped
      .map(s => ({ s, d: haversine(s.latitude, s.longitude) }))
      .sort((a, b) => a.d - b.d)
      .map(x => x.s);
  }

  const final = ordered.slice(0, 8);
  setCachedAddressSearch(cacheKey, final);
  res.json(final);
}));

router.post("/customers/:id/geocode", requireAuth, asyncHandler("Geocodierung fehlgeschlagen", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const user = req.user!;
  if (!user.isAdmin) {
    const { storage } = await import("../storage");
    const assignedIds = await storage.getAssignedCustomerIds(user.id);
    if (!assignedIds.includes(id)) {
      return res.status(403).json({ error: "Zugriff verweigert" });
    }
  }

  const { db } = await import("../lib/db");
  const { customers } = await import("@shared/schema/customers");
  const { eq } = await import("drizzle-orm");

  const [customer] = await db.select({
    id: customers.id,
    latitude: customers.latitude,
    longitude: customers.longitude,
    strasse: customers.strasse,
    nr: customers.nr,
    plz: customers.plz,
    stadt: customers.stadt,
  }).from(customers).where(eq(customers.id, id));

  if (!customer) return res.status(404).json({ error: "Kunde nicht gefunden" });

  if (customer.latitude && customer.longitude) {
    return res.json({ latitude: customer.latitude, longitude: customer.longitude });
  }

  if (!customer.strasse || !customer.plz || !customer.stadt) {
    return res.status(422).json({ error: "Kundenadresse unvollständig — Geocodierung nicht möglich" });
  }

  const { geocodeAddress } = await import("../services/geocoding");
  const result = await geocodeAddress(customer.strasse, customer.nr, customer.plz, customer.stadt);

  if (!result) {
    return res.status(422).json({ error: "Adresse konnte nicht aufgelöst werden. Bitte Kundenadresse prüfen." });
  }

  await db.update(customers)
    .set({ latitude: result.latitude, longitude: result.longitude })
    .where(eq(customers.id, id));

  res.json({ latitude: result.latitude, longitude: result.longitude });
}));

export default router;
