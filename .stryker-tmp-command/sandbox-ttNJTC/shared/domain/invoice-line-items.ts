/**
 * Task #561 — Kilometer-Line-Items: konsistente Quantisierung.
 *
 * Hintergrund: Anfahrts-/Customer-Kilometer kommen als Dezimal-Float aus dem
 * Routing-/GPS-System (z.B. 2,714 km). Vor diesem Modul wurden Anzeige und
 * Berechnung unabhängig gerundet — Folge: Menge × Satz ≠ Summe auf dem PDF,
 * was eine Pflegekasse/GoBD-Prüfung berechtigt zurückweisen würde
 * (siehe Rechnung RE-2026-0003 — Analyse in der Task-Beschreibung).
 *
 * Konvention: GoBD-konform wird die Strecke auf zwei Nachkommastellen
 * kaufmännisch gerundet und genau dieser Wert sowohl ANGEZEIGT als auch
 * BERECHNET. So gilt für jede km-Line garantiert
 *   Math.round(roundedQuantity * unitPriceCents) === totalCents.
 *
 * Wer immer das Rechnungs-PDF oder den Leistungsnachweis berührt, ruft die
 * Helper hier — keine eigene Rundung im Routes-Code oder im Template.
 */
// @ts-nocheck
function stryNS_9fa48() {
  var g = typeof globalThis === 'object' && globalThis && globalThis.Math === Math && globalThis || new Function("return this")();
  var ns = g.__stryker__ || (g.__stryker__ = {});
  if (ns.activeMutant === undefined && g.process && g.process.env && g.process.env.__STRYKER_ACTIVE_MUTANT__) {
    ns.activeMutant = g.process.env.__STRYKER_ACTIVE_MUTANT__;
  }
  function retrieveNS() {
    return ns;
  }
  stryNS_9fa48 = retrieveNS;
  return retrieveNS();
}
stryNS_9fa48();
function stryCov_9fa48() {
  var ns = stryNS_9fa48();
  var cov = ns.mutantCoverage || (ns.mutantCoverage = {
    static: {},
    perTest: {}
  });
  function cover() {
    var c = cov.static;
    if (ns.currentTestId) {
      c = cov.perTest[ns.currentTestId] = cov.perTest[ns.currentTestId] || {};
    }
    var a = arguments;
    for (var i = 0; i < a.length; i++) {
      c[a[i]] = (c[a[i]] || 0) + 1;
    }
  }
  stryCov_9fa48 = cover;
  cover.apply(null, arguments);
}
function stryMutAct_9fa48(id) {
  var ns = stryNS_9fa48();
  function isActive(id) {
    if (ns.activeMutant === id) {
      if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) {
        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');
      }
      return true;
    }
    return false;
  }
  stryMutAct_9fa48 = isActive;
  return isActive(id);
}
const KM_DECIMALS = 2;

/**
 * Kaufmännische Rundung auf zwei Nachkommastellen. Negative km werden
 * absichtlich beibehalten (z.B. Stornorechnung mit negativem Total — die
 * Strecke bleibt positiv, das Vorzeichen liegt im totalCents).
 */
export function quantizeKm(km: number): number {
  if (stryMutAct_9fa48("92")) {
    {}
  } else {
    stryCov_9fa48("92");
    if (stryMutAct_9fa48("95") ? false : stryMutAct_9fa48("94") ? true : stryMutAct_9fa48("93") ? Number.isFinite(km) : (stryCov_9fa48("93", "94", "95"), !Number.isFinite(km))) return 0;
    const factor = 10 ** KM_DECIMALS;
    return stryMutAct_9fa48("96") ? Math.round(km * factor) * factor : (stryCov_9fa48("96"), Math.round(stryMutAct_9fa48("97") ? km / factor : (stryCov_9fa48("97"), km * factor)) / factor);
  }
}

/**
 * Liefert den auf Cent gerundeten Gesamtbetrag einer km-Line bei Satz
 * `unitPriceCents` pro Kilometer. Verwendet denselben quantisierten Wert,
 * der auch via `formatKmQuantityDisplay` angezeigt wird.
 */
export function computeKmLineTotalCents(km: number, unitPriceCents: number): number {
  if (stryMutAct_9fa48("98")) {
    {}
  } else {
    stryCov_9fa48("98");
    const q = quantizeKm(km);
    return Math.round(stryMutAct_9fa48("99") ? q / unitPriceCents : (stryCov_9fa48("99"), q * unitPriceCents));
  }
}

/**
 * Deutsche Anzeige einer km-Strecke mit zwei Nachkommastellen und
 * Komma-Trenner — z.B. `2,71 km`.
 */
export function formatKmQuantityDisplay(km: number): string {
  if (stryMutAct_9fa48("100")) {
    {}
  } else {
    stryCov_9fa48("100");
    const q = quantizeKm(km);
    return stryMutAct_9fa48("101") ? `` : (stryCov_9fa48("101"), `${q.toFixed(KM_DECIMALS).replace(stryMutAct_9fa48("102") ? "" : (stryCov_9fa48("102"), "."), stryMutAct_9fa48("103") ? "" : (stryCov_9fa48("103"), ","))} km`);
  }
}

/**
 * Deutsche Anzeige einer Stundenleistung (Minuten in `h`/`Min.`).
 * Konsistent zum bestehenden Verhalten von `formatMinutes` im PDF-Template
 * — hier gespiegelt, damit der Template-Code keine eigene Formatierungslogik
 * mehr braucht und Drift unmöglich wird.
 */
export function formatHoursQuantityDisplay(minutes: number): string {
  if (stryMutAct_9fa48("104")) {
    {}
  } else {
    stryCov_9fa48("104");
    const m = stryMutAct_9fa48("105") ? Math.min(0, Math.round(minutes)) : (stryCov_9fa48("105"), Math.max(0, Math.round(minutes)));
    const h = Math.floor(stryMutAct_9fa48("106") ? m * 60 : (stryCov_9fa48("106"), m / 60));
    const rem = stryMutAct_9fa48("107") ? m * 60 : (stryCov_9fa48("107"), m % 60);
    if (stryMutAct_9fa48("110") ? h !== 0 : stryMutAct_9fa48("109") ? false : stryMutAct_9fa48("108") ? true : (stryCov_9fa48("108", "109", "110"), h === 0)) return stryMutAct_9fa48("111") ? `` : (stryCov_9fa48("111"), `${rem} Min.`);
    if (stryMutAct_9fa48("114") ? rem !== 0 : stryMutAct_9fa48("113") ? false : stryMutAct_9fa48("112") ? true : (stryCov_9fa48("112", "113", "114"), rem === 0)) return stryMutAct_9fa48("115") ? `` : (stryCov_9fa48("115"), `${h} Std.`);
    return stryMutAct_9fa48("116") ? `` : (stryCov_9fa48("116"), `${h} Std. ${rem} Min.`);
  }
}
export type LineItemQuantityUnit = "hours" | "km";

/**
 * Service-Codes, die als Kilometer-Strecke abgerechnet werden. Zentralisiert,
 * damit Routes/PDF/ZUGFeRD denselben Filter teilen.
 */
export const KM_SERVICE_CODES = new Set<string>(stryMutAct_9fa48("117") ? [] : (stryCov_9fa48("117"), [stryMutAct_9fa48("118") ? "" : (stryCov_9fa48("118"), "travel_km"), stryMutAct_9fa48("119") ? "" : (stryCov_9fa48("119"), "customer_km")]));
export function isKmLineItem(serviceCode: string | null | undefined): boolean {
  if (stryMutAct_9fa48("120")) {
    {}
  } else {
    stryCov_9fa48("120");
    return stryMutAct_9fa48("123") ? !!serviceCode || KM_SERVICE_CODES.has(serviceCode) : stryMutAct_9fa48("122") ? false : stryMutAct_9fa48("121") ? true : (stryCov_9fa48("121", "122", "123"), (stryMutAct_9fa48("124") ? !serviceCode : (stryCov_9fa48("124"), !(stryMutAct_9fa48("125") ? serviceCode : (stryCov_9fa48("125"), !serviceCode)))) && KM_SERVICE_CODES.has(serviceCode));
  }
}

/**
 * Rohwert der Menge für ein Line-Item — Stunden (Dezimal) oder Kilometer
 * (zwei Nachkommastellen). Wird in das neue `quantity_raw`-Feld persistiert
 * und ist die einzige Quelle für PDF-Anzeige und ZUGFeRD-Quantity.
 *
 * - Für Stunden: `durationMinutes / 60` (kann viele Nachkommastellen haben).
 * - Für Kilometer: `quantizeKm(km)`.
 */
export function deriveQuantityRaw(unit: LineItemQuantityUnit, args: {
  durationMinutes?: number | null;
  km?: number | null;
}): number {
  if (stryMutAct_9fa48("126")) {
    {}
  } else {
    stryCov_9fa48("126");
    if (stryMutAct_9fa48("129") ? unit !== "km" : stryMutAct_9fa48("128") ? false : stryMutAct_9fa48("127") ? true : (stryCov_9fa48("127", "128", "129"), unit === (stryMutAct_9fa48("130") ? "" : (stryCov_9fa48("130"), "km")))) {
      if (stryMutAct_9fa48("131")) {
        {}
      } else {
        stryCov_9fa48("131");
        return quantizeKm(stryMutAct_9fa48("132") ? args.km && 0 : (stryCov_9fa48("132"), args.km ?? 0));
      }
    }
    const minutes = stryMutAct_9fa48("133") ? args.durationMinutes && 0 : (stryCov_9fa48("133"), args.durationMinutes ?? 0);
    return stryMutAct_9fa48("134") ? minutes * 60 : (stryCov_9fa48("134"), minutes / 60);
  }
}

/**
 * Anzeige-Helper für ein persistiertes Line-Item. Bevorzugt die neuen
 * Felder `quantityRaw`/`quantityUnit` (Task #561). Fällt auf
 * `durationMinutes` + `serviceCode` zurück, damit bestehende
 * Rechnungs-PDFs (vor Migration) unverändert rendern — die historische
 * Drift bleibt für sie sichtbar (GoBD-Immutabilität).
 */
export function renderLineItemQuantity(item: {
  serviceCode: string | null;
  durationMinutes: number;
  quantityRaw?: number | null;
  quantityUnit?: LineItemQuantityUnit | string | null;
}): string {
  if (stryMutAct_9fa48("135")) {
    {}
  } else {
    stryCov_9fa48("135");
    const unit = stryMutAct_9fa48("136") ? item.quantityUnit as LineItemQuantityUnit | null | undefined && (isKmLineItem(item.serviceCode) ? "km" : "hours") : (stryCov_9fa48("136"), item.quantityUnit as LineItemQuantityUnit | null | undefined ?? (isKmLineItem(item.serviceCode) ? stryMutAct_9fa48("137") ? "" : (stryCov_9fa48("137"), "km") : stryMutAct_9fa48("138") ? "" : (stryCov_9fa48("138"), "hours")));
    if (stryMutAct_9fa48("141") ? unit !== "km" : stryMutAct_9fa48("140") ? false : stryMutAct_9fa48("139") ? true : (stryCov_9fa48("139", "140", "141"), unit === (stryMutAct_9fa48("142") ? "" : (stryCov_9fa48("142"), "km")))) {
      if (stryMutAct_9fa48("143")) {
        {}
      } else {
        stryCov_9fa48("143");
        const km = stryMutAct_9fa48("144") ? item.quantityRaw && item.durationMinutes : (stryCov_9fa48("144"), item.quantityRaw ?? item.durationMinutes);
        return formatKmQuantityDisplay(km);
      }
    }
    // Stunden — historisch wurde der Wert in Minuten transportiert.
    const minutes = (stryMutAct_9fa48("147") ? item.quantityRaw == null : stryMutAct_9fa48("146") ? false : stryMutAct_9fa48("145") ? true : (stryCov_9fa48("145", "146", "147"), item.quantityRaw != null)) ? Math.round(stryMutAct_9fa48("148") ? item.quantityRaw / 60 : (stryCov_9fa48("148"), item.quantityRaw * 60)) : item.durationMinutes;
    return formatHoursQuantityDisplay(minutes);
  }
}