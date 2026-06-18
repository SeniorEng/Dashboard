import {
  budgetAllocations,
  budgetTransactions,
  customerBudgetTypeSettings,
  customers,
  type CustomerBudgetPreferences,
  type CustomerBudgetTypeSetting,
} from "@shared/schema";
import { eq, and, sql, lte, gte, isNull, or, asc, inArray } from "drizzle-orm";
import { todayISO, parseLocalDate, lastDayOfMonth } from "@shared/utils/datetime";
import { clampToStatutoryMax, effectiveDefaultPots } from "@shared/domain/budgets";
import { db } from "../../lib/db";
import { customersRepo } from "../../repos";
import type { DbClient, BudgetSummary, Budget45aSummary, Budget39_42aSummary, AllBudgetSummaries } from "./types";
import type { AppointmentBudgetFit } from "@shared/types";
import { getBudgetPreferences, readBudgetTypeSettings } from "./preferences-storage";
import { getCustomerBudgetAmounts, syncCarryoverAndExpiry, calculateAllocatedCents, pickEffective45bSettingRow, getExcluded45bConsumption } from "./allocation-storage";
import { getPlannedCostCents, getPlannedCostByAppointment } from "./appointment-cost-calculator";
import { computeCapSlot } from "./cap-calculator";
import { readUnifiedBudgetAvailability, type PotAvailability, type UnifiedBudgetAvailability } from "./unified-reader";
import { budgetAllocationsRepo } from "../../repos";

// Hinweis (Task #603): §45b bleibt ein Jahrestopf — KEIN harter Monats-Cap.
// `monthlyLimitCents` im Summary spiegelt den per-Kunde konfigurierbaren
// "Unser Anteil"-Wert (€/Monat) wider, der die monatliche Aufstockung
// reduziert. Ist kein Wert konfiguriert, liefert das Summary `null` (entspricht
// dem gesetzlichen Default 131 €/Monat).

export async function getTotalCarryoverCents(customerId: number, asOfDate: string, _tx?: DbClient): Promise<number> {
  const d = _tx ?? db;
  const carryoverAllocations = await budgetAllocationsRepo.selectColumnsFrom({
    total: sql<number>`COALESCE(SUM(${budgetAllocations.amountCents}), 0)`,
  }, d)
    .where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
      eq(budgetAllocations.source, "carryover"),
      isNull(budgetAllocations.deletedAt),
      lte(budgetAllocations.validFrom, asOfDate),
      or(
        isNull(budgetAllocations.expiresAt),
        gte(budgetAllocations.expiresAt, asOfDate)
      )
    ));

  return Number(carryoverAllocations[0]?.total ?? 0);
}

async function getAvailableCarryoverCents(customerId: number, asOfDate: string, _tx?: DbClient): Promise<number> {
  const d = _tx ?? db;
  const carryoverAllocations = await budgetAllocationsRepo.selectFrom(d)
    .where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
      eq(budgetAllocations.source, "carryover"),
      isNull(budgetAllocations.deletedAt),
      lte(budgetAllocations.validFrom, asOfDate),
      or(
        isNull(budgetAllocations.expiresAt),
        gte(budgetAllocations.expiresAt, asOfDate)
      )
    ));

  if (carryoverAllocations.length === 0) return 0;

  const allocationIds = carryoverAllocations.map(a => a.id);
  const consumed = await d.select({
    allocationId: budgetTransactions.allocationId,
    total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
  })
    .from(budgetTransactions)
    .where(and(
      inArray(budgetTransactions.allocationId, allocationIds),
      sql`${budgetTransactions.transactionType} IN ('consumption', 'write_off')`
    ))
    .groupBy(budgetTransactions.allocationId);

  const reversed = await d.select({
    allocationId: budgetTransactions.allocationId,
    total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
  })
    .from(budgetTransactions)
    .where(and(
      inArray(budgetTransactions.allocationId, allocationIds),
      eq(budgetTransactions.transactionType, "reversal")
    ))
    .groupBy(budgetTransactions.allocationId);

  const consumedMap = new Map(consumed.map(c => [c.allocationId, Number(c.total)]));
  const reversalMap = new Map(reversed.map(r => [r.allocationId, Number(r.total)]));

  let totalAvailable = 0;
  for (const alloc of carryoverAllocations) {
    const used = consumedMap.get(alloc.id) ?? 0;
    const rev = reversalMap.get(alloc.id) ?? 0;
    totalAvailable += Math.max(0, alloc.amountCents - Math.max(0, used - rev));
  }

  return totalAvailable;
}

export async function getBudgetSummary(customerId: number, _preferences?: CustomerBudgetPreferences | undefined, _typeSettings?: CustomerBudgetTypeSetting[], asOfDate: string = todayISO()): Promise<BudgetSummary> {
  const [preferences, typeSettings, customerRows] = await Promise.all([
    _preferences !== undefined ? _preferences : getBudgetPreferences(customerId),
    _typeSettings ?? readBudgetTypeSettings(customerId, { kind: "forDate", asOfDate }),
    customersRepo.selectColumnsFrom({ billingType: customers.billingType }, db).where(eq(customers.id, customerId)),
  ]);
  const billingType = customerRows[0]?.billingType;

  // Task #911 — Stichtag respektieren: alle Monats-/Jahres-/Fenster-Ableitungen
  // hängen an `today`, das jetzt der übergebene Stichtag ist (Default = heute,
  // damit Bestandscaller/Tests unverändert bleiben).
  const today = asOfDate;
  const todayDate = parseLocalDate(today);
  const currentYear = todayDate.getFullYear();
  const currentMonth = todayDate.getMonth() + 1;
  const currentMonthStart = `${currentYear}-${String(currentMonth).padStart(2, '0')}-01`;

  const allocValidWhere = and(
    eq(budgetAllocations.customerId, customerId),
    eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
    lte(budgetAllocations.validFrom, today),
    isNull(budgetAllocations.deletedAt),
    or(isNull(budgetAllocations.expiresAt), gte(budgetAllocations.expiresAt, today))
  );

  const [totalAllocatedCents, currentYearAllocatedCents, txResult, carryoverResult, currentMonthResult, currentMonthReversalResult] = await Promise.all([
    calculateAllocatedCents(customerId, "entlastungsbetrag_45b", { asOfDate: today }, undefined, preferences, typeSettings),

    calculateAllocatedCents(customerId, "entlastungsbetrag_45b", { year: currentYear, asOfDate: today }, undefined, preferences, typeSettings),

    // Task #911 — Stichtag-Korrektheit: `totalUsedCents` (Allocation-Sicht)
    // darf nur Buchungen BIS zum Stichtag summieren, sonst flössen bei einer
    // Vergangenheits-Abfrage spätere Buchungen mit ein.
    db.select({
      transactionType: budgetTransactions.transactionType,
      absTotal: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
      rawTotal: sql<number>`COALESCE(SUM(${budgetTransactions.amountCents}), 0)`,
    }).from(budgetTransactions).where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
      lte(budgetTransactions.transactionDate, today)
    )).groupBy(budgetTransactions.transactionType),

    budgetAllocationsRepo.selectColumnsFrom({
      total: sql<number>`COALESCE(SUM(${budgetAllocations.amountCents}), 0)`,
      expiresAt: sql<string | null>`MIN(${budgetAllocations.expiresAt})`,
    }, db).where(and(
      allocValidWhere,
      eq(budgetAllocations.source, "carryover"),
      sql`${budgetAllocations.expiresAt} IS NOT NULL`
    )),

    db.select({
      total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
    }).from(budgetTransactions).where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
      eq(budgetTransactions.transactionType, "consumption"),
      gte(budgetTransactions.transactionDate, currentMonthStart),
      lte(budgetTransactions.transactionDate, today)
    )),

    db.select({
      total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
    }).from(budgetTransactions).where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
      eq(budgetTransactions.transactionType, "reversal"),
      gte(budgetTransactions.transactionDate, currentMonthStart),
      lte(budgetTransactions.transactionDate, today)
    )),
  ]);

  const txMap = new Map<string, { absTotal: number; rawTotal: number }>();
  for (const row of txResult) {
    txMap.set(row.transactionType, { absTotal: Number(row.absTotal), rawTotal: Number(row.rawTotal) });
  }
  const consumptionCents = txMap.get("consumption")?.absTotal ?? 0;
  const writeOffCents = txMap.get("write_off")?.absTotal ?? 0;
  const manualAdjustmentCents = txMap.get("manual_adjustment")?.absTotal ?? 0;
  const reversalsCents = txMap.get("reversal")?.rawTotal ?? 0;
  const netUsedCents = consumptionCents + writeOffCents + manualAdjustmentCents - reversalsCents;

  const carryoverCents = Number(carryoverResult[0]?.total ?? 0);
  const carryoverExpiresAt = carryoverCents > 0 ? (carryoverResult[0]?.expiresAt ?? null) : null;
  const currentMonthConsumption = Number(currentMonthResult[0]?.total ?? 0);
  const currentMonthReversals = Number(currentMonthReversalResult[0]?.total ?? 0);
  const currentMonthUsedCents = Math.max(0, currentMonthConsumption - currentMonthReversals);

  const availableCents = totalAllocatedCents - netUsedCents;
  const currentMonthPrefix = today.slice(0, 7);
  const [plannedByAppt, currentMonthPlannedCents] = await Promise.all([
    getPlannedCostByAppointment(customerId),
    getPlannedCostCents(customerId, { monthPrefix: currentMonthPrefix }),
  ]);
  const plannedCents = plannedByAppt.reduce((sum, p) => sum + p.costCents, 0);

  // Task #704 — Zeitliche §45b-Projektion: zukünftige Monatsaufstockungen UND
  // ablaufende Carryovers (30.06.) müssen in „Verfügbar (nach Planung)"
  // einfließen, sonst werden langlaufende Serien (Catrin-Barz-Bug) fälschlich
  // als „Budget reicht nicht" angezeigt. Wir gruppieren geplante Kosten nach
  // Termin-Monat und prüfen für jedes Monatsende, ob die bis dahin
  // aufgelaufene Allokation (`calculateAllocated45b` mit
  // `projectFuture=true`) die kumulierten Buchungen deckt.
  const futureCostsByMonth = new Map<string, number>();
  const todayMonthPrefix = today.slice(0, 7);
  let futurePlannedTotal = 0;
  for (const p of plannedByAppt) {
    // Termine im laufenden oder zukünftigen Monat fließen in die Projektion ein.
    // Vergangene Termine sind bereits in `netUsedCents` enthalten (consumption)
    // bzw. werden über `expired_unsigned` aus der Planung herausfallen.
    if (p.date.slice(0, 7) < todayMonthPrefix) continue;
    const ym = p.date.slice(0, 7);
    futureCostsByMonth.set(ym, (futureCostsByMonth.get(ym) ?? 0) + p.costCents);
    futurePlannedTotal += p.costCents;
  }
  const sortedMonths = [...futureCostsByMonth.keys()].sort();

  let worstShortfallCents = 0;
  let plannedShortfallMonth: string | null = null;
  let allocAtHorizon = totalAllocatedCents;
  // Task #1340 — Verbrauch, der gegen einen zum projizierten Monatsende NICHT
  // mehr gezählten Übertrag / verdrängte `initial_balance` gebucht wurde, am
  // Horizont (für `projectedAvailable`). Default 0 (keine Exklusion / kein
  // Forecast).
  let excludedAtHorizon = 0;
  if (sortedMonths.length > 0) {
    let cumulativeUsed = netUsedCents;
    for (const ym of sortedMonths) {
      const [y, m] = ym.split("-").map(Number);
      const monthEnd = `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
      const allocAtEnd = await calculateAllocatedCents(
        customerId,
        "entlastungsbetrag_45b",
        { asOfDate: monthEnd, projectFuture: true },
        undefined,
        preferences,
        typeSettings,
      );
      // Task #1340 — Carryover-Verfalls-Symmetrie. `allocAtEnd` lässt für Monate
      // nach dem 30.06. den Übertrag wegfallen; der gegen GENAU diesen Übertrag
      // (bzw. per IB-Supersession verdrängte `initial_balance`) gebuchte
      // Verbrauch muss dann ebenfalls aus `cumulativeUsed` herausfallen — sonst
      // belastet er den laufenden Topf doppelt (künstlicher Fehlbetrag). Quelle
      // ist dieselbe SSoT (`getExcluded45bConsumption` → `calculateAllocated45b`)
      // wie in `unified-reader`/`consumption-engine`, MIT `projectFuture: true`,
      // damit Allocation- und Exklusions-Fenster identisch sind. Solange der
      // Übertrag noch gültig ist (z.B. im Juni), bleibt die Exklusion leer →
      // keine Über-Korrektur an der Juni-Seite des Boundary.
      const { excludedConsumedNetCents } = await getExcluded45bConsumption(
        customerId,
        monthEnd,
        db,
        typeSettings,
        { projectFuture: true },
      );
      cumulativeUsed += futureCostsByMonth.get(ym)!;
      const remaining = allocAtEnd - (cumulativeUsed - excludedConsumedNetCents);
      if (remaining < 0 && -remaining > worstShortfallCents) {
        worstShortfallCents = -remaining;
        if (plannedShortfallMonth === null) plannedShortfallMonth = ym;
      }
      allocAtHorizon = allocAtEnd;
      excludedAtHorizon = excludedConsumedNetCents;
    }
  }

  const s45b = typeSettings.find(s => s.budgetType === "entlastungsbetrag_45b" && s.enabled);
  // BUG-19 (Facette A): fehlende §45b-Zeile = Default-Aktivierung → aus der SSoT
  // `effectiveDefaultPots(customer)`, die den Selbstzahler-Anspruchs-Gate
  // durchläuft (keine eigene Zweitprüfung). `pflegegrad` ist für den §45b-Default
  // irrelevant (nur billingType-abhängig).
  const default45bEnabled = effectiveDefaultPots({ billingType, pflegegrad: null })
    .find(p => p.budgetType === "entlastungsbetrag_45b")?.enabled ?? false;
  const isCurrentlyActive = !s45b
    ? default45bEnabled
    : (!s45b.validFrom || today >= s45b.validFrom) && (!s45b.validTo || today <= s45b.validTo);

  // §45b ist ein Jahrestopf — kein harter Monats-Cap. Die "Verfügbar diesen
  // Monat"-Anzeige entspricht der gesamten zum Stichtag aufgelaufenen
  // Verfügbarkeit, da die monatliche Aufstockung ohnehin in
  // calculateAllocated45b nur bis "heute" zählt.
  //
  // Task #603: `monthlyLimitCents` exponiert jetzt den konfigurierten
  // "Unser Anteil"-Wert (geclampt gegen §45b-Maximum), damit die UI ihn anzeigen
  // kann. Er wirkt NICHT als Buchungs-Cap — der reduzierte Pot folgt aus der
  // reduzierten monatlichen Aufstockung.
  //
  // Task #911 (NS-4) — Der angezeigte Limit-Wert MUSS aus derselben phasen-
  // bewussten Quelle stammen wie die Allocation-Reduktion (`monthlyAmountFor`
  // in `calculateAllocated45b`). Vorher leitete die Anzeige ihn aus der
  // einzelnen `forDate(asOfDate)`-Zeile (`s45b`) ab — lag der effektive Limit-
  // Wert in einer Phasen-Zeile, die dieser Single-Row-Lookup nicht traf (z.B.
  // ein Append mit `validFrom = morgen`, aber bis Monatsende in Kraft), schrumpfte
  // der Topf korrekt, die UI zeigte aber `null`. Wir wählen daher die für den
  // Monat des Stichtags wirksame Zeile über `pickEffective45bSettingRow`.
  const all45bSettingRows = await db.select()
    .from(customerBudgetTypeSettings)
    .where(and(
      eq(customerBudgetTypeSettings.customerId, customerId),
      eq(customerBudgetTypeSettings.budgetType, "entlastungsbetrag_45b"),
    ));
  const effective45b = pickEffective45bSettingRow(all45bSettingRows, currentYear, currentMonth);
  const monthlyLimitCents = effective45b?.monthlyLimitCents != null
    ? clampToStatutoryMax({
        budgetType: "entlastungsbetrag_45b",
        monthlyLimitCents: effective45b.monthlyLimitCents,
        yearlyLimitCents: null,
        pflegegrad: null,
      }).monthlyLimitCents
    : null;
  const currentMonthAvailableRaw = availableCents;

  // Task #704 — `availableAfterPlannedCents` ist die zeitlich projizierte
  // Restdeckung. Bei einer Lücke spiegelt sie den größten kumulierten
  // Fehlbetrag (negativ); ohne Lücke fällt sie auf den nach allen Buchungen
  // verbleibenden Topf am Horizont zurück.
  //
  // Task #1340 — Am Horizont gilt dieselbe Carryover-Verfalls-Symmetrie wie in
  // der Schleife: `allocAtHorizon` lässt einen abgelaufenen Übertrag wegfallen,
  // also muss der gegen ihn gebuchte Verbrauch (`excludedAtHorizon`) auch von
  // `netUsedCents` abgezogen werden, sonst entsteht ein künstlicher Fehlbetrag.
  const projectedAvailable = sortedMonths.length > 0
    ? allocAtHorizon - (netUsedCents - excludedAtHorizon) - futurePlannedTotal
    : availableCents - plannedCents;
  const availableAfterPlannedCents = worstShortfallCents > 0
    ? -worstShortfallCents
    : projectedAvailable;

  return {
    customerId,
    totalAllocatedCents,
    totalUsedCents: netUsedCents,
    availableCents: isCurrentlyActive ? availableCents : 0,
    plannedCents: isCurrentlyActive ? plannedCents : 0,
    availableAfterPlannedCents: isCurrentlyActive ? availableAfterPlannedCents : 0,
    carryoverCents,
    carryoverExpiresAt,
    currentYearAllocatedCents,
    monthlyLimitCents,
    currentMonthUsedCents,
    currentMonthPlannedCents: isCurrentlyActive ? currentMonthPlannedCents : 0,
    currentMonthAvailableCents: isCurrentlyActive ? Math.max(0, currentMonthAvailableRaw) : 0,
    isCurrentlyActive,
    plannedShortfallMonth: isCurrentlyActive ? plannedShortfallMonth : null,
  };
}

/**
 * Task #707 — Pro geplantem Kundentermin: passt er im eigenen Monat noch in das
 * verfügbare §45b-Kontingent?
 *
 * Wiederverwendung statt Neubau (Ersetzungs-Regel): identische zeitliche
 * §45b-Projektion wie `getBudgetSummary` (Task #704) — `getPlannedCostByAppointment`
 * + `calculateAllocatedCents({ projectFuture: true })` — nur per-Termin aufgelöst.
 * Termine werden chronologisch nach Monat gruppiert; innerhalb der zeitlichen
 * Reihenfolge wird der kumulierte Verbrauch (`netUsedCents` + bisherige geplante
 * Kosten) gegen die bis zum jeweiligen Monatsende aufgelaufene Allokation geprüft.
 * Der Termin, der den kumulierten Verbrauch über die Allokation hebt, wird (samt
 * aller folgenden) als `fitsInMonthlyBudget: false` markiert.
 *
 * Liefert NUR Marker für Kunden mit aktivem §45b-Topf; sonst leeres Array
 * (Selbstzahler / §45b deaktiviert ⇒ kein Kontingent-Limit ⇒ kein Marker).
 */
export async function getMonthlyBudgetFitByAppointment(
  customerId: number,
  asOfDate: string = todayISO(),
): Promise<AppointmentBudgetFit[]> {
  const today = asOfDate;

  const [preferences, typeSettings, customerRows] = await Promise.all([
    getBudgetPreferences(customerId),
    readBudgetTypeSettings(customerId, { kind: "forDate", asOfDate: today }),
    customersRepo.selectColumnsFrom({ billingType: customers.billingType }, db).where(eq(customers.id, customerId)),
  ]);
  const billingType = customerRows[0]?.billingType;

  // §45b-Aktivität identisch zu getBudgetSummary (BUG-19 Facette A): fehlende
  // Zeile ⇒ Default-Aktivierung über effectiveDefaultPots (Selbstzahler-Gate).
  const s45b = typeSettings.find(s => s.budgetType === "entlastungsbetrag_45b" && s.enabled);
  const default45bEnabled = effectiveDefaultPots({ billingType, pflegegrad: null })
    .find(p => p.budgetType === "entlastungsbetrag_45b")?.enabled ?? false;
  const isCurrentlyActive = !s45b
    ? default45bEnabled
    : (!s45b.validFrom || today >= s45b.validFrom) && (!s45b.validTo || today <= s45b.validTo);
  if (!isCurrentlyActive) return [];

  const plannedByAppt = await getPlannedCostByAppointment(customerId);
  if (plannedByAppt.length === 0) return [];

  // netUsedCents = Allocation-Sicht aller §45b-Buchungen bis zum Stichtag
  // (identische Basis wie die Projektion in getBudgetSummary).
  const txResult = await db.select({
    transactionType: budgetTransactions.transactionType,
    absTotal: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
    rawTotal: sql<number>`COALESCE(SUM(${budgetTransactions.amountCents}), 0)`,
  }).from(budgetTransactions).where(and(
    eq(budgetTransactions.customerId, customerId),
    eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
    lte(budgetTransactions.transactionDate, today),
  )).groupBy(budgetTransactions.transactionType);
  const txMap = new Map<string, { absTotal: number; rawTotal: number }>();
  for (const row of txResult) {
    txMap.set(row.transactionType, { absTotal: Number(row.absTotal), rawTotal: Number(row.rawTotal) });
  }
  const netUsedCents =
    (txMap.get("consumption")?.absTotal ?? 0)
    + (txMap.get("write_off")?.absTotal ?? 0)
    + (txMap.get("manual_adjustment")?.absTotal ?? 0)
    - (txMap.get("reversal")?.rawTotal ?? 0);

  const todayMonthPrefix = today.slice(0, 7);

  // Vergangene Termine sind bereits in netUsedCents enthalten bzw. fallen über
  // expired_unsigned aus der Planung — kein Marker (fits=true).
  const result: AppointmentBudgetFit[] = [];
  const futureAppts: typeof plannedByAppt = [];
  for (const p of plannedByAppt) {
    if (p.date.slice(0, 7) < todayMonthPrefix) {
      result.push({ appointmentId: p.appointmentId, date: p.date, plannedCostCents: p.costCents, fitsInMonthlyBudget: true, shortfallCents: 0 });
    } else {
      futureAppts.push(p);
    }
  }

  // Allokation pro Monatsende vorberechnen (projectFuture, wie getBudgetSummary).
  const allocAtEndByMonth = new Map<string, number>();
  for (const ym of [...new Set(futureAppts.map(p => p.date.slice(0, 7)))]) {
    const [y, m] = ym.split("-").map(Number);
    const monthEnd = `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
    allocAtEndByMonth.set(ym, await calculateAllocatedCents(
      customerId,
      "entlastungsbetrag_45b",
      { asOfDate: monthEnd, projectFuture: true },
      undefined,
      preferences,
      typeSettings,
    ));
  }

  // futureAppts ist chronologisch sortiert (getPlannedCostByAppointment).
  let cumulativeUsed = netUsedCents;
  for (const p of futureAppts) {
    const allocAtEnd = allocAtEndByMonth.get(p.date.slice(0, 7))!;
    cumulativeUsed += p.costCents;
    const remaining = allocAtEnd - cumulativeUsed;
    const fits = remaining >= 0;
    result.push({
      appointmentId: p.appointmentId,
      date: p.date,
      plannedCostCents: p.costCents,
      fitsInMonthlyBudget: fits,
      shortfallCents: fits ? 0 : -remaining,
    });
  }

  return result;
}

export async function getBudgetSummary45a(customerId: number, _preferences?: CustomerBudgetPreferences | undefined, _amounts?: { pflegesachleistungen36: number; verhinderungspflege39: number }, _typeSettings?: CustomerBudgetTypeSetting[], asOfDate: string = todayISO()): Promise<Budget45aSummary> {
  const today = asOfDate;

  const amounts = _amounts ?? await getCustomerBudgetAmounts(customerId);
  const typeSettings = _typeSettings ?? await readBudgetTypeSettings(customerId, { kind: "forDate", asOfDate: today });
  const preferences = _preferences !== undefined ? _preferences : await getBudgetPreferences(customerId);
  const s45a = typeSettings.find(s => s.budgetType === "umwandlung_45a" && s.enabled);
  // Task #915 — `typeSettings` ist auf den Stichtag gefiltert
  // (`readBudgetTypeSettings({ kind: "forDate", asOfDate })`). Fehlt die §45a-
  // Zeile, ist §45a am abgefragten Datum NICHT konfiguriert-und-wirksam (vor
  // `validFrom` bzw. nach `validTo`) → der Topf ist nicht aktiv. Früher
  // defaultete dieser Zweig auf `true` und meldete einen noch-nicht/nicht-mehr
  // konfigurierten §45a-Topf fälschlich als aktiv für Vergangenheits-/Zukunfts-
  // Stichtage.
  const isCurrentlyActive = !s45a
    ? false
    : (!s45a.validFrom || today >= s45a.validFrom) && (!s45a.validTo || today <= s45a.validTo);

  // SSoT-Pfad: Cap-Mathematik (Monats-Fenster, statutorische Klemme nach
  // Pflegegrad) wird über `computeCapSlot` aus demselben Helfer gezogen,
  // den auch der Buchungspfad (`createCascadeConsumption`) und die Import-
  // Preview (`getAvailableForDate`) nutzen. Vorher hatte diese Funktion
  // ihre eigene Window-Net-Aggregation — bei Daten, bei denen
  // `monthlyLimitCents` über dem gesetzlichen Maximum lag (Backfill, manueller
  // SQL-Eingriff), wich die Overview-Anzeige vom tatsächlich buchbaren Betrag
  // ab. Siehe `docs/budget-ssot-inventory.md` Phase 1.2.
  const capSlotPromise = computeCapSlot({
    customerId,
    budgetType: "umwandlung_45a",
    transactionDate: today,
    monthlyLimitCents: s45a?.monthlyLimitCents ?? null,
    yearlyLimitCents: null,
  });
  const [currentMonthAllocatedCents, capSlot] = await Promise.all([
    calculateAllocatedCents(customerId, "umwandlung_45a", { asOfDate: today }, undefined, preferences, typeSettings),
    capSlotPromise,
  ]);

  const currentMonthUsedCents = capSlot.netUsedInWindowCents;
  const fallbackAvailable = Math.max(0, currentMonthAllocatedCents - currentMonthUsedCents);
  const cappedAvailable = Number.isFinite(capSlot.capRemainingCents)
    ? Math.min(capSlot.capRemainingCents, fallbackAvailable)
    : fallbackAvailable;

  return {
    customerId,
    monthlyBudgetCents: amounts.pflegesachleistungen36,
    currentMonthAllocatedCents,
    currentMonthUsedCents,
    currentMonthAvailableCents: isCurrentlyActive ? cappedAvailable : 0,
    isCurrentlyActive,
  };
}

export async function getBudgetSummary39_42a(customerId: number, _preferences?: CustomerBudgetPreferences | undefined, _amounts?: { pflegesachleistungen36: number; verhinderungspflege39: number }, _typeSettings?: CustomerBudgetTypeSetting[], asOfDate: string = todayISO()): Promise<Budget39_42aSummary> {
  const today = asOfDate;
  const todayDate = parseLocalDate(today);
  const currentYear = todayDate.getFullYear();

  const amounts = _amounts ?? await getCustomerBudgetAmounts(customerId);
  const typeSettings = _typeSettings ?? await readBudgetTypeSettings(customerId, { kind: "forDate", asOfDate: today });
  const preferences = _preferences !== undefined ? _preferences : await getBudgetPreferences(customerId);
  const s39 = typeSettings.find(s => s.budgetType === "ersatzpflege_39_42a" && s.enabled);

  // SSoT-Pfad: Year-Cap (§39/§42a-Jahres-Cap inkl. statutorischer Klemme auf
  // BUDGET_39_42A_MAX_YEARLY_CENTS) wird über denselben `computeCapSlot`-Helfer
  // berechnet wie Buchungspfad/Preview. Siehe Kommentar oben (§45a).
  const capSlotPromise = computeCapSlot({
    customerId,
    budgetType: "ersatzpflege_39_42a",
    transactionDate: today,
    monthlyLimitCents: null,
    yearlyLimitCents: s39?.yearlyLimitCents ?? null,
  });
  const [currentYearAllocatedCents, capSlot] = await Promise.all([
    calculateAllocatedCents(customerId, "ersatzpflege_39_42a", { year: currentYear }, undefined, preferences, typeSettings),
    capSlotPromise,
  ]);

  const currentYearUsedCents = capSlot.netUsedInWindowCents;
  const fallbackAvailable = Math.max(0, currentYearAllocatedCents - currentYearUsedCents);
  const cappedAvailable = Number.isFinite(capSlot.capRemainingCents)
    ? Math.min(capSlot.capRemainingCents, fallbackAvailable)
    : fallbackAvailable;

  return {
    customerId,
    yearlyBudgetCents: amounts.verhinderungspflege39,
    currentYearAllocatedCents,
    currentYearUsedCents,
    currentYearAvailableCents: cappedAvailable,
  };
}

export async function getAllBudgetSummaries(customerId: number, asOfDate: string = todayISO()): Promise<AllBudgetSummaries> {
  await syncCarryoverAndExpiry(customerId);

  const [preferences, typeSettings] = await Promise.all([
    getBudgetPreferences(customerId),
    readBudgetTypeSettings(customerId, { kind: "forDate", asOfDate }),
  ]);
  const amounts = await getCustomerBudgetAmounts(customerId, undefined, typeSettings);

  const is45aEnabled = typeSettings.some(s => s.budgetType === "umwandlung_45a" && s.enabled);
  const is39Enabled = typeSettings.some(s => s.budgetType === "ersatzpflege_39_42a" && s.enabled);

  const [entlastungsbetrag45b, umwandlung45a, ersatzpflege39_42a] = await Promise.all([
    getBudgetSummary(customerId, preferences, typeSettings, asOfDate),
    is45aEnabled
      ? getBudgetSummary45a(customerId, preferences, amounts, typeSettings, asOfDate)
      : { customerId, monthlyBudgetCents: 0, currentMonthAllocatedCents: 0, currentMonthUsedCents: 0, currentMonthAvailableCents: 0, isCurrentlyActive: false } as Budget45aSummary,
    is39Enabled
      ? getBudgetSummary39_42a(customerId, preferences, amounts, typeSettings, asOfDate)
      : { customerId, yearlyBudgetCents: 0, currentYearAllocatedCents: 0, currentYearUsedCents: 0, currentYearAvailableCents: 0 } as Budget39_42aSummary,
  ]);
  return { entlastungsbetrag45b, umwandlung45a, ersatzpflege39_42a };
}

// ---------------------------------------------------------------------------
// Task #874 — Serving-Assembler (Phase 4): Verfügbarkeit aus dem EINEN Reader.
//
// Die Legacy-`getBudgetSummary*`-Reader oben bleiben UNVERÄNDERT — sie sind der
// Compat-/Equality-Pfad und liefern weiterhin das volle DTO-Gerüst
// (Carryover, Planung, Limit, `totalUsedCents`).
//
// Die nach AUSSEN ausgelieferten Verfügbarkeits-Zahlen (`availableCents` & Co.)
// kommen ab Phase 4 ausschließlich aus `readUnifiedBudgetAvailability` (SSoT
// `Available = Allocated − HoldsActive − ConsumedNet`). Diese Assembler
// überschreiben nur die Available-Felder des Legacy-Gerüsts.
//
// WICHTIG §45b: `totalUsedCents` bleibt die ALLOCATION-Sicht (consumption +
// write_off + manual_adjustment − reversal, all-time) — sie ist durch den
// Equality-Test `budget-history-vs-overview` an die History-Aggregation
// gepinnt und ist NICHT dasselbe wie die buchbare Verfügbarkeit. Der unified
// Reader schließt `manual_adjustment` bewusst aus (= Buchungspfad
// `getAvailableForDate`). Für Kunden MIT `manual_adjustment` weicht die
// angezeigte §45b-Verfügbarkeit daher ab — bewusste Produkt-Entscheidung
// (Phase 4), die Reconciliation der manual_adjustment-Semantik ist Phase 6.
// ---------------------------------------------------------------------------

/**
 * §45b: Legacy-Gerüst + unified Available. `availableCents`,
 * `currentMonthAvailableCents` kommen 1:1 aus dem unified Reader; die
 * Planungs-Projektion `availableAfterPlannedCents` wird um exakt die Differenz
 * (= im Wesentlichen der nicht mehr abgezogene `manual_adjustment`)
 * verschoben, damit „Verfügbar" und „Verfügbar nach Planung" konsistent auf
 * derselben Basis stehen.
 */
export function mergeServed45b(legacy: BudgetSummary, pot: PotAvailability): BudgetSummary {
  if (!legacy.isCurrentlyActive) {
    return { ...legacy, availableCents: 0, currentMonthAvailableCents: 0, availableAfterPlannedCents: 0 };
  }
  const availableDelta = pot.availableCents - legacy.availableCents;
  return {
    ...legacy,
    availableCents: pot.availableCents,
    currentMonthAvailableCents: Math.max(0, pot.availableCents),
    availableAfterPlannedCents: legacy.availableAfterPlannedCents + availableDelta,
  };
}

function mergeServed45a(legacy: Budget45aSummary, pot: PotAvailability): Budget45aSummary {
  return {
    ...legacy,
    currentMonthAvailableCents: legacy.isCurrentlyActive ? pot.availableCents : 0,
  };
}

function mergeServed39_42a(legacy: Budget39_42aSummary, pot: PotAvailability): Budget39_42aSummary {
  return {
    ...legacy,
    currentYearAvailableCents: pot.availableCents,
  };
}

/** Reine Verfügbarkeits-Überschreibung des Legacy-Gerüsts mit dem unified Reader. */
export function mergeServedAvailability(
  legacy: AllBudgetSummaries,
  unified: UnifiedBudgetAvailability,
): AllBudgetSummaries {
  return {
    entlastungsbetrag45b: mergeServed45b(legacy.entlastungsbetrag45b, unified.pots.entlastungsbetrag_45b),
    umwandlung45a: mergeServed45a(legacy.umwandlung45a, unified.pots.umwandlung_45a),
    ersatzpflege39_42a: mergeServed39_42a(legacy.ersatzpflege39_42a, unified.pots.ersatzpflege_39_42a),
  };
}

/**
 * Serving-Pfad für `/overview`: Legacy-Gerüst (synct Carryover/Expiry, liefert
 * Planung/Carryover/Limit) + unified Available. Reihenfolge: Legacy ZUERST
 * (synct), damit der rein lesende unified Reader die gesynchten Allocations
 * sieht.
 */
export async function getAllBudgetSummariesServed(customerId: number, asOfDate: string = todayISO()): Promise<AllBudgetSummaries> {
  const legacy = await getAllBudgetSummaries(customerId, asOfDate);
  const unified = await readUnifiedBudgetAvailability(customerId, asOfDate);
  return mergeServedAvailability(legacy, unified);
}

/**
 * Serving-Pfad für `/summary` und die §45b-Budget-Warnung (Termin-/Serien-
 * Anlage). Synct NICHT selbst — die Caller rufen `syncCarryoverAndExpiry`
 * explizit auf, bevor sie diesen Reader nutzen.
 */
export async function getBudgetSummaryServed(customerId: number, asOfDate: string = todayISO()): Promise<BudgetSummary> {
  const legacy = await getBudgetSummary(customerId, undefined, undefined, asOfDate);
  const unified = await readUnifiedBudgetAvailability(customerId, asOfDate);
  return mergeServed45b(legacy, unified.pots.entlastungsbetrag_45b);
}
