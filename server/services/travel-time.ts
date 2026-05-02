import { geocodeAddress, rateLimitedFetch } from "./geocoding";
import { log } from "../lib/log";

const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";

interface TravelTimeResult {
  distanceKm: number;
  durationMinutes: number;
  bufferMinutes: number;
  pickupTime: string;
}

interface OsrmResponse {
  code: string;
  routes: Array<{
    distance: number;
    duration: number;
  }>;
}

function calculateBuffer(durationMinutes: number, pickupHour: number): number {
  let buffer = 10;

  if ((pickupHour >= 7 && pickupHour < 9) || (pickupHour >= 16 && pickupHour < 18)) {
    buffer += 10;
  }

  if (durationMinutes > 30) {
    buffer += Math.ceil(durationMinutes * 0.15);
  }

  return Math.max(buffer, 10);
}

function calculatePickupTime(
  doctorAppointmentTime: string,
  durationMinutes: number,
  bufferMinutes: number
): string {
  const [hours, minutes] = doctorAppointmentTime.split(":").map(Number);
  const doctorMinutes = hours * 60 + minutes;
  let pickupMinutes = doctorMinutes - durationMinutes - bufferMinutes;

  if (pickupMinutes < 0) pickupMinutes += 24 * 60;

  const h = Math.floor(pickupMinutes / 60) % 24;
  const m = pickupMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

async function getOsrmRoute(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number
): Promise<{ distanceKm: number; durationMinutes: number } | null> {
  try {
    const url = `${OSRM_BASE}/${fromLng},${fromLat};${toLng},${toLat}?overview=false`;
    const response = await fetch(url, {
      headers: { "User-Agent": "CareConnect/1.0" },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as OsrmResponse;
    if (data.code !== "Ok" || !data.routes || data.routes.length === 0) return null;

    const route = data.routes[0];
    return {
      distanceKm: Math.round((route.distance / 1000) * 10) / 10,
      durationMinutes: Math.ceil(route.duration / 60),
    };
  } catch (error) {
    log(`OSRM routing error: ${error}`, "travel-time");
    return null;
  }
}

export async function calculateTravelTime(params: {
  fromLat: number;
  fromLng: number;
  toStrasse: string;
  toNr?: string;
  toPlz: string;
  toStadt: string;
  doctorAppointmentTime: string;
}): Promise<TravelTimeResult | null> {
  const geocoded = await geocodeAddress(params.toStrasse, params.toNr || null, params.toPlz, params.toStadt);
  if (!geocoded) return null;

  const route = await getOsrmRoute(
    params.fromLat,
    params.fromLng,
    geocoded.latitude,
    geocoded.longitude
  );
  if (!route) return null;

  const pickupTimeEstimate = calculatePickupTime(
    params.doctorAppointmentTime,
    route.durationMinutes,
    0
  );
  const pickupHour = parseInt(pickupTimeEstimate.split(":")[0]);
  const buffer = calculateBuffer(route.durationMinutes, pickupHour);
  const pickupTime = calculatePickupTime(
    params.doctorAppointmentTime,
    route.durationMinutes,
    buffer
  );

  return {
    distanceKm: route.distanceKm,
    durationMinutes: route.durationMinutes,
    bufferMinutes: buffer,
    pickupTime,
  };
}

export async function calculateTravelTimeFromCoords(params: {
  fromLat: number;
  fromLng: number;
  toLat: number;
  toLng: number;
  doctorAppointmentTime: string;
}): Promise<TravelTimeResult | null> {
  const route = await getOsrmRoute(
    params.fromLat,
    params.fromLng,
    params.toLat,
    params.toLng
  );
  if (!route) return null;

  const pickupTimeEstimate = calculatePickupTime(
    params.doctorAppointmentTime,
    route.durationMinutes,
    0
  );
  const pickupHour = parseInt(pickupTimeEstimate.split(":")[0]);
  const buffer = calculateBuffer(route.durationMinutes, pickupHour);
  const pickupTime = calculatePickupTime(
    params.doctorAppointmentTime,
    route.durationMinutes,
    buffer
  );

  return {
    distanceKm: route.distanceKm,
    durationMinutes: route.durationMinutes,
    bufferMinutes: buffer,
    pickupTime,
  };
}
