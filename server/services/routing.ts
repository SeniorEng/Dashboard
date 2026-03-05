const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";

interface RouteResult {
  distanceKm: number;
  durationMinutes: number;
}

export async function calculateRoute(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number
): Promise<RouteResult | null> {
  try {
    const url = `${OSRM_BASE}/${fromLng},${fromLat};${toLng},${toLat}?overview=false`;
    const response = await fetch(url, {
      headers: { "User-Agent": "CareConnect/1.0" },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return null;

    const data = await response.json() as {
      code: string;
      routes: Array<{ distance: number; duration: number }>;
    };

    if (data.code !== "Ok" || !data.routes || data.routes.length === 0) return null;

    const route = data.routes[0];
    return {
      distanceKm: Math.round(route.distance / 100) / 10,
      durationMinutes: Math.round(route.duration / 60),
    };
  } catch (error) {
    console.error("[routing] OSRM error:", error);
    return null;
  }
}
