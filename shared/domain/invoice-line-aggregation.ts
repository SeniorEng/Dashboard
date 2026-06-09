/**
 * Task #1083 — Rechnung: kumulierte Positionen.
 *
 * Die Rechnungs-PDF (und das eingebettete ZUGFeRD/EN-16931-XML) listete bisher
 * JEDEN Termin einzeln, zusätzlich pro Service-Code UND pro Kilometer-Typ
 * (`travel_km`/`customer_km`) eine eigene Zeile. Bei vielen Terminen lief die
 * Rechnung dadurch auf eine zweite Seite (siehe Bundle-RE-2026-0051).
 *
 * Dieses Modul fasst die persistierten, pro-Termin geführten Line-Items
 * AUSSCHLIESSLICH auf der Render-/XML-Ebene zu kumulierten Positionen zusammen:
 *   - eine Zeile je Service-Typ (gleicher `serviceCode` + gleicher Stückpreis),
 *   - EINE gemeinsame „Fahrtkosten"-Zeile je Stückpreis (mergt `travel_km` +
 *     `customer_km`),
 *   - „Vergebliche Anfahrt" (`no_show_charge`) bleibt absichtlich pro Termin
 *     stehen, da das Datum Teil der Leistungsbeschreibung ist.
 *
 * Wichtig (GoBD / Σ-Invariante): die Summe der `totalCents` bleibt bit-genau
 * erhalten (= `invoice.netAmountCents`), damit die ZUGFeRD-Reconciliation
 * (LineTotalSum == Nettobetrag) und BR-CO-10/13 weiterhin halten. Die
 * persistierten `invoice_line_items` selbst werden NICHT verändert — sie führen
 * weiter `appointmentId` (Doppelabrechnungs-Guard, Pot-Split) und sind die
 * Quelle für den pro-Termin-Leistungsnachweis.
 *
 * Reine Funktion ohne Seiteneffekte — die Anzeige↔Buchung-Konsistenz ist hier
 * zentralisiert, damit PDF-Renderer und ZUGFeRD-Mapper exakt dieselben
 * kumulierten Positionen sehen.
 */
import { isKmLineItem, quantizeKm } from "./invoice-line-items";

/**
 * Strukturelle Form eines Rechnungs-Line-Items, wie es der PDF-Renderer
 * (`InvoicePdfData["lineItems"][number]`) und der ZUGFeRD-Mapper konsumieren.
 * Bewusst lokal definiert, damit `shared/domain` nicht von `server/lib`
 * abhängt; die Felder spiegeln 1:1 die Renderer-Form.
 */
export interface AggregatableInvoiceLine {
  appointmentId: number | null;
  appointmentDate: string;
  startTime: string | null;
  endTime: string | null;
  serviceDescription: string;
  serviceCode: string | null;
  durationMinutes: number;
  quantityRaw?: number | null;
  quantityUnit?: "hours" | "km" | string | null;
  unitPriceCents: number;
  totalCents: number;
  employeeName: string | null;
  appointmentNotes: string | null;
  serviceDetails: string | null;
}

/** Anzeige-Label der zusammengefassten Kilometer-Zeile. */
export const FAHRTKOSTEN_LABEL = "Fahrtkosten";
/**
 * Service-Code der zusammengefassten Fahrtkosten-Zeile. Bewusst ein
 * anerkannter km-Code (`travel_km`), damit `isKmLineItem` weiterhin greift und
 * der ZUGFeRD-Mapper die Einheit `KMT` (statt `HUR`) setzt.
 */
const FAHRTKOSTEN_SERVICE_CODE = "travel_km";
/** Pro-Termin-Position, die NICHT kumuliert wird (Datum steht in der Beschreibung). */
const NO_SHOW_SERVICE_CODE = "no_show_charge";

interface LineGroup {
  serviceDescription: string;
  serviceCode: string | null;
  quantityUnit: "hours" | "km";
  unitPriceCents: number;
  quantitySum: number;
  totalCents: number;
}

function quantityOf(item: AggregatableInvoiceLine, unit: "hours" | "km"): number {
  if (unit === "km") {
    return item.quantityRaw != null ? item.quantityRaw : (item.durationMinutes ?? 0);
  }
  return item.quantityRaw != null ? item.quantityRaw : (item.durationMinutes ?? 0) / 60;
}

function groupToLine(g: LineGroup): AggregatableInvoiceLine {
  const quantityRaw = g.quantityUnit === "km" ? quantizeKm(g.quantitySum) : g.quantitySum;
  return {
    appointmentId: null,
    appointmentDate: "",
    startTime: null,
    endTime: null,
    serviceDescription: g.serviceDescription,
    serviceCode: g.serviceCode,
    durationMinutes: g.quantityUnit === "km" ? Math.round(quantityRaw) : Math.round(quantityRaw * 60),
    quantityRaw,
    quantityUnit: g.quantityUnit,
    unitPriceCents: g.unitPriceCents,
    totalCents: g.totalCents,
    employeeName: null,
    appointmentNotes: null,
    serviceDetails: null,
  };
}

/**
 * Fasst pro-Termin-Line-Items zu kumulierten Rechnungspositionen zusammen.
 *
 * Reihenfolge (deterministisch, byte-stabil): Service-Gruppen in Reihenfolge
 * ihres ersten Auftretens, danach die Fahrtkosten-Gruppen, danach die nicht
 * kumulierten `no_show_charge`-Zeilen in Originalreihenfolge.
 */
export function aggregateInvoiceLineItems<T extends AggregatableInvoiceLine>(
  items: readonly T[],
): AggregatableInvoiceLine[] {
  const serviceGroups = new Map<string, LineGroup>();
  const serviceOrder: string[] = [];
  const kmGroups = new Map<string, LineGroup>();
  const kmOrder: string[] = [];
  const passthrough: AggregatableInvoiceLine[] = [];

  for (const item of items) {
    if (item.serviceCode === NO_SHOW_SERVICE_CODE) {
      passthrough.push({ ...item });
      continue;
    }

    if (isKmLineItem(item.serviceCode)) {
      const key = String(item.unitPriceCents);
      let g = kmGroups.get(key);
      if (!g) {
        g = {
          serviceDescription: FAHRTKOSTEN_LABEL,
          serviceCode: FAHRTKOSTEN_SERVICE_CODE,
          quantityUnit: "km",
          unitPriceCents: item.unitPriceCents,
          quantitySum: 0,
          totalCents: 0,
        };
        kmGroups.set(key, g);
        kmOrder.push(key);
      }
      g.quantitySum += quantityOf(item, "km");
      g.totalCents += item.totalCents;
      continue;
    }

    const unit: "hours" | "km" = item.quantityUnit === "km" ? "km" : "hours";
    const key = `${item.serviceCode ?? item.serviceDescription}|${item.unitPriceCents}|${unit}`;
    let g = serviceGroups.get(key);
    if (!g) {
      g = {
        serviceDescription: item.serviceDescription,
        serviceCode: item.serviceCode,
        quantityUnit: unit,
        unitPriceCents: item.unitPriceCents,
        quantitySum: 0,
        totalCents: 0,
      };
      serviceGroups.set(key, g);
      serviceOrder.push(key);
    }
    g.quantitySum += quantityOf(item, unit);
    g.totalCents += item.totalCents;
  }

  const out: AggregatableInvoiceLine[] = [];
  for (const key of serviceOrder) out.push(groupToLine(serviceGroups.get(key)!));
  for (const key of kmOrder) out.push(groupToLine(kmGroups.get(key)!));
  out.push(...passthrough);
  return out;
}
