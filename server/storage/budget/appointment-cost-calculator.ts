import { sql } from "drizzle-orm";
import { db } from "../../lib/db";
import { serviceCatalogStorage } from "../service-catalog";

export async function calculateAppointmentCost(params: {
  customerId: number;
  hauswirtschaftMinutes: number;
  alltagsbegleitungMinutes: number;
  travelKilometers: number;
  customerKilometers: number;
  date: string;
}): Promise<{
  hauswirtschaftCents: number;
  alltagsbegleitungCents: number;
  travelCents: number;
  customerKilometersCents: number;
  totalCents: number;
}> {
  const [hwService, abService, travelKmService, customerKmService] = await Promise.all([
    serviceCatalogStorage.getServiceByCode("hauswirtschaft"),
    serviceCatalogStorage.getServiceByCode("alltagsbegleitung"),
    serviceCatalogStorage.getServiceByCode("travel_km"),
    serviceCatalogStorage.getServiceByCode("customer_km"),
  ]);

  if (!hwService && !abService && !travelKmService && !customerKmService) {
    throw new Error(`Keine Preisvereinbarung für Kunde ${params.customerId} zum Datum ${params.date} gefunden`);
  }

  const customerPrices = await db.execute(sql`
    SELECT s.code AS "serviceCode", csp.price_cents AS "priceCents"
    FROM customer_service_prices csp
    INNER JOIN services s ON s.id = csp.service_id
    WHERE csp.customer_id = ${params.customerId}
      AND csp.valid_from::date <= ${params.date}::date
      AND (csp.valid_to IS NULL OR csp.valid_to::date >= ${params.date}::date)
  `);

  const cpMap = new Map((customerPrices.rows as Array<{ serviceCode: string; priceCents: number }>).map(cp => [cp.serviceCode, cp.priceCents]));

  const hauswirtschaftRateCents = cpMap.get("hauswirtschaft")
    ?? ((hwService?.isBillable !== false) ? (hwService?.defaultPriceCents || 0) : 0);
  const alltagsbegleitungRateCents = cpMap.get("alltagsbegleitung")
    ?? ((abService?.isBillable !== false) ? (abService?.defaultPriceCents || 0) : 0);
  const travelKmRateCents = cpMap.get("travel_km")
    ?? ((travelKmService?.isBillable !== false) ? (travelKmService?.defaultPriceCents || 0) : 0);
  const customerKmRateCents = cpMap.get("customer_km")
    ?? ((customerKmService?.isBillable !== false) ? (customerKmService?.defaultPriceCents || 0) : 0);

  const hauswirtschaftCents = Math.round((params.hauswirtschaftMinutes / 60) * hauswirtschaftRateCents);
  const alltagsbegleitungCents = Math.round((params.alltagsbegleitungMinutes / 60) * alltagsbegleitungRateCents);
  const travelCents = Math.round(params.travelKilometers * travelKmRateCents);
  const customerKilometersCents = Math.round(params.customerKilometers * customerKmRateCents);

  const totalCents = hauswirtschaftCents + alltagsbegleitungCents + travelCents + customerKilometersCents;

  return {
    hauswirtschaftCents,
    alltagsbegleitungCents,
    travelCents,
    customerKilometersCents,
    totalCents,
  };
}

export async function getPlannedCostCents(customerId: number): Promise<number> {
  const rows = await db.execute(sql`
    SELECT 
      a.id AS "appointmentId",
      s.lohnart_kategorie AS "lohnartKategorie",
      aps.planned_duration_minutes AS "plannedMinutes",
      a.date AS "appointmentDate",
      a.travel_kilometers AS "travelKm",
      a.customer_kilometers AS "customerKm"
    FROM appointments a
    INNER JOIN appointment_services aps ON aps.appointment_id = a.id
    INNER JOIN services s ON s.id = aps.service_id
    WHERE a.customer_id = ${customerId}
      AND a.appointment_type = 'Kundentermin'
      AND a.status IN ('scheduled', 'in_progress', 'documenting')
      AND a.deleted_at IS NULL
  `);

  if (rows.rows.length === 0) {
    return 0;
  }

  const perAppointment = new Map<number, { date: string; hwMinutes: number; abMinutes: number; travelKm: number; customerKm: number }>();

  interface PlannedCostRow {
    appointmentId: number;
    lohnartKategorie: string;
    plannedMinutes: number | null;
    appointmentDate: string;
    travelKm: number | null;
    customerKm: number | null;
  }

  for (const row of (rows.rows as unknown) as PlannedCostRow[]) {
    const apptId = row.appointmentId;
    if (!perAppointment.has(apptId)) {
      perAppointment.set(apptId, {
        date: `${row.appointmentDate}`,
        hwMinutes: 0,
        abMinutes: 0,
        travelKm: row.travelKm || 0,
        customerKm: row.customerKm || 0,
      });
    }
    const data = perAppointment.get(apptId)!;
    const minutes = row.plannedMinutes || 0;
    if (row.lohnartKategorie === "hauswirtschaft") {
      data.hwMinutes += minutes;
    } else if (row.lohnartKategorie === "alltagsbegleitung") {
      data.abMinutes += minutes;
    }
  }

  let totalPlannedCents = 0;

  for (const [, data] of perAppointment) {
    const costs = await calculateAppointmentCost({
      customerId,
      hauswirtschaftMinutes: data.hwMinutes,
      alltagsbegleitungMinutes: data.abMinutes,
      travelKilometers: data.travelKm,
      customerKilometers: data.customerKm,
      date: data.date,
    });
    totalPlannedCents += costs.totalCents;
  }

  return totalPlannedCents;
}
