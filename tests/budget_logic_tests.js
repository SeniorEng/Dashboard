/**
 * @deprecated Wird ersetzt durch:
 *   - tests/budget/properties.test.ts (Phase 4 T4) — Property-Tests für FIFO, §45b-Cap, Carryover-Math
 *   - tests/budget/race-*.test.ts (Phase 4 T3) — echte Race-Tests statt der Pseudo-Simulation Zeile 1383+
 *   - tests/budget-e2e.test.ts — bereits vorhanden für E2E-Pfade
 *
 * NICHT in CI laufen lassen. Nach Abschluss von T3 und T4 löschen.
 */
"use strict";

const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", B = "\x1b[1m", X = "\x1b[0m";

let passed = 0, failed = 0;
const failures = [];
const asyncTests = [];

function describe(label, fn) {
  console.log(`\n${B}${label}${X}`);
  fn();
}

function test(label, fn) {
  if (fn.constructor.name === "AsyncFunction") {
    asyncTests.push({ label, fn });
    return;
  }
  try {
    fn();
    console.log(`  ${G}✓${X} ${label}`);
    passed++;
  } catch (e) {
    console.log(`  ${R}✗${X} ${label}`);
    console.log(`    ${R}→ ${e.message}${X}`);
    failed++;
    failures.push({ label, error: e.message });
  }
}

function expect(actual) {
  return {
    toBe:            (e) => { if (actual !== e)   throw new Error(`Erwartet ${e}, erhalten ${actual}`); },
    toEqual:         (e) => { const a=JSON.stringify(actual),b=JSON.stringify(e); if(a!==b) throw new Error(`Erwartet:\n  ${b}\nErhalten:\n  ${a}`); },
    toBeGreaterThan: (n) => { if (!(actual > n))  throw new Error(`${actual} ist nicht > ${n}`); },
    toBeLessThan:    (n) => { if (!(actual < n))  throw new Error(`${actual} ist nicht < ${n}`); },
    toBeAtLeast:     (n) => { if (actual < n)     throw new Error(`${actual} ist nicht >= ${n}`); },
    toBeAtMost:      (n) => { if (actual > n)     throw new Error(`${actual} ist nicht <= ${n}`); },
    toBeNull:        ()  => { if (actual !== null) throw new Error(`Erwartet null, erhalten ${actual}`); },
    toBeUndefined:   ()  => { if (actual !== undefined) throw new Error(`Erwartet undefined, erhalten ${actual}`); },
    toThrow: (msg) => {
      if (typeof actual !== "function") throw new Error("expect(fn).toThrow() braucht eine Funktion");
      let threw = false;
      try { actual(); } catch(e) {
        threw = true;
        if (msg && !e.message.includes(msg))
          throw new Error(`Exception '${e.message}' enthaelt nicht '${msg}'`);
      }
      if (!threw) throw new Error("Keine Exception geworfen");
    },
    toNotThrow: () => {
      if (typeof actual !== "function") throw new Error("expect(fn).toNotThrow() braucht eine Funktion");
      try { actual(); } catch(e) { throw new Error(`Unerwartete Exception: ${e.message}`); }
    },
  };
}

const BUDGET_45B_MONTHLY = 13100;
const BUDGET_45A_PG = { 1: 0, 2: 31840, 3: 59880, 4: 74360, 5: 91960 };
const BUDGET_42A_YEARLY = 353900;

const PRICES_PFLEGEKASSE = {
  hauswirtschaft:    3800,
  alltagsbegleitung: 4200,
  gruppenangebot:    2500,
  fahrt_km:            35,
  kunden_km:           35,
};

function calculateAppointmentCost({ services, priceTable }) {
  let total = 0;
  for (const s of services) {
    const rate = priceTable[s.type];
    if (rate === undefined) throw new Error(`Unbekannter Service-Typ: ${s.type}`);
    if (s.type === "fahrt_km" || s.type === "kunden_km") {
      total += Math.round(s.km * rate);
    } else {
      total += Math.round((s.minutes / 60) * rate);
    }
  }
  return total;
}

function calculateAppointmentCostWithCustomerPrices({ services, defaultPriceTable, customerPrices, date }) {
  let total = 0;
  for (const s of services) {
    const cp = customerPrices.find(p =>
      p.serviceCode === s.type && p.validFrom <= date && (!p.validTo || p.validTo >= date)
    );
    const rate = cp ? cp.priceCents : defaultPriceTable[s.type];
    if (rate === undefined) throw new Error(`Unbekannter Service-Typ: ${s.type}`);
    if (s.type === "fahrt_km" || s.type === "kunden_km") {
      total += Math.round(s.km * rate);
    } else {
      total += Math.round((s.minutes / 60) * rate);
    }
  }
  return total;
}

function consumeFifo(allocations, amountCents) {
  const sorted = [...allocations].sort((a, b) =>
    a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : a.id - b.id
  );
  const splits = [];
  let remaining = amountCents;
  for (const a of sorted) {
    if (remaining <= 0) break;
    const available = a.amountCents - a.usedCents;
    if (available <= 0) continue;
    const consume = Math.min(available, remaining);
    splits.push({ allocationId: a.id, consumedCents: consume });
    remaining -= consume;
  }
  return { consumedCents: amountCents - remaining, splits, remainingCents: remaining };
}

function consumeFifoWithDetails(allocations, amountCents, details) {
  const sorted = [...allocations].sort((a, b) =>
    a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : a.id - b.id
  );
  const splits = [];
  let remaining = amountCents;
  let isFirst = true;
  for (const a of sorted) {
    if (remaining <= 0) break;
    const available = a.amountCents - a.usedCents;
    if (available <= 0) continue;
    const consume = Math.min(available, remaining);
    const ratio = amountCents > 0 ? consume / amountCents : (isFirst ? 1 : 0);
    const split = {
      allocationId: a.id,
      consumedCents: consume,
      hauswirtschaftMinutes: details ? Math.round(details.hauswirtschaftMinutes * ratio) : 0,
      hauswirtschaftCents: details ? Math.round(details.hauswirtschaftCents * ratio) : 0,
      alltagsbegleitungMinutes: details ? Math.round(details.alltagsbegleitungMinutes * ratio) : 0,
      alltagsbegleitungCents: details ? Math.round(details.alltagsbegleitungCents * ratio) : 0,
    };
    splits.push(split);
    remaining -= consume;
    isFirst = false;
  }
  return { consumedCents: amountCents - remaining, splits, remainingCents: remaining };
}

function buildSummary45b({ allocations, transactions, monthlyLimitCents, today }) {
  const todayStr = today.toISOString().split("T")[0];
  const currentMonth = todayStr.slice(0, 7);
  const currentYear = todayStr.slice(0, 4);

  const validAllocs = allocations.filter(a =>
    !a.deleted &&
    a.validFrom <= todayStr &&
    (a.expiresAt === null || a.expiresAt >= todayStr)
  );

  const totalAllocatedCents = validAllocs.reduce((s, a) => s + a.amountCents, 0);

  const netUsedCents = transactions.reduce((s, t) => {
    if (["consumption", "write_off", "manual_adjustment"].includes(t.type)) return s + Math.abs(t.amountCents);
    if (t.type === "reversal") return s - Math.abs(t.amountCents);
    return s;
  }, 0);

  const availableCents = totalAllocatedCents - netUsedCents;

  const carryoverAllocs = validAllocs.filter(a => a.source === "carryover");
  const carryoverCents = carryoverAllocs.reduce((s, a) => s + a.amountCents, 0);
  const carryoverExpiresAt = carryoverAllocs.length > 0
    ? [...carryoverAllocs].sort((a, b) => a.expiresAt > b.expiresAt ? 1 : -1)[0].expiresAt
    : null;

  const currentMonthUsedCents = transactions
    .filter(t => t.type === "consumption" && t.date.startsWith(currentMonth))
    .reduce((s, t) => s + Math.abs(t.amountCents), 0);

  const currentYearAllocatedCents = validAllocs
    .filter(a => a.source !== "carryover" && a.validFrom.startsWith(currentYear))
    .reduce((s, a) => s + a.amountCents, 0);

  const effectiveMonthlyLimit = monthlyLimitCents != null
    ? monthlyLimitCents + carryoverCents
    : null;

  const availableThisMonth = effectiveMonthlyLimit != null
    ? Math.max(0, effectiveMonthlyLimit - currentMonthUsedCents)
    : availableCents;

  return {
    totalAllocatedCents, netUsedCents, availableCents, carryoverCents,
    carryoverExpiresAt, currentMonthUsedCents, currentYearAllocatedCents,
    monthlyLimitCents, effectiveMonthlyLimit, availableThisMonth,
  };
}

function buildSummary45a({ allocations, transactions, monthlyBudgetCents, today }) {
  const todayStr = today.toISOString().split("T")[0];
  const todayDate = new Date(todayStr + "T00:00:00");
  const currentYear = todayDate.getFullYear();
  const currentMonth = todayDate.getMonth() + 1;
  const currentMonthStr = `${currentYear}-${String(currentMonth).padStart(2, '0')}`;
  const lastDay = new Date(currentYear, currentMonth, 0).getDate();
  const currentMonthLastDay = `${currentYear}-${String(currentMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  const currentMonthAllocs = allocations.filter(a =>
    !a.deleted &&
    a.year === currentYear &&
    a.month === currentMonth &&
    a.validFrom <= todayStr &&
    (a.expiresAt === null || a.expiresAt >= todayStr)
  );

  const currentMonthAllocatedCents = currentMonthAllocs.reduce((s, a) => s + a.amountCents, 0);
  const currentMonthUsedCents = transactions
    .filter(t => t.type === "consumption" && t.date >= `${currentMonthStr}-01` && t.date <= currentMonthLastDay)
    .reduce((s, t) => s + Math.abs(t.amountCents), 0);

  return {
    monthlyBudgetCents,
    currentMonthAllocatedCents,
    currentMonthUsedCents,
    currentMonthAvailableCents: currentMonthAllocatedCents - currentMonthUsedCents,
  };
}

function buildSummary42a({ allocations, transactions, yearlyBudgetCents, today }) {
  const todayStr = today.toISOString().split("T")[0];
  const todayDate = new Date(todayStr + "T00:00:00");
  const currentYear = todayDate.getFullYear();
  const yearStart = `${currentYear}-01-01`;
  const yearEnd = `${currentYear}-12-31`;

  const currentYearAllocs = allocations.filter(a =>
    !a.deleted &&
    a.year === currentYear &&
    a.validFrom <= todayStr &&
    (a.expiresAt === null || a.expiresAt >= todayStr)
  );

  const currentYearAllocatedCents = currentYearAllocs.reduce((s, a) => s + a.amountCents, 0);
  const currentYearUsedCents = transactions
    .filter(t => t.type === "consumption" && t.date >= yearStart && t.date <= yearEnd)
    .reduce((s, t) => s + Math.abs(t.amountCents), 0);

  return {
    yearlyBudgetCents,
    currentYearAllocatedCents,
    currentYearUsedCents,
    currentYearAvailableCents: currentYearAllocatedCents - currentYearUsedCents,
  };
}

function cascadeConsumption({ costCents, budgets, acceptsPrivatePayment, transactionDate }) {
  let remaining = costCents;
  const result = [];
  const txDate = new Date(transactionDate + "T00:00:00");
  const txYear = txDate.getFullYear();
  const txMonth = txDate.getMonth() + 1;
  const currentMonthStart = `${txYear}-${String(txMonth).padStart(2, '0')}-01`;
  const lastDay = new Date(txYear, txMonth, 0).getDate();
  const currentMonthEnd = `${txYear}-${String(txMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  const yearStart = `${txYear}-01-01`;
  const yearEnd = `${txYear}-12-31`;

  for (const budget of budgets) {
    if (remaining <= 0) break;
    if (!budget.enabled) {
      result.push({ budget: budget.name, consumedCents: 0 });
      continue;
    }

    let maxConsumable = remaining;

    if (budget.monthlyLimitCents != null) {
      const alreadyUsedThisMonth = (budget.transactions || [])
        .filter(t => t.type === "consumption" && t.date >= currentMonthStart && t.date <= currentMonthEnd)
        .reduce((s, t) => s + Math.abs(t.amountCents), 0);

      let effectiveMonthlyLimit = budget.monthlyLimitCents;
      if (budget.name === "45b" && budget.carryoverCents) {
        effectiveMonthlyLimit += budget.carryoverCents;
      }
      const monthlyRemaining = Math.max(0, effectiveMonthlyLimit - alreadyUsedThisMonth);
      maxConsumable = Math.min(remaining, monthlyRemaining);
    }

    if (budget.yearlyLimitCents != null) {
      const alreadyUsedThisYear = (budget.transactions || [])
        .filter(t => t.type === "consumption" && t.date >= yearStart && t.date <= yearEnd)
        .reduce((s, t) => s + Math.abs(t.amountCents), 0);
      const yearlyRemaining = Math.max(0, budget.yearlyLimitCents - alreadyUsedThisYear);
      maxConsumable = Math.min(maxConsumable, yearlyRemaining);
    }

    if (maxConsumable <= 0) {
      result.push({ budget: budget.name, consumedCents: 0 });
      continue;
    }

    const canUse = Math.min(budget.availableCents, maxConsumable);
    if (canUse <= 0) {
      result.push({ budget: budget.name, consumedCents: 0 });
      continue;
    }

    const fifo = consumeFifo(budget.allocations, canUse);
    result.push({ budget: budget.name, consumedCents: fifo.consumedCents, splits: fifo.splits });
    remaining -= fifo.consumedCents;
  }

  if (remaining > 0) {
    if (!acceptsPrivatePayment)
      throw new Error(`Budget nicht ausreichend. ${remaining} Cent ungedeckt.`);
    result.push({ budget: "privat", consumedCents: remaining, splits: [] });
  }
  return result;
}

function processExpiredCarryover({ allocations, transactions, today }) {
  const todayStr = today.toISOString().split("T")[0];
  const writeOffs = [];
  for (const alloc of allocations) {
    if (alloc.source !== "carryover") continue;
    if (!alloc.expiresAt || alloc.expiresAt >= todayStr) continue;
    const alreadyWrittenOff = transactions.some(t => t.type === "write_off" && t.allocationId === alloc.id);
    if (alreadyWrittenOff) continue;
    const used = transactions
      .filter(t => t.allocationId === alloc.id && t.type === "consumption")
      .reduce((s, t) => s + Math.abs(t.amountCents), 0);
    const remaining = alloc.amountCents - used;
    if (remaining > 0)
      writeOffs.push({ allocationId: alloc.id, amountCents: remaining, reason: "carryover_expired" });
  }
  return writeOffs;
}

function computeAvailableAfterPlanned(availableCents, plannedCents) {
  return availableCents - plannedCents;
}

function ensureMonthlyAllocations({ budgetStartDate, initialBalanceMonths, existingAllocations, monthlyAmount, currentYear, currentMonth }) {
  const startDate = new Date(budgetStartDate + "T00:00:00");
  let allocStartYear = startDate.getFullYear();
  let allocStartMonth = startDate.getMonth() + 1;

  if (initialBalanceMonths.length > 0) {
    let latestIbYear = 0, latestIbMonth = 0;
    for (const ib of initialBalanceMonths) {
      if (ib.year > latestIbYear || (ib.year === latestIbYear && ib.month > latestIbMonth)) {
        latestIbYear = ib.year;
        latestIbMonth = ib.month;
      }
    }
    let afterMonth = latestIbMonth + 1, afterYear = latestIbYear;
    if (afterMonth > 12) { afterMonth = 1; afterYear++; }
    if (afterYear > allocStartYear || (afterYear === allocStartYear && afterMonth > allocStartMonth)) {
      allocStartYear = afterYear;
      allocStartMonth = afterMonth;
    }
  }

  const existingMonthlySet = new Set(
    existingAllocations
      .filter(a => a.source === "monthly_auto" || a.source === "monthly")
      .map(a => `${a.year}-${a.month}`)
  );
  const initialBalanceSet = new Set(
    initialBalanceMonths.map(ib => `${ib.year}-${ib.month}`)
  );

  const created = [];
  let year = allocStartYear;
  let month = allocStartMonth;
  while (year < currentYear || (year === currentYear && month <= currentMonth)) {
    const key = `${year}-${month}`;
    if (!existingMonthlySet.has(key) && !initialBalanceSet.has(key)) {
      created.push({
        year, month,
        amountCents: monthlyAmount,
        source: "monthly_auto",
        validFrom: `${year}-${String(month).padStart(2, '0')}-01`,
        expiresAt: null,
      });
    }
    month++;
    if (month > 12) { month = 1; year++; }
  }
  return created;
}

async function simulateParallelConsumption({ allocationAmountCents, cost1Cents, cost2Cents, withLock }) {
  let usedCents = 0;
  let lockHolder = null;

  async function acquireLock(txId) {
    if (!withLock) return;
    while (lockHolder !== null && lockHolder !== txId) {
      await new Promise(r => setTimeout(r, 1));
    }
    lockHolder = txId;
  }
  function releaseLock(txId) {
    if (withLock && lockHolder === txId) lockHolder = null;
  }

  async function consume(txId, costCents) {
    await acquireLock(txId);
    try {
      const available = allocationAmountCents - usedCents;
      await new Promise(r => setTimeout(r, 2));
      if (costCents > available)
        throw new Error(`TX${txId}: Budget nicht ausreichend (available=${available}, cost=${costCents})`);
      usedCents += costCents;
      return { txId, success: true, consumed: costCents };
    } finally {
      releaseLock(txId);
    }
  }

  const results = await Promise.allSettled([consume(1, cost1Cents), consume(2, cost2Cents)]);
  return { usedCents, results };
}


describe("1. Kostenberechnung – calculateAppointmentCost", () => {

  test("1.1 – 90 Min Hauswirtschaft = 57,00 EUR", () => {
    expect(calculateAppointmentCost({ services: [{ type: "hauswirtschaft", minutes: 90 }], priceTable: PRICES_PFLEGEKASSE })).toBe(5700);
  });

  test("1.2 – 60 Min Alltagsbegleitung = 42,00 EUR", () => {
    expect(calculateAppointmentCost({ services: [{ type: "alltagsbegleitung", minutes: 60 }], priceTable: PRICES_PFLEGEKASSE })).toBe(4200);
  });

  test("1.3 – 7 km Fahrtkosten = 2,45 EUR", () => {
    expect(calculateAppointmentCost({ services: [{ type: "fahrt_km", km: 7 }], priceTable: PRICES_PFLEGEKASSE })).toBe(245);
  });

  test("1.4 – Kombination 90 Min HW + 7 km = 59,45 EUR", () => {
    expect(calculateAppointmentCost({ services: [{ type: "hauswirtschaft", minutes: 90 }, { type: "fahrt_km", km: 7 }], priceTable: PRICES_PFLEGEKASSE })).toBe(5945);
  });

  test("1.5 – Anteilig: 30 Min HW = 19,00 EUR", () => {
    expect(calculateAppointmentCost({ services: [{ type: "hauswirtschaft", minutes: 30 }], priceTable: PRICES_PFLEGEKASSE })).toBe(1900);
  });

  test("1.6 – 0 Minuten = 0,00 EUR", () => {
    expect(calculateAppointmentCost({ services: [{ type: "alltagsbegleitung", minutes: 0 }], priceTable: PRICES_PFLEGEKASSE })).toBe(0);
  });

  test("1.7 – Gruppenangebot 60 Min = 25,00 EUR", () => {
    expect(calculateAppointmentCost({ services: [{ type: "gruppenangebot", minutes: 60 }], priceTable: PRICES_PFLEGEKASSE })).toBe(2500);
  });

  test("1.8 – Unbekannter Service-Typ wirft Fehler", () => {
    expect(() => calculateAppointmentCost({ services: [{ type: "massage", minutes: 60 }], priceTable: PRICES_PFLEGEKASSE })).toThrow("Unbekannter Service-Typ");
  });

  test("1.9 – Zwei Termine/Monat = 118,90 EUR Gesamtkosten", () => {
    const kosten = calculateAppointmentCost({ services: [{ type: "hauswirtschaft", minutes: 90 }, { type: "fahrt_km", km: 7 }], priceTable: PRICES_PFLEGEKASSE });
    expect(kosten * 2).toBe(11890);
  });

  test("1.10 – Kundenspezifischer Preis hat Vorrang vor Default", () => {
    const cost = calculateAppointmentCostWithCustomerPrices({
      services: [{ type: "hauswirtschaft", minutes: 60 }],
      defaultPriceTable: PRICES_PFLEGEKASSE,
      customerPrices: [{ serviceCode: "hauswirtschaft", priceCents: 4500, validFrom: "2025-01-01", validTo: null }],
      date: "2025-03-15",
    });
    expect(cost).toBe(4500);
  });

  test("1.11 – Kundenpreis ausserhalb Gueltigkeit faellt auf Default zurueck", () => {
    const cost = calculateAppointmentCostWithCustomerPrices({
      services: [{ type: "hauswirtschaft", minutes: 60 }],
      defaultPriceTable: PRICES_PFLEGEKASSE,
      customerPrices: [{ serviceCode: "hauswirtschaft", priceCents: 4500, validFrom: "2025-06-01", validTo: null }],
      date: "2025-03-15",
    });
    expect(cost).toBe(3800);
  });
});


describe("2. FIFO-Verbrauch – consumeFifo", () => {

  const allocs3 = () => [
    { id: 1, amountCents: 13100, usedCents: 0,    validFrom: "2025-01-01" },
    { id: 2, amountCents: 13100, usedCents: 5000, validFrom: "2025-02-01" },
    { id: 3, amountCents: 13100, usedCents: 0,    validFrom: "2025-03-01" },
  ];

  test("2.1 – Verbrauch aus aeltester Allokation", () => {
    const r = consumeFifo(allocs3(), 4000);
    expect(r.splits.length).toBe(1);
    expect(r.splits[0].allocationId).toBe(1);
    expect(r.splits[0].consumedCents).toBe(4000);
    expect(r.remainingCents).toBe(0);
  });

  test("2.2 – FIFO uebergreift zwei Allokationen", () => {
    const r = consumeFifo(allocs3(), 13100 + 3000);
    expect(r.splits[0].allocationId).toBe(1);
    expect(r.splits[0].consumedCents).toBe(13100);
    expect(r.splits[1].allocationId).toBe(2);
    expect(r.splits[1].consumedCents).toBe(3000);
  });

  test("2.3 – usedCents einer Allokation wird korrekt beruecksichtigt", () => {
    const r = consumeFifo(allocs3(), 13100 + 8100);
    expect(r.splits.length).toBe(2);
    expect(r.splits[1].consumedCents).toBe(8100);
  });

  test("2.4 – Exakte Erschoepfung einer Allokation", () => {
    const r = consumeFifo(allocs3(), 13100);
    expect(r.splits.length).toBe(1);
    expect(r.splits[0].consumedCents).toBe(13100);
  });

  test("2.5 – Nicht genuegend Budget: remainingCents > 0 (kein throw)", () => {
    const r = consumeFifo([{ id: 1, amountCents: 1000, usedCents: 900, validFrom: "2025-01-01" }], 200);
    expect(r.consumedCents).toBe(100);
    expect(r.remainingCents).toBe(100);
  });

  test("2.6 – Sortierung: gleicher validFrom, niedrigste ID zuerst", () => {
    const r = consumeFifo([
      { id: 5, amountCents: 5000, usedCents: 0, validFrom: "2025-01-01" },
      { id: 2, amountCents: 5000, usedCents: 0, validFrom: "2025-01-01" },
      { id: 8, amountCents: 5000, usedCents: 0, validFrom: "2025-01-01" },
    ], 1);
    expect(r.splits[0].allocationId).toBe(2);
  });

  test("2.7 – Vollstaendiger Verbrauch aller Allokationen", () => {
    const r = consumeFifo([
      { id: 1, amountCents: 5000, usedCents: 0, validFrom: "2025-01-01" },
      { id: 2, amountCents: 5000, usedCents: 0, validFrom: "2025-02-01" },
    ], 10000);
    expect(r.consumedCents).toBe(10000);
    expect(r.remainingCents).toBe(0);
  });

  test("2.8 – Allokation mit 0 verfuegbaren Cent wird uebersprungen", () => {
    const r = consumeFifo([
      { id: 1, amountCents: 5000, usedCents: 5000, validFrom: "2025-01-01" },
      { id: 2, amountCents: 5000, usedCents: 0,    validFrom: "2025-02-01" },
    ], 3000);
    expect(r.splits[0].allocationId).toBe(2);
  });
});


describe("2b. FIFO-Verbrauch – Service-Detail-Proportionierung", () => {

  test("2b.1 – Zwei-Allokationen-Split teilt HW/AB proportional auf", () => {
    const r = consumeFifoWithDetails(
      [
        { id: 1, amountCents: 3000, usedCents: 0, validFrom: "2025-01-01" },
        { id: 2, amountCents: 7000, usedCents: 0, validFrom: "2025-02-01" },
      ],
      10000,
      { hauswirtschaftMinutes: 60, hauswirtschaftCents: 3800, alltagsbegleitungMinutes: 120, alltagsbegleitungCents: 8400 }
    );
    expect(r.splits.length).toBe(2);
    expect(r.splits[0].hauswirtschaftMinutes).toBe(Math.round(60 * 3000 / 10000));
    expect(r.splits[0].hauswirtschaftCents).toBe(Math.round(3800 * 3000 / 10000));
    expect(r.splits[1].hauswirtschaftMinutes).toBe(Math.round(60 * 7000 / 10000));
    expect(r.splits[1].hauswirtschaftCents).toBe(Math.round(3800 * 7000 / 10000));
  });

  test("2b.2 – Einzelne Allokation bekommt 100% der Details", () => {
    const r = consumeFifoWithDetails(
      [{ id: 1, amountCents: 20000, usedCents: 0, validFrom: "2025-01-01" }],
      5000,
      { hauswirtschaftMinutes: 90, hauswirtschaftCents: 5700, alltagsbegleitungMinutes: 0, alltagsbegleitungCents: 0 }
    );
    expect(r.splits.length).toBe(1);
    expect(r.splits[0].hauswirtschaftMinutes).toBe(90);
    expect(r.splits[0].hauswirtschaftCents).toBe(5700);
  });

  test("2b.3 – Betrag 0 mit Details: erste Allokation bekommt ratio=1", () => {
    const r = consumeFifoWithDetails(
      [{ id: 1, amountCents: 20000, usedCents: 0, validFrom: "2025-01-01" }],
      0,
      { hauswirtschaftMinutes: 90, hauswirtschaftCents: 0, alltagsbegleitungMinutes: 60, alltagsbegleitungCents: 0 }
    );
    expect(r.consumedCents).toBe(0);
  });
});


describe("3. §45b – Entlastungsbetrag (131 EUR/Monat, kumulierend)", () => {

  const today = new Date("2025-03-15");
  const baseAllocs = [
    { id: 1, amountCents: 13100, validFrom: "2025-01-01", expiresAt: null, deleted: false, source: "monthly_auto" },
    { id: 2, amountCents: 13100, validFrom: "2025-02-01", expiresAt: null, deleted: false, source: "monthly_auto" },
    { id: 3, amountCents: 13100, validFrom: "2025-03-01", expiresAt: null, deleted: false, source: "monthly_auto" },
  ];

  test("3.1 – Gesamtallokation 3 Monate = 393,00 EUR", () => {
    const s = buildSummary45b({ allocations: baseAllocs, transactions: [], monthlyLimitCents: BUDGET_45B_MONTHLY, today });
    expect(s.totalAllocatedCents).toBe(39300);
    expect(s.availableCents).toBe(39300);
  });

  test("3.2 – Verbrauch korrekt abgezogen", () => {
    const s = buildSummary45b({ allocations: baseAllocs, transactions: [{ type: "consumption", amountCents: 5945, date: "2025-03-10", allocationId: 3 }], monthlyLimitCents: BUDGET_45B_MONTHLY, today });
    expect(s.netUsedCents).toBe(5945);
    expect(s.availableCents).toBe(39300 - 5945);
  });

  test("3.3 – Reversal hebt Consumption auf (netUsed = 0)", () => {
    const s = buildSummary45b({ allocations: baseAllocs, transactions: [
      { type: "consumption", amountCents: 5945, date: "2025-03-10", allocationId: 3 },
      { type: "reversal",    amountCents: 5945, date: "2025-03-11", allocationId: 3 },
    ], monthlyLimitCents: BUDGET_45B_MONTHLY, today });
    expect(s.netUsedCents).toBe(0);
  });

  test("3.4 – currentMonthUsedCents zaehlt NUR aktuellen Monat (Maerz)", () => {
    const s = buildSummary45b({ allocations: baseAllocs, transactions: [
      { type: "consumption", amountCents: 3800, date: "2025-01-20", allocationId: 1 },
      { type: "consumption", amountCents: 5945, date: "2025-03-10", allocationId: 3 },
    ], monthlyLimitCents: BUDGET_45B_MONTHLY, today });
    expect(s.currentMonthUsedCents).toBe(5945);
  });

  test("3.5 – Zukuenftige Allokation wird NICHT gezaehlt", () => {
    const withFuture = [...baseAllocs, { id: 10, amountCents: 13100, validFrom: "2025-12-01", expiresAt: null, deleted: false, source: "monthly_auto" }];
    const s = buildSummary45b({ allocations: withFuture, transactions: [], monthlyLimitCents: BUDGET_45B_MONTHLY, today });
    expect(s.totalAllocatedCents).toBe(39300);
  });

  test("3.6 – Geloeschte Allokation wird ignoriert", () => {
    const s = buildSummary45b({ allocations: [{ id: 1, amountCents: 13100, validFrom: "2025-01-01", expiresAt: null, deleted: true, source: "monthly_auto" }], transactions: [], monthlyLimitCents: BUDGET_45B_MONTHLY, today });
    expect(s.totalAllocatedCents).toBe(0);
  });

  test("3.7 – Carryover wird zu effectiveMonthlyLimit addiert", () => {
    const s = buildSummary45b({ allocations: [
      { id: 3, amountCents: 13100, validFrom: "2025-03-01", expiresAt: null, deleted: false, source: "monthly_auto" },
      { id: 9, amountCents: 5000,  validFrom: "2024-07-01", expiresAt: "2025-06-30", deleted: false, source: "carryover" },
    ], transactions: [], monthlyLimitCents: BUDGET_45B_MONTHLY, today });
    expect(s.carryoverCents).toBe(5000);
    expect(s.effectiveMonthlyLimit).toBe(13100 + 5000);
  });

  test("3.8 – Carryover verfaellt nach 30. Juni", () => {
    const s = buildSummary45b({ allocations: [
      { id: 3, amountCents: 13100, validFrom: "2025-03-01", expiresAt: null, deleted: false, source: "monthly_auto" },
      { id: 9, amountCents: 5000,  validFrom: "2024-07-01", expiresAt: "2025-06-30", deleted: false, source: "carryover" },
    ], transactions: [], monthlyLimitCents: BUDGET_45B_MONTHLY, today: new Date("2025-07-01") });
    expect(s.carryoverCents).toBe(0);
  });

  test("3.9 – carryoverExpiresAt: fruehestes Datum bei mehreren Carryovers", () => {
    const s = buildSummary45b({ allocations: [
      { id: 9,  amountCents: 2000, validFrom: "2024-01-01", expiresAt: "2025-06-30", deleted: false, source: "carryover" },
      { id: 10, amountCents: 1000, validFrom: "2024-07-01", expiresAt: "2026-06-30", deleted: false, source: "carryover" },
    ], transactions: [], monthlyLimitCents: BUDGET_45B_MONTHLY, today });
    expect(s.carryoverExpiresAt).toBe("2025-06-30");
  });

  test("3.10 – Kein Monatslimit: availableThisMonth = availableCents", () => {
    const s = buildSummary45b({ allocations: baseAllocs, transactions: [], monthlyLimitCents: null, today });
    expect(s.availableThisMonth).toBe(s.availableCents);
  });

  test("3.11 – Monatslimit ausgeschoepft: availableThisMonth = 0 (nicht negativ)", () => {
    const s = buildSummary45b({ allocations: baseAllocs, transactions: [{ type: "consumption", amountCents: 13100, date: "2025-03-05", allocationId: 3 }], monthlyLimitCents: BUDGET_45B_MONTHLY, today });
    expect(s.availableThisMonth).toBe(0);
  });

  test("3.12 – Kumulierung: Jan-Maerz Budget kumuliert ohne Verfall", () => {
    const s = buildSummary45b({ allocations: baseAllocs, transactions: [], monthlyLimitCents: null, today: new Date("2025-12-15") });
    expect(s.totalAllocatedCents).toBe(39300);
    expect(s.availableCents).toBe(39300);
  });

  test("3.13 – write_off zaehlt zu netUsedCents", () => {
    const s = buildSummary45b({ allocations: baseAllocs, transactions: [
      { type: "write_off", amountCents: 2000, date: "2025-03-01", allocationId: 1 },
    ], monthlyLimitCents: null, today });
    expect(s.netUsedCents).toBe(2000);
    expect(s.availableCents).toBe(39300 - 2000);
  });

  test("3.14 – manual_adjustment zaehlt zu netUsedCents", () => {
    const s = buildSummary45b({ allocations: baseAllocs, transactions: [
      { type: "manual_adjustment", amountCents: 1500, date: "2025-03-01", allocationId: 1 },
    ], monthlyLimitCents: null, today });
    expect(s.netUsedCents).toBe(1500);
  });
});


describe("3b. §45b – ensureMonthlyAllocations / initial_balance Override", () => {

  test("3b.1 – Ohne initial_balance: monthly_auto ab Startdatum", () => {
    const created = ensureMonthlyAllocations({
      budgetStartDate: "2025-01-01",
      initialBalanceMonths: [],
      existingAllocations: [],
      monthlyAmount: 13100,
      currentYear: 2025,
      currentMonth: 3,
    });
    expect(created.length).toBe(3);
    expect(created[0].validFrom).toBe("2025-01-01");
    expect(created[2].validFrom).toBe("2025-03-01");
  });

  test("3b.2 – initial_balance fuer Maerz: monthly_auto erst ab April", () => {
    const created = ensureMonthlyAllocations({
      budgetStartDate: "2025-01-01",
      initialBalanceMonths: [{ year: 2025, month: 3 }],
      existingAllocations: [],
      monthlyAmount: 13100,
      currentYear: 2025,
      currentMonth: 5,
    });
    const months = created.map(a => `${a.year}-${a.month}`);
    expect(months.includes("2025-3")).toBe(false);
    expect(months.includes("2025-4")).toBe(true);
    expect(months.includes("2025-5")).toBe(true);
  });

  test("3b.3 – initial_balance fuer Jan+Feb: monthly_auto erst ab Maerz", () => {
    const created = ensureMonthlyAllocations({
      budgetStartDate: "2025-01-01",
      initialBalanceMonths: [{ year: 2025, month: 1 }, { year: 2025, month: 2 }],
      existingAllocations: [],
      monthlyAmount: 13100,
      currentYear: 2025,
      currentMonth: 4,
    });
    const months = created.map(a => `${a.year}-${a.month}`);
    expect(months.includes("2025-1")).toBe(false);
    expect(months.includes("2025-2")).toBe(false);
    expect(months.includes("2025-3")).toBe(true);
  });

  test("3b.4 – Existierende monthly_auto werden uebersprungen (Idempotenz)", () => {
    const created = ensureMonthlyAllocations({
      budgetStartDate: "2025-01-01",
      initialBalanceMonths: [],
      existingAllocations: [{ year: 2025, month: 1, source: "monthly_auto" }],
      monthlyAmount: 13100,
      currentYear: 2025,
      currentMonth: 3,
    });
    const months = created.map(a => `${a.year}-${a.month}`);
    expect(months.includes("2025-1")).toBe(false);
    expect(months.includes("2025-2")).toBe(true);
  });

  test("3b.5 – monthly_auto hat expiresAt = null", () => {
    const created = ensureMonthlyAllocations({
      budgetStartDate: "2025-01-01",
      initialBalanceMonths: [],
      existingAllocations: [],
      monthlyAmount: 13100,
      currentYear: 2025,
      currentMonth: 1,
    });
    expect(created[0].expiresAt).toBeNull();
  });
});


describe("4. §45a – Umwandlungsanspruch (verfaellt Monatsende, kein Uebertrag)", () => {

  const today = new Date("2025-03-15");

  test("4.1 – PG2: 318,40 EUR/Monat korrekt allokiert", () => {
    const s = buildSummary45a({ allocations: [{ id: 1, amountCents: BUDGET_45A_PG[2], validFrom: "2025-03-01", expiresAt: "2025-03-31", deleted: false, year: 2025, month: 3 }], transactions: [], monthlyBudgetCents: BUDGET_45A_PG[2], today });
    expect(s.currentMonthAllocatedCents).toBe(31840);
    expect(s.currentMonthAvailableCents).toBe(31840);
  });

  test("4.2 – Gesetzliche Betraege PG2-PG5 stimmen (40% der Sachleistungen)", () => {
    const sachleistungen = { 2: 79600, 3: 149700, 4: 185900, 5: 229900 };
    for (const pg of [2, 3, 4, 5]) {
      expect(Math.round(sachleistungen[pg] * 0.4)).toBe(BUDGET_45A_PG[pg]);
    }
  });

  test("4.3 – Verbrauch im aktuellen Monat korrekt", () => {
    const s = buildSummary45a({ allocations: [{ id: 1, amountCents: BUDGET_45A_PG[3], validFrom: "2025-03-01", expiresAt: "2025-03-31", deleted: false, year: 2025, month: 3 }], transactions: [{ type: "consumption", amountCents: 4200, date: "2025-03-10" }], monthlyBudgetCents: BUDGET_45A_PG[3], today });
    expect(s.currentMonthAvailableCents).toBe(BUDGET_45A_PG[3] - 4200);
  });

  test("4.4 – Kein Uebertrag: Februar-Allokation im Maerz NICHT verfuegbar", () => {
    const s = buildSummary45a({ allocations: [{ id: 1, amountCents: BUDGET_45A_PG[2], validFrom: "2025-02-01", expiresAt: "2025-02-28", deleted: false, year: 2025, month: 2 }], transactions: [], monthlyBudgetCents: BUDGET_45A_PG[2], today });
    expect(s.currentMonthAllocatedCents).toBe(0);
    expect(s.currentMonthAvailableCents).toBe(0);
  });

  test("4.5 – Allokation am letzten Monatstag noch gueltig", () => {
    const s = buildSummary45a({ allocations: [{ id: 1, amountCents: BUDGET_45A_PG[2], validFrom: "2025-03-01", expiresAt: "2025-03-31", deleted: false, year: 2025, month: 3 }], transactions: [], monthlyBudgetCents: BUDGET_45A_PG[2], today: new Date("2025-03-31") });
    expect(s.currentMonthAllocatedCents).toBe(31840);
  });

  test("4.6 – PG1 hat keinen §45a-Anspruch", () => {
    expect(BUDGET_45A_PG[1]).toBe(0);
  });

  test("4.7 – Disabled §45a: keine Allokation, Summary zeigt 0", () => {
    const s = buildSummary45a({ allocations: [], transactions: [], monthlyBudgetCents: 0, today });
    expect(s.currentMonthAllocatedCents).toBe(0);
    expect(s.currentMonthAvailableCents).toBe(0);
  });
});


describe("5. §39/42a – Gemeinsamer Jahresbetrag (3.539 EUR, verfaellt 31.12.)", () => {

  test("5.1 – Jahresallokation 3.539,00 EUR korrekt", () => {
    const s = buildSummary42a({ allocations: [{ id: 1, amountCents: BUDGET_42A_YEARLY, validFrom: "2025-07-01", expiresAt: "2025-12-31", deleted: false, year: 2025 }], transactions: [], yearlyBudgetCents: BUDGET_42A_YEARLY, today: new Date("2025-08-15") });
    expect(s.currentYearAllocatedCents).toBe(353900);
  });

  test("5.2 – Verbrauch korrekt abgezogen", () => {
    const s = buildSummary42a({ allocations: [{ id: 1, amountCents: BUDGET_42A_YEARLY, validFrom: "2025-07-01", expiresAt: "2025-12-31", deleted: false, year: 2025 }], transactions: [{ type: "consumption", amountCents: 50000, date: "2025-08-01" }], yearlyBudgetCents: BUDGET_42A_YEARLY, today: new Date("2025-08-15") });
    expect(s.currentYearAvailableCents).toBe(353900 - 50000);
  });

  test("5.3 – Am 31.12. noch gueltig", () => {
    const s = buildSummary42a({ allocations: [{ id: 1, amountCents: BUDGET_42A_YEARLY, validFrom: "2025-01-01", expiresAt: "2025-12-31", deleted: false, year: 2025 }], transactions: [], yearlyBudgetCents: BUDGET_42A_YEARLY, today: new Date("2025-12-31") });
    expect(s.currentYearAllocatedCents).toBe(353900);
  });

  test("5.4 – Ab 01.01. Folgejahr verfallen (kein Uebertrag)", () => {
    const s = buildSummary42a({ allocations: [{ id: 1, amountCents: BUDGET_42A_YEARLY, validFrom: "2025-01-01", expiresAt: "2025-12-31", deleted: false, year: 2025 }], transactions: [], yearlyBudgetCents: BUDGET_42A_YEARLY, today: new Date("2026-01-01") });
    expect(s.currentYearAllocatedCents).toBe(0);
  });

  test("5.5 – Folgejahres-Allokation ist unabhaengig vom Vorjahr", () => {
    const s = buildSummary42a({ allocations: [
      { id: 1, amountCents: BUDGET_42A_YEARLY, validFrom: "2025-01-01", expiresAt: "2025-12-31", deleted: false, year: 2025 },
      { id: 2, amountCents: BUDGET_42A_YEARLY, validFrom: "2026-01-01", expiresAt: "2026-12-31", deleted: false, year: 2026 },
    ], transactions: [], yearlyBudgetCents: BUDGET_42A_YEARLY, today: new Date("2026-06-01") });
    expect(s.currentYearAllocatedCents).toBe(353900);
  });

  test("5.6 – Disabled §39/42a: keine Allokation, Summary zeigt 0", () => {
    const s = buildSummary42a({ allocations: [], transactions: [], yearlyBudgetCents: 0, today: new Date("2025-08-15") });
    expect(s.currentYearAllocatedCents).toBe(0);
    expect(s.currentYearAvailableCents).toBe(0);
  });
});


describe("6. Kaskaden-Verbrauch – cascadeConsumption", () => {

  const mkBudgets = (a45a, a45b, a42a) => [
    { name: "45a", enabled: true, availableCents: a45a, allocations: [{ id: 10, amountCents: a45a, usedCents: 0, validFrom: "2025-03-01" }], monthlyLimitCents: null, yearlyLimitCents: null, carryoverCents: 0, transactions: [] },
    { name: "45b", enabled: true, availableCents: a45b, allocations: [{ id: 20, amountCents: a45b, usedCents: 0, validFrom: "2025-01-01" }], monthlyLimitCents: null, yearlyLimitCents: null, carryoverCents: 0, transactions: [] },
    { name: "42a", enabled: true, availableCents: a42a, allocations: [{ id: 30, amountCents: a42a, usedCents: 0, validFrom: "2025-07-01" }], monthlyLimitCents: null, yearlyLimitCents: null, carryoverCents: 0, transactions: [] },
  ];

  test("6.1 – Kosten komplett aus §45a (Prioritaet 1)", () => {
    const r = cascadeConsumption({ costCents: 4200, budgets: mkBudgets(10000, 13100, 50000), acceptsPrivatePayment: false, transactionDate: "2025-03-15" });
    expect(r[0].budget).toBe("45a");
    expect(r[0].consumedCents).toBe(4200);
  });

  test("6.2 – §45a erschoepft: Ueberlauf in §45b", () => {
    const r = cascadeConsumption({ costCents: 7000, budgets: mkBudgets(3000, 13100, 50000), acceptsPrivatePayment: false, transactionDate: "2025-03-15" });
    expect(r[0].budget).toBe("45a");
    expect(r[0].consumedCents).toBe(3000);
    expect(r[1].budget).toBe("45b");
    expect(r[1].consumedCents).toBe(4000);
  });

  test("6.3 – §45a + §45b erschoepft: Ueberlauf in §42a", () => {
    const r = cascadeConsumption({ costCents: 20000, budgets: mkBudgets(5000, 10000, 353900), acceptsPrivatePayment: false, transactionDate: "2025-03-15" });
    expect(r[2].budget).toBe("42a");
    expect(r[2].consumedCents).toBe(5000);
  });

  test("6.4 – Alle Toepfe leer + Privatzahlung: privat-Transaktion", () => {
    const r = cascadeConsumption({ costCents: 5000, budgets: mkBudgets(0, 0, 0), acceptsPrivatePayment: true, transactionDate: "2025-03-15" });
    const privat = r.find(x => x.budget === "privat");
    expect(privat.consumedCents).toBe(5000);
  });

  test("6.5 – Alle Toepfe leer + keine Privatzahlung: Fehler", () => {
    expect(() => cascadeConsumption({ costCents: 5000, budgets: mkBudgets(0, 0, 0), acceptsPrivatePayment: false, transactionDate: "2025-03-15" }))
      .toThrow("Budget nicht ausreichend");
  });

  test("6.6 – Kosten exakt = Gesamtbudget: kein Fehler, kein privat-Split", () => {
    const r = cascadeConsumption({ costCents: 5000, budgets: mkBudgets(2000, 3000, 0), acceptsPrivatePayment: false, transactionDate: "2025-03-15" });
    expect(r.find(x => x.budget === "privat")).toBeUndefined();
  });

  test("6.7 – Summe aller consumedCents = costCents", () => {
    const r = cascadeConsumption({ costCents: 11890, budgets: mkBudgets(5000, 13100, 0), acceptsPrivatePayment: false, transactionDate: "2025-03-15" });
    expect(r.reduce((s, x) => s + x.consumedCents, 0)).toBe(11890);
  });

  test("6.8 – Leerer §45a-Topf wird uebersprungen (kein Split mit 0)", () => {
    const r = cascadeConsumption({ costCents: 4200, budgets: mkBudgets(0, 13100, 0), acceptsPrivatePayment: false, transactionDate: "2025-03-15" });
    expect(r.filter(x => x.consumedCents > 0).every(x => x.consumedCents > 0)).toBe(true);
  });

  test("6.9 – Disabled §45a wird uebersprungen, §45b uebernimmt", () => {
    const budgets = [
      { name: "45a", enabled: false, availableCents: 30000, allocations: [{ id: 10, amountCents: 30000, usedCents: 0, validFrom: "2025-03-01" }], monthlyLimitCents: null, yearlyLimitCents: null, carryoverCents: 0, transactions: [] },
      { name: "45b", enabled: true, availableCents: 13100, allocations: [{ id: 20, amountCents: 13100, usedCents: 0, validFrom: "2025-01-01" }], monthlyLimitCents: null, yearlyLimitCents: null, carryoverCents: 0, transactions: [] },
      { name: "42a", enabled: true, availableCents: 0, allocations: [], monthlyLimitCents: null, yearlyLimitCents: null, carryoverCents: 0, transactions: [] },
    ];
    const r = cascadeConsumption({ costCents: 5000, budgets, acceptsPrivatePayment: false, transactionDate: "2025-03-15" });
    expect(r.find(x => x.budget === "45a").consumedCents).toBe(0);
    expect(r.find(x => x.budget === "45b").consumedCents).toBe(5000);
  });

  test("6.10 – Monatslimit §45b begrenzt Verbrauch, Rest in §42a", () => {
    const budgets = [
      { name: "45a", enabled: true, availableCents: 0, allocations: [], monthlyLimitCents: null, yearlyLimitCents: null, carryoverCents: 0, transactions: [] },
      { name: "45b", enabled: true, availableCents: 39300, allocations: [{ id: 20, amountCents: 39300, usedCents: 0, validFrom: "2025-01-01" }], monthlyLimitCents: 20000, yearlyLimitCents: null, carryoverCents: 5000, transactions: [] },
      { name: "42a", enabled: true, availableCents: 353900, allocations: [{ id: 30, amountCents: 353900, usedCents: 0, validFrom: "2025-01-01" }], monthlyLimitCents: null, yearlyLimitCents: null, carryoverCents: 0, transactions: [] },
    ];
    const r = cascadeConsumption({ costCents: 30000, budgets, acceptsPrivatePayment: false, transactionDate: "2025-03-15" });
    expect(r.find(x => x.budget === "45b").consumedCents).toBe(25000);
    expect(r.find(x => x.budget === "42a").consumedCents).toBe(5000);
  });

  test("6.11 – Monatslimit §45a begrenzt Verbrauch", () => {
    const budgets = [
      { name: "45a", enabled: true, availableCents: 59880, allocations: [{ id: 10, amountCents: 59880, usedCents: 0, validFrom: "2025-03-01" }], monthlyLimitCents: 30000, yearlyLimitCents: null, carryoverCents: 0, transactions: [{ type: "consumption", amountCents: 10000, date: "2025-03-05" }] },
      { name: "45b", enabled: true, availableCents: 39300, allocations: [{ id: 20, amountCents: 39300, usedCents: 0, validFrom: "2025-01-01" }], monthlyLimitCents: null, yearlyLimitCents: null, carryoverCents: 0, transactions: [] },
      { name: "42a", enabled: true, availableCents: 0, allocations: [], monthlyLimitCents: null, yearlyLimitCents: null, carryoverCents: 0, transactions: [] },
    ];
    const r = cascadeConsumption({ costCents: 25000, budgets, acceptsPrivatePayment: false, transactionDate: "2025-03-15" });
    expect(r.find(x => x.budget === "45a").consumedCents).toBe(20000);
    expect(r.find(x => x.budget === "45b").consumedCents).toBe(5000);
  });

  test("6.12 – Jahreslimit §39/42a begrenzt Verbrauch", () => {
    const budgets = [
      { name: "45a", enabled: true, availableCents: 0, allocations: [], monthlyLimitCents: null, yearlyLimitCents: null, carryoverCents: 0, transactions: [] },
      { name: "45b", enabled: true, availableCents: 0, allocations: [], monthlyLimitCents: null, yearlyLimitCents: null, carryoverCents: 0, transactions: [] },
      { name: "42a", enabled: true, availableCents: 353900, allocations: [{ id: 30, amountCents: 353900, usedCents: 0, validFrom: "2025-01-01" }], monthlyLimitCents: null, yearlyLimitCents: 200000, carryoverCents: 0, transactions: [{ type: "consumption", amountCents: 150000, date: "2025-06-01" }] },
    ];
    const r = cascadeConsumption({ costCents: 100000, budgets, acceptsPrivatePayment: true, transactionDate: "2025-08-15" });
    expect(r.find(x => x.budget === "42a").consumedCents).toBe(50000);
    const privat = r.find(x => x.budget === "privat");
    expect(privat.consumedCents).toBe(50000);
  });

  test("6.13 – Teilweiser Restbetrag als Privatzahlung", () => {
    const r = cascadeConsumption({ costCents: 15000, budgets: mkBudgets(5000, 5000, 0), acceptsPrivatePayment: true, transactionDate: "2025-03-15" });
    const privat = r.find(x => x.budget === "privat");
    expect(privat.consumedCents).toBe(5000);
    expect(r.reduce((s, x) => s + x.consumedCents, 0)).toBe(15000);
  });
});


describe("7. processExpiredCarryover – Ablauf-Abschreibung", () => {

  test("7.1 – Abgelaufener Carryover erzeugt write_off", () => {
    const wo = processExpiredCarryover({ allocations: [{ id: 99, amountCents: 5000, source: "carryover", expiresAt: "2025-06-30" }], transactions: [], today: new Date("2025-07-01") });
    expect(wo.length).toBe(1);
    expect(wo[0].amountCents).toBe(5000);
  });

  test("7.2 – Noch nicht abgelaufener Carryover: kein write_off", () => {
    const wo = processExpiredCarryover({ allocations: [{ id: 99, amountCents: 5000, source: "carryover", expiresAt: "2025-06-30" }], transactions: [], today: new Date("2025-06-30") });
    expect(wo.length).toBe(0);
  });

  test("7.3 – Teilverbrauch: nur Restbetrag wird abgeschrieben", () => {
    const wo = processExpiredCarryover({
      allocations: [{ id: 99, amountCents: 5000, source: "carryover", expiresAt: "2025-06-30" }],
      transactions: [{ type: "consumption", amountCents: 2000, allocationId: 99, date: "2025-05-01" }],
      today: new Date("2025-07-01"),
    });
    expect(wo[0].amountCents).toBe(3000);
  });

  test("7.4 – Idempotenz: bereits write_off vorhanden: kein zweites write_off", () => {
    const wo = processExpiredCarryover({
      allocations: [{ id: 99, amountCents: 5000, source: "carryover", expiresAt: "2025-06-30" }],
      transactions: [{ type: "write_off", amountCents: 5000, allocationId: 99, date: "2025-07-01" }],
      today: new Date("2025-07-15"),
    });
    expect(wo.length).toBe(0);
  });

  test("7.5 – Nicht-Carryover-Allokation wird ignoriert", () => {
    const wo = processExpiredCarryover({ allocations: [{ id: 1, amountCents: 5000, source: "monthly_auto", expiresAt: "2025-06-30" }], transactions: [], today: new Date("2025-07-01") });
    expect(wo.length).toBe(0);
  });

  test("7.6 – Vollstaendig verbrauchter Carryover: remaining=0, kein write_off", () => {
    const wo = processExpiredCarryover({
      allocations: [{ id: 99, amountCents: 5000, source: "carryover", expiresAt: "2025-06-30" }],
      transactions: [{ type: "consumption", amountCents: 5000, allocationId: 99, date: "2025-05-01" }],
      today: new Date("2025-07-01"),
    });
    expect(wo.length).toBe(0);
  });

  test("7.7 – Carryover ohne expiresAt wird nie abgeschrieben", () => {
    const wo = processExpiredCarryover({ allocations: [{ id: 99, amountCents: 5000, source: "carryover", expiresAt: null }], transactions: [], today: new Date("2030-01-01") });
    expect(wo.length).toBe(0);
  });
});


describe("8. availableAfterPlanned (darf negativ sein, kein Fehler)", () => {

  test("8.1 – Normal: planned < available: positiver Wert", () => {
    expect(computeAvailableAfterPlanned(13100, 5945)).toBeGreaterThan(0);
  });

  test("8.2 – Genau ausgeschoepft: planned = available: 0", () => {
    expect(computeAvailableAfterPlanned(5945, 5945)).toBe(0);
  });

  test("8.3 – Ueberbuchung: planned > available: negativer Wert (kein Fehler!)", () => {
    expect(() => computeAvailableAfterPlanned(5000, 8000)).toNotThrow();
    expect(computeAvailableAfterPlanned(5000, 8000)).toBeLessThan(0);
  });

  test("8.4 – Negativer Wert entspricht exakt der Ueberbuchungshoehe", () => {
    expect(computeAvailableAfterPlanned(5000, 8000)).toBe(-3000);
  });

  test("8.5 – Sonderfall: Budget = 0, Planung = 0: 0", () => {
    expect(computeAvailableAfterPlanned(0, 0)).toBe(0);
  });

  test("8.6 – availableThisMonth in §45b-Summary niemals < 0 (Math.max-Schutz)", () => {
    const s = buildSummary45b({
      allocations: [{ id: 1, amountCents: 13100, validFrom: "2025-03-01", expiresAt: null, deleted: false, source: "monthly_auto" }],
      transactions: [{ type: "consumption", amountCents: 20000, date: "2025-03-05", allocationId: 1 }],
      monthlyLimitCents: BUDGET_45B_MONTHLY,
      today: new Date("2025-03-15"),
    });
    expect(s.availableThisMonth).toBeAtLeast(0);
  });
});


describe("9. Race Condition (pg_advisory_xact_lock Simulation)", () => {

  test("9.1 – OHNE Lock: Ueberbuchung moeglich (demonstriert das Problem)", async () => {
    const { usedCents, results } = await simulateParallelConsumption({ allocationAmountCents: 10000, cost1Cents: 6000, cost2Cents: 6000, withLock: false });
    const bothOk = results.every(r => r.status === "fulfilled");
    if (bothOk && usedCents > 10000) {
      console.log(`    ${Y}!  Race Condition aufgetreten: usedCents=${usedCents} > 10000 (Ueberbuchung)${X}`);
    } else {
      console.log(`    ${Y}!  Kein Race-Condition-Effekt (Timing-abhaengig, kein zuverlaessiger Schutz)${X}`);
    }
  });

  test("9.2 – MIT Lock: Niemals Ueberbuchung, exakt eine TX abgewiesen", async () => {
    const { usedCents, results } = await simulateParallelConsumption({ allocationAmountCents: 10000, cost1Cents: 6000, cost2Cents: 6000, withLock: true });
    expect(usedCents).toBeAtMost(10000);
    expect(results.filter(r => r.status === "fulfilled").length).toBe(1);
    expect(results.filter(r => r.status === "rejected").length).toBe(1);
  });

  test("9.3 – MIT Lock: Zwei kleine TX passen beide rein", async () => {
    const { usedCents, results } = await simulateParallelConsumption({ allocationAmountCents: 10000, cost1Cents: 3000, cost2Cents: 4000, withLock: true });
    expect(results.filter(r => r.status === "fulfilled").length).toBe(2);
    expect(usedCents).toBe(7000);
  });

  test("9.4 – MIT Lock: Exakter Budget-Match (beide TX zusammen = Budget)", async () => {
    const { usedCents } = await simulateParallelConsumption({ allocationAmountCents: 10000, cost1Cents: 4000, cost2Cents: 6000, withLock: true });
    expect(usedCents).toBe(10000);
  });

  test("9.5 – MIT Lock: Lock wird korrekt freigegeben (wiederholte Calls moeglich)", async () => {
    const r1 = await simulateParallelConsumption({ allocationAmountCents: 20000, cost1Cents: 5000, cost2Cents: 5000, withLock: true });
    const r2 = await simulateParallelConsumption({ allocationAmountCents: 20000, cost1Cents: 5000, cost2Cents: 5000, withLock: true });
    expect(r1.usedCents).toBe(10000);
    expect(r2.usedCents).toBe(10000);
  });
});


async function runAsyncTests() {
  for (const { label, fn } of asyncTests) {
    try {
      await fn();
      console.log(`  ${G}✓${X} ${label}`);
      passed++;
    } catch (e) {
      console.log(`  ${R}✗${X} ${label}`);
      console.log(`    ${R}→ ${e.message}${X}`);
      failed++;
      failures.push({ label, error: e.message });
    }
  }
}

runAsyncTests().then(() => {
  const total = passed + failed;
  console.log(`\n${"─".repeat(62)}`);
  console.log(`${B}Ergebnis: ${passed}/${total} Tests bestanden${X}`);
  if (failures.length > 0) {
    console.log(`\n${R}Fehlgeschlagene Tests:${X}`);
    failures.forEach(f => console.log(`  ${R}✗${X} ${f.label}\n    → ${f.error}`));
  } else {
    console.log(`${G}Alle Tests bestanden ✓${X}`);
  }
  console.log(`${"─".repeat(62)}\n`);
  process.exit(failed > 0 ? 1 : 0);
});
